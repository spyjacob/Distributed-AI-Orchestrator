import { atomicFile } from './atomic-file.js';
/** Per-tab working trees and serialized, tested integration into the project. */
import { documentAI } from './app-ai.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { githubEnv } from './github-auth.js';
import { commitAndPush, createPrivateRepo, githubCommitUrl } from './git.js';
import { HARNESS_APP_ID } from './harness-guard.js';
import { displayVersion, nextVersion } from './harness-version.js';
import { snapshotTab } from './test-build.js';

const exec = promisify(execFile);
const identity = ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost'];
async function git(dir, ...args) {
  const { stdout } = await exec('git', [...identity, ...args], { cwd: dir, env: await githubEnv(), timeout: 120_000, maxBuffer: 8e6 });
  return stdout.trim();
}
async function clean(dir) { return !(await git(dir, 'status', '--porcelain')); }
async function repository(dir) {
  const root = await git(dir, 'rev-parse', '--show-toplevel');
  const common = await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return { root: await fs.realpath(root), common: await fs.realpath(common) };
}
const queues = new Map();
// The file lock also excludes another harness process on the same host. Never
// steal a lock on timeout: leave recovery of an interrupted integration explicit.
async function locked(repo, action) {
  const previous = queues.get(repo.common) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const lock = path.join(repo.common, 'harness-integration.lock');
    try { await fs.mkdir(lock); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Another harness process holds the project integration lock. Retry after it finishes; an interrupted lock requires recovery.'); throw e; }
    try { return await action(); } finally { await fs.rmdir(lock); }
  });
  queues.set(repo.common, task);
  try { return await task; } finally { if (queues.get(repo.common) === task) queues.delete(repo.common); }
}

/** Pull only an idle, clean primary checkout, under the integration lock. */
export async function syncHarnessCheckout(dir, { busy = () => false } = {}) {
  const repo = await repository(dir);
  return locked(repo, async () => {
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    const branch = await git(repo.root, 'symbolic-ref', '--short', 'HEAD');
    const upstream = await git(repo.root, 'rev-parse', '--abbrev-ref', '@{u}');
    await git(repo.root, 'fetch', '--quiet');
    const latest = await git(repo.root, 'rev-parse', upstream);
    const available = Number(await git(repo.root, 'rev-list', '--count', `${head}..${latest}`)) > 0;
    if (busy()) return { head, latest, available, skipped: 'busy' };
    if (!await clean(repo.root)) return { head, latest, available, skipped: 'local changes' };
    if (busy() || !await clean(repo.root)
      || await git(repo.root, 'rev-parse', 'HEAD') !== head
      || await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== branch)
      return { head, latest, available, skipped: 'checkout changed or busy' };
    await git(repo.root, 'merge', '--ff-only', upstream);
    const updated = await git(repo.root, 'rev-parse', 'HEAD');
    return { head: updated, latest, published: updated === latest, available: false, updated: updated !== head };
  });
}

/**
 * DO's own repository is public, so its commits must not carry the address in
 * someone's global Git settings. Every tab shares this repository-level setting,
 * which also covers commits an AI makes. An identity chosen for it is kept.
 */
async function keepIdentityPrivate(repo) {
  for (const [key, value] of [['user.name', 'Distributed Orchestrator'], ['user.email', 'orchestrator@localhost']]) {
    const chosen = await git(repo.root, 'config', '--local', '--get', key).catch(() => '');
    if (!chosen) await git(repo.root, 'config', '--local', key, value);
  }
}

