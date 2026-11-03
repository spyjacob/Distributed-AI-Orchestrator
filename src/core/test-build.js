/**
 * Testing DO's own changes on this computer before they are pushed.
 *
 * A DO tab edits a private worktree, so the server cannot simply run what is on
 * disk: several tabs may be mid-edit, and a half-written file must never take DO
 * down. When a tab finishes a turn, its files are recorded as a snapshot commit.
 * A test build is the published checkout plus every snapshot, merged in a worktree
 * of its own under .git/harness-builds. It is what the next Push would produce,
 * so the thing you test is the thing you publish.
 *
 * Changes that only touch the interface swap in without a restart. Anything else
 * passes a trial start on a scratch port and data folder, then DO restarts itself
 * once nothing is running. server/boot.js starts the build and falls back to
 * published code if it will not start, so a bad change cannot lock you out.
 *
 * The record is <data>/test-build.json: one DO instance, one test build. It is never
 * replicated; other computers only see what /api/harness/status reports.
 *
 * Node built-ins only: server/boot.js loads this before anything else.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { atomicFile } from './atomic-file.js';

const exec = promisify(execFile);
const identity = ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost', '-c', 'commit.gpgsign=false'];
async function git(dir, args, env) {
  const { stdout } = await exec('git', [...identity, ...args], { cwd: dir, timeout: 120_000, maxBuffer: 8e6, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  return stdout.trim();
}

/** Files that take effect without replacing the running process. */
const NO_RESTART = [/^server\/public\//, /^(docs|test|tests)\//, /\.md$/, /^VERSION$/, /^\.harness-next-version$/, /^\.gitignore$/];
const needsRestart = (file) => !NO_RESTART.some((pattern) => pattern.test(file));

const lines = (text) => text.split('\n').filter(Boolean);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const exists = (target) => fs.stat(target).then(() => true, () => false);
const message = (error) => String(error?.message || error).trim().slice(0, 600);
export const describeFiles = (count) => `${count} unpushed file${count === 1 ? '' : 's'}`;

const statePath = (dataDir) => path.join(dataDir, 'test-build.json');
const buildsDir = (root) => path.join(root, '.git', 'harness-builds');
/** Instances sharing a checkout (a test server, say) must never touch each other's builds. */
const owner = (dataDir) => sha256(path.resolve(dataDir)).slice(0, 8);

async function readState(dataDir) {
  try {
    const saved = JSON.parse(await fs.readFile(statePath(dataDir), 'utf8'));
    return { tabs: saved.tabs || {}, current: saved.current || null, failure: saved.failure || null };
  } catch { return { tabs: {}, current: null, failure: null }; }
}
const writeState = (dataDir, state) => atomicFile(statePath(dataDir), JSON.stringify(state));

/** Only a primary checkout runs test builds; tab worktrees, archives and test copies never do. */
export async function available(root) {
  return Boolean((await fs.stat(path.join(root, '.git')).catch(() => null))?.isDirectory());
}

/** The tab exactly as it stands, as a commit, without touching its index or files. */
export async function snapshotTab(dir) {
  const index = path.join(os.tmpdir(), `do-test-build-${crypto.randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', 'HEAD'], env);
    await git(dir, ['add', '-A'], env);
    const tree = await git(dir, ['write-tree'], env);
    const head = await git(dir, ['rev-parse', 'HEAD']);
    if (tree === await git(dir, ['rev-parse', 'HEAD^{tree}'])) return head;
    return await git(dir, ['commit-tree', tree, '-p', head, '-m', 'DO test build snapshot']);
  } finally {
    await fs.rm(index, { force: true }).catch(() => {});
    await fs.rm(`${index}.lock`, { force: true }).catch(() => {});
  }
}

async function removeBuild(root, dir) {
  await git(root, ['worktree', 'remove', '--force', dir]).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function pruneBuilds(root, dataDir, keep) {
  const kept = new Set(keep.filter(Boolean).map((dir) => path.basename(dir)));
  const names = (await fs.readdir(buildsDir(root)).catch(() => []))
    .filter((name) => name.startsWith(`${owner(dataDir)}-`) && !kept.has(name));
  for (const name of names) await removeBuild(root, path.join(buildsDir(root), name));
  if (names.length) await git(root, ['worktree', 'prune']).catch(() => {});
}

/** Snapshots hang off no branch; keep Git from collecting one a tab still needs. */
async function protectSnapshots(root, dataDir, state) {
  const prefix = `refs/harness/test/${owner(dataDir)}/`;
  const wanted = new Map(Object.entries(state.tabs).map(([id, tab]) => [prefix + sha256(id).slice(0, 24), tab.snapshot]));
  for (const line of lines(await git(root, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]))) {
    const [ref, commit] = line.split(' ');
    if (!wanted.has(ref)) await git(root, ['update-ref', '-d', ref]);
    else if (wanted.get(ref) === commit) wanted.delete(ref);
  }
  for (const [ref, commit] of wanted) await git(root, ['update-ref', ref, commit]);
}

const orderedTabs = (state) => Object.entries(state.tabs).sort((a, b) => a[1].at - b[1].at);

/**
 * Published code plus every recorded tab, oldest first. A tab that conflicts is
 * left out and reported, not fatal. No build when nothing differs from published.
 */
async function assemble(root, dataDir, state) {
  const base = await git(root, ['rev-parse', 'HEAD']);
  const tabs = orderedTabs(state);
  if (!tabs.length) return { build: null, conflicts: [], base };
  const id = `${owner(dataDir)}-${sha256(JSON.stringify([base, ...tabs.map(([session, tab]) => [session, tab.snapshot])])).slice(0, 12)}`;
  const dir = path.join(buildsDir(root), id);
  if (state.current?.id === id && await exists(path.join(dir, 'server'))) return { build: state.current, conflicts: state.current.conflicts || [], base };
  await removeBuild(root, dir);
  await fs.mkdir(buildsDir(root), { recursive: true });
  await git(root, ['worktree', 'prune']).catch(() => {});
  await git(root, ['worktree', 'add', '--detach', '--force', dir, base]);
  const included = [], conflicts = [];
  for (const [session, tab] of tabs) {
    const before = await git(dir, ['rev-parse', 'HEAD']);
    try {
      await git(dir, ['merge', '--no-edit', '--no-ff', '--no-verify', '-m', 'DO test build', tab.snapshot]);
      if (await git(dir, ['rev-parse', 'HEAD']) !== before) included.push({ session, name: tab.name });
    } catch {
      const files = lines(await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''));
      await git(dir, ['merge', '--abort']).catch(() => {});
      conflicts.push({ session, name: tab.name, files: files.slice(0, 20) });
    }
  }
  const files = lines(await git(dir, ['diff', '--name-only', base, 'HEAD']));
  if (!files.length) {
    await removeBuild(root, dir);
    return { build: null, conflicts, base };
  }
  return { base, conflicts, build: { id, dir, base, commit: await git(dir, ['rev-parse', 'HEAD']),
    tabs: included, conflicts, files: files.length, changed: files.slice(0, 2000) } };
}

/** Called by server/boot.js. Returns the code to run, or null for published code. */
export async function prepareBoot(root, dataDir) {
  if (!await available(root)) return null;
  const state = await readState(dataDir);
  if (!Object.keys(state.tabs).length) {
    if (state.current) await writeState(dataDir, { ...state, current: null });
    await pruneBuilds(root, dataDir, []);
    return null;
  }
  const { build, conflicts } = await assemble(root, dataDir, state);
  state.current = build ? { ...build, conflicts } : null;
  await writeState(dataDir, state);
  await pruneBuilds(root, dataDir, [build?.dir]);
  if (!build) return null;
  return { id: build.id, entry: pathToFileURL(path.join(build.dir, 'server', 'index.js')).href };
}

/** The build would not start: take its tabs off the record so it is not retried. */
export async function bootFailed(dataDir, boot, error) {
  const state = await readState(dataDir);
  const tabs = state.current?.id === boot.id ? state.current.tabs : [];
  for (const tab of tabs) delete state.tabs[tab.session];
  state.failure = { at: Date.now(), tabs, message: message(error) };
  state.current = null;
  await writeState(dataDir, state);
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/**
 * Start the build on a scratch port and data folder, so a change that cannot start
 * is caught with DO still running. It must also serve the page used to get back
 * to published code. Throws what the process printed.
 */
export async function trialStart(dir, { timeoutMs = 45_000 } = {}) {
  const port = await freePort();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'do-test-build-'));
  const token = crypto.randomUUID();
  const { ORCHESTRATOR_RESTART_ID: _restart, ...env } = process.env;
  const child = spawn(process.execPath, [path.join(dir, 'server', 'boot.js')], { cwd: dir, windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...env, HARNESS_PORT: String(port), HARNESS_DATA_DIR: data, HARNESS_TOKEN: token, ORCHESTRATOR_TEST_BUILDS: 'trial',
      ORCHESTRATOR_PUBLIC_URL: `http://127.0.0.1:${port}`, ORCHESTRATOR_NODE_NAME: 'test-build-trial' } });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-1500); });
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  const ask = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-harness-token': token }, signal: AbortSignal.timeout(2000) });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(errors.trim() || `It exited with code ${child.exitCode}.`);
      try {
        const [page, back, status] = await Promise.all([ask('/'), ask('/test-build'), ask('/api/harness/status')]);
        // The status route may answer 503 while Tailscale is down; 500 means it broke.
        if (page.ok && back.ok && status.status !== 500) return;
      } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(errors.trim() || 'It did not start in time.');
  } finally {
    child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    await fs.rm(data, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** A syntax error in the interface would leave a blank page; catch it before anyone reloads. */
async function checkInterface(build) {
  for (const file of build.changed.filter((name) => /^server\/public\/.*\.js$/.test(name))) {
    try { await exec(process.execPath, ['--check', path.join(build.dir, file)], { timeout: 30_000, windowsHide: true }); }
    catch (error) { throw new Error(`${file}: ${String(error.stderr || error.message).trim().slice(0, 600)}`); }
  }
}

/**
 * What the running server does with test builds.
 *
 * @param root     the checkout (HARNESS_ROOT)
 * @param codeDir  where this process actually loaded its code from
 * @param enabled  false in test servers and trial starts
 * @param adopt    serve this directory's interface and report what now runs
 * @param restart  replace this process; rejects with {busy:true} when it must wait
 * @param busy     is anything running that a restart would interrupt
 */
export async function createTestBuilds({ root, codeDir, dataDir, enabled: allowed = true, adopt, restart, busy, record = () => {} }) {
  const enabled = allowed && await available(root);
  const codeCommit = enabled ? await git(codeDir, ['rev-parse', 'HEAD']).catch(() => '') : '';
  let queue = Promise.resolve();
  let waiting = false, lastError = null, servingDir = codeDir;
  const serial = (work) => {
    const task = queue.catch(() => {}).then(work);
    queue = task;
    return task;
  };

  /** Bring the server in line with the record: swap now, or queue a restart. */
  async function apply(state, { mayRestart = true, tryStart = true, traceId } = {}) {
    const started = Date.now();
    const { build, conflicts, base } = await assemble(root, dataDir, state);
    const commit = build?.commit || base;
    const restartNeeded = lines(await git(root, ['diff', '--name-only', codeCommit, commit])).some(needsRestart);
    try {
      if (build?.changed.includes('package-lock.json')) throw Object.assign(new Error('They change dependencies, which only load after a Push and restart.'), { stage: 'dependencies' });
      if (build) await checkInterface(build);
      if (build && restartNeeded && tryStart) await trialStart(build.dir);
    } catch (error) {
      await pruneBuilds(root, dataDir, [codeDir, servingDir, state.current?.dir]);
      throw error;
    }
    state.current = build ? { ...build, conflicts } : null;
    await writeState(dataDir, state);
    await protectSnapshots(root, dataDir, state).catch(() => {});
    if (restartNeeded) waiting ||= mayRestart;
    else {
      waiting = false;
      servingDir = build?.dir || root;
      await adopt({ dir: servingDir, commit, base, build: state.current });
    }
    await pruneBuilds(root, dataDir, [codeDir, servingDir, build?.dir]);
    record('test-build.applied', { correlationId: traceId, outcome: restartNeeded ? 'restart' : 'swapped', count: build?.files || 0, durationMs: Date.now() - started });
    return { build: state.current, conflicts, restartNeeded, waiting };
  }

  return {
    enabled,
    /** A tab finished with changes: run them here. Never rejects; reports what went wrong. */
    tabFinished(session, { traceId } = {}) {
      if (!enabled || !session.tabWorkspace) return Promise.resolve(null);
      return serial(async () => {
        const state = await readState(dataDir);
        const snapshot = await snapshotTab(session.tabWorkspace.dir);
        state.tabs[session.id] = { name: session.name, snapshot, at: state.tabs[session.id]?.at ?? Date.now() };
        state.failure = null;
        const result = await apply(state, { traceId });
        if (lastError?.session === session.id) lastError = null;
        return { ...result, conflict: result.conflicts.find((entry) => entry.session === session.id) };
      }).catch((error) => {
        // Nothing was written, so whatever already runs here keeps running.
        lastError = { session: session.id, name: session.name, stage: error.stage || 'start', message: message(error) };
        record('test-build.rejected', { correlationId: traceId, outcome: lastError.stage });
        return { error: lastError.message, stage: lastError.stage };
      });
    },
    /**
     * Discarded, deleted or reverted: this tab no longer belongs in the build. A Push
     * also moves the published branch, so it looks again even for an unrecorded tab.
     */
    tabDone(session, { published = false } = {}) {
      if (!enabled) return Promise.resolve(null);
      return serial(async () => {
        const state = await readState(dataDir);
        const recorded = Boolean(state.tabs[session.id]);
        delete state.tabs[session.id];
        if (lastError?.session === session.id) lastError = null;
        // Off the record for good, even if what remains fails to build just now.
        if (recorded) await writeState(dataDir, state);
        return recorded || published ? apply(state, { tryStart: false }) : null;
      }).catch((error) => {
        lastError = { stage: 'update', message: message(error) };
        return { error: lastError.message };
      });
    },
    /** Back to published code; every tab keeps its changes. */
    stop() {
      if (!enabled) return Promise.resolve(null);
      return serial(async () => {
        const state = await readState(dataDir);
        lastError = null;
        return apply({ ...state, tabs: {}, failure: null }, { tryStart: false });
      });
    },
    /** The published branch moved: rebuild on it, and swap if no restart is needed. */
    mainMoved() {
      if (!enabled) return Promise.resolve(null);
      return serial(async () => apply(await readState(dataDir), { mayRestart: false, tryStart: false }))
        .catch((error) => {
          lastError = { stage: 'update', message: message(error) };
          return { error: lastError.message };
        });
    },
    /** Restart if one is queued and nothing would be interrupted. Retried after each turn. */
    async restartIfWaiting() {
      if (!enabled || !waiting || busy()) return false;
      waiting = false;
      try { await restart(); return true; }
      catch (error) {
        if (error.busy) waiting = true;
        else lastError = { stage: 'restart', message: message(error) };
        return false;
      }
    },
    async status() {
      const state = await readState(dataDir);
      return { enabled, waiting, error: lastError, failure: state.failure,
        tabs: orderedTabs(state).map(([session, tab]) => ({ session, name: tab.name })),
        conflicts: state.current?.conflicts || [] };
    },
    async tabStatus(id) {
      if (!enabled) return null;
      const state = await readState(dataDir);
      return { recorded: Boolean(state.tabs[id]), waiting,
        conflict: state.current?.conflicts?.find((entry) => entry.session === id) || null,
        error: lastError?.session === id ? lastError.message : null };
    },
    /** A failed start, handed over once so its tabs can be told. */
    async takeFailure() {
      if (!enabled) return null;
      const state = await readState(dataDir);
      if (!state.failure || state.failure.reported) return null;
      state.failure.reported = true;
      await writeState(dataDir, state);
      return state.failure;
    },
    /** The build this process started from, if any. */
    async runningBuild() {
      if (!enabled || path.resolve(codeDir) === path.resolve(root)) return null;
      const state = await readState(dataDir);
      return state.current?.dir && path.resolve(state.current.dir) === path.resolve(codeDir) ? state.current : null;
    },
  };
}
