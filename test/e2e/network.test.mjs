import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'network-gate-'));
const state = path.join(root, 'tailscale-state');
await fs.writeFile(state, 'Stopped');
await fs.writeFile(path.join(root, 'models.json'), JSON.stringify({ default: 'local', models: {
  local: { provider: 'openai', sourceKind: 'ollama', model: 'test:local', apiKeyOptional: true, baseUrl: 'http://127.0.0.1:11434/v1' },
} }));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
  HARNESS_TEST_LOCAL_MODELS: '1', HARNESS_PORT: String(port), HARNESS_DATA_DIR: root, HARNESS_TOKEN: 'network-test',
  ORCHESTRATOR_TAILSCALE_BIN: process.execPath,
  ORCHESTRATOR_TAILSCALE_SOCKET: '', HARNESS_TEST_TAILSCALE_STATE: state,
}, stdio: 'ignore' });
const exited = once(child, 'exit');
const request = (route, method = 'GET') => fetch(`http://127.0.0.1:${port}${route}`, {
  method, headers: { 'x-harness-token': 'network-test', 'Content-Type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify({ name: 'blocked', text: 'hello' }) } : {}),
  signal: AbortSignal.timeout(5000),
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let network;
  for (let i = 0; i < 60; i++) {
    try { network = await (await request('/api/network')).json(); break; }
    catch { await pause(100); }
  }
  assert.equal(network.connected, false);
  assert.equal((await request('/api/diagnostics')).status, 200, 'local diagnostics survive Tailscale disconnection');
  assert.equal((await request('/')).status, 200, 'the blocking screen is still served');
  const blocked = await request('/api/sessions', 'POST');
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, 'TAILSCALE_DISCONNECTED');
  assert.equal((await request('/api/state')).status, 503);
  await fs.writeFile(state, 'Running');
  await pause(2200);
  assert.equal((await (await request('/api/network')).json()).connected, true);
  assert.equal((await request('/api/state')).status, 200, 'same process recovers without a restart');
  // Execute the served preview against the real app registry (empty/error),
  // then a reachable app fixture; check viewport choice and honest load traces.
  assert.equal((await request('/app-preview.html')).status, 200);
  const previewSource = await (await request('/app-preview.js')).text();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, clientWidth: 366,
      setAttribute(k, v) { this[k] = v; }, hasAttribute(k) { return Boolean(this[k]); } });
    return elements.get(id);
  };
  const traces = [];
  let appReply;
  const preview = vm.createContext({ URL, URLSearchParams, clearTimeout, setTimeout: () => 1,
    location: { search: '?app=demo&layout=desktop', hostname: '127.0.0.1', protocol: 'http:', pathname: '/app-preview.html' },
    history: { replaceState() {} }, document: { getElementById: element },
    window: { addEventListener() {}, harnessTrace: (event, details) => traces.push(details) },
    fetch: () => appReply ? Promise.resolve(Response.json(appReply)) : request('/api/apps'),
  });
  vm.runInContext(previewSource, preview);
  for (let i = 0; i < 100 && !element('preview-status').textContent; i++) await pause(50);
  assert.match(element('preview-status').textContent, /stopped/);
  assert.equal(traces.at(-1).outcome, 'error');
  appReply = { apps: [{ id: 'demo', name: 'Demo', running: true, reachable: true, urls: { desktop: 'http://127.0.0.1:4321' } }] };
  vm.runInContext(previewSource, preview);
  await pause(10);
  assert.equal(element('preview-frame').src, 'http://127.0.0.1:4321/');
  assert.equal(element('preview-frame').style.width, '1280px');
  element('preview-phone').onclick();
  assert.equal(element('preview-frame').style.width, '390px');
  element('preview-frame').onload();
  assert.equal(traces.at(-1).outcome, 'frame-loaded');
  assert.match(element('preview-status').textContent, /does not confirm app success/);
  preview.location.hostname = 'remote.example';
  vm.runInContext(previewSource, preview);
  await pause(10);
  assert.match(element('preview-status').textContent, /Phone access address/);
  // Drive the served connection gate against this server, then a stalled phone request.
  const frontend = await (await request('/app.js')).text();
  const gateElements = new Map();
  const gateElement = id => {
    if (!gateElements.has(id)) gateElements.set(id, {id, hidden:false});
    return gateElements.get(id);
  };
  let hangProbe = false, deadline, initializations = 0;
  const gateUi = vm.createContext({
    AbortController, clearTimeout() {}, setTimeout: fn => { deadline = fn; return 1; }, setInterval() {},
    document: {hidden:false, addEventListener() {}, body:{children:[gateElement('network-gate'),gateElement('composer')]}},
    $:gateElement, window:{addEventListener() {}, harnessTrace() {}}, showBanner() {},
    initializeApp: async () => { initializations++; throw Error('Chat could not open'); },
    nativeFetch: (route, options) => {
      assert.equal(route, '/api/network', 'probe must stay on the serving host');
      if (hangProbe) return new Promise((resolve,reject) => options.signal.addEventListener('abort',()=>reject(Error('timeout'))));
      return request(route);
    },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('let networkChecking ='),frontend.indexOf('// Runtime status is always')), gateUi);
  for(let i=0;i<50 && !gateElement('network-gate').hidden;i++) await pause(20);
  assert.equal(gateElement('network-gate').hidden,true);
  assert.equal(initializations,1,'chat failure must not become a network failure');
  hangProbe = true;
  const stalled = gateUi.checkNetworkConnection();
  deadline();
  await stalled;
  assert.equal(gateElement('network-gate-title').textContent,'Waiting for Harness');
  hangProbe = false;
  await gateUi.checkNetworkConnection();
  assert.equal(gateElement('network-gate').hidden,true,'timed out probe releases retry lock');
  assert.equal(gateElement('composer').inert,false);

  const sources = async body => {
    const response = await fetch(`http://127.0.0.1:${port}/api/cluster/sources`, {
      method: 'POST', headers: { 'x-harness-token': 'network-test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await sources({ action: 'catalog' })).models.local.runtimeStatus, 'not loaded');
  for (const [operation, pending, final] of [['load', 'loading', 'loaded'], ['unload', 'unloading', 'not loaded']]) {
    await sources({ action: 'local', operation, model: 'test:local' });
    assert.equal((await sources({ action: 'catalog' })).models.local.runtimeStatus, pending);
    let catalog;
    for (let attempt = 0; attempt < 40; attempt++) {
      catalog = await sources({ action: 'catalog' });
      if (catalog.models.local.runtimeStatus === final) break;
      await pause(100);
    }
    assert.equal(catalog.models.local.runtimeStatus, final);
    assert.equal(catalog.jobs.at(-1).state, 'done');
  }
  await fs.writeFile(state, 'Stopped');
  await pause(2200);
  assert.equal((await request('/api/state')).status, 503, 'disconnects close the gate again');
  console.log('PASS disconnected startup blocks API work, serves the error screen and recovers without restart');
} finally {
  child.kill('SIGTERM');
  await exited;
  await fs.rm(root, { recursive: true, force: true });
}