export async function prepareTab(session, { distributed = false, recover = false } = {}) {
  let repo;
  try { repo = await repository(session.projectDir); }
  catch {
    await git(session.projectDir, 'init', '-b', 'main');
    repo = await repository(session.projectDir);
  }
  return locked(repo, async () => {
    if (session.appId === HARNESS_APP_ID) await keepIdentityPrivate(repo);
    const previous = session.tabWorkspace;
    if (recover && previous?.root === repo.root && previous.common === repo.common) {
      if (await git(previous.dir, 'symbolic-ref', '--short', 'HEAD') !== previous.branch)
        throw new Error('Tab worktree is on an unexpected branch.');
      return previous;
    }
    const branch = await git(repo.root, 'symbolic-ref', '--short', 'HEAD');
    if (distributed) {
      if (!await clean(repo.root)) throw new Error('Commit the project’s local changes before syncing across computers.');
      await git(repo.root, 'fetch', 'origin', `refs/heads/${branch}`);
      await git(repo.root, 'merge', '--ff-only', 'FETCH_HEAD');
    }
    let head;
    try { head = await git(repo.root, 'rev-parse', 'HEAD'); }
    catch {
      await git(repo.root, 'add', '-A');
      await git(repo.root, 'commit', '--allow-empty', '-m', 'harness: initial project snapshot');
      head = await git(repo.root, 'rev-parse', 'HEAD');
    }
    if (!await clean(repo.root)) throw new Error('The shared project has uncommitted changes. Commit or move those changes before starting an isolated tab; they will not be included automatically.');
    const key = crypto.createHash('sha256').update(session.id).digest('hex').slice(0, 24);
    const dir = path.join(repo.common, 'harness-tabs', key);
    const tabBranch = `harness/tab-${key}`;
    await fs.mkdir(path.dirname(dir), { recursive: true });
    try { await fs.stat(dir); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const exists = await git(repo.root, 'branch', '--list', tabBranch);
      await git(repo.root, 'worktree', 'add', ...(exists ? [] : ['-b', tabBranch]), dir, exists ? tabBranch : head);
    }
    if (await git(dir, 'symbolic-ref', '--short', 'HEAD') !== tabBranch) throw new Error('Tab worktree is on an unexpected branch; restore its tab branch before continuing.');
    // Only synchronize clean trees. Pending edits and failed integrations remain
    // available to the same tab, including after a server restart.
    if (await clean(dir)) {
      try { await git(dir, 'merge', '--no-edit', head); }
      catch { await git(dir, 'merge', '--abort').catch(() => {}); }
    }
    const relative = path.relative(repo.root, await fs.realpath(session.projectDir));
    session.tabWorkspace = { root: repo.root, common: repo.common, dir, cwd: path.join(dir, relative), branch: tabBranch, target: branch };
    return session.tabWorkspace;
  });
}

/** Includes commits saved by an unsuccessful integration, not only dirty files. */
export async function tabHasUnpublishedWork(session) {
  const ws = session.tabWorkspace;
  if (!ws) return false;
  if (!await clean(ws.dir)) return true;
  return (await git(ws.dir, 'rev-list', '--count', `${ws.target}..HEAD`)) !== '0';
}

async function pendingFiles(ws) {
  const base = await git(ws.dir, 'merge-base', ws.target, 'HEAD');
  const tracked = await git(ws.dir, 'diff', '--name-only', '-z', base);
  const untracked = await git(ws.dir, 'ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
}

/** Describe all pending edits, including saved commits and untracked files. */
export async function pendingSummary(session) {
  const ws = session.tabWorkspace;
  if (!ws) return 'No pending changes.';
  const files = await pendingFiles(ws);
  if (!files.length) return await tabHasUnpublishedWork(session) ? 'Saved commits; no net file changes.' : 'No pending changes.';
  const areas = new Set(files.map(file =>
    /^(server\/public\/|.*\.(css|html)$)/.test(file) ? 'interface' :
    /^(test\/|tests\/)/.test(file) ? 'tests' :
    /^(docs\/|README|.*\.md$)/.test(file) ? 'documentation' :
    /^scripts\//.test(file) ? 'startup and scripts' :
    /^(server\/|src\/)/.test(file) ? 'application code' : 'project files'));
  return 'Changes to ' + [...areas].join(', ') + ' · ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '.';
}

async function validate(dir, log, base, signal) {
  await git(dir, 'diff', '--check', base, 'HEAD');
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let custom;
  try { custom = JSON.parse(await fs.readFile(path.join(dir, '.harness-integration.json'), 'utf8')).command; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (custom !== undefined && (typeof custom !== 'string' || !custom.trim())) throw new Error('.harness-integration.json needs a nonempty command string.');
  if (!custom && !pkg?.scripts?.test) throw new Error('No automated integration check configured. Add a package.json test script or .harness-integration.json with a command; the tab commit has been kept without changing the project.');
  const output = await fs.open(log, 'w');
  const run = async (command, args) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd: dir, detached: process.platform !== 'win32',
      stdio: ['ignore', output.fd, output.fd], windowsHide: true });
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const timer = setTimeout(stop, 600_000);
    signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', (e) => { cleanup(); reject(e); });
    child.once('close', (code) => {
      cleanup();
      if (code === 0 && !stopped) resolve();
      else reject(new Error(`Integration check ${stopped ? 'cancelled or timed out' : 'failed'} (${args.join(' ')}). See ${log}`));
    });
    if (signal?.aborted) stop();
  });
  try {
    if (custom) {
      await run(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', custom] : ['-c', custom]);
    } else {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) await run(npm, ['ci', '--no-audit', '--no-fund']);
      await run(npm, ['test']);
    }
  } finally { await output.close(); }
  if (!await clean(dir)) throw new Error('Integration checks changed tracked or unignored files; review the tab before integrating.');
}

