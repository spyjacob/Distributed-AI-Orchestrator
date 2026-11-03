/** Explicitly paired execution nodes. Credentials never leave the gateway. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const publicNode = ({ id, name, url }) => ({ id, name, url });
export function createNodes(dir, { request = fetch } = {}) {
  const file = path.join(dir, 'nodes.json');
  let queue = Promise.resolve();
  async function load() {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  function change(fn) {
    const next = queue.catch(() => {}).then(async () => {
      const rows = await load();
      const result = await fn(rows);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
      await fs.rename(tmp, file);
      return result;
    });
    queue = next;
    return next;
  }
  async function query(node, route) {
    const r = await request(node.url + route, {
      headers: { 'x-harness-token': node.token }, redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`Node returned ${r.status}`);
    return r.json();
  }
  return {
    async list() { return (await load()).map(publicNode); },
    async add({ name, url, token }) {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
        throw new Error('Enter a node origin such as https://desktop.example:8443, without a path or credentials.');
      }
      if (typeof token !== 'string' || !token.trim()) throw new Error('Enter the remote node access token.');
      if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a machine name.');
      const node = { id: crypto.randomUUID(), name: name.trim(), url: u.origin, token: token.trim() };
      const info = await query(node, '/api/node-info');
      if (info.protocol !== 1 || !info.authenticated) throw new Error('The remote node must support pairing and require an access token.');
      return change((rows) => {
        if (rows.some((r) => r.url === node.url)) throw new Error('This address is already connected.');
        rows.push(node);
        return publicNode(node);
      });
    },
    remove(id) { return change((rows) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); }); },
    async catalog() {
      return Promise.all((await load()).map(async (node) => {
        try {
          const state = await query(node, '/api/state');
          return { ...publicNode(node), online: true, sessions: state.sessions, models: state.models,
            running: state.running, home: state.home };
        } catch { return { ...publicNode(node), online: false }; }
      }));
    },
    async proxy(req, res, id, route) {
      const node = (await load()).find((n) => n.id === id);
      if (!node) { res.writeHead(404); res.end('Unknown machine'); return; }
      // A node cannot use another node as a recursive gateway or change its peers.
      if (!route.startsWith('/api/') || /^\/api\/(nodes|node-info)(?:[/?]|$)/.test(route)) {
        res.writeHead(403); res.end('Node administration is local'); return;
      }
      const target = new URL(node.url);
      const headers = { 'x-harness-token': node.token };
      for (const name of ['content-type', 'content-length', 'x-filename', 'accept', 'accept-encoding', 'range', 'x-harness-trace', 'x-harness-session']) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      const safeRoute = new URL(route, 'http://node.invalid');
      safeRoute.searchParams.delete('t');
      const upstream = (target.protocol === 'https:' ? https : http).request({
        protocol: target.protocol, hostname: target.hostname, port: target.port,
        method: req.method, path: safeRoute.pathname + safeRoute.search, headers,
      }, (reply) => {
        clearTimeout(timer);
        const responseHeaders = {};
        for (const name of ['content-type', 'content-length', 'content-encoding', 'content-disposition', 'cache-control', 'vary', 'content-security-policy', 'x-content-type-options']) {
          if (reply.headers[name]) responseHeaders[name] = reply.headers[name];
        }
        res.writeHead(reply.statusCode, responseHeaders);
        reply.on('error', () => res.destroy());
        reply.pipe(res);
      });
      const timer = setTimeout(() => upstream.destroy(new Error('Node did not respond')), 15000);
      upstream.on('error', () => {
        clearTimeout(timer);
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `${node.name} is unavailable. Work was not retried on another machine.` }));
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { clearTimeout(timer); upstream.destroy(); });
      req.pipe(upstream);
    },
  };
}
