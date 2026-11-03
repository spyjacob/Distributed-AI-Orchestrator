import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';
// Restart an isolated real server; never address the user's live server.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-server-'));
const checkout = path.join(dir, 'checkout');
await fs.mkdir(checkout);
for (const folder of ['server', 'src', 'scripts']) await fs.cp(folder, path.join(checkout, folder), { recursive: true });
await fs.copyFile('package.json', path.join(checkout, 'package.json'));
await fs.symlink(path.resolve('node_modules'), path.join(checkout, 'node_modules'), 'junction');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], { cwd: checkout, env: { ...process.env,
  HARNESS_PORT: String(port), HARNESS_TOKEN: 'restart-test', HARNESS_DATA_DIR: dir,
  ORCHESTRATOR_PUBLIC_URL: origin,
}, stdio: 'ignore' });
const exited = once(child, 'exit');
const call = async (route, method = 'GET', target = origin, body) => {
  const response = await fetch(target + route, { method,
    headers: { 'x-harness-token': 'restart-test', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  return response.json();
};
const waitFor = async (predicate, target = origin) => {
  for (let i = 0; i < 120; i++) {
    try { const status = await call('/api/harness/status', 'GET', target); if (predicate(status)) return status; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Test server did not become ready');
};
let replacement, peer, peerClosed, peerReplacement;
try {
  const original = await waitFor(() => true);
  assert.equal(original.pid, child.pid);
  const header = async target => {
    const response = await fetch(target + '/?node=another-machine', { headers: { 'x-harness-token': 'restart-test' } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.text()).match(/<div id="header-revision">(.*?)<\/div>/)[1];
  };
  assert.ok((await header(origin)).includes(original.version.startedAt));
  const peerProbe = net.createServer();
  await new Promise(resolve => peerProbe.listen(0, '127.0.0.1', resolve));
  const peerPort = peerProbe.address().port;
  await new Promise(resolve => peerProbe.close(resolve));
  const peerOrigin = `http://127.0.0.1:${peerPort}`;
  peer = spawn(process.execPath, ['server/index.js'], { cwd: checkout, env: { ...process.env,
    HARNESS_PORT: String(peerPort), HARNESS_TOKEN: 'restart-test', HARNESS_DATA_DIR: path.join(dir, 'peer'),
    ORCHESTRATOR_PUBLIC_URL: peerOrigin,
  }, stdio: 'ignore' });
  peerClosed = once(peer, 'exit');
  const peerOriginal = await waitFor(() => true, peerOrigin);
  await call('/api/cluster/join', 'POST', peerOrigin, { url: origin, ownUrl: peerOrigin, token: 'restart-test' });
  const source = await fs.readFile('server/public/app.js', 'utf8');
  let peerRequested;
  const button = { isConnected: true, setAttribute() {} };
  const ui = vm.createContext({ Date, setTimeout, AbortSignal,
    nativeFetch: route => fetch(origin + route, { headers: { 'x-harness-token': 'restart-test' } }),
    api: async (route, options) => {
      const result = await call(route, options?.method || 'GET');
      if (options?.method === 'POST') peerRequested = result;
      return result;
    },
    closeSheet() { assert.fail('remote restart must keep the panel open'); },
    harnessVersionSheet() { assert.fail('remote restart must retain its button result'); },
    location: { reload() { assert.fail('remote restart must not reload the serving frontend'); } },
    showBanner(message) { assert.fail(message); },
  });
  vm.runInContext(source.slice(source.indexOf('async function restartOrchestrator('), source.indexOf('function renderAppsSheet(')), ui);
  await ui.restartOrchestrator(button, peerOriginal.node);
  assert.equal(button.textContent, 'Restarted ✓');
  assert.equal(button.disabled, true);

  peerReplacement = await waitFor(status => status.restartId === peerRequested.restartId, peerOrigin);
  assert.equal((await call('/api/harness/status')).instanceId, original.instanceId, 'restarting a peer leaves this machine running');
  assert.equal(peerReplacement.node, peerOriginal.node);
  assert.notEqual(peerReplacement.pid, peerOriginal.pid);
  await peerClosed;
  const requested = await call('/api/harness/restart', 'POST');
  assert.equal(requested.instanceId, original.instanceId);
  replacement = await waitFor(status => status.restartId === requested.restartId);
  assert.notEqual(replacement.pid, original.pid);
  assert.notEqual(replacement.instanceId, original.instanceId);
  assert.equal(replacement.node, original.node);
  await exited;
  assert.ok((await header(origin)).includes(replacement.version.startedAt), 'header reflects the serving replacement, independent of node selection');
  // The replacement still serves the same app and data after the old parent exits.
  let state;
  for (let i = 0; i < 120; i++) {
    try { state = await call('/api/state'); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(state, 'the restarted cluster elects a coordinator and resumes serving state');
  assert.ok(Array.isArray(state.sessions));
  console.log('PASS real cluster restart replaces both PIDs, preserves identities and serves requests after the old processes exit');
} finally {
  if (peerReplacement) { try { process.kill(peerReplacement.pid, 'SIGTERM'); } catch {} }
  if (peer && peer.exitCode === null && peer.signalCode === null) peer.kill('SIGTERM');
  if (peerClosed) await peerClosed;
  if (replacement) { try { process.kill(replacement.pid, 'SIGTERM'); } catch {} }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited;
  await new Promise(resolve => setTimeout(resolve, 500));
  await fs.rm(dir, { recursive: true, force: true });
}