/**
 * DO numbers its own releases. Bumped after the merge and checks, right before
 * publishing, so two tabs can never conflict over the number; a rejected push
 * drops this commit and numbers again on the newer base. A tab asks for a larger
 * step by leaving "minor" or "major" in .harness-next-version.
 */
const NEXT_VERSION = '.harness-next-version';
async function bumpVersion(ws) {
  const file = path.join(ws.dir, 'VERSION'), marker = path.join(ws.dir, NEXT_VERSION);
  const requested = await fs.readFile(marker, 'utf8').catch(() => null);
  const next = nextVersion(await fs.readFile(file, 'utf8').catch(() => '1.00'), requested?.trim().toLowerCase());
  await fs.writeFile(file, next + '\n');
  const shown = displayVersion(next);
  await git(ws.dir, 'add', '-A', '--', 'VERSION');
  if (requested !== null) {
    await fs.rm(marker, { force: true });
    await git(ws.dir, 'add', '-A', '--', NEXT_VERSION);
  }
  await git(ws.dir, 'commit', '-m', `harness: ${shown}`);
  return { commit: await git(ws.dir, 'rev-parse', 'HEAD'), shown };
}
async function dropBump(ws, bump) {
  if (bump && await git(ws.dir, 'rev-parse', 'HEAD') === bump.commit) await git(ws.dir, 'reset', '--hard', 'HEAD~1');
}

/**
 * Remove a tab's unpushed work: back to the published branch. Its files are kept
 * under refs/harness/discarded, so a mistaken discard can still be recovered with Git.
 */
export async function discardTab(session) {
  const ws = session.tabWorkspace;
  if (!ws) throw new Error('This tab has no changes to discard.');
  const repo = await repository(session.projectDir);
  if (repo.root !== ws.root || repo.common !== ws.common) throw new Error('The project moved; reopen the tab first.');
  return locked(repo, async () => {
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch) throw new Error('Tab branch changed; nothing was discarded.');
    const files = await pendingFiles(ws);
    const snapshot = await snapshotTab(ws.dir);
    const saved = `refs/harness/discarded/${path.basename(ws.dir)}/${Date.now()}`;
    await git(ws.dir, 'update-ref', saved, snapshot);
    await git(ws.dir, 'reset', '--hard', ws.target);
    await git(ws.dir, 'clean', '-fd');
    return { files: files.length, saved };
  });
}

async function commitLink(repo, sha, pushed) {
  if (!pushed) return null;
  const remote = await git(repo.root, 'remote', 'get-url', 'origin').catch(() => '');
  return githubCommitUrl(remote, sha);
}

async function publish(repo, target, options) {
  let pushed = false, created, reason = 'push disabled';
  if (options.push) {
    await options.beforePublish?.();
    try {
      const remotes = await git(repo.root, 'remote');
      if (!remotes.split('\n').includes('origin') && options.autoCreatePrivate) {
        const result = await createPrivateRepo(repo.root, target, options.appName, options.visibility);
        pushed = result.ok; created = result.repo; reason = result.reason;
      } else { await git(repo.root, 'push', '-u', 'origin', target); pushed = true; reason = null; }
    }
    catch (e) { reason = e.stderr || e.message; }
  }
  return { pushed, reason, created };
}

