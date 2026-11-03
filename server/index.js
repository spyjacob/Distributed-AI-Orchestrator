import { validateEffort } from '../src/core/model-effort.js';
/**
 * LAN server: the same harness core, driven from a phone.
 *
 * Everything here is a thin shell over src/core - the identical agent loop,
 * store and providers the desktop app uses, against the identical data
 * directory. A session started on the phone opens in the desktop app and the
 * other way round.
 *
 * Access control: this process runs shell commands on this machine, so every
 * request must carry the token printed at startup. The token is bound into the
 * URL once and then kept in a cookie.
 */

import { diagnostics } from '../src/core/diagnostics.js';
import { runtimeAI } from '../src/core/app-ai.js';
import { createMessageQueue } from '../src/core/message-queue.js';
import { writeCheckpoint, checkpointFile, checkpointExists, renderCheckpoint, resumeText } from '../src/core/resume-checkpoint.js';
import { defaultDataDir } from '../src/core/platform.js';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { replicatedAssets } from '../src/core/cluster/assets.js';
import { portableWorkspaces } from '../src/core/cluster/workspaces.js';
import { appPlacement, replicationHosts } from '../src/core/cluster/placement.js';
import { deviceInventory } from '../src/core/cluster/devices.js';
import { hostPairing } from '../src/core/cluster/pairing.js';
import { executionHosts, executionOwner, assignmentError, sessionWriteError, recoverStoppedTurn } from '../src/core/cluster/execution.js';
import { createCluster } from '../src/core/cluster/index.js';
import { projectRecovery } from '../src/core/cluster/project-recovery.js';
import { restartPeers } from '../src/core/cluster/restart.js';
import { harnessVersions, versionMetadata, readVersion } from '../src/core/harness-version.js';
import { createTestBuilds, describeFiles } from '../src/core/test-build.js';
import { createNodes } from '../src/core/nodes.js';
import { createAISources } from '../src/core/ai-sources.js';
import { modelInventory, machineHelp } from '../src/core/machine-help.js';
import { runTurn, usesTools } from '../src/core/agent.js';
import { loadConfig, patchModel, addModel } from '../src/core/config.js';
import { resetClients } from '../src/core/providers/index.js';
import { loadSecrets, setSecret } from '../src/core/secrets.js';
import { transcribe, transcriptionKey } from '../src/core/transcription.js';
import * as attachments from '../src/core/attachments.js';
import * as git from '../src/core/git.js';
import { readPublication, mergeTab, prepareTab, integrateTab, tabHasUnpublishedWork, pendingSummary, syncHarnessCheckout, discardTab } from '../src/core/tab-workspaces.js';
import { configureGithub, createGithubAuth } from '../src/core/github-auth.js';
import { loadNotify, saveNotify, send as sendNotify, summarise, notificationSetupError } from '../src/core/notify.js';
import * as store from '../src/core/store.js';
import { noteEvent, userEvent, assistantEvent } from '../src/core/transcript.js';
import { eraseEvent, rewindTo } from '../src/core/rewind.js';
import { normalizeProviderLimits, WINDOWS } from '../src/core/usage.js';
import * as codexCli from '../src/core/providers/codex-cli.js';
import { canonicalPath, insidePath } from '../src/core/path-policy.js';
import { refuseAsProjectDir, HARNESS_ROOT, HARNESS_APP_ID } from '../src/core/harness-guard.js';
import { loadEmailConfig, saveEmailConfig } from '../src/core/email-config.js';
import * as apps from '../src/core/apps.js';
import { viewerAddress } from '../src/core/cluster/viewers.js';
import { createNetworkGate } from '../src/core/network-gate.js';
import { networkStatus, setupPhoneAccess } from '../src/core/tailscale.js';
import { createBeacons, wedgeMessage, stallMsFor } from '../src/core/beacon.js';
import { sendEmail } from '../src/core/email.js';
import * as usageStore from '../src/core/usage-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Moves when a test build's interface swaps in without a restart.
let PUBLIC = path.join(__dirname, 'public');

const PORT = Number(process.env.HARNESS_PORT ?? 8787);
const connectionStatus = createNetworkGate(() => networkStatus(PORT));
const instanceId = crypto.randomUUID();
let restarting = false;
// A test build loads its code from its own folder; updates, restarts and "what
// is published" always belong to the checkout. See src/core/test-build.js.
const codeDir = path.resolve(__dirname, '..');
const harnessDir = HARNESS_ROOT;
let loadedRevision = (await git.run(['rev-parse', 'HEAD'], harnessDir)).out;
const loadedVersion = {
  revision: loadedRevision,
  number: await readVersion(harnessDir),
  committedAt: (await git.run(['show', '-s', '--format=%cI', 'HEAD'], harnessDir)).out,
  startedAt: new Date().toISOString(),
  dirty: Boolean((await git.run(['status', '--porcelain'], harnessDir)).out),
  testing: null,
};
// Pages compare this to reload themselves only when the interface really changed.
let uiTree = (await git.run(['rev-parse', 'HEAD:server/public'], codeDir)).out || null;
let builds = null;
let harnessUpdate = { restartRequired: false };
let checkingHarnessUpdate = false;

// Share the desktop app's data directory so both frontends see one set of
// sessions. This is Electron's app.getPath('userData') for productName Harness.
const USER_DATA =
  process.env.HARNESS_DATA_DIR ||
  defaultDataDir();

configureGithub(USER_DATA);
const github = createGithubAuth(USER_DATA);
const nodes = createNodes(USER_DATA);
const inventory = deviceInventory(USER_DATA);
const aiSources = createAISources(USER_DATA);

let cluster = null;
let usageHistory = null;
let readVersionMetadata;
const observedVersions = new Map();
function observeVersion(peer, version) {
  const value = version?.revision || 'unavailable';
  if (observedVersions.get(peer) === value) return;
  observedVersions.set(peer, value);
  usageHistory?.record(version ? 'peer.version' : 'peer.unavailable', { peer, observedRevision: version?.revision });
}
let recovery = null;
let pairing = null;
let workspaces = null;
let placement = null;
let clusterAssets = null;
let TOKEN = '';              // resolved from disk at startup
let usage = null;            // the usage ledger, loaded at startup
let usageDirty = false;

/**
 * Fold whatever is new into the usage ledger.
 *
 * Only sessions that changed since their cursor are opened, so a quiet pass
 * reads nothing but the session index.
 */
async function collectUsage({ force = false } = {}) {
  if (!usage) return;
  const cfg = await loadConfig(USER_DATA);
  const listed = await store.list();
  const seen = new Set();
  let added = 0;

  for (const meta of listed) {
    seen.add(meta.id);
    const cursor = usage.cursors[meta.id];
    // Untouched since we last looked: nothing to read.
    if (!force && cursor && meta.updatedAt && meta.updatedAt <= cursor.ts) continue;

    const session = live.get(meta.id) ?? (await store.load(meta.id, { repair: false }).catch(() => null));
    if (session) added += usageStore.ingestSession(usage, session, cfg.models);
  }

  // Forget sessions that no longer exist, so cursors do not accumulate.
  for (const id of Object.keys(usage.cursors)) {
    if (!seen.has(id)) delete usage.cursors[id];
  }

  if (added || usageDirty) {
    usageStore.prune(usage);
    usage.updatedAt = Date.now();
    await usageStore.save(USER_DATA, usage);
    usageDirty = false;
  }
  return added;
}

const CLAUDE_PERMISSIONS = ['default','acceptEdits','auto','bypassPermissions','plan'];
const messageQueue = createMessageQueue();
// Paused sessions on this owner host: id -> { at, interrupted, checkpoint }.
// The pause is also saved on the session record (session.pause) with its held
// messages, so a restart keeps it: the first request that needs it reads it
// back and parks those messages again.
const paused = new Map();
const pauseReads = new Map(); // id -> this process's one read of a saved pause
const PAUSE_ROUTES = new Set(['pause', 'resume', 'stop', 'send', 'queue', 'pending', 'events']);
const messageAdmissions = new Map();
const interactionChains = new Map();
const interactions = new Map(); // Live provider requests; never inferred from assistant prose.
function requestInteraction(sessionId, request, signal) {
  const prior = interactionChains.get(sessionId) || Promise.resolve();
  const pending = prior.catch(() => {}).then(() => presentInteraction(sessionId, request, signal));
  interactionChains.set(sessionId, pending);
  pending.finally(() => { if (interactionChains.get(sessionId) === pending) interactionChains.delete(sessionId); }).catch(() => {});
  return pending;
}
function presentInteraction(sessionId, request, signal) {
  if (signal?.aborted) return Promise.resolve({allow:false, message:'Turn stopped.'});
  return new Promise(resolve => {
    const entry = { ...request, id:crypto.randomUUID() };
    const finish = answer => {
      signal?.removeEventListener('abort', cancel);
      if (interactions.get(sessionId)?.request.id === entry.id) { interactions.delete(sessionId); shareWaiting(sessionId, null); }
      broadcast(sessionId, {kind:'interaction', request:null});
      beacons.touch(sessionId, 'user responded');
      usageHistory?.record('interaction.finished', {correlationId:entry.id, outcome:answer.allow ? 'approved' : 'declined'});
      resolve(answer);
    };
    const cancel = () => finish({allow:false, message:'Turn stopped.'});
    interactions.set(sessionId, {request:entry, finish});
    shareWaiting(sessionId, request.kind);
    signal?.addEventListener('abort', cancel, {once:true});
    broadcast(sessionId, {kind:'interaction', request:entry});
    usageHistory?.record('interaction.waiting', {correlationId:entry.id, outcome:request.kind});
  });
}

/**
 * Session lists come from the coordinator, which only holds its own pending
 * questions. A turn on another computer records its question in the replicated
 * session instead. Never awaited: a slow save must not hold up the question.
 */
function shareWaiting(sessionId, kind) {
  const session = live.get(sessionId);
  if (!session || !cluster?.shared() || (kind ? session.waitingFor === kind : !session.waitingFor)) return;
  if (kind && cluster.replica.role === 'leader') return;
  if (kind) session.waitingFor = kind; else delete session.waitingFor;
  store.save(session).catch(() => {});
}

const running = new Map();   // sessionId -> { controller, startedAt, last }
const live = new Map();      // sessionId -> the session object a turn is mutating
const providerLimits = new Map(); // model alias -> its last reported rate-limit info
const beacons = createBeacons();  // per-turn liveness, so a stall cannot stay invisible
const listeners = new Map(); // sessionId -> Set<ServerResponse>

/**
 * Without a token, direct network callers are refused (see authorized): only
 * loopback sockets with a localhost Host, so neither LAN callers nor DNS
 * rebinding get in. Phone access through Tailscale Serve and paired computers
 * are trusted separately and work either way.
 *
 * Set HARNESS_TOKEN=<secret> to require one, or HARNESS_TOKEN=auto to generate
 * one and keep it on disk so a bookmarked link survives restarts.
 */
async function resolveToken(dir) {
  const want = process.env.HARNESS_TOKEN;
  if (!want) return '';                 // no auth
  if (want !== 'auto') return want;

  const file = path.join(dir, 'server-token');
  try {
    const saved = (await fs.readFile(file, 'utf8')).trim();
    if (saved) return saved;
  } catch {
    // not yet created
  }
  const fresh = crypto.randomBytes(16).toString('hex');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  return fresh;
}

