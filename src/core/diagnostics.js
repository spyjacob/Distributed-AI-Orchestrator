// Host-local, bounded diagnostics. No request bodies, URLs, text or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export function diagnostics(dir, host, revision) {
  const root = path.join(dir, 'diagnostics'), configFile = path.join(root, 'settings.json');
  let config = { enabled: true, maxMB: 2048, days: 14 }, queue = Promise.resolve(), pending = 0, dropped = 0, failed = 0;
  const ready = fs.mkdir(root, { recursive: true }).then(async () => {
    try {
      const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
      if (typeof saved.enabled === 'boolean' && Number.isInteger(saved.maxMB) && saved.maxMB >= 4 && saved.maxMB <= 2048 &&
          Number.isInteger(saved.days) && saved.days >= 1 && saved.days <= 90)
        config = { enabled: saved.enabled, maxMB: saved.maxMB, days: saved.days };
    } catch {}
  });
  const serial = fn => { const task = queue.catch(() => {}).then(() => ready).then(fn); queue = task.catch(() => {}); return task; };
  const files = async () => Promise.all((await fs.readdir(root)).filter(n => n.endsWith('.jsonl')).sort().map(async name => {
    const s = await fs.stat(path.join(root, name)); return { name, bytes: s.size, at: Number(name.split('-')[0]) || s.mtimeMs };
  }));
  async function disk() {
    try { const s = await fs.statfs(root); return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }; }
    catch { return { freeBytes: null, totalBytes: null }; }
  }
  let cachedSpace = null, checkedAt = 0, segment = null;
  async function maintain() {
    const space = await disk(), list = await files();
    let bytes = list.reduce((n, f) => n + f.bytes, 0);
    const limit = Math.min(config.maxMB * 1048576, space.freeBytes === null ? config.maxMB * 1048576 : Math.max(0, (space.freeBytes + bytes) * .05));
    for (const f of list) if (bytes > limit || f.at < Date.now() - config.days * 86400000 || (space.freeBytes !== null && space.freeBytes < 2 * 1073741824)) {
      await fs.unlink(path.join(root, f.name)); bytes -= f.bytes;
    }
    cachedSpace = { ...space, bytes, effectiveMaxBytes: limit };
    checkedAt = Date.now();
    const retained = await files();
    segment = retained.at(-1) || null;
    return cachedSpace;
  }
  const safe = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(v) ? v : undefined;
  function record(event, details = {}) {
    if (pending >= 1000) { dropped++; return Promise.resolve(); }
    pending++;
    return serial(async () => {
      if (!config.enabled) return;
      const row = { id: crypto.randomUUID(), at: new Date().toISOString(), host, revision, event: safe(event) || 'unknown' };
      for (const key of ['correlationId','browser','page','device','control','screen','outcome','route','method','peer','leader','role','observedRevision','effort','requestedEffort','model','provider','phase','cli'])
        if (safe(details[key])) row[key] = details[key];
      for (const key of ['durationMs','status','width','height','count','conflicts','term','clientAt'])
        if (Number.isFinite(details[key])) row[key] = Math.max(0, Math.min(details[key], 1e15));
      const space = !cachedSpace || Date.now() - checkedAt >= 1000 ? await maintain() : cachedSpace;
      if (space.effectiveMaxBytes < 4096 || (space.freeBytes !== null && space.freeBytes < 2 * 1073741824)) { dropped++; return; }
      if (!segment || segment.bytes >= 4 * 1048576 || segment.at <= Date.now() - 86400000)
        segment = {name:Date.now() + '-' + crypto.randomUUID() + '.jsonl', bytes:0, at:Date.now()};
      const line = JSON.stringify(row) + '\n';
      await fs.appendFile(path.join(root, segment.name), line, { mode: 0o600 });
      const bytes = Buffer.byteLength(line); segment.bytes += bytes; cachedSpace.bytes += bytes;
      if (cachedSpace.freeBytes !== null) cachedSpace.freeBytes -= bytes;
      if (cachedSpace.bytes >= cachedSpace.effectiveMaxBytes) await maintain();
    }).catch(() => { failed++; cachedSpace = null; segment = null; }).finally(() => pending--);
  }
  return {
    record,
    async run(action = 'status', body = {}) {
      return serial(async () => {
        if (action === 'settings') {
          if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.maxMB) || body.maxMB < 4 || body.maxMB > 2048 ||
            !Number.isInteger(body.days) || body.days < 1 || body.days > 90) throw Error('Choose 4–2048 MB and 1–90 days.');
          const next = { enabled: body.enabled, maxMB: body.maxMB, days: body.days };
          const tmp = configFile + '.tmp'; await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 }); await fs.rename(tmp, configFile);
          config = next;
        } else if (action === 'clear') {
          for (const f of await files()) await fs.unlink(path.join(root, f.name));
        } else if (!['status', 'events'].includes(action)) throw Error('Unknown diagnostics action.');
        const storage = await maintain(), list = await files();
        let events;
        if (action === 'events') {
          events = [];
          const before = typeof body.before === 'string' ? body.before : '9999';
          for (const f of list.reverse()) {
            const rows = (await fs.readFile(path.join(root, f.name), 'utf8')).split('\n').filter(Boolean).flatMap(line => {
              try { const row = JSON.parse(line); return (row.at + '|' + (row.id || '')) < before ? [row] : []; } catch { return []; }
            });
            events = [...rows, ...events].sort((a,b) => (a.at + '|' + (a.id || '')).localeCompare(b.at + '|' + (b.id || ''))).slice(-1000);
            if (events.length >= 1000) break;
          }
        }
        return { host, revision, ...config, ...storage, files: list.length, oldestAt: list.length ? new Date(Math.min(...list.map(f => f.at))).toISOString() : null, dropped, failed, events, nextBefore: events?.length ? events[0].at + '|' + (events[0].id || '') : null };
      });
    },
  };
}