// Git's remote branch update is the cross-machine serialization point. A
// rejected push never updates the local target. Fetch, merge and test the new
// candidate again; never force-push or reuse checks against an older base.
async function fetchTarget(repo, target) {
  try {
    await git(repo.root, 'fetch', 'origin', `refs/heads/${target}`);
    return await git(repo.root, 'rev-parse', 'FETCH_HEAD');
  } catch (error) {
    // A newly configured remote may not have this branch yet. Still distinguish
    // that from authentication or connectivity failures before attempting a push.
    const advertised = await git(repo.root, 'ls-remote', '--heads', 'origin', `refs/heads/${target}`);
    if (!advertised) return null;
    throw error;
  }
}

async function checkWithRepair(ws, log, base, options) {
  const check = async () => {
    const head = await git(ws.dir, 'rev-parse', 'HEAD');
    await validate(ws.dir, log, base, options.signal);
    if (await git(ws.dir, 'rev-parse', 'HEAD') !== head) throw Error('Tab changed during checks; retry integration.');
  };
  try { await check(); }
  catch (error) {
    if (!options.repair || !error.message.startsWith('Integration check failed')) throw error;
    const before = await git(ws.dir, 'rev-parse', 'HEAD');
    await options.repair({ target: base, reason: 'checks-failed', conflicts: '', log });
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch || !await clean(ws.dir))
      throw Error('Check repair left unsaved work; publication stopped.');
    await git(ws.dir, 'merge-base', '--is-ancestor', before, 'HEAD');
    const alteredChecks = await git(ws.dir, 'diff', '--name-only', before, 'HEAD', '--', 'package.json', '.harness-integration.json', 'test', 'tests');
    if (alteredChecks) throw Error('Automatic repair changed check definitions. Work is saved, but review is required before publishing.');
    await check();
  }
}

async function mergeForIntegration(ws, target, options) {
  try { await git(ws.dir, 'merge', '--no-edit', target); }
  catch (error) {
    const conflicts = await git(ws.dir, 'diff', '--name-only', '--diff-filter=U');
    if (!conflicts || !options.repair) {
      await git(ws.dir, 'merge', '--abort').catch(() => {});
      throw error;
    }
    // Abort before repair: a failed/cancelled assistant leaves saved work,
    // rather than an unresolved index that prevents the next attempt.
    await git(ws.dir, 'merge', '--abort');
    const before = await git(ws.dir, 'rev-parse', 'HEAD');
    await options.repair({ target, reason: 'merge-conflict', conflicts });
    await git(ws.dir, 'merge-base', '--is-ancestor', before, 'HEAD');
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch || !await clean(ws.dir))
      throw Error('Merge repair left uncommitted work. Work is preserved; publication stopped.');
    await git(ws.dir, 'merge-base', '--is-ancestor', target, 'HEAD');
    // A conflict in the validation itself needs human review. Comparing both
    // parents prevents automatic repair from inventing weakened checks.
    for (const base of [before, target]) {
      const altered = await git(ws.dir, 'diff', '--name-only', base, 'HEAD', '--', 'package.json', 'package-lock.json', '.harness-integration.json', 'test', 'tests');
      if (altered) throw Error('Automatic merge repair affected check definitions. Work is saved; explicit review is required before publishing.');
    }
  }
}

export async function mergeTab(session, options = {}) {
  const ws = session.tabWorkspace;
  if (!ws) throw Error('Start a coding turn before merging this tab.');
  const repo = await repository(session.projectDir);
  if (repo.root !== ws.root || repo.common !== ws.common) throw Error('Project moved; reopen this tab.');
  return locked(repo, async () => {
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch) throw Error('Tab branch changed.');
    const saved = await commitAndPush(ws.dir, { push: false });
    if (!saved.ok) throw Error(saved.error || 'Could not save tab changes.');
    const before = await git(ws.dir, 'rev-parse', 'HEAD');
    const local = await git(repo.root, 'rev-parse', ws.target);
    const remote = await git(repo.root, 'remote', 'get-url', 'origin').catch(() => '');
    const target = remote ? await fetchTarget(repo, ws.target) : null;
    await mergeForIntegration(ws, local, options);
    if (target) await mergeForIntegration(ws, target, options);
    let candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    const log = path.join(repo.common, 'harness-tabs', `${path.basename(ws.dir)}-checks.log`);
    await options.onCheck?.();
    await checkWithRepair(ws, log, before, options);
    candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    options.signal?.throwIfAborted();
    if (!await clean(ws.dir) || await git(ws.dir, 'rev-parse', 'HEAD') !== candidate) throw Error('Tab changed during checks. Retry merge.');
    return { ok: true, merged: true, pushed: false, sha: candidate.slice(0, 8) };
  });
}

