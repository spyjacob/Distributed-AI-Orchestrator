// One way to start DO on any computer: a status window instead of a terminal,
// and DO stops on this computer when that window closes. Only showing the window
// differs by system; the Start DO file for each system just finds Node and runs this.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, closeSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { killTree } from '../src/core/platform.js';
import { loadNodeConfig } from './node-config.mjs';
import { ownsPort, stopServer } from './stop-server.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A double-click must not leave anything waiting on it.
if (process.argv.includes('--detach')) {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.exit(0);
}

const dir = path.join(root, '.launcher');
await fs.mkdir(dir, { recursive: true });
const launch = crypto.randomUUID();
const startedAt = Date.now();
const version = await fs.readFile('VERSION', 'utf8').then((text) => `v${text.trim()}`, () => 'unknown');

// Bounded and searchable, for whoever has to work out what happened. No addresses
// with keys, no tokens, no chat contents. Tracing must never break starting DO.
const tracePath = path.join(dir, 'trace.jsonl');
function trace(event, details = {}) {
  try {
    if (statSync(tracePath, { throwIfNoEntry: false })?.size > 256 * 1024) renameSync(tracePath, `${tracePath}.1`);
    appendFileSync(tracePath, JSON.stringify({ at: new Date().toISOString(), launch, version, platform: process.platform, event, ...details }) + '\n', { mode: 0o600 });
  } catch { /* nothing better to do */ }
}

let log = null;
function openLog() {
  const file = path.join(dir, 'output.log');
  try {
    if (statSync(file, { throwIfNoEntry: false })?.size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
    log = openSync(file, 'a', 0o600);
  } catch { log = null; }
}
function writeLog(text) { try { if (log !== null) writeSync(log, text); } catch { /* the window still works */ } }

// ---------------------------------------------------------------- what the window shows
let port = null;
const view = { state: 'starting', detail: 'Getting ready…', computer: os.hostname(), version, busy: false, needsTailscale: false,
  hosts: [], viewers: [], phone: null, log: [], problem: '', surface: 'window' };
const pages = new Set();
const send = (page, value) => { try { page.write(`data: ${JSON.stringify(value)}\n\n`); } catch { /* it is closing */ } };
let shownState = '';
function show(changes) {
  const before = JSON.stringify(view);
  Object.assign(view, changes);
  if (JSON.stringify(view) === before) return;
  if (view.state !== shownState) {
    shownState = view.state;
    trace('state', { state: view.state });
    say(`DO: ${words[view.state]}${view.detail ? ` - ${view.detail}` : ''}`);
  }
  for (const page of pages) send(page, view);
}
const friendlySystem = { darwin: 'Mac', win32: 'Windows PC', linux: 'Linux PC' };
const words = { starting: 'Starting', online: 'Online', waiting: 'Waiting', restarting: 'Restarting', offline: 'Offline', stopping: 'Stopping', stopped: 'Stopped' };
// With no desktop there is no window, so the terminal says what the window would.
function say(text) { if (surface?.kind === 'none') console.log(text); }

// ---------------------------------------------------------------- the running server
const token = async () => {
  const want = process.env.HARNESS_TOKEN;
  if (want !== 'auto') return want || '';
  return fs.readFile(path.join(process.env.HARNESS_DATA_DIR, 'server-token'), 'utf8').then((text) => text.trim(), () => '');
};
async function api(route) {
  const secret = await token();
  // A stopped server refuses at once. A slow answer is a slow Tailscale check, not a lost server.
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: secret ? { 'x-harness-token': secret } : {}, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, code: body.code });
  }
  return response.json();
}
// DO refuses most of its API while Tailscale is off, on purpose. It still answers the cluster's.
const isServing = () => api('/api/cluster/status').then((value) => Boolean(value.self), () => false);
const readStatus = () => api('/api/harness/status').catch((error) => {
  if (error.code !== 'TAILSCALE_DISCONNECTED') throw error;
  return { needsTailscale: true };
});
// Only this checkout's server is this launcher's to show and stop.
const ours = () => { try { return ownsPort(root, port); } catch { return false; } };
let otherCopy = '';
function refuseOtherCopy(id) {
  otherCopy = id;
  trace('server.other-copy');
  show({ state: 'offline', detail: `Another copy of DO is using port ${port}. Close it, or choose another HARNESS_PORT in .orchestrator-node.env, then start again.` });
}