// App records and API keys travel over authenticated cluster transport.
// Model definitions, local endpoints, CLI paths and logins stay on their host.
const SHARED_SETTINGS = ['secrets.json', 'apps.json'];
let settingsApplied = '';
async function snapshotSettings() {
  for (const name of SHARED_SETTINGS) {
    let value = await fs.readFile(path.join(USER_DATA, name), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (name === 'apps.json' && value !== null) {
      const parsed = JSON.parse(value);
      for (const app of parsed.apps || []) app.ownerNode ||= cluster.self.id;
      value = JSON.stringify(parsed);
    }
    if (value !== null && cluster.replica.state.values['settings:' + name] !== value) {
      await cluster.replica.propose({ type: 'value', id: 'settings:' + name, value });
    }
  }
}
async function saveModelSecret(alias, apiKey) {
  if (cluster.shared() && cluster.replica.role !== 'leader') await cluster.shareSecret(alias, apiKey);
  await setSecret(USER_DATA, alias, apiKey);
  if (cluster.shared() && cluster.replica.role === 'leader') await snapshotSettings();
}

async function restoreSettings() {
  const values = SHARED_SETTINGS.map((name) => cluster.replica.state.values['settings:' + name] ?? null);
  const fingerprint = JSON.stringify(values);
  if (fingerprint === settingsApplied) return;
  for (let i = 0; i < SHARED_SETTINGS.length; i++) {
    if (values[i] === null) continue;
    let content = values[i];
    const parsed = JSON.parse(content);
    if (SHARED_SETTINGS[i] === 'apps.json') {
      for (const app of parsed.apps || []) if (app.ownerNode && app.ownerNode !== cluster.self.id) app.pid = null;
      content = JSON.stringify(parsed);
    }
    const file = path.join(USER_DATA, SHARED_SETTINGS[i]);
    const tmp = `${file}.cluster-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, content, { mode: 0o600 }); await fs.rename(tmp, file);
  }
  resetClients(); settingsApplied = fingerprint;
}

// ---------------------------------------------------------------- utilities

/**
 * One reply, compressed when there is anything to win.
 *
 * A long session's JSON is most of a megabyte, and over the tailnet from a
 * phone that transfer is the second or two between tapping a session and
 * seeing it - gzip takes it to roughly a quarter. Compression is async so a
 * big transcript does not stall every other session's turn, and anything
 * under a packet is sent as-is because framing it would cost more than it
 * saves. The stream endpoints write their own headers and are untouched:
 * buffering an event stream would defeat the point of it.
 */
function send(res, code, type, buf) {
  const head = { 'Content-Type': type, 'Cache-Control': 'no-store' };

  if (!res.gzipOk || buf.length < 1400) {
    head['Content-Length'] = buf.length;
    res.writeHead(code, head);
    return res.end(buf);
  }

  zlib.gzip(buf, (err, gz) => {
    // A failed compress must still answer the request, just uncompressed.
    const body = err ? buf : gz;
    if (!err) {
      head['Content-Encoding'] = 'gzip';
      head.Vary = 'Accept-Encoding';
    }
    head['Content-Length'] = body.length;
    res.writeHead(code, head);
    res.end(body);
  });
  return undefined;
}

async function json(res, code, body) {
  if (res.syncSettings && code < 400) {
    try { await snapshotSettings(); }
    catch (error) {
      settingsApplied = '';
      return send(res, 503, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ error: error.message })));
    }
  }
  return send(res, code, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(body)));
}

async function readBody(req, limit = 4_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req, url) {
  // Serve strips incoming identity headers and supplies its authenticated user.
  // Only trust these headers from its local proxy, never from a remote socket.
  const peer = req.socket.remoteAddress;
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) &&
      req.headers['tailscale-user-login'] && !req.headers['tailscale-funnel-request']) return true;
  if (cluster?.trusted(req)) return true;
  if (!TOKEN) return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && ['localhost','127.0.0.1','[::1]'].includes(url.hostname); // refuse LAN callers and DNS rebinding
  const supplied =
    url.searchParams.get('t') ||
    req.headers['x-harness-token'] ||
    (req.headers.cookie ?? '').match(/(?:^|;\s*)ht=([^;]+)/)?.[1];
  if (cluster?.verifyTicket(supplied)) return true;
  if (!supplied) return false;

  // Constant-time compare so the token can't be guessed a byte at a time.
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A short label for what a tool was doing, so a stall names its own cause. */
function describeArg(call) {
  const a = call?.args ?? {};
  return String(a.command ?? a.path ?? '').slice(0, 60);
}

/**
 * The notifier's settings, complete.
 *
 * Which channel to use lives in notify.json; the Gmail credential that the SMS
 * channel needs lives in the 0600 secrets file with the other keys. Merging
 * them here means no caller has to know that, and the password is read at the
 * moment of sending rather than held anywhere.
 */
async function notifyConfig(extra = {}) {
  const base = await loadNotify(USER_DATA);
  if ({ ...base, ...extra }.kind !== 'sms') return { ...base, ...extra };
  const email = await loadEmailConfig(USER_DATA).catch(() => ({}));
  return {
    ...base,
    gmailUser: email.gmailUser ?? null,
    gmailPass: email.gmailPass ?? null,
    carrier: email.carrier ?? null,
    ...extra,
  };
}

function broadcast(sessionId, payload) {
  const set = listeners.get(sessionId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(frame);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Directories that are never a session's output and would swamp the useful
// results if walked.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.cache', 'screenshots', 'html',
  // macOS guards these behind a consent dialog. Reading one blocks until
  // somebody clicks it, and with the lid shut nobody can — which exhausts
  // libuv's threadpool and takes the whole server down with it. A session
  // rooted at ~ walks straight into them.
  'Library', 'Documents', 'Downloads', 'Desktop', 'Movies', 'Music', 'Pictures',
  'Applications', 'Public', 'Sites', 'iCloud Drive (Archive)',
]);

/** A directory read that gives up rather than blocking on a consent dialog. */
async function readdirBounded(dir, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      fs.readdir(dir, { withFileTypes: true }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Files under `root` modified at or after `since`, newest first. */
async function filesChangedSince(root, since, max = 400) {
  const out = [];

  async function walk(dir, depth) {
    if (depth > 6 || out.length >= max) return;
    const entries = await readdirBounded(dir);
    if (!entries) return;   // unreadable, vanished, or waiting on a permission dialog
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.mtimeMs >= since) {
          out.push({
            name: e.name,
            path: full,
            rel: path.relative(root, full),
            size: st.size,
            modified: st.mtimeMs,
            kind: kindOf(e.name),
          });
        }
      }
    }
  }

  await walk(root, 0);
  return out.sort((a, b) => b.modified - a.modified);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.py', '.sh', '.zsh', '.yml', '.yaml', '.toml', '.csv', '.tsv', '.log', '.xml', '.sql', '.env',
  '.gitignore', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.swift', '.kt', '.php',
]);

const MIME_FILE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.pdf': 'application/pdf',
};
for (const ext of TEXT_EXT) MIME_FILE[ext] = 'text/plain; charset=utf-8';

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext) || !ext) return 'text';
  return 'other';
}

/** Where the browser opens when nothing says otherwise. */
function state0Dir() {
  return os.homedir();
}

/** v1.03 + 3 unpushed files: the version, and whether this computer differs from it. */
function servingLabel() {
  const machine = cluster.self.name || os.hostname();
  const number = loadedVersion.number || loadedVersion.revision?.slice(0, 8) || 'unknown';
  const local = loadedVersion.testing ? ` + ${describeFiles(loadedVersion.testing.files)}` : loadedVersion.dirty ? ' · local edits' : '';
  return `${machine} · ${number}${local}`;
}
const servingTitle = () => `Serving commit ${loadedVersion.revision || 'unknown'} · started ${loadedVersion.startedAt}`;
const testingSummary = build => build ? { files: build.files, tabs: build.tabs } : null;

/** A test build can break the interface itself; leave a way back that needs no app.js. */
const TEST_BUILD_WATCHDOG = `<script>setTimeout(function(){if(window.doAppReady)return;var a=document.createElement('a');a.href='/test-build';a.textContent='These unpushed changes may have broken this page. See what is running and go back';a.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;padding:14px;background:var(--bg-3,#22252b);color:var(--fg,#d7dbe0);border:1px solid var(--line,#3a3f47);border-radius:8px;z-index:2147483647;text-align:center;font:14px system-ui;min-height:44px;box-sizing:border-box';document.body.appendChild(a);var ui=document.getElementById('serving-label');setInterval(function(){window.fetch('/api/harness/status').then(function(r){return r.json();}).then(function(s){if(s.ui&&ui&&s.ui!==ui.dataset.ui)location.reload();},function(){});},5000);},8000);</script>`;

/** The way back when the interface cannot load, so it depends on nothing else. */
async function testBuildPage(res) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = await builds.status();
  const testing = loadedVersion.testing;
  const tabs = testing ? testing.tabs.map(tab => `<li>${escape(tab.name)}</li>`).join('') : '';
  const problem = status.failure?.message || status.error?.message;
  send(res, 200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What is running · DO</title>
<body style="background:#14161a;color:#d7dbe0;font:16px system-ui;padding:2rem;max-width:40rem;margin:auto;overflow-wrap:anywhere">
<h2>${escape(servingLabel())}</h2>
${testing ? `<p>This computer is running unpushed changes from:</p><ul>${tabs}</ul><p>Going back keeps the changes in their tabs. Only what runs here changes.</p>
<p><button id="back" style="min-height:44px;padding:0 18px;font:inherit;background:#22252b;color:inherit;border:1px solid #3a3f47;border-radius:8px">Go back to published</button></p>
<p id="status" role="status"></p>
<script>
document.getElementById('back').onclick = async function () {
  var status = document.getElementById('status');
  this.disabled = true; status.textContent = 'Going back…';
  try {
    var answer = await fetch('/api/harness/test-build/stop', { method: 'POST' });
    if (!answer.ok) throw new Error('DO refused (' + answer.status + ').');
  } catch (error) { status.textContent = 'Could not go back: ' + error.message; this.disabled = false; return; }
  setInterval(function () {
    fetch('/api/harness/status', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (s) { if (s.version && !s.version.testing) location.href = '/'; }, function () {});
  }, 1000);
};
</script>` : '<p>This computer is running the published version.</p>'}
${problem ? `<p>Last problem: ${escape(problem)}</p>` : ''}
<p><a href="/" style="color:inherit">Open DO</a></p>`));
}

/** Make a test build's interface current, and report what this computer now runs. */
async function adoptCode({ dir, commit, base, build }) {
  PUBLIC = path.join(dir, 'server', 'public');
  uiTree = (await git.run(['rev-parse', `${commit}:server/public`], harnessDir)).out || null;
  loadedVersion.testing = testingSummary(build);
  if (base === loadedRevision) return;
  loadedRevision = loadedVersion.revision = base;
  loadedVersion.committedAt = (await git.run(['show', '-s', '--format=%cI', base], harnessDir)).out;
  loadedVersion.number = await readVersion(harnessDir);
  harnessUpdate = { ...harnessUpdate, restartRequired: false };
}

/**
 * Start the process that takes over once this one stops. `local` skips the GitHub
 * check: loading this computer's own changes must work with no connection.
 */
async function launchReplacement({ targetRevision, local = false } = {}) {
  if (running.size || messageQueue.size) throw new Error('Work started during the restart. Wait for it to finish, then retry.');
  const restartId = crypto.randomUUID();
  const out = openSync(path.join(USER_DATA, 'server.log'), 'a');
  let helper, revision;
  try {
    helper = spawn(process.execPath, [path.join(harnessDir, 'scripts/restart-server.mjs'), String(PORT), path.join(harnessDir, 'server/boot.js'), ...(local ? ['--local'] : [])], {
      windowsHide: true, detached: true, stdio: ['ignore', out, out, 'ipc'],
      cwd: harnessDir,
      env: { ...process.env, HARNESS_PORT: String(PORT), HARNESS_DATA_DIR: USER_DATA, ORCHESTRATOR_RESTART_ID: restartId },
    });
    // Do not stop this server until the relauncher has loaded successfully.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Restart update check timed out.')), 180000);
      const finish = (error) => {
        clearTimeout(timer);
        helper.removeListener('error', finish);
        helper.removeListener('exit', exited);
        helper.removeListener('message', ready);
        error ? reject(error) : resolve();
      };
      const exited = () => finish(new Error('Restart helper exited before it was ready.'));
      const ready = (message) => {
        if (message?.error) return finish(new Error(message.error));
        if (message?.ready) {
          revision = message.revision;
          if (targetRevision && revision !== targetRevision) return finish(new Error('GitHub changed during rollout; retry with the latest commit.'));
          finish();
        }
      };
      helper.once('error', finish);
      helper.once('exit', exited);
      helper.on('message', ready);
    });
    helper.disconnect();
    helper.unref();
    return { restartId, revision };
  } catch (error) {
    helper?.kill();
    throw error;
  } finally { closeSync(out); }
}

/** What a turn's end says about the tab's changes. */
function turnEndNote(id, pending, loaded) {
  if (!pending) return 'No pending changes in this tab.';
  if (!loaded) return 'Changes saved in this tab. Open Push to review and publish.';
  if (loaded.error) return 'Changes saved in this tab, not running on this computer.';
  if (!loaded.build && !loaded.conflict) return 'Changes saved in this tab. Open Push to review and publish.';
  if (loaded.conflict) return `Changes saved in this tab, not running: they conflict with another tab's unpushed changes${loaded.conflict.files.length ? ` in ${loaded.conflict.files.slice(0, 3).join(', ')}` : ''}. Push or discard one of them.`;
  // The turn ending here still counts once as running and once as queued.
  if (loaded.waiting) return `Changes saved. DO restarts to load them ${running.size > 1 || messageQueue.size > 1 || messageQueue.pending(id).length ? 'when running work finishes' : 'now'}. Not pushed.`;
  return `Running on this computer · ${describeFiles(loaded.build?.files ?? 0)}. Open Push to publish or discard.`;
}

/** After the reply is out, so the restart interrupts nothing and nobody is left waiting. */
const restartForTestBuild = () => setTimeout(() => builds.restartIfWaiting().catch(() => {}), 1000).unref();

async function serveStatic(res, name) {
  try {
    const file = path.join(PUBLIC, name);
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    let body = await fs.readFile(file);
    if (name === 'index.html') {
      const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      body = body.toString().replace('<!-- serving-revision -->',
        `<a id="serving-label" href="/test-build" data-ui="${escape(uiTree || '')}" title="${escape(servingTitle())}">${escape(servingLabel())}</a>`);
      if (loadedVersion.testing) body = body.replace('</body>', () => `${TEST_BUILD_WATCHDOG}</body>`);
      body = Buffer.from(body);
    }
    send(res, 200, `${MIME[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

async function sessionPlacement(session) {
  const app = session.appId ? (await apps.load(USER_DATA)).find(a => a.id === session.appId) : null;
  const hosts = executionHosts(app, cluster.replica.members(), cluster.self.id);
  return { app, hosts, distributed: cluster.shared() && Boolean(app) && hosts.length > 1 };
}

async function sourceAction(body) {
  await requireConnection();
  const { action, ...args } = body;
  if (action === 'catalog') return { ...await aiSources.catalog(), machine: cluster.self };
  if (action === 'discover') return aiSources.discover(args.kind);
  if (action === 'add') return aiSources.add(args);
  if (action === 'remove') {
    const dependents = (await apps.load(USER_DATA)).filter(app => (app.aiDependencies || []).some(d => d.host === cluster.self.id && d.alias === args.alias));
    if (dependents.length) throw new Error('Used by ' + dependents.map(a => a.name).join(', ') + '. Update their AI dependencies before removing this source.');

    if ([...live.values()].some(s => s.model === args.alias)) throw new Error('Wait for sessions using this source to finish.');
    return aiSources.remove(args.alias);
  }
  if (action === 'default') return aiSources.setDefault(args);
  if (action === 'helper-setting') return aiSources.delegateSetting(args.alias, args.enabled);
  if (action === 'local') return aiSources.localAction(args.operation, args.model);
  if (action === 'helper') return aiSources.helper(args);
  if (action === 'running') return aiSources.running();
  throw new Error('Unknown AI source action.');
}

async function requireConnection() {
  const network = await connectionStatus();
  if (!network.connected) throw new Error(network.error);
}

// A running turn keeps saving its own copy of the session, so a change made
// while it runs goes onto that copy rather than one it would overwrite.
async function editSession(id, change) {
  const session = live.get(id) ?? await store.load(id, { repair: false });
  if (change(session) !== false) await store.save(session);
  return session;
}

/** Read a saved pause once per process; after a restart it parks the held messages again. */
function pauseOf(id) {
  if (!pauseReads.has(id)) {
    const read = (async () => {
      const saved = paused.has(id) ? null : (live.get(id) ?? await store.load(id, { repair: false })).pause;
      if (!saved || paused.has(id)) return;
      const { queue = [], ...held } = saved;
      paused.set(id, held);
      messageQueue.hold(id);
      if (!messageQueue.pending(id).length) for (const body of queue) await scheduleTurn(id, { ...body }, true, { park: true });
      usageHistory?.record('turn.pause-restored', { outcome: held.interrupted ? 'interrupted' : 'queue-held', count: queue.length });
    })();
    pauseReads.set(id, read);
    read.catch(() => { if (pauseReads.get(id) === read) pauseReads.delete(id); }); // the next request retries
  }
  return pauseReads.get(id).then(() => paused.get(id) ?? null, () => paused.get(id) ?? null);
}

/** Save the pause and its held messages on the session record, or clear it. */
function savePause(id) {
  const held = paused.get(id);
  return editSession(id, session => {
    if (held) session.pause = { ...held, queue: messageQueue.pending(id).map(({ text, attachments, clientMessageId }) => ({ text, attachments, clientMessageId })) };
    else if (session.pause) delete session.pause;
    else return false;
  });
}

/** Write the paused turn's checkpoint. A failed write is recorded; it never undoes the pause. */
async function checkpointPause(id, session, correlationId) {
  const held = paused.get(id);
  if (!held?.interrupted) return null;
  try {
    const spec = (await loadConfig(USER_DATA).catch(() => null))?.models?.[session.model];
    held.checkpoint = await writeCheckpoint(session, {
      pausedAt: held.at, host: cluster.self.name || os.hostname(), queue: messageQueue.pending(id),
      model: [spec?.label || session.model, session.effort && `effort ${session.effort}`].filter(Boolean).join(' · '),
    });
    usageHistory?.record('turn.checkpoint', { correlationId, outcome: held.checkpoint ? 'written' : 'no-folder' });
  } catch (e) {
    held.checkpoint = null;
    usageHistory?.record('turn.checkpoint', { correlationId, outcome: `failed-${e.code || 'write'}` });
  }
  return held.checkpoint;
}

/** The paused turn's last word: refresh its checkpoint and note where it is in the transcript. */
async function recordPause(id, session, correlationId) {
  const file = await checkpointPause(id, session, correlationId);
  const waiting = messageQueue.pending(id).length;
  const held = waiting ? `; ${waiting} queued message${waiting === 1 ? ' waits' : 's wait'}` : '';
  const event = noteEvent(file ? `Paused. Resume checkpoint saved to ${file}. Resume continues from it${held}.`
    : `Paused. Resume continues from here${held}.`, { paused: true, ...(file ? { checkpoint: file } : {}) });
  session.events.push(event);
  await savePause(id); // saves this note along with the pause
  broadcast(id, { kind: 'event', event });
  broadcast(id, { kind: 'paused', paused: true, checkpoint: file });
}

/**
 * Stop cancels queued messages, as interrupting does in Claude Code. The
 * browser that stopped puts them back in its message box; this note keeps
 * their text in the transcript so none vanish on any other device either.
 */
function unsentNote(messages) {
  const quote = (m) => {
    const text = String(m.text || '');
    const files = m.attachments?.length ? ` (+${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'})` : '';
    return `“${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}”${files}`;
  };
  return noteEvent(messages.length === 1
    ? `Not sent: Stop cancelled your queued message ${quote(messages[0])}.`
    : `Not sent: Stop cancelled ${messages.length} queued messages: ${messages.map((m, i) => `${i + 1}. ${quote(m)}`).join(' ')}`,
  { unsent: messages.length });
}

/** What Resume sends: a pointer to the checkpoint, rebuilt first if it is missing. */
async function resumeMessage(id, correlationId) {
  const session = await store.load(id, { repair: false });
  if (!usesTools(session)) return { text: resumeText(), via: 'transcript' };
  const file = await checkpointExists(checkpointFile(session)) ? checkpointFile(session) : await checkpointPause(id, session, correlationId);
  if (file) return { text: resumeText({ file }), via: 'file' };
  return { text: resumeText({ inline: renderCheckpoint(session, { pausedAt: paused.get(id)?.at, queue: messageQueue.pending(id) }) }), via: 'inline' };
}

async function scheduleTurn(id, body, queueNext = false, { front = false, park = false } = {}) {
  usageHistory?.record('turn.requested', { correlationId: body.traceId });
  const queued = park || messageQueue.busy(id);
  body.pendingId = crypto.randomUUID();
  let acknowledge, refuse;
  const started = new Promise((resolve, reject) => { acknowledge = resolve; refuse = reject; });
  const task = async () => {
    try {
      broadcast(id, { kind: 'pending', pending: messageQueue.pending(id), starting: queued ? body : null });
      await dispatchMessage(id, body, (code, value) => {
        if (code >= 400) throw new Error(value.error);
        acknowledge();
      });
    } catch (e) {
      refuse(e);
      broadcast(id, { kind: 'error', error: e.message });
    }
  };
  // Parked: a held message restored after a restart waits for Resume.
  if (park) messageQueue.park(id, task, { onError: refuse, body });
  else messageQueue.submit(id, task, { queue: queueNext, front, onError: refuse, body });
  if (queued) broadcast(id, { kind: 'pending', pending: messageQueue.pending(id) });
  if (queued) { started.catch(() => {}); return true; }
  await started;
  return false;
}

async function dispatchMessage(id, body, reply) {
  // Where acceptance time goes, so a slow send is explained by the trace.
  const admittedFrom = Date.now();
  let phaseAt = admittedFrom;
  const phase = (name) => {
    const now = Date.now();
    if (now - phaseAt >= 200) usageHistory?.record('turn.admission', { correlationId: body.traceId, phase: name, durationMs: now - phaseAt });
    phaseAt = now;
  };
  const network = await connectionStatus();
  phase('network');
  if (!network.connected) return reply(503, { error: network.error });
  if (running.has(id)) return reply(409, { error: 'a turn is already running' });

  const { text, attachments: atts } = body;
  const session = await store.load(id);
  phase('load');
  if (cluster.shared()) {
    if (session.turnHost) return reply(409, { error: 'The previous turn is still marked running. Wait for it to finish or reconnect its computer.' });
    if (executionOwner(session, null, cluster.replica.leader) !== cluster.self.id) return reply(409, { error: 'This tab belongs to another computer.' });
    if (session.tabWorkspace && session.tabWorkspace.ownerNode !== cluster.self.id) return reply(409, { error: 'This tab has a Git worktree on another host. Reconnect that host to continue; tab branches are not yet migrated between hosts.' });
    await clusterAssets.session(session);
    for (const attachment of atts || []) await clusterAssets.restore(attachment);
    phase('assets');
    // Every save rewrites the whole conversation, so only a moved tab is saved
    // here; the accept save below records the rest.
    const placed = JSON.stringify([session.projectDir, session.ownerNode, session.tabWorkspace]);
    // A project runs from this host's own copy of it: the folder it was made
    // in, or the Git clone its machine placement keeps here.
    const app = session.appId && !session.editsHarness && session.appId !== '__harness'
      ? (await apps.load(USER_DATA)).find((a) => a.id === session.appId) : null;
    if (app) {
      const dir = await placement.localDir(app);
      if (!dir) {
        const here = cluster.self.name;
        const machine = placement.describe(app).find((m) => m.id === cluster.self.id);
        return reply(409, { error: machine?.placed
          ? `${app.name} is not on ${here} yet${machine.error ? ` — ${machine.error}` : ' — its copy is still being made'}.`
          : `${app.name} is not on ${here}, which is running tabs right now. Add ${here} under Edit project → Machines, or make one of its machines main.` });
      }
      if (session.projectDir !== dir && !session.projectDir?.startsWith(dir + path.sep)) {
        session.projectDir = dir;
        delete session.tabWorkspace; // its worktree lived in the other copy
      }
      session.ownerNode = cluster.self.id;
    } else await workspaces.prepare(session);
    phase('workspace');
    if (JSON.stringify([session.projectDir, session.ownerNode, session.tabWorkspace]) !== placed) {
      await store.save(session);
      phase('placement-save');
    }
  }
  const placementInfo = await sessionPlacement(session);
  if (session.appId && !placementInfo.hosts.includes(cluster.self.id)) return reply(409, { error: 'This computer is not enabled for this project.' });
  const cfg = await loadConfig(USER_DATA);
  if (cfg.error) return reply(400, { error: cfg.error });

  if (running.has(id)) return reply(409, { error: 'a turn is already running' });
  if (!cfg.models[session.model]) return reply(400, { error: 'Choose a model configured on this tab’s computer.' });
  if (cfg.models[session.model]?.supportsTools === false && session.mode !== 'chat') return reply(400, { error: 'This local model supports chat only. Use a chat session or choose a model with tool support.' });
  const inventory = await modelInventory(cfg);
  phase('config');
  if (!inventory.models[session.model]?.available) return reply(400, { error: inventory.models[session.model]?.availability || 'Model unavailable on this computer.' });
  delete session.queueTurn;
  // A turn only starts once a pause is over; never carry a stale one forward.
  if (!paused.has(id)) delete session.pause;
  const sentAt = session.events.length;
  const controller = new AbortController();
  const turn = { controller, startedAt: Date.now(), executionEpoch: session.executionEpoch || 0 };
  live.set(id, session);
  running.set(id, turn);
  // Replicated with the session, so if this host disappears mid-turn the
  // next main can fail this one tab instead of leaving it looking busy.
  if (cluster.shared()) {
    session.turnHost = cluster.self.id;
    session.turnStartedAt = turn.startedAt;
  }
  // The threshold depends on the backend: an agent CLI legitimately
  // goes quiet for many minutes while running its own loop.
  const accepted = userEvent(String(text || '').trim(), Array.isArray(atts) ? atts : []);
  if (body.clientMessageId) accepted.clientMessageId = body.clientMessageId;
  if (body.resume) accepted.resume = true; // a checkpoint looks past it to the request it continues
  session.events.push(accepted);
  // One save claims the turn and records the message, so neither is ever saved without the other.
  try { await store.save(session); }
  catch (error) { running.delete(id); live.delete(id); return reply(503, {error:error.message}); }
  phase('accept-save');
  broadcast(id, {kind:'event', event:accepted});
  beacons.start(id, { model: session.model, stallMs: stallMsFor(cfg.models[session.model]) });
  reply(200, { ok: true }); // answer now; the work streams over SSE
  usageHistory?.record('turn.started', { correlationId: body.traceId, durationMs: Date.now() - admittedFrom, provider:cfg.models[session.model]?.provider, effort:session.effort || cfg.models[session.model]?.effort || cfg.models[session.model]?.reasoningEffort || 'default' });
  broadcast(id, { kind: 'started', startedAt: turn.startedAt });

  let prepared = false, turnFailed = false;
  await Promise.resolve().then(async () => {
    if (cfg.models[session.model]?.sourceKind === 'ollama') await aiSources.prepare(cfg.models[session.model].model);
    if (session.mode !== 'chat') {
      await prepareTab(session, { distributed: placementInfo.distributed, recover: Boolean(session.tabWorkspace) });
      if (cluster.shared()) session.tabWorkspace.ownerNode = cluster.self.id;
      prepared = true;
      await store.save(session);
    }
    return runTurn({
      session,
      models: cfg.models,
      userText: null,
      onOutcome: outcome => { turnFailed = outcome === 'error'; },
      clientMessageId: body.clientMessageId,
      requestInteraction: (request, signal) => requestInteraction(id, request, signal || controller.signal),
      executionContext: `\n\nJev (TypeSafe) is an optional API integration. Check GET http://127.0.0.1:${PORT}/api/jev for configured status. If configured, consider it for classification, routing, ranking and rubric scoring, or when the user requests it. It returns structured decisions, not generated text. POST /api/jev/evaluate on that origin with {state, questions, model?}; model defaults to jev-latest. Read https://docs.typesafe.ai/api for question schemas (noul, choice, score). The server supplies the stored key; never read or copy secrets. Send only task-relevant data, handle uncertain results and failures explicitly, and explain API requirements in app README files. Saving a key does not validate account access. For deployed apps, use their own backend and TYPESAFE_API_KEY; never expose provider keys or Harness credentials in frontend code.\n\nFor optional local GPU helpers, POST JSON {host, action:"catalog"} to /api/cluster/sources to find models with allowDelegate enabled, then POST {host, action:"helper", alias, prompt} to the same endpoint. Supply only task-relevant text; helpers have no tools. Use the localhost origin described below. For cross-machine setup diagnostics, GET http://127.0.0.1:${PORT}/api/cluster/status for host IDs, then POST JSON {host, question, useClaude} to http://127.0.0.1:${PORT}/api/machine-help. This returns installation/configuration checks; useClaude asks that computer’s Claude to interpret the snapshot without tools. It cannot inspect arbitrary files or edit another computer.`,
      localModel: async ({ host = cluster.self.id, ...args }) => host === cluster.self.id
        ? sourceAction({ action: 'helper', ...args }) : cluster.hostSources(host, { action: 'helper', ...args }),
      machineHelp: async ({ host, ...request }) => host === cluster.self.id
        ? machineHelp(await loadConfig(USER_DATA), cluster.self, request) : cluster.hostHelp(host, request),
      attachments: [],
      signal: controller.signal,
      save: async (s) => {
        return store.save(s);
      },
      tailnetHost: await apps.tailnetHost().catch(() => null),
      onEvent: (event) => broadcast(id, { kind: 'event', event }),
      onDelta: (delta) => {
        // Any sign of life counts: a token, a tool starting, a tool ending.
        beacons.touch(id, delta.kind === 'tool_start' ? `${delta.call?.name} ${describeArg(delta.call)}` : delta.kind);
        if (delta.kind === 'native_context') usageHistory?.record('turn.native-context', {correlationId:body.traceId, outcome:delta.outcome, count:delta.count, cli:delta.cli});
        if (delta.kind === 'model_report') {
          const { model, effort, requestedEffort } = delta.report;
          usageHistory?.record('turn.model-report', { correlationId: body.traceId, model, effort: effort ?? (effort === null ? 'none' : undefined), requestedEffort,
            outcome: effort === undefined ? 'effort-unreported' : requestedEffort && effort !== requestedEffort ? 'effort-differs' : 'reported' });
        }
        if (delta.kind === 'tool_end') usageHistory?.record('turn.tool', { correlationId: body.traceId, outcome: delta.result?.ok ? 'ok' : 'error' });
        if (delta.kind === 'rate_limit') {
          usageHistory?.record('turn.rate-limit', { correlationId: body.traceId });
          providerLimits.set(session.model, { info: delta.info, at: Date.now() });
          if (usage) {
            usage.limits[session.model] = { info: delta.info, at: Date.now() };
            usageDirty = true;
          }
        }
        broadcast(id, { kind: 'delta', delta });
      },
    });
  })
    .catch(async (e) => {
      turnFailed = true;
      usageHistory?.record('turn.error', { correlationId: body.traceId });
      const event = noteEvent(e?.message ?? String(e), { outcome: 'error' });
      session.events.push(event);
      await store.save(session);
      broadcast(id, { kind: 'event', event });
    })
    .finally(async () => {
      beacons.stop(id);

      // A paused turn ends here. Refresh its checkpoint with the final steps and
      // say where it is, so the way back is in the transcript as well as on disk.
      const pausedHere = paused.get(id)?.interrupted && controller.signal.aborted;
      if (pausedHere && !turn.pauseRecorded) {
        turn.pauseRecorded = true; // a shutdown may already have recorded it
        await recordPause(id, session, body.traceId).catch(() => {}); // Resume rebuilds a missing checkpoint
      }
      if (turn.unsent?.length) {
        const event = unsentNote(turn.unsent);
        session.events.push(event);
        await store.save(session).catch(() => {});
        broadcast(id, { kind: 'event', event });
      }

      // Publishing is explicit: finishing a chat never updates the remote.
      if (prepared) {
        const pending = await tabHasUnpublishedWork(session).catch(() => true);
        // DO's own changes run on this computer as soon as a turn completes them.
        const testable = session.appId === HARNESS_APP_ID && !turnFailed && !controller.signal.aborted && !pausedHere;
        const loaded = !testable ? null : pending ? await builds.tabFinished(session, { traceId: body.traceId }) : await builds.tabDone(session);
        const event = noteEvent(turnEndNote(id, pending, loaded), { publication: 'pending' });
        session.events.push(event);
        // A note never reaches the next turn; this does, so the AI can fix what it broke.
        const problem = loaded?.error && { ...assistantEvent({ text: `These changes were not loaded, so this computer keeps running what it had. ${loaded.error}` }), operation: 'push' };
        if (problem) session.events.push(problem);
        await store.save(session);
        broadcast(id, { kind: 'event', event });
        if (problem) broadcast(id, { kind: 'event', event: problem });
      }

      // What this turn actually produced. Asking for a file and then
      // hunting for it is the thing this avoids: it is attached to the
      // reply that made it.
      try {
        const made = await filesChangedSince(session.tabWorkspace?.dir ?? session.projectDir, turn.startedAt, 30);
        if (made.length) {
          session.events.push({
            id: `f_${Date.now().toString(36)}`,
            ts: Date.now(),
            type: 'files',
            files: made,
          });
          await store.save(session);
          broadcast(id, { kind: 'event', event: session.events.at(-1) });
        }
      } catch { /* a scan failure must not affect the turn */ }

      if (session.turnHost) {
        delete session.turnHost;
        delete session.turnStartedAt;
        delete session.waitingFor;
        await store.save(session).catch(() => {});
      }
      running.delete(id);
      live.delete(id);
      broadcast(id, { kind: 'done' });
      restartForTestBuild();
      usageHistory?.record('turn.finished', { correlationId: body.traceId, outcome: pausedHere ? 'paused' : turnFailed ? 'error' : controller.signal.aborted ? 'cancelled' : 'completed', durationMs: Date.now() - turn.startedAt });
      collectUsage().catch(() => {}); // fold the turn in; never block the reply

      // Tell the user it finished. Deliberately after `done`, and never
      // awaited by anything that matters: a notifier is not allowed to
      // delay or break a turn.
      (async () => {
        const cfg = await notifyConfig();
        const seconds = (Date.now() - turn.startedAt) / 1000;
        if (!cfg.enabled || seconds < (cfg.minSeconds ?? 0)) return;

        const since = session.events.slice(sentAt);
        const last = [...since].reverse().find((e) => e.type === 'assistant' && e.text?.trim());
        const res = await sendNotify(cfg, summarise({
          sessionName: session.name,
          model: session.model,
          steps: since.filter((e) => e.type === 'tool_result').length,
          seconds,
          // From the turn's recorded result, never guessed from note wording.
          outcome: pausedHere ? 'paused' : turnFailed ? 'error' : controller.signal.aborted ? 'stopped' : 'completed',
          lastText: last?.text,
        }));
        if (!res.ok) {
          session.events.push(noteEvent(`notify: ${res.reason}`));
          await store.save(session);
          broadcast(id, { kind: 'event', event: session.events.at(-1) });
        }
      })().catch(() => {});
    }).catch((e) => {
      running.delete(id);
      live.delete(id);
      beacons.stop(id);
      usageHistory?.record('turn.error', { correlationId: body.traceId });
      broadcast(id, { kind: 'error', error: e?.message ?? String(e) });
      broadcast(id, { kind: 'done' });
    });
  return undefined;
}

async function joinHost(body) {
  if (running.size) throw new Error('Wait for this host’s running turns to finish before joining.');
  const correlationId = crypto.randomUUID(), started = Date.now();
  await recovery.trace('join.request', { correlationId });
  try {
    // Preserve the local registry in the pre-join archive, before any replacement.
    await snapshotSettings();
    const sessions = await Promise.all((await store.list()).map((s) => store.load(s.id, { repair: false })));
    for (const session of sessions) await clusterAssets.session(session, true);
    const values = Object.fromEntries(Object.entries(cluster.replica.state.values).filter(([id]) => id.startsWith('asset:')));
    const projects = (await apps.load(USER_DATA)).filter(a => !a.builtin);
    const result = await cluster.join(body, sessions, values, projects);
    await recovery.trace('join.imported', { correlationId, projects: projects.length, tabs: sessions.length, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    await recovery.trace('join.error', { correlationId, durationMs: Date.now() - started });
    throw error;
  }
}

// ------------------------------------------------------------------ routing

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  // Browsers must not use a malicious page to drive the owner's local API.
  // Cluster and CLI clients have no Origin; signed peers may proxy an original one.
  if (!cluster?.trusted(req) && pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
    let originHost;
    try { if (req.headers.origin) originHost = new URL(req.headers.origin).host; } catch { originHost = 'invalid'; }
    if ((originHost && originHost !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site')
      return json(res,403,{error:'Cross-origin mutation refused.'});
  }
  res.gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

  // Only minimal health is public, so an already-authorized browser can find
  // another host without leaking sessions or sharing a cluster credential.
  if (req.method === 'GET' && pathname === '/api/cluster/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return json(res, 200, { id: cluster?.replica.disk.clusterId, node: cluster?.self.id,
      ready: Boolean(cluster?.replica.writable()), leader: cluster?.replica.leader });
  }
  if (pathname === '/api/cluster/pairing') {
    try {
      if (req.method === 'GET') return json(res, 200, pairing.status());
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' });
      const body = await readBody(req, 2048);
      if (body.action === 'request') return json(res, 200, await pairing.announce(body.url));
      pairing.accept(body); // completes independently of browser lifetime
      return json(res, 202, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const invited = pathname === '/api/cluster/admit' && cluster?.validInvite(req.headers['x-harness-token']);
  if (!invited && !authorized(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<body style="background:#14161a;color:#d7dbe0;font:16px system-ui;padding:2rem">' +
      '<h2>Distributed Orchestrator</h2><p>This link needs its access token. Open the full URL printed on the laptop.</p></body>');
  }

  const requestStarted = Date.now();
  const requestId = /^[a-zA-Z0-9-]{1,100}$/.test(req.headers['x-harness-trace'] || '')
    ? req.headers['x-harness-trace'] : crypto.randomUUID();
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/diagnostics')) {
    const operation = pathname.match(/^\/api\/(?:sessions|apps)\/[^/]+\/([a-z-]+)$/)?.[1];
    const route = pathname.split('/').slice(1, 3).join('.') + (operation ? '.' + operation : '');
    res.once('finish', () => {
      const durationMs = Date.now() - requestStarted;
      // Routine replication heartbeats otherwise bury the user's interactions.
      if (pathname === '/api/cluster/rpc' && res.statusCode < 400 && durationMs < 1000) return;
      usageHistory?.record('request.finished', { correlationId: requestId,
        route, method: req.method, status: res.statusCode, durationMs });
    });
    res.once('close', () => { if (!res.writableFinished) usageHistory?.record('request.aborted', { correlationId: requestId, route }); });
  }
  if (pathname === '/api/diagnostics') {
    try {
      const target = url.searchParams.get('host');
      if (target && target !== cluster.self.id) {
        if (cluster.trusted(req)) return json(res, 400, { error: 'Diagnostics forwarding loop refused.' });
        if (!cluster.replica.members().some(h => h.id === target)) return json(res, 404, { error: 'Unknown computer.' });
        return cluster.proxy(req, res, target);
      }
      if (req.method === 'GET' && url.searchParams.get('action') === 'all') {
        const histories = await Promise.all(cluster.replica.members().map(async h => {
          try {
            if (h.id === cluster.self.id) return await usageHistory.run('events');
            const r = await fetch(new URL('/api/diagnostics?action=events', h.url), {
              headers: { 'x-cluster-key': cluster.replica.disk.secret }, signal: AbortSignal.timeout(5000), redirect: 'error' });
            if (!r.ok) throw Error('unavailable');
            const data = await r.json();
            if (data.host !== h.id) throw Error('identity mismatch');
            await usageHistory.record('peer.observed', { peer: h.id, observedRevision: data.revision });
            return data;
          } catch { return { host: h.id, unavailable: true }; }
        }));
        return json(res, 200, { histories });
      }
      if (req.method === 'GET') return json(res, 200, await usageHistory.run(url.searchParams.get('action') || 'status', { before: url.searchParams.get('before') }));
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required.' });
      const body = await readBody(req, 65536);
      if (body.action === 'append') {
        if (!Array.isArray(body.events) || body.events.length > 100) throw Error('Supply at most 100 events.');
        for (const event of body.events) await usageHistory.record('browser.' + (['action','visible','request','error','lifecycle'].includes(event.event) ? event.event : 'unknown'), event);
        return json(res, 200, { ok: true });
      }
      return json(res, 200, await usageHistory.run(body.action, body));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  // First hit carries ?t=; stow it in a cookie so later navigations are clean.
  if (url.searchParams.has('t')) {
    res.setHeader('Set-Cookie', `ht=${cluster?.verifyTicket(url.searchParams.get('t')) ? url.searchParams.get('t') : TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${req.headers['tailscale-user-login'] ? '; Secure' : ''}`);
  }

  try {
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/cluster/')
      && !pathname.startsWith('/api/network') && !pathname.endsWith('/stop')) {
      const network = await connectionStatus();
      if (!network.connected) return json(res, 503, { error: network.error, code: 'TAILSCALE_DISCONNECTED' });
    }
    if (pathname.startsWith('/api/cluster/')) {
      const route = pathname.slice('/api/cluster/'.length);
      const internal = ['rpc', 'command', 'activate', 'read-session', 'worker-save', 'worker-models', 'worker-help', 'model-secret', 'worker-stopped', 'worker-sources', 'worker-recovery', 'read-projects'];
      if (internal.includes(route) && !cluster.trusted(req)) return json(res, 403, { error: 'Cluster authentication required' });
      if (req.method === 'GET' && route === 'discover') return json(res, 200, await pairing.discover());
      if (req.method === 'GET' && route === 'status') return json(res, 200, cluster.status());
      if (req.method === 'GET' && route === 'devices') {
        const observed = await inventory();
        // This host's current Tailscale snapshot is authoritative. Merging
        // remembered snapshots from other hosts resurrects removed devices.
        return json(res, 200, observed);
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
      const body = await readBody(req, 500_000_000); // snapshots carry project checkpoints
      if (route === 'read-projects') return json(res, 200, { apps: await cluster.readProjects() });
      if (route === 'recovery' || route === 'worker-recovery') {
        try {
          const { host = cluster.self.id, ...request } = body;
          return json(res, 200, route === 'worker-recovery' || host === cluster.self.id
            ? await recovery.run(request) : await cluster.hostRecovery(host, request));
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (route === 'read-session') {
        if (!cluster.replica.writable()) return json(res, 503, { error: 'Coordinator unavailable.' });
        const session = cluster.replica.state.sessions[body.id];
        return json(res, 200, { session: session && body.metadata ? { ownerNode: session.ownerNode, executionEpoch: session.executionEpoch } : session || null });
      }
      if (route === 'worker-stopped') {
        const changed = await cluster.changeSession(body.id, current => {
          if (current?.ownerNode !== body.host) return undefined;
          return recoverStoppedTurn(current, { turnHost: body.host,
            turnStartedAt: body.turnStartedAt, executionEpoch: body.executionEpoch },
          noteEvent('This computer restarted or stopped the turn. Unfinished edits remain in this tab’s worktree; nothing was automatically published or replayed. Send a message here to resume.', { outcome: 'interrupted' }));
        });
        return json(res, 200, { recovered: Boolean(changed) });
      }
      if (route === 'worker-save') {
        try {
          await cluster.changeSession(body.session?.id, current => {
            if (current?.ownerNode !== body.host || body.session.ownerNode !== body.host)
              throw new Error('Tab ownership changed; this computer cannot save it.');
            const error = sessionWriteError(current, body.session);
            if (error) throw new Error(error);
            return body.session;
          });
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (route === 'model-secret') {
        if (!cluster.replica.writable()) return json(res, 503, { error: 'Coordinator unavailable.' });
        await restoreSettings();
        await setSecret(USER_DATA, body.alias, body.apiKey);
        await snapshotSettings();
        resetClients();
        return json(res, 200, { ok: true });
      }
      if (route === 'sources' || route === 'worker-sources') {
        try {
          const { host = cluster.self.id, ...request } = body;
          const result = route === 'worker-sources' || host === cluster.self.id
            ? await sourceAction(request) : await cluster.hostSources(host, request);
          return json(res, 200, result);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (route === 'worker-help') return json(res, 200, await machineHelp(await loadConfig(USER_DATA), cluster.self, body));
      if (route === 'worker-models') {
        const cfg = await loadConfig(USER_DATA);
        return json(res, 200, await modelInventory(cfg));
      }
      if (route === 'request-join') return json(res, 200, await pairing.requestJoin(body.url));
      if (route === 'approve-host') return json(res, 200, await pairing.approve(body.url));
      if (route === 'cancel-join') return json(res, 200, pairing.cancel());
      if (route === 'invite') return json(res, 200, cluster.invite());
      if (route === 'rpc') return json(res, 200, await cluster.replica.receive(body));
      if (route === 'command') { await cluster.replica.propose(body); return json(res, 200, { ok: true }); }
      if (route === 'viewer') return json(res, 200, await cluster.viewer(body, req.headers['user-agent'] || '', viewerAddress(req)));
      if (route === 'name') {
        if (!cluster.replica.members().some((n) => n.id === body.id)) return json(res, 400, { error: 'Unknown host' });
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) return json(res, 400, { error: 'Use a computer name between 1 and 100 characters.' });
        await cluster.command({ type: 'value', id: 'machine-name:' + body.id, value: name });
        return json(res, 200, { ok: true });
      }
      if (route === 'preferred') {
        if (!cluster.replica.members().some((n) => n.id === body.id)) return json(res, 400, { error: 'Unknown host' });
        await cluster.command({ type: 'preferred', id: body.id }); return json(res, 200, { ok: true });
      }
      if (route === 'admit') {
        if (body.projectImportVersion !== 1) return json(res, 409, { error: 'Update and restart Harness on the joining computer before joining, so its projects are preserved.' });
        if (invited && !cluster.validInvite(req.headers['x-harness-token'])) return json(res, 403, { error: 'Approval expired or was already used.' });
        if (invited && !cluster.matchesInvite(body.member)) return json(res, 403, { error: 'Approval belongs to a different host.' });
        if (invited) cluster.consumeInvite(); // reserve before any asynchronous snapshot work
        if (!TOKEN && !invited) return json(res, 403, { error: 'Create a join code on the existing main host first.' });
        if (!cluster.shared()) {
          for (const meta of await store.list()) {
            const session = await store.load(meta.id, { repair: false });
            session.ownerNode = cluster.self.id;
            await clusterAssets.session(session, true);
            await store.save(session);
            await cluster.command({ type: 'session', id: session.id, value: { ...session, ownerNode: cluster.self.id } });
          }
        }
        await snapshotSettings();
        const snapshot = await cluster.admit(body.member);
        return json(res, 200, snapshot);
      }
      if (route === 'activate') { await cluster.activate(body.member); return json(res, 200, { ok: true }); }
      if (route === 'join') {
        if (running.size) return json(res, 409, { error: 'Wait for this host’s running turns to finish before joining.' });
        return json(res, 200, await joinHost(body));
      }
      return json(res, 404, { error: 'Unknown cluster operation' });
    }
    // Session traffic goes to its owner, regardless of which browser host received it.
    // The coordinator supplies authoritative ownership; proxies never retry a mutation.
    let workerRequest = false;
    if (cluster.shared()) {
      const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(\w+))?$/);
      const scoped = /^\/api\/(git|files|file|dirs|models)(?:[/?]|$)/.test(pathname);
      const sessionId = sessionRoute?.[1] || (scoped && (url.searchParams.get('session') || req.headers['x-harness-session']));
      if (sessionId && sessionRoute?.[2] !== 'machine') {
        const session = await cluster.readSession(sessionId);
        if (!session) return json(res, 404, { error: 'Session not found' });
        const owner = executionOwner(session, null, cluster.replica.leader);
        if (owner !== cluster.self.id) {
          if (req.method === 'GET' && sessionRoute && !sessionRoute[2] && !cluster.status().hosts.some(h => h.id === owner && h.active))
            return json(res, 200, { ...session, ownerOffline: true });
          if (req.headers['x-harness-worker'] && cluster.trusted(req)) return json(res, 409, { error: 'Tab owner changed. Refresh before retrying.' });
          return cluster.proxy(req, res, owner, req.method === 'GET' && sessionRoute && !sessionRoute[2] ? () => json(res, 200, { ...session, ownerOffline: true }) : undefined);
        }
        workerRequest = true;
      }
    }
    if (cluster.shared() && pathname.startsWith('/api/') &&
        !/^\/api\/(network|node-info|nodes|harness|models)(?:[/?]|$)/.test(pathname)) {
      if (!workerRequest && cluster.replica.role !== 'leader') {
        if (cluster.trusted(req)) return json(res, 503, { error: 'Coordinator changed. Refresh before retrying.' });
        return cluster.proxy(req, res);
      }
      if (!workerRequest && !cluster.replica.writable()) return json(res, 503, { error: 'Waiting for coordinator quorum.' });
      await restoreSettings();
      res.syncSettings = !workerRequest && req.method !== 'GET' && /^\/api\/(models|apps|github)(?:[/?]|$)/.test(pathname);
    }
    if (req.method === 'GET' && pathname === '/api/node-info') {
      return json(res, 200, { protocol: 1, name: process.env.ORCHESTRATOR_NODE_NAME || os.hostname(),
        platform: process.platform, authenticated: Boolean(TOKEN), storage: 'node-owned' });
    }
    if (pathname === '/api/nodes' || pathname.startsWith('/api/nodes/')) {
      // Nothing can be connected without a token, so there is nothing to list.
      if (!TOKEN && pathname === '/api/nodes' && req.method === 'GET') return json(res, 200, []);
      if (!TOKEN) return json(res, 403, { error: 'Set HARNESS_TOKEN=auto and restart before connecting machines.' });
      if (pathname === '/api/nodes' && req.method === 'GET') return json(res, 200, await nodes.catalog());
      if (pathname === '/api/nodes' && req.method === 'POST') {
        try { return json(res, 201, await nodes.add(await readBody(req))); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      const remote = pathname.match(/^\/api\/nodes\/([a-f0-9-]+)(\/api\/.*)?$/);
      if (!remote) return json(res, 404, { error: 'Unknown node route' });
      if (remote[2]) return await nodes.proxy(req, res, remote[1], remote[2] + url.search);
      if (req.method === 'DELETE') { await nodes.remove(remote[1]); return json(res, 200, { ok: true }); }
      return json(res, 405, { error: 'Method not allowed' });
    }

    // ---- static
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && pathname === '/test-build') return testBuildPage(res);
    if (req.method === 'GET' && /^\/(app-preview\.html|app-preview\.js|app-preview\.css|app\.js|diagnostics\.js|voice\.js|cluster-client\.js|sw\.js|styles\.css)$/.test(pathname)) {
      return serveStatic(res, pathname.slice(1));
    }

    // Jev keys stay in the shared secret store; callers only receive results.
    if (pathname === '/api/jev' && req.method === 'GET') {
      return json(res, 200, { configured: Boolean((await loadSecrets(USER_DATA)).__jev) });
    }
    if (pathname === '/api/jev' && ['PUT', 'DELETE'].includes(req.method)) {
      const body = req.method === 'PUT' ? await readBody(req) : {};
      if (req.method === 'PUT' && (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 4096 || /[\r\n]/.test(body.apiKey)))
        return json(res, 400, { error: 'Enter a valid TypeSafe API key.' });
      await saveModelSecret('__jev', req.method === 'PUT' ? body.apiKey.trim() : '');
      return json(res, 200, { configured: req.method === 'PUT' });
    }
    if (pathname === '/api/jev/evaluate' && req.method === 'POST') {
      const key = (await loadSecrets(USER_DATA)).__jev;
      if (!key) return json(res, 400, { error: 'Add a key in Settings → Jev · TypeSafe first.' });
      const body = await readBody(req);
      if (body.state == null || !body.questions || typeof body.questions !== 'object' || Array.isArray(body.questions)
        || !Object.keys(body.questions).length || (body.model !== undefined && typeof body.model !== 'string'))
        return json(res, 400, { error: 'Supply state and a nonempty questions map; model is optional.' });
      try {
        const upstream = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: body.state, questions: body.questions, model: body.model || 'jev-latest' }),
        });
        if (!upstream.ok) return json(res, upstream.status, { error: `Jev returned HTTP ${upstream.status}. Check your key, question format, or account limits.` });
        const result = await upstream.json();
        return json(res, 200, { model: result.model, answers: result.answers, usage: result.usage });
      } catch { return json(res, 502, { error: 'Jev could not be reached or returned an invalid response. No automatic retry was made.' }); }
    }

    // Voice uses the same access control as the rest of the chat.
    if (req.method === 'GET' && pathname === '/api/transcription') {
      return json(res, 200, { configured: Boolean(await transcriptionKey(USER_DATA)) });
    }
    if (req.method === 'POST' && pathname === '/api/transcription') {
      try {
        return json(res, 200, await transcribe(req, await transcriptionKey(USER_DATA)));
      } catch (e) {
        return json(res, e.status || 500, { error: e.status ? e.message : 'Transcription failed. Please retry.' });
      }
    }

    // ---- state
    if (req.method === 'GET' && pathname === '/api/network') {
      return json(res, 200, await connectionStatus());
    }
    if (req.method === 'POST' && pathname === '/api/network/setup') {
      // JSON requests from our settings UI; reject cross-origin form posts.
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
      const n = await setupPhoneAccess(PORT);
      if (n.phoneUrl) await cluster.setUrl(n.phoneUrl).catch(() => {});
      return json(res, 200, n);
    }

    if (req.method === 'POST' && pathname === '/api/machine-help') {
      const { host, ...request } = await readBody(req);
      const result = host === cluster.self.id
        ? await machineHelp(await loadConfig(USER_DATA), cluster.self, request)
        : await cluster.hostHelp(host, request);
      return json(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/execution-models') {
      const app = (await apps.load(USER_DATA)).find(a => a.id === url.searchParams.get('app'));
      const host = url.searchParams.get('host') || cluster.self.id;
      if (!executionHosts(app, cluster.replica.members(), cluster.self.id).includes(host))
        return json(res, 403, { error: 'This computer is not enabled for the project.' });
      if (host !== cluster.self.id) return json(res, 200, await cluster.hostModels(host));
      const cfg = await loadConfig(USER_DATA);
      return json(res, 200, await modelInventory(cfg));
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const cfg = await loadConfig(USER_DATA);
      const models = Object.fromEntries(
        Object.entries(cfg.models).map(([k, m]) => [k, { ...m, apiKey: undefined }]), // never ship keys back
      );
      return json(res, 200, {
        models,
        harnessUpdate,
        default: cfg.default,
        machines: cluster.status(),
        apps: (await apps.load(USER_DATA)).map(app => ({ id: app.id, name: app.name, dir:app.dir, ownerNode:app.ownerNode, builtin:app.builtin, runtimeKnown:false,
          executionHosts: executionHosts(app, cluster.replica.members(), cluster.self.id) })),
        error: cfg.error,
        // Chats left by the old monitoring tab stay hidden.
        sessions: (await store.list()).filter((x) => !x.id.endsWith('--monitor')),
        home: os.homedir(),
        running: [...new Set([...running.keys(), ...Object.values(cluster.replica.state.sessions).filter(s => s.turnHost).map(s => s.id)])],
        // Turns stopped on a permission or question for you: the coordinator's
        // own, and other computers' from their replicated sessions.
        waiting: [...new Set([...interactions.keys(), ...Object.values(cluster.replica.state.sessions).filter(s => s.turnHost && s.waitingFor).map(s => s.id)])],
        // Elapsed time belongs to the turn, not to whoever happens to be
        // watching: a phone that reloads must not restart the clock at zero.
        turns: { ...Object.fromEntries(Object.values(cluster.replica.state.sessions).filter(s => s.turnHost).map(s => [s.id, { startedAt: s.turnStartedAt }])), ...Object.fromEntries(
          [...running.entries()].map(([k, v]) => [k, { startedAt: v.startedAt }]),
        ) },
        // Liveness, not just "is it running": a turn can be running and stuck.
        beacons: Object.fromEntries(beacons.all().map((b) => [b.sessionId, b])),
      });
    }

    // ---- model config, editable from the phone
    if (req.method === 'GET' && pathname === '/api/models/catalog') {
      const cfg = await loadConfig(USER_DATA);
      return json(res, 200, await modelInventory(cfg));
    }
    if (req.method === 'POST' && pathname === '/api/models/key') {
      const { alias, apiKey } = await readBody(req);
      await saveModelSecret(alias, apiKey);
      resetClients();
      return json(res, 200, { ok: true });
    }
    // Ask an endpoint what it actually serves. Model ids move faster than
    // anyone's memory, so the authoritative list comes from the provider.
    if (req.method === 'POST' && pathname === '/api/models/discover') {
      const { alias } = await readBody(req);
      const cfg = await loadConfig(USER_DATA);
      const spec = cfg.models[alias];
      if (!spec) return json(res, 404, { error: `no model "${alias}"` });
      if (spec.provider !== 'openai') {
        return json(res, 400, { error: 'only OpenAI-compatible endpoints can be queried' });
      }

      const base = (spec.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      try {
        const upstream = await fetch(`${base}/models`, {
          headers: spec.apiKey ? { Authorization: `Bearer ${spec.apiKey}` } : {},
          signal: AbortSignal.timeout(15_000),
        });
        const body = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return json(res, 200, {
            ok: false,
            status: upstream.status,
            error: body?.error?.message ?? `endpoint returned ${upstream.status}`,
          });
        }
        const ids = (body.data ?? []).map((m) => m.id).sort();
        return json(res, 200, { ok: true, base, count: ids.length, models: ids });
      } catch (e) {
        return json(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    if (req.method === 'POST' && pathname === '/api/models/add') {
      const body = await readBody(req);
      try {
        const alias = await addModel(USER_DATA, body);
        if (body.apiKey) await saveModelSecret(alias, body.apiKey);
        resetClients();
        return json(res, 200, { alias });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/models/patch') {
      const { alias, patch } = await readBody(req);
      const block = await patchModel(USER_DATA, alias, patch);
      resetClients();
      return json(res, 200, { ok: true, block });
    }

    // ---- directory browsing (no native file dialog on a phone)
    if (req.method === 'GET' && pathname === '/api/dirs') {
      const asked = url.searchParams.get('path') || os.homedir();

      // A directory can be renamed or deleted out from under a saved path. Walk
      // up to the nearest place that still exists rather than failing: a broken
      // path should never be able to wedge the browser.
      let dir = path.resolve(asked);
      let note = null;
      while (dir !== path.dirname(dir)) {
        try {
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch {
          // keep walking up
        }
        dir = path.dirname(dir);
      }
      if (dir !== path.resolve(asked)) note = `${asked} no longer exists — showing ${dir}`;

      if (insidePath(canonicalPath(USER_DATA), canonicalPath(dir))) return json(res,403,{error:'Harness private data cannot be browsed.'});
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return json(res, 200, {
        path: dir,
        note,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs: entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // ---- apps: the durable things sessions attach to
    const appMatch = pathname.match(/^\/api\/apps(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (appMatch) {
      const [, appId, verb] = appMatch;
      if (cluster.shared() && appId && req.method !== 'GET') {
        const app = (await apps.load(USER_DATA)).find((item) => item.id === appId);
        if (verb && app?.ownerNode && app.ownerNode !== cluster.self.id) return json(res, 409, {
          error: `This app’s processes run on ${cluster.replica.state.history[app.ownerNode]?.name || 'another host'}. Make that machine main to start or stop it.`,
        });
      }

      if (req.method === 'GET' && !appId) {
        // Visibility is not shown in the list (it lives in each app's edit
        // sheet, fetched on demand), so the list does not pay for a gh call
        // per app — that was making the sheet slow to open.
        const list = await apps.listWithStatus(USER_DATA, cluster.self.id);
        if (cluster.shared()) for (const app of list) if (!app.builtin) app.machines = placement.describe(app);
        return json(res, 200, { apps: list });
      }
      if (req.method === 'POST' && !appId) {
        const body = await readBody(req);
        try {
          const cfg = await loadConfig(USER_DATA);
          if (!cfg.default) return json(res, 400, { error: 'Add an AI source before creating a project.' });
          const placed = cluster.shared() && body.hosts !== undefined ? replicationHosts(body.hosts, cluster.replica.members(), cluster.self.id) : null;
          const app = await apps.create(USER_DATA, { ...body, hosts: placed,
            ownerNode: undefined });
          const session = store.newSession({
            name: 'Tab 1', model: cfg.default, projectDir: app.dir, appId: app.id,
          });
          if (cfg.defaultEffort) session.effort = cfg.defaultEffort;
          await store.save(session);
          return json(res, 200, { ...app, sessionId: session.id });
        }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'PATCH' && appId) {
        try {
          const patch = await readBody(req);
          const fields = new Set(['name','dir','repo','start','hosts','port','servePort','aiDependencies']);
          if (!patch || Array.isArray(patch) || Object.keys(patch).some(key => !fields.has(key))) throw new Error('Unsupported project setting.');
          for (const key of ['name','dir','start']) if (patch[key] !== undefined && typeof patch[key] !== 'string') throw new Error(`Invalid ${key}.`);
          if (patch.hosts !== undefined) {
            if (!cluster.shared()) throw new Error('Join another machine before choosing where this project lives.');
            const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
            if (!app) throw new Error('no such app');
            patch.hosts = replicationHosts(patch.hosts, cluster.replica.members(), app.ownerNode || app.hosts?.[0] || cluster.self.id);
            if (Object.values(cluster.replica.state.sessions).some(s => s.appId === appId && !patch.hosts.includes(executionOwner(s, app, cluster.self.id))))
              throw new Error('This computer still owns project tabs. Keep it enabled until those tabs are removed.');
          }
          // Every host notices the replicated change and reconciles its copy.
          return json(res, 200, await apps.update(USER_DATA, appId, patch));
        }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'DELETE' && appId) {
        // Folder, sessions, and GitHub deletion are independent opt-in choices.
        // Validate and complete GitHub deletion before removing local records.
        const wantFiles = url.searchParams.get('files') === '1';
        const wantSessions = url.searchParams.get('sessions') === '1';

        const target = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!target || target.builtin) return json(res, 400, { error: 'This project cannot be deleted.' });
        if (url.searchParams.get('github') === '1' &&
            (await store.list()).some((s) => s.appId === appId && running.has(s.id))) {
          return json(res, 409, { error: 'Stop this project’s active sessions before deleting its GitHub repository.' });
        }
        let deletedRepo = null;
        if (url.searchParams.get('github') === '1') {
          try {
            const body = await readBody(req);
            deletedRepo = await git.deleteAppRepo(target, body.confirmRepository);
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        const attached = (await store.list()).filter((m) => m.appId === appId);
        const removedSessions = [];
        for (const meta of attached) {
          if (wantSessions) {
            running.get(meta.id)?.controller.abort();
            live.delete(meta.id);
            await store.remove(meta.id);
            // Also clears any chat the old monitoring tab left for this session.
            await store.remove(`${meta.id}--monitor`).catch(() => {});
            removedSessions.push(meta.name);
          } else {
            // Sessions outlive the app record; they simply come unattached.
            const sn = await store.load(meta.id, { repair: false }).catch(() => null);
            if (sn) { sn.appId = null; await store.save(sn); }
          }
        }

        try {
          const done = await apps.destroy(USER_DATA, appId, { files: wantFiles });
          return json(res, 200, { ...done, deletedRepo, removedSessions, apps: await apps.load(USER_DATA) });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (req.method === 'POST' && appId && verb === 'start') {
        try {
          const app = (await apps.load(USER_DATA)).find(a => a.id === appId);
          if (!app) throw new Error('No such app');
          const inventory = await modelInventory(await loadConfig(USER_DATA));
          const dependencies = runtimeAI(app.aiDependencies || [], cluster.self.id, inventory.models);
          const r = await apps.start(USER_DATA, appId, { ai: dependencies });
          return json(res, 200, { ...r, urls: apps.urlsFor(r.app, await apps.tailnetHost()) });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && appId && verb === 'stop') {
        try { return json(res, 200, await apps.stop(USER_DATA, appId)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && appId && verb === 'git') {
        const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!app) return json(res, 404, { error: 'no such app' });
        return json(res, 200, await git.visibility(app.dir));
      }
      if (req.method === 'POST' && appId && verb === 'visibility') {
        const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!app) return json(res, 404, { error: 'no such app' });
        const { visibility } = await readBody(req);
        return json(res, 200, await git.setVisibility(app.dir, visibility));
      }
      if (req.method === 'GET' && appId && verb === 'log') {
        const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!app) return json(res, 404, { error: 'no such app' });
        const text = await fs.readFile(apps.logPath(USER_DATA, app), 'utf8').catch(() => '');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text.slice(-40_000));
      }
    }

    // ---- outbound email, available to every session as a tool
    if (req.method === 'GET' && pathname === '/api/email') {
      const cfg = await loadEmailConfig(USER_DATA);
      // The key itself never leaves the machine; only whether there is one.
      return json(res, 200, { enabled: cfg.enabled, to: cfg.to, from: cfg.from, hasKey: Boolean(cfg.apiKey) });
    }
    if (req.method === 'POST' && pathname === '/api/email') {
      const { enabled, to, from, apiKey, gmailUser, gmailPass, carrier } = await readBody(req);
      if (enabled !== undefined && typeof enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
      const cfg = await saveEmailConfig(USER_DATA, { enabled, to, from, apiKey, gmailUser, gmailPass, carrier });
      return json(res, 200, { enabled: cfg.enabled, to: cfg.to, from: cfg.from, hasKey: Boolean(cfg.apiKey) });
    }
    // ---- restart the harness to apply edits made to its own source
    // A harness-editing session changes files, but the running process keeps
    // the old code until it restarts. Without this, every self-edit looks
    // broken: new endpoints 404, new UI never appears.
    if (['/api/harness/status', '/api/harness/restart'].includes(pathname) && url.searchParams.has('host')) {
      const target = url.searchParams.get('host');
      if (!cluster.replica.members().some(host => host.id === target)) return json(res, 404, { error: 'Unknown machine' });
      if (target !== cluster.self.id) {
        if (cluster.trusted(req)) return json(res, 409, { error: 'Machine identity changed' });
        return cluster.proxy(req, res, target);
      }
    }
    if (req.method === 'GET' && pathname === '/api/harness/status') {
      return json(res, 200, { instanceId, restartId: process.env.ORCHESTRATOR_RESTART_ID || null,
        node: cluster.self.id, pid: process.pid, busy: Boolean(running.size || messageQueue.size), restarting,
        version: loadedVersion, update: harnessUpdate, ui: uiTree, label: servingLabel(), title: servingTitle() });
    }
    if (req.method === 'GET' && pathname === '/api/harness/test-build') {
      return json(res, 200, { ...await builds.status(), node: cluster.self.id, label: servingLabel(), running: loadedVersion.testing, number: loadedVersion.number });
    }
    if (req.method === 'POST' && pathname === '/api/harness/test-build/stop') {
      if (!builds.enabled) return json(res, 409, { error: 'This DO cannot run test builds.' });
      const result = await builds.stop();
      usageHistory?.record('test-build.stop', { correlationId: requestId, outcome: result?.waiting ? 'restart' : 'swapped' });
      restartForTestBuild();
      return json(res, 200, { ok: true, restarting: Boolean(result?.waiting) });
    }
    if (req.method === 'GET' && pathname === '/api/harness/versions') {
      return json(res, 200, await readVersionMetadata({ node: cluster.self.id, version: loadedVersion, update: harnessUpdate, busy: Boolean(running.size || messageQueue.size), restarting }));
    }
    if (req.method === 'POST' && pathname === '/api/harness/restart') {
      if (restarting) return json(res, 409, { error: 'A restart is already in progress.' });
      if (running.size || messageQueue.size) {
        return json(res, 409, { error: 'A turn or queued message is still running — wait for it to finish, then restart.' });
      }
      const targetRevision = req.headers['x-harness-revision'];
      if (targetRevision) {
        const head = await git.run(['rev-parse', 'HEAD'], harnessDir);
        const dirty = await git.run(['status', '--porcelain'], harnessDir);
        if (!head.ok || head.out !== targetRevision || !dirty.ok || dirty.out)
          return json(res, 409, { error: 'Checkout changed; waiting for the expected clean published commit.' });
      }
      restarting = true;
      try {
        // Restart only the addressed machine; the browser chooses each host.
        const { restartId, revision } = await launchReplacement({ targetRevision });
        await json(res, 200, { ok: true, restarting: true, instanceId, restartId, node: cluster.self.id, revision });
        setTimeout(() => shutdown('restart'), 400);
      } catch (error) {
        restarting = false;
        return json(res, 500, { error: `Could not restart: ${error.message}` });
      }
      return undefined;
    }

    if (req.method === 'POST' && pathname === '/api/email/test') {
      try {
        const cfg = await loadEmailConfig(USER_DATA);
        const sent = await sendEmail(cfg, {
          subject: 'harness test',
          text: 'This is the harness checking it can reach you. Every session can send mail this way.',
        });
        return json(res, 200, { ok: true, ...sent });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/notify') {
      {
        const n = await loadNotify(USER_DATA);
        const e = await loadEmailConfig(USER_DATA).catch(() => ({}));
        // The password itself never leaves the machine; only whether one exists.
        return json(res, 200, {
          ...n, gmailUser: e.gmailUser ?? null, carrier: e.carrier ?? null, hasGmailPass: Boolean(e.gmailPass),
        });
      }
    }
    if (req.method === 'POST' && pathname === '/api/notify') {
      const body = await readBody(req);
      const problem = notificationSetupError(await notifyConfig(body));
      if (problem) return json(res, 400, { error: problem });
      const cfg = await saveNotify(USER_DATA, { ...(await loadNotify(USER_DATA)), ...body });
      return json(res, 200, cfg);
    }
    if (req.method === 'POST' && pathname === '/api/notify/test') {
      const cfg = await notifyConfig({ ...(await readBody(req)), enabled: true });
      return json(res, 200, await sendNotify(cfg, 'Distributed Orchestrator test — notifications are working.'));
    }

    // GitHub credentials are global; repository visibility remains session-specific.
    if (pathname === '/api/github' && req.method === 'GET') return json(res, 200, await github.status());
    if (pathname === '/api/github/login' && req.method === 'POST') return json(res, 200, await github.start());
    if (pathname === '/api/github/login' && req.method === 'GET') return json(res, 200, github.progress());
    if (pathname === '/api/github/finish' && req.method === 'POST') return json(res, 200, await github.finish());

    // ---- git
    if (req.method === 'GET' && pathname === '/api/git') {
      const id = url.searchParams.get('session');
      const session = id ? (live.get(id) ?? (await store.load(id, { repair: false }).catch(() => null))) : null;
      if (!session) return json(res, 404, { error: 'no such session' });
      const history = [];
      for (const entry of url.searchParams.get('history') === '1' ? await store.list() : []) {
        const saved = await store.load(entry.id, { repair: false }).catch(() => null);
        if (!saved || (session.appId ? saved.appId !== session.appId : saved.projectDir !== session.projectDir)) continue;
        for (const event of saved.events || []) if (event.pushReceipt) history.push({ ...event.pushReceipt, ts: event.ts, session: saved.name });
      }
      const app = session.appId ? (await apps.load(USER_DATA)).find(a => a.id === session.appId) : null;
      return json(res, 200, { ...(await git.status(session.tabWorkspace?.dir ?? session.projectDir)),
        projectName: app?.name || path.basename(session.projectDir),
        createRepository: Boolean(app && !app.builtin), repositoryName: git.defaultRepoName(session.projectDir, app?.name),
        isolated: Boolean(session.tabWorkspace), enabled: false,
        summary: url.searchParams.get('history') === '1' ? await pendingSummary(session) : undefined,
        publication: await readPublication(session),
        pending: await tabHasUnpublishedWork(session), machine: cluster.self.name || cluster.self.id,
        testing: session.appId === HARNESS_APP_ID && builds.enabled ? { ...await builds.tabStatus(id), running: Boolean(loadedVersion.testing?.tabs.some(tab => tab.session === id)) } : null,
        busy: running.has(id), history: history.sort((a, b) => b.ts - a.ts).slice(0, 12) });
    }

    // Runs a tab's changes now, for when its last turn was stopped or failed.
    if (req.method === 'POST' && pathname === '/api/git/test') {
      const { session: id } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      if (!builds.enabled || session.appId !== HARNESS_APP_ID) return json(res, 409, { error: 'Only DO tabs can be tested live.' });
      if (running.has(id) || messageQueue.busy(id)) return json(res, 409, { error: 'Wait for this tab to finish first.' });
      if (!session.tabWorkspace || !await tabHasUnpublishedWork(session).catch(() => false)) return json(res, 409, { error: 'This tab has no unpushed changes to test.' });
      const result = await builds.tabFinished(session, { traceId: requestId });
      if (result?.error) return json(res, 409, { error: result.error });
      restartForTestBuild();
      return json(res, 200, { ok: true, restarting: Boolean(result?.waiting), conflict: result?.conflict || null });
    }

    // Removes a tab's unpushed work. It is saved under refs/harness/discarded first.
    if (req.method === 'POST' && pathname === '/api/git/discard') {
      const { session: id } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      if (running.has(id) || messageQueue.busy(id)) return json(res, 409, { error: 'Wait for the tab and queued messages to finish before discarding.' });
      if (!session.tabWorkspace) return json(res, 409, { error: 'This tab has no changes to discard.' });
      const result = await discardTab(session);
      for (const event of [{ ...userEvent('Discard changes'), operation: 'push' },
        { ...assistantEvent({ text: `Discarded · ${result.files} file${result.files === 1 ? '' : 's'} removed from this tab, which now matches the published version.` }), operation: 'push', outcome: 'success' }]) {
        session.events.push(event);
        await store.save(session);
        broadcast(id, { kind: 'event', event });
      }
      const loaded = await builds.tabDone(session);
      usageHistory?.record('test-build.discard', { correlationId: requestId, outcome: loaded?.waiting ? 'restart' : 'swapped', count: result.files });
      restartForTestBuild();
      return json(res, 200, { ok: true, files: result.files, restarting: Boolean(loaded?.waiting) });
    }

    if (req.method === 'POST' && pathname === '/api/git/connect') {
      const { session: id, remote } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const res2 = await git.connect(session.projectDir, remote);
      return json(res, res2.ok ? 200 : 400, res2);
    }

    if (req.method === 'POST' && pathname === '/api/git/visibility') {
      const { session: id, visibility } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const res2 = visibility
        ? await git.setVisibility(session.projectDir, visibility)
        : await git.visibility(session.projectDir);
      return json(res, 200, res2);
    }

    if (req.method === 'POST' && ['/api/git/push', '/api/git/merge'].includes(pathname)) {
      const mergeOnly = pathname === '/api/git/merge';
      const { session: id, visibility = 'private' } = await readBody(req);
      if (!['private', 'public'].includes(visibility)) return json(res, 400, { error: 'Choose private or public visibility.' });
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      if (running.has(id) || messageQueue.busy(id)) return json(res, 409, { error: 'Wait for the tab and queued messages to finish before integrating.' });
      if (!session.tabWorkspace) return json(res, 409, { error: 'Start an isolated coding turn before integrating changes.' });
      const startedAt = Date.now();
      let publicationResult = null;
      running.set(id, { controller: new AbortController(), startedAt, executionEpoch: session.executionEpoch || 0 });
      live.set(id, session);
      try {
        if (cluster.shared()) {
          session.turnHost = cluster.self.id;
          session.turnStartedAt = startedAt;
          await store.save(session);
        }
        const announce = async event => {
          session.events.push(event);
          await store.save(session);
          broadcast(id, { kind: 'event', event });
        };
        await announce({ ...userEvent(mergeOnly ? 'Merge latest changes into this tab' : 'Push changes'), operation: 'push' });
        broadcast(id, { kind: 'started', startedAt });
        await announce(noteEvent(mergeOnly ? 'Merge in progress · fetching latest changes.' : 'Push in progress · preparing changes.', { publication: 'pushing' }));
        usageHistory?.record(mergeOnly ? 'merge.started' : 'push.started', { correlationId: requestId });
        const app = session.appId ? (await apps.load(USER_DATA)).find(a => a.id === session.appId) : null;
        let repairAttempts = 0;
        const repair = async ({ target, reason, conflicts, log }) => {
          if (repairAttempts++ >= 2) throw Error('Automatic repair limit reached; work is saved in this tab.');
          const cfg = await loadConfig(USER_DATA);
          await announce(noteEvent(`${reason === 'checks-failed' ? 'Checks failed' : 'Merge conflict'} · attempting AI repair in this tab.`, { publication: 'pushing' }));
          usageHistory?.record('integration.repair', { correlationId: requestId, outcome: reason, count: repairAttempts });
          const previousMode = session.mode;
          session.mode = 'agent';
          try {
            await runTurn({ session, models: cfg.models,
              userText: `${reason === 'checks-failed' ? `Repair the failing integration checks; read ${log}.` : 'Resolve the merge conflict.'} Integrate commit ${target} in this isolated tab worktree. Conflicted files: ${conflicts}.
Preserve both branches' intended behavior. Merge and commit the resolution on the current tab branch. Do not push, switch branches, modify other worktrees, weaken tests, or alter integration checks. Run the existing checks. If intent is ambiguous or repair cannot be verified, leave work saved and explain the blocker.`,
              requestInteraction: (request, signal) => requestInteraction(id, request, signal),
              attachments: [], signal: AbortSignal.any([running.get(id).controller.signal, AbortSignal.timeout(300000)]),
              save: s => store.save(s), onEvent: event => broadcast(id, {kind:'event', event}),
              onDelta: delta => broadcast(id, {kind:'delta', delta}) });
          } finally { session.mode = previousMode; }
        };
        const result = await (mergeOnly ? mergeTab : integrateTab)(session, {
          repair,
          distributed: (await sessionPlacement(session)).distributed,
          beforePublish: async () => {
            await requireConnection();
            await announce(noteEvent('Checks passed · publishing to GitHub.', { publication: 'pushing' }));
          },
          retryPush: true,
          versionBump: !mergeOnly && Boolean(app?.builtin),
          autoCreatePrivate: Boolean(app && !app.builtin),
          appName: app?.name,
          aiDependencies: app && !app.builtin ? app.aiDependencies || [] : undefined,
          visibility,
          signal: running.get(id).controller.signal,
          onCheck: async () => {
            await announce(noteEvent(`${mergeOnly ? 'Merge' : 'Push'} in progress · running project checks.`, { publication: 'pushing' }));
          },
          push: true,
        });
        if (result.pushed) publicationResult = result.publication || {state:'published', candidate:result.sha};
        if (!result.ok || (!mergeOnly && !result.pushed && result.skipped !== 'no changes'))
          throw new Error(result.error || result.reason || 'Publication did not finish.');
        if (app && !app.builtin && result.created) {
          const linked = await git.status(session.projectDir);
          if (linked.remote) await apps.update(USER_DATA, app.id, { repo: linked.remote });
        }
        const published = result.version || result.sha;
        const note = noteEvent(mergeOnly ? 'Merged into this tab; nothing published.' : result.pushed ? `Published to GitHub · ${published}` : 'Already published; no new changes.', {
          sha: result.sha, commitUrl: result.commitUrl, publication: mergeOnly ? 'merged' : 'published',
          pushReceipt: { machine: cluster.self.name || cluster.self.id, status: mergeOnly ? 'Merged locally' : result.pushed ? 'Published' : 'No changes', sha: result.sha, version: result.version, files: result.files?.length || 0 },
        });
        await announce(note);
        // Published changes are already what this computer runs; take them off the test build.
        const loaded = !mergeOnly && app?.builtin ? await builds.tabDone(session, { published: true }) : null;
        const afterPush = !app?.builtin ? '' : !builds.enabled ? ' Restart Harness to load the changes.'
          : `${loaded?.waiting ? ' DO restarts to finish loading it.' : ''}${cluster.shared() ? ' Other computers pick it up automatically.' : ''}`;
        await announce({ ...assistantEvent({ text: mergeOnly ? `Merge done · ${result.sha}. Checks passed. Nothing published.` : result.pushed
          ? `Push done · ${result.files?.length || 0} file${result.files?.length === 1 ? '' : 's'} · ${published}.${result.warning ? ' ' + result.warning : ''}${afterPush}`
          : 'Already up to date. Nothing new to push.' }), operation: 'push', outcome: 'success' });
        usageHistory?.record(mergeOnly ? 'merge.finished' : 'push.finished', { correlationId: requestId, outcome: mergeOnly ? 'merged' : 'published', durationMs: Date.now() - startedAt });
        return json(res, 200, result);
      } catch (e) {
        const publication = publicationResult || e.publication;
        const description = publication?.state === 'published' ? `Published ${publication.candidate}; follow-up failed`
          : publication ? 'Remote publication outcome is uncertain; inspect the saved publication receipt and remote branch before retrying' : 'Not published';
        const note = noteEvent(`${description}: ${e.message}`, { publication: publication ? publication.state : 'failed',
          pushReceipt: { machine: cluster.self.name || cluster.self.id, status: publication?.state === 'published' ? 'Published; follow-up failed' : publication ? 'Outcome uncertain' : 'Failed', error: e.message } });
        const reply = { ...assistantEvent({ text: `${description}. ${mergeOnly ? 'Merge' : 'Push'} did not complete: ${e.message}` }), operation: 'push' };
        session.events.push(note, reply);
        await store.save(session).catch(() => {});
        broadcast(id, { kind: 'event', event: note });
        broadcast(id, { kind: 'event', event: reply });
        usageHistory?.record(mergeOnly ? 'merge.finished' : 'push.finished', { correlationId: requestId, outcome: 'failed', durationMs: Date.now() - startedAt });
        return json(res, 409, { error: `${description}: ${e.message}`, publication });
      } finally {
        if (session.turnHost) {
          delete session.turnHost;
          delete session.turnStartedAt;
          delete session.waitingFor;
          await store.save(session).catch(() => {});
        }
        live.delete(id);
        running.delete(id);
        broadcast(id, { kind: 'done' });
        restartForTestBuild();
      }
    }

    // ---- usage: a lookup against the ledger, not a scan of transcripts
    if (req.method === 'GET' && pathname === '/api/usage') {
      const window = url.searchParams.get('window') || 'seven_day';
      const cfg = await loadConfig(USER_DATA);

      // A read is a sum over buckets; no transcript is opened here. `refresh=1`
      // forces a collection first, for when a caller wants it up to the second.
      if (url.searchParams.get('refresh') === '1') await collectUsage();

      const span = usageStore.resolvePeriod(usage, window)
        ?? usageStore.resolvePeriod(usage, 'seven_day');
      const models = usageStore.query(usage, { from: span.from, to: span.to, models: cfg.models });

      for (const [alias, spec] of Object.entries(cfg.models)) {
        if (models.some((m) => m.alias === alias)) continue;
        models.push({
          alias, label: spec.label ?? alias, provider: spec.provider,
          turns: 0, input: 0, output: 0, cached: 0, ms: 0, tools: 0, cost: 0,
        });
      }

      const provider = {};
      for (const [alias, saved] of Object.entries(usage.limits ?? {})) {
        provider[alias] = { ...normalizeProviderLimits(saved.info), reportedAt: saved.at };
      }

      // Codex reports plan usage to its rollout files rather than down its
      // stream, and that figure covers the whole account. So a Codex model
      // that has not run a turn here yet can still show a true percentage,
      // rather than an empty card promising one after the next turn.
      const needsCodex = Object.entries(cfg.models)
        .filter(([alias, spec]) => spec.provider === 'codex-cli' && !provider[alias]);
      if (needsCodex.length) {
        const info = await codexCli.latestRateLimits().catch(() => null);
        if (info) {
          for (const [alias] of needsCodex) {
            provider[alias] = { ...normalizeProviderLimits(info), reportedAt: null };
          }
        }
      }

      return json(res, 200, {
        window,
        windows: Object.keys(WINDOWS),
        models,
        provider,
        sessionCount: Object.keys(usage.cursors).length,
        collectedAt: usage.updatedAt,
      });
    }

    // ---- file browsing: folders AND files, with previews
    if (req.method === 'GET' && pathname === '/api/files') {
      const asked = url.searchParams.get('path') || state0Dir();
      let dir = path.resolve(asked);
      let note = null;
      while (dir !== path.dirname(dir)) {
        try {
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch { /* keep walking up */ }
        dir = path.dirname(dir);
      }
      if (dir !== path.resolve(asked)) note = `${asked} no longer exists — showing ${dir}`;

      if (insidePath(canonicalPath(USER_DATA), canonicalPath(dir))) return json(res,403,{error:'Harness private data cannot be browsed.'});
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: full });
        } else if (e.isFile()) {
          const size = await fs.stat(full).then((st) => st.size).catch(() => 0);
          files.push({ name: e.name, path: full, size, kind: kindOf(e.name) });
        }
      }
      return json(res, 200, {
        path: dir,
        note,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs: dirs.sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // ---- one file's contents, for the phone to render
    if (req.method === 'GET' && pathname === '/api/file') {
      let file = path.resolve(url.searchParams.get('path') ?? '');
      const scopedId = url.searchParams.get('session') || req.headers['x-harness-session'];
      const session = scopedId ? await store.load(scopedId, {repair:false}) : null;
      const attachment = session?.events?.flatMap(event => event.attachments || []).find(item => item.path === file);
      if (attachment && cluster.shared()) file = await clusterAssets.resolve(file);
      const target = canonicalPath(file);
      const approvedAttachment = Boolean(attachment && insidePath(canonicalPath(path.join(USER_DATA,'attachments')), target));
      const roots = session
        ? [session.projectDir, session.tabWorkspace?.cwd, session.tabWorkspace?.dir, ...(session.readableDirs || [])].filter(Boolean)
        : (await apps.load(USER_DATA)).map(app => app.dir);
      if (!approvedAttachment && (insidePath(canonicalPath(USER_DATA), target) ||
          !(session?.confineToProjectDir === false || roots.some(root => insidePath(canonicalPath(root), target)))))
        return json(res, 403, {error:'File is outside the project and its approved readable folders.'});
      file = target;

      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: 'not a file' });

      const kind = kindOf(file);
      // A phone should not be asked to swallow a 20 MB page of HTML; text is
      // truncated with a note, images are sent whole.
      const TEXT_CAP = 400_000;
      if (kind === 'text' && st.size > TEXT_CAP) {
        const fh = await fs.open(file, 'r');
        const buf = Buffer.alloc(TEXT_CAP);
        await fh.read(buf, 0, TEXT_CAP, 0);
        await fh.close();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`${buf.toString('utf8')}\n\n--- truncated: showing the first ${TEXT_CAP} of ${st.size} bytes ---`);
      }

      const body = await fs.readFile(file);
      const download = url.searchParams.get('download') === '1';
      res.writeHead(200, {
        'Content-Type': download
          ? 'application/octet-stream'
          : MIME_FILE[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'X-Content-Type-Options': 'nosniff',
        // Even an HTML/SVG file opened directly gets an opaque origin and no scripts.
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'",
        'Cache-Control': 'no-store',
        ...(download
          ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` }
          : {}),
      });
      return res.end(body);
    }

    // ---- a look at the laptop's screen, for when a tool opens a window
    if (req.method === 'POST' && pathname === '/api/dirs') {
      const { parent, name } = await readBody(req);
      if (!name || /[/\\]/.test(name)) return json(res, 400, { error: 'invalid folder name' });
      const made = canonicalPath(path.join(parent, name));
      if (insidePath(canonicalPath(USER_DATA), made)) return json(res,403,{error:'Harness private data is protected.'});
      await fs.mkdir(made, { recursive: true });
      return json(res, 200, { path: made });
    }

    // ---- sessions
    const m = pathname.match(/^\/api\/sessions(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (m) {
      const [, id, verb] = m;
      // A pause saved before a restart is read back before any route relies on it.
      if (id && (PAUSE_ROUTES.has(verb) || (!verb && req.method === 'GET'))) await pauseOf(id);

      if (req.method === 'POST' && id && verb === 'machine') {
        const session = await store.load(id, { repair: false });
        const { ownerNode } = await readBody(req);
        const { hosts } = await sessionPlacement(session);
        const error = session.pause ? 'Resume or stop the paused turn before moving this tab.' : assignmentError(session, ownerNode, hosts);
        if (error) return json(res, 409, { error });
        const inventory = ownerNode === cluster.self.id ? await modelInventory(await loadConfig(USER_DATA)) : await cluster.hostModels(ownerNode);
        const fallback = !inventory.models[session.model]?.available;
        if (fallback) session.model = inventory.default;
        if (!session.model) return json(res, 400, { error: 'No available models on this computer.' });
        // Assignment shares the same serialized commit path as worker writes.
        const assign = latest => {
          const changed = assignmentError(latest, ownerNode, hosts);
          if (changed) throw new Error(changed);
          latest.model = session.model;
          // The old effort belonged to the old model; the new default brings its own.
          if (fallback) { if (inventory.defaultEffort) latest.effort = inventory.defaultEffort; else delete latest.effort; }
          latest.ownerNode = ownerNode;
          latest.executionEpoch = (latest.executionEpoch || 0) + 1;
          return latest;
        };
        try {
          const updated = cluster.shared() ? await cluster.changeSession(id, assign) : await store.save(assign(session));
          return json(res, 200, updated);
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (req.method === 'GET' && id && verb === 'models') {
        const cfg = await loadConfig(USER_DATA);
        return json(res, 200, await modelInventory(cfg));
      }
      if (req.method === 'POST' && !id) {
        const { name, model, effort, claudePermission, projectDir: askedDir, system, mode, appId, ownerNode: requestedOwner } = await readBody(req);
        if (claudePermission !== undefined && !CLAUDE_PERMISSIONS.includes(claudePermission)) return json(res, 400, { error: 'Invalid Claude permission mode.' });
        if (effort !== undefined && (typeof effort !== 'string' || (effort !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))))
          return json(res, 400, { error: 'Invalid effort level.' });
        let ownerNode = cluster.self.id;
        // An app owns its directory; a session attached to one works there
        // rather than carrying a directory of its own.
        let projectDir = askedDir;
        let editsHarness = false;
        if (appId) {
          const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
          if (!app) return json(res, 400, { error: 'no such app' });
          projectDir = app.dir;
          editsHarness = Boolean(app.editsHarness);
          const eligible = executionHosts(app, cluster.replica.members(), cluster.self.id);
          ownerNode = requestedOwner || (eligible.includes(cluster.self.id) ? cluster.self.id : eligible[0]);
          if (!eligible.includes(ownerNode)) return json(res, 400, { error: 'This computer is not enabled for the project.' });
        }
        // A session may not be rooted where it could modify the harness — unless
        // it is a session of the built-in Harness app, which is allowed the
        // harness source (never its data directory).
        const refusal = refuseAsProjectDir(projectDir, { allowHarnessSource: editsHarness });
        if (refusal) return json(res, 400, { error: refusal });
        // Typing a path that does not exist yet is a normal thing to do on a
        // phone; create it now rather than failing on the first tool call.
        if (projectDir && ownerNode === cluster.self.id) await fs.mkdir(projectDir, { recursive: true });
        const inventory = ownerNode === cluster.self.id ? await modelInventory(await loadConfig(USER_DATA)) : await cluster.hostModels(ownerNode);
        const selectedModel = inventory.models[model]?.available ? model : inventory.default;
        if (!selectedModel) return json(res, 400, { error: 'No available models on this computer.' });
        // An explicit effort applies only to the model it was chosen for; otherwise
        // the computer's default model brings its default effort.
        const sessionEffort = selectedModel === model && effort !== undefined ? effort
          : selectedModel === inventory.default ? inventory.defaultEffort || '' : '';
        try { validateEffort(inventory.models[selectedModel], sessionEffort); }
        catch (error) { return json(res, 400, { error: error.message }); }
        const session = store.newSession({ name, model: selectedModel, projectDir, system, mode, appId: appId ?? null });
        if (sessionEffort) session.effort = sessionEffort;
        if (claudePermission && inventory.models[selectedModel]?.provider === 'claude-cli') session.claudePermission = claudePermission;
        session.ownerNode = ownerNode;
        if (editsHarness) session.editsHarness = true;
        await store.save(session);
        return json(res, 200, session);
      }
      if (req.method === 'GET' && id && !verb) {
        // While a turn runs, the in-memory copy is the truth; reading the file
        // would race the writer and trip the crash-repair path.
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        session.projectDirMissing = !(await fs
          .stat(session.projectDir)
          .then((st) => st.isDirectory())
          .catch(() => false));
        // Rooted at home means every project on the machine is in scope, which
        // is never what was wanted and is worth surfacing rather than inferring.
        session.projectDirIsHome = path.resolve(session.projectDir) === path.resolve(os.homedir());
        return json(res, 200, { ...session, busy:messageQueue.busy(id) || running.has(id), paused:paused.has(id), checkpoint:paused.get(id)?.checkpoint ?? null });
      }
      if (req.method === 'DELETE' && id && !verb) {
        if (running.has(id)) return json(res, 409, { error: 'Stop the turn and wait for it to finish before deleting this session.' });
        const removed = await store.load(id, { repair: false });
        if (!cluster.shared() && removed.appId && removed.appId !== '__harness')
          await apps.update(USER_DATA, removed.appId, {}).catch(e => { if (e.message !== 'no such app') throw e; });
        live.delete(id);
        await store.remove(id);
        // Nothing may wait on a deleted session's pause.
        paused.delete(id); pauseReads.delete(id);
        messageQueue.cancel(id); messageQueue.release(id);
        // Its worktree is gone, so nothing could push or discard what it left running.
        if (removed.appId === HARNESS_APP_ID) { await builds.tabDone(removed); restartForTestBuild(); }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && id && !verb) {
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        const patch = await readBody(req);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return json(res,400,{error:'Session settings must be an object.'});
        if (running.has(id)) return json(res, 409, { error: 'Wait for the current turn and integration to finish before editing this session.' });
        if (patch.claudePermission !== undefined && !CLAUDE_PERMISSIONS.includes(patch.claudePermission))
          return json(res, 400, {error:'Invalid Claude permission mode.'});
        if (patch.effort !== undefined && (typeof patch.effort !== 'string' || (patch.effort !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(patch.effort))))
          return json(res, 400, { error: 'Invalid effort level.' });
        const effortModel = (await loadConfig(USER_DATA)).models[patch.model || session.model];
        try {
          if (patch.effort || (patch.model && patch.model !== session.model && session.effort))
            validateEffort(effortModel || {}, patch.effort === undefined ? session.effort : patch.effort);
        } catch (error) { return json(res,400,{error:error.message + ' Choose a supported effort or clear the override before switching models.'}); }
        const fields = new Set(['name','model','system','projectDir','mode','confineToProjectDir','readableDirs','allowLongContext','effort','claudePermission']);
        if (!patch || Array.isArray(patch) || Object.keys(patch).some(key => !fields.has(key)))
          return json(res, 400, {error:'Unsupported session setting.'});
        for (const key of ['name','model','system','projectDir','mode','effort','claudePermission'])
          if (patch[key] !== undefined && typeof patch[key] !== 'string') return json(res,400,{error:`Invalid ${key}.`});
        for (const key of ['confineToProjectDir','allowLongContext'])
          if (patch[key] !== undefined && typeof patch[key] !== 'boolean') return json(res,400,{error:`Invalid ${key}.`});
        if (patch.mode !== undefined && !['agent','chat'].includes(patch.mode)) return json(res,400,{error:'Invalid session mode.'});
        if (patch.readableDirs !== undefined && (!Array.isArray(patch.readableDirs) || patch.readableDirs.some(p => typeof p !== 'string' || !path.isAbsolute(p))))
          return json(res,400,{error:'Readable folders must be absolute paths.'});
        if (patch.projectDir && patch.projectDir !== session.projectDir) delete session.tabWorkspace;
        const badDir = refuseAsProjectDir(patch.projectDir);
        if (badDir) return json(res, 400, { error: badDir });
        if (patch.projectDir) await fs.mkdir(patch.projectDir, { recursive: true });

        // Record a switch in the transcript. Without this there is no evidence
        // it happened, which is exactly how a silently-failed switch goes
        // unnoticed until the answers look wrong.
        const from = session.model;
        Object.assign(session, patch);
        if (patch.model && patch.model !== from) {
          session.events.push(noteEvent(`model switched from ${from} to ${patch.model} — history carries over`));
        }

        await store.save(session);
        return json(res, 200, session);
      }
      // Editing the past. Both refuse while a turn is running: the transcript
      // in memory is the one the model is mid-way through sending.
      if (req.method === 'POST' && id && ['erase', 'rewind'].includes(verb)) {
        if (running.has(id)) return json(res, 409, { error: 'Stop the turn and wait for it to finish before editing this conversation.' });
        const { eventId, revertFiles = false } = await readBody(req);
        const session = await store.load(id, { repair: false });
        if (revertFiles) return json(res, 409, { error: 'File rewind is disabled for shared projects. Ask a new turn to undo the change so it is merged and tested.' });
        try {
          if (verb === 'erase') {
            const { events, removed, describe } = eraseEvent(session.events, eventId);
            session.events = events;
            session.events.push(noteEvent(`removed ${describe} from the conversation — it is no longer sent to the model`));
            await store.save(session);
            return json(res, 200, { ok: true, removed, session });
          }

          // Rewind conversation only; code reversals are new coding turns.
          const { events, removed, draft, attachments: atts } = rewindTo(session.events, eventId);
          session.events = events;
          session.events.push(noteEvent(`rewound the conversation here — ${removed} later event(s) removed`));
          await store.save(session);
          return json(res, 200, { ok: true, removed, draft, attachments: atts, git: null, session });
        } catch (e) {
          return json(res, 400, { error: e?.message ?? String(e) });
        }
      }

      if (id && verb === 'interaction') {
        const pending = interactions.get(id);
        if (req.method === 'GET') return json(res, 200, {request:pending?.request || null});
        if (req.method === 'POST') {
          const answer = await readBody(req, 65536);
          if (!pending || pending.request.id !== answer.id) return json(res, 409, {error:'This request has already been answered or stopped.'});
          if (typeof answer.allow !== 'boolean') return json(res, 400, {error:'Choose approve or decline.'});
          if (answer.scope !== undefined && (!['once','always','all'].includes(answer.scope) || pending.request.kind !== 'permission'
              || (answer.scope === 'always' && !pending.request.always?.length)))
            return json(res, 400, {error:'That approval option is not available for this request.'});
          if (answer.allow && pending.request.kind === 'question') {
            const questions = pending.request.input.questions || [];
            if (!answer.answers || questions.some(q => typeof answer.answers[q.question] !== 'string' || !answer.answers[q.question].trim()))
              return json(res, 400, {error:'Answer each question before continuing.'});
          }
          pending.finish({allow:answer.allow, answers:answer.answers, scope:answer.scope || 'once'});
          usageHistory?.record('interaction.answered', {correlationId:requestId, outcome:answer.allow ? answer.scope || 'once' : 'declined'});
          return json(res, 200, {ok:true});
        }
      }
      if (id && verb === 'pending') {
        if (req.method === 'GET') return json(res, 200, { pending: messageQueue.pending(id) });
        if (['PATCH', 'DELETE'].includes(req.method)) {
          const body = await readBody(req);
          const pending = messageQueue.pending(id).find(message => message.pendingId === body.pendingId);
          if (!pending || pending.pendingId !== body.pendingId) return json(res, 409, { error: 'This message has already started or changed.' });
          if (req.method === 'PATCH') {
            if (typeof body.text !== 'string' || (!body.text.trim() && !pending.attachments?.length)) return json(res, 400, {error:'Enter a message.'});
            messageQueue.edit(id, body.pendingId, body.text.trim());
          } else messageQueue.cancel(id, body.pendingId);
          if (paused.has(id)) await savePause(id);
          usageHistory?.record('queue.changed', {correlationId:requestId, outcome:req.method === 'PATCH' ? 'edited' : 'cancelled'});
          broadcast(id, {kind:'pending', pending:messageQueue.pending(id)});
          return json(res, 200, {pending:messageQueue.pending(id)});
        }
      }
      // Pause: stop the turn now and keep queued messages. The pause, those
      // messages and a resume checkpoint are saved, so a restart keeps all three.
      if (req.method === 'POST' && id && verb === 'pause') {
        const turn = running.get(id);
        const before = paused.get(id);
        if (!turn && !messageQueue.pending(id).length) return json(res, 409, { error: 'Nothing is running to pause.' });
        paused.set(id, { interrupted: Boolean(turn) || Boolean(before?.interrupted), at: before?.at ?? Date.now(), checkpoint: before?.checkpoint ?? null });
        messageQueue.hold(id);
        turn?.controller.abort();
        broadcast(id, { kind: 'paused', paused: true });
        let saved = true;
        try {
          if (turn) await checkpointPause(id, live.get(id) ?? await store.load(id, { repair: false }), requestId);
          await savePause(id);
        } catch { saved = false; }
        const checkpoint = paused.get(id)?.checkpoint ?? null;
        if (checkpoint) broadcast(id, { kind: 'paused', paused: true, checkpoint });
        // An unsaved pause is held in memory only and would not survive a restart.
        usageHistory?.record('turn.paused', { correlationId: requestId, outcome: `${turn ? 'interrupted' : 'queue-held'}${saved ? '' : '-unsaved'}`, count: messageQueue.pending(id).length });
        return json(res, 200, { ok: true, paused: true, checkpoint, saved });
      }
      if (req.method === 'POST' && id && verb === 'resume') {
        const held = paused.get(id);
        if (!held) return json(res, 409, { error: 'This session is not paused.' });
        let resume;
        try {
          resume = held.interrupted ? await resumeMessage(id, requestId) : null;
          paused.delete(id);
          await savePause(id);
        } catch (e) {
          paused.set(id, held);
          return json(res, 409, { error: e.message });
        }
        broadcast(id, { kind: 'paused', paused: false });
        try {
          // The interrupted work goes first, then anything that was queued.
          if (resume) await scheduleTurn(id, { text: resume.text, resume: true, traceId: requestId }, true, { front: true });
        } catch (e) {
          paused.set(id, held);
          await savePause(id).catch(() => {});
          broadcast(id, { kind: 'paused', paused: true, checkpoint: held.checkpoint ?? null });
          return json(res, 409, { error: e.message });
        } finally { if (!paused.has(id)) messageQueue.release(id); }
        usageHistory?.record('turn.resumed', { correlationId: requestId, outcome: resume ? `continued-${resume.via}` : 'queue-released', durationMs: Date.now() - held.at });
        return json(res, 200, { ok: true, pending: messageQueue.pending(id) });
      }
      if (req.method === 'POST' && id && verb === 'stop') {
        const wasPaused = paused.delete(id);
        if (wasPaused) broadcast(id, { kind: 'paused', paused: false });
        // Handed back, never silently dropped: see unsentNote.
        const returned = messageQueue.pending(id).map(({ text, attachments }) => ({ text: text || '', attachments: attachments || [] }));
        messageQueue.cancel(id);
        messageQueue.release(id);
        broadcast(id, {kind:"pending", pending:null});
        const turn = running.get(id);
        if (turn && returned.length) turn.unsent = returned; // noted after the turn's own stop note
        turn?.controller.abort();
        if (!turn && returned.length) {
          const event = unsentNote(returned);
          await editSession(id, session => { session.events.push(event); })
            .then(() => broadcast(id, { kind: 'event', event })).catch(() => {});
        }
        if (wasPaused) await savePause(id).catch(() => {});
        usageHistory?.record('turn.stop-requested', { correlationId: requestId, outcome: turn ? 'running' : wasPaused ? 'paused' : 'idle', count: returned.length });
        return json(res, 200, { ok: true, returned });
      }

      // Live transcript. One stream per open phone; several may watch at once.
      if (req.method === 'GET' && id && verb === 'events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const live = running.get(id);
        res.write(`retry: 2000\n\ndata: ${JSON.stringify({
          kind: 'hello', pending: messageQueue.pending(id), interaction: interactions.get(id)?.request || null,
          running: Boolean(live), paused: paused.has(id), checkpoint: paused.get(id)?.checkpoint ?? null,
          startedAt: live?.startedAt ?? null,
        })}\n\n`);

        if (!listeners.has(id)) listeners.set(id, new Set());
        listeners.get(id).add(res);

        // Phones suspend radios aggressively; a heartbeat keeps NAT and the
        // browser from quietly dropping the connection.
        const beat = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(beat);
          listeners.get(id)?.delete(res);
        });
        return undefined;
      }

      // Raw-bytes upload. Multipart would mean a parser and an extra
      // dependency for no benefit; the filename rides in a header.
      if (req.method === 'POST' && id && verb === 'upload') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > attachments.MAX_BYTES) return json(res, 413, { error: 'image too large (25 MB limit)' });
          chunks.push(c);
        }
        if (!size) return json(res, 400, { error: 'empty upload' });

        const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'image.jpg'));
        try {
          const att = await attachments.store(USER_DATA, id, { name, buffer: Buffer.concat(chunks) });
          if (cluster.shared()) await clusterAssets.capture(att);
          return json(res, 200, att);
        } catch (e) {
          return json(res, 400, { error: e?.message ?? String(e) });
        }
      }

      if (req.method === 'POST' && id && ['send', 'queue'].includes(verb)) {
        if (restarting) return json(res, 409, { error: 'The server is restarting. Try again when it reconnects.' });
        const body = await readBody(req);
        if ((!body.text || !String(body.text).trim()) && !body.attachments?.length) return json(res, 400, { error: 'Enter a message or attach a file.' });
        if (body.clientMessageId !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(body.clientMessageId))
          return json(res, 400, {error:'Invalid message ID.'});
        const key = body.clientMessageId && id + ':' + body.clientMessageId;
        try {
          if (key && messageAdmissions.has(key)) {
            await messageAdmissions.get(key);
            return json(res, 200, {ok:true, duplicate:true, pending:messageQueue.pending(id)});
          }
          const admit = async () => {
            if (key) {
              const existing = live.get(id) || await store.load(id, {repair:false});
              if (existing.events.some(e => e.clientMessageId === body.clientMessageId)
                || messageQueue.pending(id).some(e => e.clientMessageId === body.clientMessageId)) return {duplicate:true};
            }
            // Sending while paused resumes with this message instead of an automatic continue.
            const wasPaused = paused.delete(id);
            if (wasPaused) {
              await savePause(id).catch(() => {}); // a starting turn clears it regardless
              broadcast(id, { kind: 'paused', paused: false });
              messageQueue.release(id);
            }
            const queued = await scheduleTurn(id, { ...body, traceId: requestId }, verb === 'queue' || wasPaused);
            return {queued};
          };
          const operation = admit();
          if (key) messageAdmissions.set(key, operation);
          try {
            const result = await operation;
            return json(res, result.queued ? 202 : 200, {ok:true, ...result, pending:messageQueue.pending(id)});
          } finally { if (key && messageAdmissions.get(key) === operation) messageAdmissions.delete(key); }
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
    }

    return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  } catch (e) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

// -------------------------------------------------------------------- start

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

await store.init(USER_DATA);
TOKEN = await resolveToken(USER_DATA);
cluster = await createCluster(USER_DATA);
readVersionMetadata = versionMetadata(cluster, { observe: observeVersion });
usageHistory = diagnostics(USER_DATA, cluster.self.id, loadedVersion.revision);
await usageHistory.record('server.started');
const testBuildMode = process.env.ORCHESTRATOR_TEST_BUILDS;
builds = await createTestBuilds({ root: harnessDir, codeDir, dataDir: USER_DATA, enabled: !testBuildMode, adopt: adoptCode,
  busy: () => Boolean(restarting || running.size || messageQueue.size),
  record: (name, details) => usageHistory.record(name, details),
  restart: async () => {
    if (restarting) return;
    if (running.size || messageQueue.size) throw Object.assign(new Error('Work is running.'), { busy: true });
    restarting = true;
    try { await launchReplacement({ local: true }); }
    catch (error) { restarting = false; throw error; }
    setTimeout(() => shutdown('restart'), 400);
  } });
loadedVersion.testing = testingSummary(await builds.runningBuild());
let lastHealth = '';
setInterval(() => {
  const status = cluster.status();
  const health = { leader: status.leader, role: status.role, term: status.term, conflicts: status.conflicts,
    count: status.hosts.filter(h => h.active).length };
  const value = JSON.stringify(health);
  if (value !== lastHealth) {
    lastHealth = value; usageHistory.record('cluster.changed', health);
    harnessVersions(cluster, { node: cluster.self.id, version: loadedVersion, update: harnessUpdate },
      { observe: observeVersion }).catch(() => {});
  }
}, 10000).unref();
recovery = projectRecovery(cluster, USER_DATA, loadedVersion.revision, usageHistory.record);
pairing = hostPairing({ cluster, inventory, join: joinHost, publish: async () => {
  // Reuses the Phone access routine: it never replaces an existing Serve route.
  const n = await setupPhoneAccess(PORT);
  if (n.phoneUrl) return cluster.setUrl(n.phoneUrl);
  if (n.approvalUrl) throw new Error(`Tailscale must allow HTTPS for this computer first. Approve it at ${n.approvalUrl} and tap request to join again.`);
  throw new Error(n.connected ? n.message : 'Tailscale is not connected on this computer. Sign in to Tailscale, then tap request to join again.');
} });
store.useCluster(cluster);
workspaces = portableWorkspaces(cluster);
placement = appPlacement(cluster, USER_DATA, {
  // A replica's apps.json is only rewritten while it is main, so read the
  // replicated record directly.
  loadApps: async () => {
    const shared = cluster.replica.state.values['settings:apps.json'];
    return shared ? JSON.parse(shared).apps || [] : apps.load(USER_DATA);
  },
  running: (appId) => [...running.keys()].some((id) => live.get(id)?.appId === appId),
});
clusterAssets = replicatedAssets(cluster, USER_DATA);
cluster.replica.start();
// Test changes that stopped DO from starting were dropped by server/boot.js. Say so
// where they were made: a chat entry the next turn can read, as well as the sheet.
setTimeout(async () => {
  const failure = await builds.takeFailure().catch(() => null);
  if (!failure) return;
  usageHistory.record('test-build.failed', { outcome: 'boot', count: failure.tabs.length });
  for (const tab of failure.tabs) {
    try {
      const session = live.get(tab.session) ?? await store.load(tab.session, { repair: false });
      const event = { ...assistantEvent({ text: `These changes stopped DO from starting, so this computer went back to ${loadedVersion.number || 'the published version'}. They are still in this tab, not running. ${failure.message}` }), operation: 'push' };
      session.events.push(event);
      await store.save(session);
      broadcast(tab.session, { kind: 'event', event });
    } catch { /* the sheet still shows the failure */ }
  }
}, 2000).unref();
let lastPublished = loadedRevision;
// Each host downloads safely. Only the coordinator rolls idle hosts forward.
setInterval(async () => {
  // A trial start only proves a build boots; it must never update or restart anything.
  if (testBuildMode === 'trial' || checkingHarnessUpdate || restarting) return;
  checkingHarnessUpdate = true;
  try {
    if (await builds.restartIfWaiting()) return;
    const result = await syncHarnessCheckout(harnessDir, { busy: () => Boolean(restarting || running.size || messageQueue.size) });
    if (result.head !== lastPublished) { lastPublished = result.head; await builds.mainMoved(); }
    harnessUpdate = { ...result, checkedAt: new Date().toISOString(), restartRequired: Boolean(loadedRevision && result.head !== loadedRevision) };
    if (result.skipped || !result.published || cluster.replica.role !== 'leader') return;
    const versions = await harnessVersions(cluster, { node: cluster.self.id, version: loadedVersion, update: harnessUpdate }, { observe: observeVersion });
    if (!versions.hosts.some(host => host.version?.revision && host.version.revision !== result.head)) return;
    harnessUpdate.phase = 'Waiting for all machines; automatic restart queued';
    await restartPeers(cluster, { targetRevision: result.head });
    if (loadedRevision === result.head && !loadedVersion.dirty) {
      harnessUpdate.phase = 'All machine running commits verified';
      return;
    }
    harnessUpdate.phase = 'Peers verified; restarting this computer';
    const response = await fetch(`http://127.0.0.1:${PORT}/api/harness/restart`, {
      method: 'POST', headers: { 'x-cluster-key': cluster.replica.disk.secret, 'x-harness-revision': result.head },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Automatic restart refused');
  } catch (e) { harnessUpdate = { ...harnessUpdate, error: e.message, phase: 'Automatic update waiting — retries every 30 seconds' }; }
  finally { checkingHarnessUpdate = false; }
}, 30_000).unref();
// Discover our published address without changing the user's Serve routes.
networkStatus(PORT).then((n) => cluster.setUrl(n.phoneUrl)).catch(() => {});
/**
 * The coordinator marks turns interrupted when their execution host disappears.
 * Healthy replicas may keep executing; becoming a follower is not a failure.
 * Nothing is replayed, and an interrupted writer is fenced by its epoch.
 */
let reconciling = false;
async function failOrphanedTurns() {
  if (reconciling || !cluster.shared()) return;
  reconciling = true;
  try {
    for (const [id, value] of Object.entries(cluster.replica.state.sessions)) {
      if (!value?.turnHost || running.has(id)) continue;
      if (value.turnHost === cluster.self.id && cluster.replica.role !== 'leader') {
        await cluster.reportStoppedTurn(value);
        continue;
      }
      if (!cluster.replica.writable()) continue;
      if (value.turnHost !== cluster.self.id && cluster.status().hosts.some(n => n.id === value.turnHost && n.active)) continue;
      const host = value.turnHost === cluster.self.id ? 'this host'
        : cluster.replica.state.history[value.turnHost]?.name || 'another host';
      const note = noteEvent(
        `turn interrupted — it was running on ${host}, which stopped or disconnected before it finished. `
        + 'Nothing was replayed. Work it had started may have partly happened, so check the project '
        + 'before assuming nothing did. Reconnect its computer before sending another message.',
        { outcome: 'interrupted' },
      );
      const changed = await cluster.changeSession(id, current => recoverStoppedTurn(current, value, note));
      if (!changed) continue;
      broadcast(id, { kind: 'event', event: note });
      broadcast(id, { kind: 'done' });
    }
  } catch { /* retried on the next pass */ } finally { reconciling = false; }
}
setInterval(() => {
  if (cluster.shared()) for (const [id, turn] of running) {
    if (turn.checkingOwner) continue;
    turn.checkingOwner = true;
    cluster.readSession(id, true).then(s => {
      if (s?.ownerNode !== cluster.self.id || (s.executionEpoch || 0) !== (turn.executionEpoch || 0)) turn.controller.abort();
    }).catch(() => turn.controller.abort()).finally(() => { turn.checkingOwner = false; });
  }
  failOrphanedTurns();
}, 500).unref();
setInterval(async () => {
  if (!cluster.replica.writable()) return;
  try {
    for (const [id, at] of cluster.replica.lastContact) {
      if ((cluster.replica.state.values['host-seen:' + id] || 0) < at) await cluster.command({ type: 'value', id: 'host-seen:' + id, value: at });
    }
  } catch { /* A new main will continue collecting sightings. */ }
}, 30000).unref();

// Each host keeps its own copies of the projects placed on it (see placement.js).
let placementFingerprint = '';
let placementAt = 0;
setInterval(() => {
  if (!cluster.shared()) return;
  const fingerprint = String(cluster.replica.state.values['settings:apps.json']);
  if (fingerprint === placementFingerprint && Date.now() - placementAt < 120_000) return;
  placementFingerprint = fingerprint; placementAt = Date.now();
  placement.reconcile().catch(() => { placementAt = 0; });
}, 10_000).unref();
// Project files used to be copied into the cluster log as checkpoints. Git
// placement replaced them; drop the old copies so the log stays small.
setInterval(async () => {
  if (!cluster.replica.writable()) return;
  try {
    for (const id of Object.keys(cluster.replica.state.values)) {
      if (id.startsWith('workspace:')) await cluster.replica.propose({ type: 'value', id, value: null });
    }
  } catch { /* the next main finishes the cleanup */ }
}, 60_000).unref();

usage = await usageStore.load(USER_DATA);
await collectUsage({ force: true });      // catch up on anything missed while down
setInterval(() => collectUsage().catch(() => {}), 60_000).unref();

/**
 * The wedge watcher.
 *
 * Runs on a plain timer in the server, deliberately outside any model: a turn
 * that has stopped progressing is exactly the thing that cannot report itself.
 * When a beacon goes stale the user is told through whatever channel they have
 * configured, and by email if that is set up, because the whole point is that
 * they are not at the laptop watching.
 */
async function checkForStalls() {
  // Each beacon carries its own threshold; an override applies to all of them.
  const override = process.env.HARNESS_STALL_MS ? Number(process.env.HARNESS_STALL_MS) : undefined;
  for (const id of interactions.keys()) beacons.touch(id, 'waiting for user');
  const due = beacons.due(override ? { stallMs: override } : {});
  for (const stall of due) {
    const session = live.get(stall.sessionId);
    const text = wedgeMessage({
      sessionName: session?.name ?? stall.sessionId,
      model: stall.model,
      silentMs: stall.silentMs,
      runningMs: stall.runningMs,
      lastActivity: stall.lastActivity,
    });

    // Into the transcript first: the evidence must survive even if every
    // outbound channel fails.
    if (session) {
      const note = noteEvent(`stalled — ${text}`);
      session.events.push(note);
      broadcast(stall.sessionId, { kind: 'event', event: note });
      await store.save(session).catch(() => {});
    }

    const cfg = await notifyConfig().catch(() => null);
    if (cfg?.enabled) await sendNotify(cfg, text).catch(() => {});
    const email = await loadEmailConfig(USER_DATA).catch(() => null);
    if (email?.enabled && email?.apiKey && email?.to) {
      await sendEmail(email, { subject: 'A harness turn has stalled', text, session: stall.sessionId }).catch(() => {});
    }
  }
}
setInterval(() => { checkForStalls().catch(() => {}); }, 30_000).unref();

/**
 * A turn that was running when the harness stopped used to vanish without a
 * trace: the transcript simply ended on a tool result, which reads as "it
 * finished and said nothing" rather than "this was cut off". That is the worst
 * kind of failure — one with nowhere to look. A shutdown now aborts the turns
 * it is interrupting and writes the interruption into each transcript before
 * the process goes away, so the evidence outlives the server.
 */
let shuttingDown = false;
async function shutdown(signal) {
  aiSources.close();
  if (shuttingDown) return;
  shuttingDown = true;
  cluster?.replica.stop();

  const interrupted = [...running.entries()];
  for (const [id, turn] of interrupted) {
    turn.controller?.abort();
    const session = live.get(id);
    if (!session) continue;
    // Paused, and still stopping: it keeps its pause and checkpoint, so Resume
    // is there when the harness comes back.
    if (paused.get(id)?.interrupted) {
      delete session.turnHost;
      if (!turn.pauseRecorded) {
        turn.pauseRecorded = true;
        await recordPause(id, session).catch(() => {});
      } else await store.save(session).catch(() => {});
      continue;
    }
    const note = noteEvent(
      `turn interrupted — the harness stopped (${signal}) while this was running. `
      + 'Work it had started in the background may have carried on regardless, so check the '
      + 'project directory before assuming nothing happened. Send another message to continue.',
      { outcome: 'interrupted' },
    );
    session.events.push(note);
    delete session.turnHost;
    delete session.waitingFor;
    broadcast(id, { kind: 'event', event: note });
    // Best effort: the process is going away either way, and a failed save
    // must not stop the other sessions from getting their note.
    try { await store.save(session); } catch { /* nothing better to do here */ }
  }

  if (usage) await usageStore.save(USER_DATA, usage).catch(() => {});
  server.close();
  // Long enough for those notes to reach a phone that is still listening.
  if (interrupted.length) await new Promise((r) => { setTimeout(r, 250); });
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { shutdown(sig).catch(() => process.exit(1)); });
}

server.listen(PORT, '0.0.0.0', () => {
  const t = TOKEN ? `?t=${TOKEN}` : '';
  console.log(`\n  harness is up\n`);
  console.log(`  local:    http://localhost:${PORT}/${t}`);
  if (TOKEN) console.log(`  network:  http://${lanAddress()}:${PORT}/${t}`);
  console.log(`\n  data: ${USER_DATA}`);
  console.log(TOKEN
    ? '  a token is required. bookmark the bare address; the cookie carries it.\n'
    : '  no token: this computer, Phone access (Tailscale) and paired computers can connect.\n'
      + '  other network addresses are refused. Set HARNESS_TOKEN=auto to allow them with a token.\n');
});