export async function readPublication(session) {
  const ws = session.tabWorkspace;
  if (!ws) return null;
  const directory = path.join(ws.common, 'harness-publications', path.basename(ws.dir));
  let names;
  try { names = (await fs.readdir(directory)).filter(n => n.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return names.length ? JSON.parse(await fs.readFile(path.join(directory,names.at(-1)), 'utf8')) : null;
}

async function integrateDistributed(repo, session, options) {
  const ws = session.tabWorkspace;
  const saved = await commitAndPush(ws.dir, { push: false });
  if (!saved.ok) return saved;
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    if (await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target || !await clean(repo.root))
      throw new Error('The project has local changes. Tab work is saved; integration is waiting.');
    const local = await git(repo.root, 'rev-parse', 'HEAD');
    const remote = await fetchTarget(repo, ws.target);
    try {
      await mergeForIntegration(ws, local, options);
      if (remote) await mergeForIntegration(ws, remote, options);
    } catch {
      await git(ws.dir, 'merge', '--abort').catch(() => {});
      throw new Error(`Changes from another computer conflict with this tab. Work is saved on ${ws.branch}; resolve the merge in this tab and retry integration.`);
    }
    let candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    if (candidate === remote) {
      await git(repo.root, 'merge', '--ff-only', remote);
      return { ok: true, skipped: 'no changes' };
    }
    const log = path.join(repo.common, 'harness-tabs', `${path.basename(ws.dir)}-checks.log`);
    session.integrationLog = log;
    await options.onCheck?.();
    await checkWithRepair(ws, log, remote || local, options);
    candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'rev-parse', 'HEAD') !== candidate || !await clean(ws.dir)
      || await git(repo.root, 'rev-parse', 'HEAD') !== local || !await clean(repo.root))
      throw new Error('Files changed during integration checks; retry integration.');
    const files = (await git(ws.dir, 'diff', '--name-only', local, candidate)).split('\n').filter(Boolean);
    await options.beforePublish?.();
    const bump = options.versionBump ? await bumpVersion(ws) : null;
    if (bump) candidate = bump.commit;
    const receipt = {version:1, candidate, target:ws.target, at:new Date().toISOString(), state:'remote-outcome-unknown'};
    const receiptFile = path.join(repo.common, 'harness-publications', path.basename(ws.dir), Date.now() + '-' + crypto.randomUUID() + '.json');
    await atomicFile(receiptFile, JSON.stringify(receipt));
    try { await git(ws.dir, 'push', 'origin', `${candidate}:refs/heads/${ws.target}`); }
    catch (e) {
      // Retry only a changed remote tip, never an uncertain unchanged failure.
      let latest;
      try { latest = await fetchTarget(repo, ws.target); }
      catch (error) { error.publication = receipt; await dropBump(ws, bump).catch(() => {}); throw error; }
      const included = latest && await git(ws.dir,'merge-base','--is-ancestor',candidate,latest).then(()=>true,()=>false);
      if (included) { /* Published, even if another publisher advanced again. */ }
      else if (latest !== remote) {
        await dropBump(ws, bump);
        await options.onWaiting?.('Another computer published first; merging and checking its changes.');
        continue;
      } else { e.publication = receipt; await dropBump(ws, bump).catch(() => {}); throw e; }
    }
    receipt.state = 'published';
    let warning = null;
    try { await atomicFile(receiptFile, JSON.stringify(receipt)); }
    catch (error) { warning = 'Published, but receipt persistence failed: ' + error.message; }
    try { await git(repo.root, 'merge', '--ff-only', candidate); receipt.localCheckout = 'updated'; }
    catch (error) { receipt.localCheckout = 'pending'; warning = 'Published; local checkout update failed: ' + (error.stderr || error.message); }
    try { await atomicFile(receiptFile, JSON.stringify(receipt)); }
    catch (error) { warning ||= 'Published, but receipt persistence failed: ' + error.message; }
    return { ok: true, integrated: receipt.localCheckout === 'updated', pushed: true, committed: true, sha: candidate.slice(0, 8), version: bump?.shown, publication:receipt, warning, commitUrl: await commitLink(repo, candidate, true).catch(()=>null), files };
  }
  throw new Error('Other computers are still publishing changes. Tab work is saved; retry integration when they finish.');
}