let starter = null;       // scripts/start.mjs, when this launcher started DO
let startedHere = false;
let opened = false;
let lostAt = 0;
let startingAt = 0;
let networkAt = 0;
let stopping = false;
let lastError = '';
const recent = [];

function record(chunk, isError) {
  // A server with a token prints it in its address.
  const text = chunk.toString().replace(/([?&]t=)[^\s&]+/g, '$1[hidden]');
  writeLog(text);
  for (const line of text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    recent.push(line);
    if (recent.length > 12) recent.shift();
    if (isError) lastError = line;
    if (view.state !== 'starting') continue;
    if (/Checking GitHub/.test(line)) show({ detail: 'Checking GitHub for updates…' });
    else if (/\bnpm\b|added \d+ packages/.test(line)) show({ detail: 'Installing what DO needs. The first start takes a minute.' });
    else if (/Startup update verified|Remote update unavailable/.test(line)) show({ detail: 'Starting DO…' });
  }
}

function startServer() {
  startedHere = true;
  lastError = '';
  recent.length = 0;
  lostAt = 0;
  startingAt = Date.now();
  show({ state: 'starting', detail: 'Starting DO…', log: [] });
  trace('server.starting');
  // Its own process group, so stopping during a first install takes npm along too.
  const child = spawn(process.execPath, ['scripts/start.mjs', '--no-browser'], { cwd: root, env: process.env,
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  starter = child;
  child.stdout.on('data', (chunk) => record(chunk, false));
  child.stderr.on('data', (chunk) => record(chunk, true));
  child.once('error', (error) => { lastError = error.message; });
  child.once('close', (code) => {
    if (starter === child) starter = null;
    if (stopping) return;
    if (code) {
      trace('server.failed', { code, durationMs: Date.now() - startedAt });
      return show({ state: 'offline', detail: lastError || `DO stopped with code ${code}.`, log: [...recent] });
    }
    isServing().then((up) => {
      if (up || stopping) return;
      trace('server.gone');
      show({ state: 'offline', detail: 'DO is not running on this computer.', log: [...recent] });
    });
  });
}

/** Read what DO reports about itself. It is the only source of what the window says. */
async function watch() {
  if (stopping || port === null) return undefined;
  let status, cluster;
  try { [status, cluster] = await Promise.all([readStatus(), api('/api/cluster/status')]); }
  catch (error) {
    if (error.status === 401) return show({ state: 'offline', detail: 'DO on this port needs an access token this launcher does not have.' });
    // Installing can take minutes, but a window must not say the same thing forever.
    if (view.state === 'starting' && startingAt && Date.now() - startingAt > 180000) {
      startingAt = 0;
      trace('server.slow');
      show({ detail: 'This is taking longer than usual. See what happened below, or stop DO and start it again.', log: [...recent] });
    }
    if (view.state === 'online' || view.state === 'waiting') {
      lostAt = Date.now();
      trace('server.lost');
      show({ state: 'restarting', detail: 'DO is coming back. This usually takes a few seconds.' });
    } else if (view.state === 'restarting') {
      // DO can announce a restart before it stops answering.
      lostAt ||= Date.now();
      if (!starter && Date.now() - lostAt > 60000) {
        trace('server.gone', { durationMs: Date.now() - lostAt });
        show({ state: 'offline', detail: 'DO is not running on this computer.', log: [...recent] });
      } else if (Date.now() - lostAt > 180000) {
        trace('server.gone', { durationMs: Date.now() - lostAt });
        show({ state: 'offline', detail: 'DO did not come back after three minutes.', log: [...recent] });
      }
    }
    return undefined;
  }
  const hosts = cluster.hosts.filter((host) => host.member).map((host) => ({ id: host.id, name: host.name,
    self: host.id === cluster.self, active: host.active, main: host.id === cluster.leader,
    system: friendlySystem[host.platform] || 'Computer', lastSeen: host.active ? null : host.lastSeen }))
    .sort((a, b) => Number(b.self) - Number(a.self) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const viewers = cluster.viewers.filter((viewer) => viewer.active).map((viewer) => ({ id: viewer.id, name: viewer.name,
    via: cluster.hosts.find((host) => host.id === viewer.hostId)?.name || '' }));
  const self = hosts.find((host) => host.self);
  const before = view.state;
  const settled = before === 'online' || before === 'waiting';
  if (!settled && cluster.self === otherCopy) return undefined;
  if (!settled && !ours()) return refuseOtherCopy(cluster.self);
  const needsTailscale = Boolean(status.needsTailscale);
  const state = status.restarting ? 'restarting' : needsTailscale || !cluster.writable ? 'waiting' : 'online';
  const detail = state === 'restarting' ? 'DO is coming back. This usually takes a few seconds.'
    : needsTailscale ? 'DO is running but can’t work until Tailscale is connected on this computer. Open Tailscale and sign in, or install it. This window updates by itself.'
      : state === 'waiting' ? 'DO is running and waiting for your other computers. It needs most of them online before it can continue.' : '';
  show({ state, detail, needsTailscale, computer: self?.name || view.computer, version: status.version?.number || version, busy: Boolean(status.busy), hosts, viewers, log: [] });
  if (state !== before) networkAt = 0;
  if (state === 'waiting' && before !== 'waiting') trace('server.waiting', { for: needsTailscale ? 'tailscale' : 'computers' });
  if (state === 'online' && before !== 'online') {
    trace('server.online', { attached: !startedHere, durationMs: lostAt ? Date.now() - lostAt : Date.now() - startedAt, hosts: hosts.length, viewers: viewers.length });
    lostAt = 0;
  }
  // With Tailscale off, DO's page could only repeat what the window already says.
  if (state !== 'restarting' && !needsTailscale && startedHere && !opened) {
    opened = true;
    if (process.env.ORCHESTRATOR_LAUNCHER_BROWSER !== 'off') openDo('started');
  }
  if (Date.now() - networkAt > 30000) {
    networkAt = Date.now();
    api('/api/network').then((network) => show({ phone: { url: network.phoneUrl || '', message: network.message || '', ready: Boolean(network.ready) } }), () => {});
  }
}

// ---------------------------------------------------------------- opening things
function openExternal(target) {
  if (surface?.kind === 'none') return;
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  const child = spawn(command, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  child.once('error', (error) => trace('open.failed', { message: error.message }));
  child.unref();
}
async function openDo(reason) {
  trace('action.open', { reason });
  const secret = await token();
  openExternal(`http://localhost:${port}/${secret ? `?t=${encodeURIComponent(secret)}` : ''}`);
}

// ---------------------------------------------------------------- the window itself
const onPath = async (names) => {
  for (const name of names) for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(folder, name);
    if (await fs.access(file, fs.constants.X_OK).then(() => true, () => false)) return file;
  }
  return null;
};
const firstFile = async (files) => {
  for (const file of files) if (await fs.access(file).then(() => true, () => false)) return file;
  return null;
};
/** Edge is on every current Windows; Chrome-family browsers can all show a bare app window. */
function appBrowser() {
  if (process.platform === 'darwin') return firstFile(['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser'].map((app) => path.join('/Applications', app)));
  if (process.platform === 'win32') {
    const places = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    return firstFile(['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']
      .flatMap((file) => places.map((place) => path.join(place, file))));
  }
  return onPath(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge', 'brave-browser']);
}

/** The Mac window: built once from source, beside the launcher's other local files. */
async function macWindow() {
  const bundle = path.join(dir, 'DO.app');
  const binary = path.join(bundle, 'Contents/MacOS/DO');
  const source = path.join(root, 'scripts/launcher-window.swift');
  const [built, wanted] = await Promise.all([fs.stat(binary).catch(() => null), fs.stat(source)]);
  if (built && built.mtimeMs >= wanted.mtimeMs) return binary;
  // Without the developer tools, swiftc would only pop up Apple's installer.
  await run('xcode-select', ['-p'], { timeout: 5000 });
  const started = Date.now();
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.join(bundle, 'Contents/Resources'), { recursive: true });
  await fs.copyFile(path.join(root, 'Start DO.app/Contents/Resources/AppIcon.icns'), path.join(bundle, 'Contents/Resources/AppIcon.icns')).catch(() => {});
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DO</string>
<key>CFBundleIdentifier</key><string>dev.orchestrator.status</string>
<key>CFBundleName</key><string>DO</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`);
  await run('swiftc', ['-O', source, '-o', binary], { timeout: 180000 });
  await run('codesign', ['--force', '--sign', '-', bundle], { timeout: 30000 }).catch(() => {});
  trace('window.built', { durationMs: Date.now() - started });
  return binary;
}

let surface = null;
let pageSeen = false;
let closeTimer = null;
const closeWord = (kind) => kind === 'tab' ? 'tab' : 'window';

const openers = {
  native: async (url) => {
    const child = spawn(await macWindow(), [url], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    return { kind: 'native', child, focus: () => { try { child.stdin.write('focus\n'); } catch { /* it is closing */ } } };
  },
  // A private profile, so this is a process of its own and not a tab in someone's browser.
  browser: async (url) => {
    const binary = await appBrowser();
    if (!binary) throw new Error('no Chrome-family browser');
    const profile = path.join(os.tmpdir(), `do-status-window-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`);
    const child = spawn(binary, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=460,700', '--no-first-run', '--no-default-browser-check', '--disable-background-mode'], { stdio: 'ignore' });
    // A page can rarely raise its own window on Windows, so ask the system too.
    const focus = process.platform === 'win32' ? () => { execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${child.pid})`], { windowsHide: true, timeout: 10000 }, () => {}); } : undefined;
    return { kind: 'browser', child, focus };
  },
  tab: async (url) => {
    surface = { kind: 'tab' };
    openExternal(url);
    return surface;
  },
  none: async (url) => {
    console.log(`Status window: ${url}`);
    return { kind: 'none' };
  },
};

