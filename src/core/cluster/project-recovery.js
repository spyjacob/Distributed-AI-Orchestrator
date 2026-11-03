import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyCommand, atomic } from './raft.js';

// Only the server reads its recovery archives. The API exposes project summaries,
// never the credentials, private transcript text or settings in those archives.
export function projectRecovery(cluster, dir, revision = null, observe = () => {}) {
  const root = path.join(dir, 'cluster');
  const traceFile = path.join(root, 'project-recovery-trace.json');
  let traceQueue = Promise.resolve();
  async function trace(event, details = {}) {
    try { await observe(event, details); } catch {}
    traceQueue = traceQueue.catch(() => {}).then(async () => {
      const rows = await read(traceFile).catch(() => []);
      const bounded = Object.fromEntries(Object.entries(details).map(([key, value]) =>
        [key, typeof value === 'string' ? value.slice(0, 160) : value]));
      rows.push({ at: new Date().toISOString(), version: 1, revision, host: cluster.self.id, event, ...bounded });
      await atomic(traceFile, rows.slice(-200));
    }).catch(() => {});
    await traceQueue;
  }
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  async function candidates() {
    const records = new Map(), sessions = new Map(), values = {};
    const acceptSession = s => {
      if (!s?.id || !s.appId || s.appId === '__harness') return;
      if (!sessions.has(s.id) || (s.updatedAt || 0) > (sessions.get(s.id).updatedAt || 0)) sessions.set(s.id, s);
    };
    const acceptApp = a => {
      if (!a?.id || a.id === '__harness' || a.builtin) return;
      if (!records.has(a.id) || (a.updatedAt || 0) > (records.get(a.id).updatedAt || 0)) records.set(a.id, a);
    };
    let unreadable = 0;
    for (const name of (await fs.readdir(root)).filter(n => /^(before-join-|conflict-).*\.json$/.test(n) && !n.endsWith('-snapshot.json')).sort()) {
      try {
        const saved = await read(path.join(root, name));
        const disk = saved.disk || saved;
        const snapshot = saved.snapshot || await read(path.join(root, name.replace(/\.json$/, '-snapshot.json'))).catch(() => null);
        const state = structuredClone(snapshot?.state || { sessions: {}, values: {}, history: {}, viewers: {} });
        for (let i = 0; i < (disk.log || []).length; i++) {
          const index = (disk.base || 0) + i + 1;
          if (index > (snapshot?.index || 0) && index <= disk.commit) applyCommand(state, disk.log[i].command);
        }
        for (const a of JSON.parse(state.values['settings:apps.json'] || '{"apps":[]}').apps) acceptApp(a);
        Object.values(state.sessions).forEach(acceptSession);
        for (const [id, value] of Object.entries(state.values)) if (id.startsWith('asset:')) values[id] = value;
      } catch { unreadable++; }
    }
    const local = await read(path.join(dir, 'apps.json')).catch(() => ({ apps: [] }));
    local.apps.forEach(acceptApp);
    for (const name of await fs.readdir(path.join(dir, 'sessions')).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try { acceptSession(await read(path.join(dir, 'sessions', name))); } catch { unreadable++; }
    }
    Object.values(cluster.replica.state.sessions).forEach(acceptSession);
    for (const s of sessions.values()) if (!records.has(s.appId) && s.projectDir) {
      const basename = s.projectDir.includes('\\') ? path.win32.basename : path.basename;
      records.set(s.appId, { id: s.appId, name: basename(s.projectDir), dir: s.projectDir,
        ownerNode: s.ownerNode || cluster.self.id, start: '', recoveredFromSession: true });
    }
    const current = await cluster.readProjects();
    return { records: [...records.values()].filter(a => !current.some(c => c.id === a.id)), sessions, values, unreadable };
  }
  return {
    trace,
    async run({ action = 'list', appId, correlationId = crypto.randomUUID(), visible } = {}) {
      if (typeof correlationId !== 'string' || correlationId.length > 160 ||
          !['list', 'restore', 'visible', 'traces'].includes(action)) throw new Error('Invalid recovery request.');
      const started = Date.now();
      if (action === 'visible') {
        await trace('recovery.visible', { correlationId, visible: ['loading', 'empty', 'results', 'success', 'error'].includes(visible) ? visible : 'unknown' });
        return { ok: true };
      }
      if (action === 'traces') return { events: await read(traceFile).catch(() => []) };
      await trace('recovery.request', { correlationId, action });
      try {
        if (!cluster.shared()) throw new Error('Project recovery requires the joined network.');
        const found = await candidates();
        if (action === 'list') {
          await trace('recovery.results', { correlationId, count: found.records.length, unreadable: found.unreadable, durationMs: Date.now() - started });
          return { correlationId, unreadable: found.unreadable, projects: found.records.map(a => ({
            id: a.id, name: a.name, ownerNode: a.ownerNode || cluster.self.id,
            inferred: Boolean(a.recoveredFromSession), tabs: [...found.sessions.values()].filter(s => s.appId === a.id).length,
          })) };
        }
        if (action !== 'restore') throw new Error('Unknown recovery action.');
        const app = found.records.find(a => a.id === appId);
        if (!app) throw new Error('No missing project with that ID was found. Refresh recovery and try again.');
        const owner = app.ownerNode || cluster.self.id;
        if (!cluster.replica.members().some(m => m.id === owner)) throw new Error('Reconnect the original project computer before restoring.');
        await cluster.command({ type: 'project-import', host: owner, apps: [app],
          sessions: [...found.sessions.values()].filter(s => s.appId === appId), values: found.values });
        await trace('recovery.restored', { correlationId, appId, durationMs: Date.now() - started });
        return { ok: true, appId, correlationId };
      } catch (error) {
        await trace('recovery.error', { correlationId, durationMs: Date.now() - started });
        throw error;
      }
    },
  };
}