export async function integrateTab(session, options = {}) {
  const ws = session.tabWorkspace;
  if (!ws) throw new Error('This session has no isolated worktree. Start a coding turn before integrating.');
  const repo = await repository(session.projectDir);
  if (repo.root !== ws.root || repo.common !== ws.common) throw new Error('The project moved; reopen the tab before integrating.');
  return locked(repo, async () => {
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch) throw new Error('Tab branch changed; integration stopped.');
    options.signal?.throwIfAborted();
    if (options.aiDependencies !== undefined) await documentAI(ws.dir, options.aiDependencies);
    if (options.recordTurn) {
      const saved = await commitAndPush(ws.dir, { push: false });
      if (!saved.ok) return saved;
      if (!saved.committed) await git(ws.dir, 'commit', '--allow-empty', '-m', 'harness: chat completed (no file changes)');
    }
    const remote = await git(repo.root, 'remote', 'get-url', 'origin').catch(() => '');
    if (remote && (options.distributed || options.push)) return integrateDistributed(repo, session, options);
    if (options.distributed && !remote && !options.autoCreatePrivate) throw new Error('Connect a remote before publishing this shared project.');
    const saved = await commitAndPush(ws.dir, { push: false });
    if (!saved.ok) return saved;
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    if (await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target || !await clean(repo.root)) {
      throw new Error('Shared project changed or has uncommitted edits. Tab work is saved; integration postponed.');
    }
    const tabHead = await git(ws.dir, 'rev-parse', 'HEAD');
    const ahead = await git(ws.dir, 'rev-list', '--count', `${head}..${tabHead}`);
    if (ahead === '0') {
      if (!options.retryPush) return { ok: true, skipped: 'no changes' };
      const publication = await publish(repo, ws.target, options);
      return { ok: true, integrated: true, sha: head.slice(0, 8), files: [], ...publication, commitUrl: await commitLink(repo, head, publication.pushed) };
    }
    try { await mergeForIntegration(ws, head, options); }
    catch {
      await git(ws.dir, 'merge', '--abort').catch(() => {});
      throw new Error(`Merge conflict. Work is saved on ${ws.branch}. In this tab, merge ${head}, resolve the conflicts, and retry. The shared project was not changed.`);
    }
    let candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    const log = path.join(repo.common, 'harness-tabs', `${path.basename(ws.dir)}-checks.log`);
    session.integrationLog = log;
    await options.onCheck?.();
    await checkWithRepair(ws, log, head, options);
    candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'rev-parse', 'HEAD') !== candidate || !await clean(ws.dir)) throw new Error('Tab changed during checks; retry integration.');
    if (await git(repo.root, 'rev-parse', 'HEAD') !== head || !await clean(repo.root)
      || await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target) throw new Error('Shared project changed during checks; retry integration.');
    const files = (await git(ws.dir, 'diff', '--name-only', head, candidate)).split('\n').filter(Boolean);
    const bump = options.versionBump ? await bumpVersion(ws) : null;
    if (bump) candidate = bump.commit;
    await git(repo.root, 'merge', '--ff-only', candidate);
    // Publish the integrated target, never the private tab branch. A push failure
    // leaves the validated commit in the local project for a later retry.
    const publication = await publish(repo, ws.target, options);
    return { ok: true, committed: true, integrated: true, sha: candidate.slice(0, 8), version: bump?.shown, files, ...publication, commitUrl: await commitLink(repo, candidate, publication.pushed) };
  });
}