function windowChoices() {
  const forced = process.env.ORCHESTRATOR_LAUNCHER_WINDOW;
  if (forced) return [forced];
  if (process.platform === 'darwin') return ['native', 'browser', 'tab'];
  // A Linux server with no desktop has nothing to show a window on.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return ['none'];
  return ['browser', 'tab'];
}

let windowUrl = '';
let choices = [];
let opening = false;
async function openWindow() {
  opening = true;
  try {
    while (choices.length) {
      const kind = choices.shift();
      const started = Date.now();
      try {
        const host = await openers[kind](windowUrl);
        host.openedAt = Date.now();
        surface = host;
        show({ surface: closeWord(kind) });
        trace('window.opened', { kind, durationMs: Date.now() - started });
        host.child?.once('error', (error) => windowFailed(host, error.message));
        host.child?.once('exit', (code) => windowExited(host, code));
        return;
      } catch (error) {
        trace('window.failed', { kind, message: String(error.message).slice(0, 300) });
      }
    }
    // Nothing can show a window. DO still runs; the launcher's log and DO itself still work.
    surface = { kind: 'none' };
    console.log(`Status window: ${windowUrl}`);
  } finally { opening = false; }
}
/** An impatient second click must not open a second window beside one still appearing. */
function windowIsAppearing() {
  if (opening || pages.size) return true;
  const recently = surface && Date.now() - surface.openedAt < 15000;
  return Boolean(recently && !pageSeen) || (surface?.kind === 'native' && surface.child.exitCode === null);
}
function windowFailed(host, message) {
  if (surface !== host) return;
  trace('window.failed', { kind: host.kind, message: String(message).slice(0, 300) });
  host.dead = true;
  openWindow();
}
async function windowExited(host, code) {
  if (surface !== host || host.dead || stopping) return;
  trace('window.exited', { kind: host.kind, code });
  // Chrome-family browsers can hand a window to an older copy of themselves and leave.
  if (host.kind === 'browser') { await pause(3000); if (pages.size) return; }
  // A window that never showed the page failed to open: try the next way.
  if (!pageSeen && Date.now() - host.openedAt < 15000) return windowFailed(host, `exited with code ${code}`);
  shutdown('window-closed');
}

