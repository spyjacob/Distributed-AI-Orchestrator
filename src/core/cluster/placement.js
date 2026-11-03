/** Which machines keep a copy of each project, and keeping those copies real.
 *
 * An app lists its machines in `hosts` (replicated with the app record). Every
 * host reconciles its own disk against that list: it clones projects placed on
 * it from their Git remote, fast-forwards clean copies so work pushed from
 * another machine arrives, and removes its copy when taken off the list — but
 * only once the copy has nothing uncommitted, stashed or unpushed. A copy that
 * is not safe to remove is kept and reported instead. Files never travel
 * through the cluster log; Git is the transport.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { run as git, githubRepoIdentity } from '../git.js';
import { refuseToDeleteDir } from '../apps.js';
import { HARNESS_APP_ID } from '../harness-guard.js';

const exists = (p) => fs.stat(p).then(() => true, () => false);
const slug = (s) => String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
const sameRepo = (a, b) => Boolean(a && b) && (a === b || (githubRepoIdentity(a) && githubRepoIdentity(a) === githubRepoIdentity(b)));

/** The machines an app lives on. Apps from before placement live where they were made. */
export function hostsFor(app, selfId) {
  return Array.isArray(app.hosts) && app.hosts.length ? app.hosts : [app.ownerNode || selfId];
}

/** Check a requested machine list against the cluster's members. */
export function validHosts(hosts, members) {
  if (!Array.isArray(hosts)) throw new Error('Choose the machines as a list.');
  const ids = [...new Set(hosts.map(String))];
  if (!ids.length) throw new Error('Choose at least one machine for this project.');
  const unknown = ids.filter((id) => !members.some((m) => m.id === id));
  if (unknown.length) throw new Error('One of those machines is not part of this system.');
  return ids;
}

/** Replication adds copies without moving the app's owning computer. */
export function replicationHosts(hosts, members, owner) {
  const ids = validHosts(hosts, members);
  if (!ids.includes(owner)) throw new Error('Keep the app host selected. Other computers are optional replicas.');
  return ids;
}

/** Why a copy cannot be deleted yet, or null when every change in it is pushed. */
export async function unsafeToRemove(dir, run = git) {
  if (!(await exists(dir))) return null;
  const top = await run(['rev-parse', '--show-toplevel'], dir);
  if (!top.ok || path.resolve(top.out) !== path.resolve(await fs.realpath(dir))) return 'it is not a Git repository, so nothing proves its files are saved elsewhere';
  const trees = (await run(['worktree', 'list', '--porcelain'], dir)).out.split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  for (const tree of trees.length ? trees : [dir]) {
    const dirty = await run(['status', '--porcelain'], tree);
    if (!dirty.ok || dirty.out) return `it has uncommitted changes${tree === (trees[0] || dir) ? '' : ` in tab ${path.basename(tree)}`}`;
  }
  if ((await run(['stash', 'list'], dir)).out) return 'it has stashed changes';
  if (!(await run(['remote'], dir)).out) return 'it has no remote to hold its history';
  if (!(await run(['fetch', '--quiet', '--all'], dir)).ok) return 'its remote could not be reached to confirm everything is pushed';
  const unpushed = await run(['log', '--branches', '--not', '--remotes', '--oneline'], dir);
  if (!unpushed.ok || unpushed.out) return 'it has commits that are not pushed';
  return null;
}