// ---------------------------------------------------------------- stopping
async function stopStarter() {
  const child = starter;
  if (!child) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    if (process.platform === 'win32') await killTree(child.pid);
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
  await Promise.race([closed, pause(12000)]);
}

/** A restart under way would bring DO back after this launcher has gone, so see it through. */
async function waitOutRestart(wasUp) {
  let expected = wasUp;
  let heardAt = Date.now();
  const giveUpAt = Date.now() + 60000;
  while (Date.now() < giveUpAt) {
    const status = await readStatus().catch(() => null);
    if (status && !status.restarting) return;
    // An update check can keep the old server answering for a while. A server
    // that has gone quiet comes back in seconds, or it has simply died.
    if (!status && (!expected || Date.now() - heardAt > 15000)) return;
    expected = true;
    if (status) heardAt = Date.now();
    await pause(500);
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  const started = Date.now();
  const wasUp = view.state === 'online' || view.state === 'restarting';
  trace('stop.started', { reason });
  show({ state: 'stopping', detail: 'Stopping DO on this computer…', problem: '' });
  try {
    if (port !== null) await waitOutRestart(wasUp);
    await stopStarter();
    // Whatever else holds the port is not this launcher's to stop.
    if (port !== null && ours()) await stopServer(root, port);
  } catch (error) {
    // The window may already be gone, so a failure has to bring one back.
    stopping = false;
    const message = String(error.message).slice(0, 400);
    trace('stop.failed', { reason, message, durationMs: Date.now() - started });
    show({ state: 'restarting', detail: 'Checking DO…', problem: `DO did not stop: ${message}` });
    if (!pages.size) { choices = windowChoices(); pageSeen = false; await openWindow(); }
    return;
  }
  trace('stop.done', { reason, durationMs: Date.now() - started });
  show({ state: 'stopped', detail: 'DO has stopped on this computer. You can close this.' });
  await pause(200);
  surface?.child?.kill();
  await fs.rm(path.join(dir, 'window.json'), { force: true });
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(`signal-${signal}`));
// Dying here would leave DO running with no window, so a mistake is recorded and survived.
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, (error) => trace('launcher.error', { message: String(error?.stack || error).slice(0, 600) }));

// ---------------------------------------------------------------- a second click
// Only the first launcher stays; another click just brings its window forward.
const lockPath = path.join(dir, 'window.json');
const readClaim = () => fs.readFile(lockPath, 'utf8').then(JSON.parse, () => null);
async function askFirstLauncher() {
  const first = await readClaim();
  if (!first?.url) return false;
  try {
    const response = await fetch(new URL('action', first.url), { method: 'POST', body: JSON.stringify({ action: 'focus' }), signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch { return false; }
}
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** True when this launcher is the one that stays. A claim nobody answers for is left over. */
async function claimWindow() {
  for (let attempt = 0; ; attempt++) {
    if (await askFirstLauncher()) return false;
    try {
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, url: windowUrl }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const first = await readClaim();
    if (!first?.pid || !running(first.pid) || attempt >= 12) await fs.rm(lockPath, { force: true });
    else await pause(250);
  }
}

// ---------------------------------------------------------------- the page and its requests
const key = crypto.randomBytes(24).toString('hex');
const assets = {
  '': ['scripts/launcher-window.html', 'text/html; charset=utf-8'],
  'styles.css': ['server/public/styles.css', 'text/css; charset=utf-8'],
  'icon.png': ['scripts/launcher-icon.png', 'image/png'],
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://launcher');
  // The key is the only thing that opens this. The Host check stops DNS rebinding.
  if (req.headers.host !== `127.0.0.1:${server.address().port}` || !url.pathname.startsWith(`/${key}/`)) {
    res.writeHead(404);
    return res.end();
  }
  const route = url.pathname.slice(key.length + 2);
  const asset = assets[route];
  if (req.method === 'GET' && asset) {
    const body = await fs.readFile(path.join(root, asset[0])).catch(() => null);
    res.writeHead(body ? 200 : 404, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'" });
    return res.end(body);
  }
  if (req.method === 'GET' && route === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    pages.add(res);
    if (!pageSeen) { pageSeen = true; trace('page.connected', { kind: surface?.kind, durationMs: Date.now() - startedAt }); }
    clearTimeout(closeTimer);
    send(res, view);
    req.once('close', () => pages.delete(res));
    return undefined;
  }
  if (req.method === 'POST' && route === 'action') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
    let request = {};
    try { request = JSON.parse(body); } catch { /* answered below */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return act(request);
  }
  res.writeHead(404);
  return res.end();
});

function act({ action, state }) {
  if (action === 'shown') return trace('page.shown', { state: String(state).slice(0, 20) });
  if (action === 'copied') return trace('action.copied');
  if (action === 'open') return openDo('button');
  if (action === 'get-tailscale') {
    trace('action.get-tailscale');
    return openExternal('https://tailscale.com/download');
  }
  if (action === 'stop') return shutdown('stop-button');
  if (action === 'retry') {
    trace('action.retry');
    if (!starter && view.state === 'offline') start();
    return undefined;
  }
  // The page is going away. A reload comes straight back; a closed window does not.
  if (action === 'closing') {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!pages.size) shutdown('window-closed'); }, 3000);
    return undefined;
  }
  if (action === 'focus') {
    trace('window.focus', { pages: pages.size });
    if (!windowIsAppearing() && surface?.kind !== 'none') {
      choices = windowChoices();
      pageSeen = false;
      return openWindow();
    }
    surface?.focus?.();
    for (const page of pages) send(page, { focus: true });
  }
  return undefined;
}