export function appPlacement(cluster, dataDir, {
  loadApps, running = () => false, run = git,
  base = path.join(os.homedir(), 'Projects'),
} = {}) {
  const file = path.join(dataDir, 'cluster', 'placements.json');
  let pending = null;
  let lastReport = '';
  let local = null;

  async function readLocal() {
    if (local) return local;
    try { local = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; local = {}; }
    return local;
  }
  async function saveLocal() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(local, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  /** The folder an app was made in is its copy on the host that made it —
   * unless that path here holds some other repository. */
  async function original(app) {
    if ((app.ownerNode || cluster.self.id) !== cluster.self.id || !app.dir || !(await exists(app.dir))) return false;
    if (!app.repo) return true;
    const remote = await run(['remote', 'get-url', 'origin'], app.dir);
    return !remote.ok || sameRepo(remote.out, app.repo);
  }

  /** A folder for a new copy that never lands on top of something else. */
  async function destination(app) {
    const name = slug(path.basename(app.dir || '') || app.name);
    for (const dir of [path.join(base, name), path.join(base, `${name}-${app.id.slice(-6)}`)]) {
      if (!(await exists(dir))) return { dir };
      // A clone of this very repository already there (made by hand, or by an
      // earlier run) is adopted rather than cloned twice.
      const remote = await run(['remote', 'get-url', 'origin'], dir);
      if (remote.ok && sameRepo(remote.out, app.repo)) return { dir, adopted: true };
    }
    throw new Error(`${path.join(base, name)} already holds something else; move it to make room`);
  }

  async function sync(dir) {
    const dirty = await run(['status', '--porcelain'], dir);
    if (!dirty.ok) return { state: 'error', error: 'its folder is not a readable Git repository' };
    if (!(await run(['rev-parse', '--abbrev-ref', '@{u}'], dir)).ok) return { state: 'ready' };
    if (dirty.out) return { state: 'ready', note: 'has local changes, so it was not updated from the remote' };
    const pull = await run(['pull', '--ff-only', '--quiet'], dir);
    if (!pull.ok) return { state: 'ready', note: `could not update from the remote: ${pull.err.split('\n')[0].slice(0, 160)}` };
    return { state: 'ready', syncedAt: Date.now() };
  }

  async function reconcileOnce() {
    const self = cluster.self.id;
    const apps = (await loadApps()).filter((a) => a && !a.builtin && !a.editsHarness && a.id !== HARNESS_APP_ID);
    const mine = await readLocal();
    const report = {};
    for (const app of apps) {
      const wanted = hostsFor(app, self).includes(self);
      let entry = mine[app.id];
      if (!entry && await original(app)) entry = mine[app.id] = { dir: app.dir, original: true };
      try {
        if (wanted) {
          if (entry && await exists(entry.dir)) {
            report[app.id] = running(app.id) ? { state: 'ready' } : await sync(entry.dir);
          } else if (!app.repo) {
            if ((app.ownerNode || self) === self) {
              // A brand-new project placed here gets an empty folder; Git
              // history starts with its first saved turn.
              const { dir } = await destination(app);
              await fs.mkdir(dir, { recursive: true });
              entry = mine[app.id] = { dir, original: true };
              report[app.id] = { state: 'ready' };
            } else {
              report[app.id] = { state: 'waiting', error: 'it has no Git remote yet; it can be copied here after its first push to GitHub' };
            }
          } else {
            const { dir, adopted } = await destination(app);
            if (!adopted) {
              await fs.mkdir(path.dirname(dir), { recursive: true });
              const clone = await run(['clone', '--quiet', app.repo, dir], path.dirname(dir), { timeout: 600_000 });
              if (!clone.ok) {
                await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
                throw new Error(`git clone failed: ${clone.err.split('\n').filter(Boolean).at(-1)?.slice(0, 200) || 'unknown error'}`);
              }
            }
            entry = mine[app.id] = { dir };
            report[app.id] = { state: 'ready', syncedAt: Date.now() };
          }
        } else if (entry) {
          if (running(app.id)) { report[app.id] = { state: 'removing', error: 'waiting for its running turn to finish' }; continue; }
          const reason = await unsafeToRemove(entry.dir, run) || refuseToDeleteDir(entry.dir);
          if (reason) { report[app.id] = { state: 'kept', error: `kept on this machine because ${reason}` }; continue; }
          await fs.rm(entry.dir, { recursive: true, force: true });
          delete mine[app.id];
        }
      } catch (e) {
        report[app.id] = { state: 'error', error: e.message };
      }
      if (mine[app.id] && report[app.id]) report[app.id].dir = mine[app.id].dir;
    }
    // A deleted app's folder is the delete dialog's decision, not ours: forget it, keep the files.
    for (const id of Object.keys(mine)) if (!apps.some((a) => a.id === id)) delete mine[id];
    await saveLocal();
    const published = JSON.stringify(report, (k, v) => (k === 'syncedAt' ? undefined : v));
    if (published !== lastReport && cluster.shared()) {
      await cluster.command({ type: 'value', id: 'placement:' + self, value: report });
      lastReport = published;
    }
    return report;
  }

  return {
    /** One pass at a time; a request during a pass waits for it and then runs again. */
    reconcile() {
      const next = (pending || Promise.resolve()).catch(() => {}).then(reconcileOnce);
      // The caller handles next's failure; this settled copy only sequences passes.
      const settled = next.catch(() => {}).finally(() => { if (pending === settled) pending = null; });
      pending = settled;
      return next;
    },
    /** This host's working copy of an app, if it has one. */
    async localDir(app) {
      const entry = (await readLocal())[app.id];
      if (entry && await exists(entry.dir)) return entry.dir;
      return hostsFor(app, cluster.self.id).includes(cluster.self.id) && await original(app) ? app.dir : null;
    },
    /** Per-machine placement and copy state for one app, for the UI. */
    describe(app) {
      const members = cluster.replica.members();
      const placed = hostsFor(app, cluster.self.id);
      return members.map((m) => {
        const r = cluster.replica.state.values['placement:' + m.id]?.[app.id];
        return { id: m.id, name: m.name, placed: placed.includes(m.id), state: r?.state || (placed.includes(m.id) ? 'pending' : null),
          error: r?.error || r?.note || null, dir: r?.dir || null };
      });
    },
  };
}