// ---------------------------------------------------------------- starting
async function start() {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then start DO again.');
    port = await loadNodeConfig(root);
    otherCopy = '';
    const found = await api('/api/cluster/status').catch(() => null);
    if (found?.self) {
      if (!ours()) return refuseOtherCopy(found.self);
      trace('server.attached');
      return undefined;
    }
    startServer();
  } catch (error) {
    trace('server.failed', { message: String(error.message).slice(0, 300) });
    show({ state: 'offline', detail: error.message });
  }
  return undefined;
}

/** Linux has no double-clickable file everywhere, so DO goes in the apps menu instead. */
async function addToLinuxAppsMenu() {
  if (process.platform !== 'linux' || /["$`%\\\n]/.test(root)) return;
  const folder = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'distributed-orchestrator.desktop'), `[Desktop Entry]
Type=Application
Name=DO
Comment=Start The DO on this computer
Exec="${root}/Start DO.sh"
Icon=${root}/scripts/launcher-icon.png
Terminal=false
Categories=Development;
`);
}

openLog();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
windowUrl = `http://127.0.0.1:${server.address().port}/${key}/`;
if (!await claimWindow()) {
  trace('launcher.second-click');
  process.exit(0);
}
trace('launcher.start', { parent: process.env.TERM_PROGRAM ? 'terminal' : 'desktop' });
if (process.platform === 'darwin') await fs.rm(path.join(root, 'Launch Distributed Orchestrator.app'), { recursive: true, force: true }).catch(() => {});
await addToLinuxAppsMenu().catch((error) => trace('apps-menu.failed', { message: String(error.message).slice(0, 200) }));
choices = windowChoices();
// The window can take seconds to build the first time; DO does not wait for it.
const windowReady = openWindow();
await start();
let watching = false;
setInterval(() => {
  if (watching) return;
  watching = true;
  watch().catch((error) => trace('watch.failed', { message: String(error.message).slice(0, 200) })).finally(() => { watching = false; });
}, 2000);
setInterval(() => { for (const page of pages) { try { page.write(': alive\n\n'); } catch { /* it is closing */ } } }, 15000).unref();
await windowReady;
await watch().catch(() => {});
