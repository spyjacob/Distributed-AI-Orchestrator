import { createAISources } from '../../src/core/ai-sources.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { prepareTab } from '../../src/core/tab-workspaces.js';
import { userEvent, assistantEvent, noteEvent } from '../../src/core/transcript.js';
import { once } from 'node:events';
import { listeningProcesses, runningInfo, stop as stopApp } from '../../src/core/apps.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-hosts-'));
process.env.CODEX_HOME = path.join(root, 'codex-home'); // the Codex fixture's session files stay in here
const hosts = [];
const pause = () => new Promise(r => setTimeout(r, 150));
let release;
const modelRequests = [];
const notifications = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.url === '/notify') { notifications.push(Buffer.concat(chunks).toString()); return res.end('ok'); }
  const body = JSON.parse(Buffer.concat(chunks));
  modelRequests.push(body);
  if (body.messages.some(m=>m.content === 'unsupported-effort')) {
    res.writeHead(400, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:{message:'reasoning_effort is unsupported'}}));
  }
  if (body.messages.some(m=>m.content === 'continue-past-forty') && body.messages.filter(m=>m.role === 'tool').length < 41) {
    const n = body.messages.filter(m=>m.role === 'tool').length;
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    return res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'step-'+n,type:'function',function:{name:'list_dir',arguments:'{"path":"."}'}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
  }
  const checkpointWork = body.messages.some(m => m.content === 'checkpoint-work');
  if (checkpointWork && !body.messages.some(m => m.role === 'tool')) {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    return res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'Looking at the project first.',tool_calls:[{index:0,id:'look-1',type:'function',function:{name:'list_dir',arguments:'{"path":"."}'}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] })}\n\n`);
  if (body.messages.at(-1)?.content === 'wait' || (checkpointWork && body.messages.at(-1)?.role === 'tool')) await new Promise(r => { release = r; });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
async function start(name) {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const dir = path.join(root, name); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: name, models: { [name]: {
    provider: 'openai', model: name, label: name, supportedEffortLevels:['low','high','max'], defaultEffort:'high', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  } } }));
  const origin = `http://127.0.0.1:${port}`;
  const fixture = path.join(dir, 'jev-fetch.mjs');
  await fs.writeFile(fixture, `
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return original(url, options);
      const body = JSON.parse(options.body);
      if (options.headers.Authorization !== 'Bearer synthetic-jev-key' || body.model !== 'jev-latest')
        return Promise.resolve(new Response('{}', {status: 401}));
      return Promise.resolve(Response.json({ model: 'jev-test', answers: { urgent: {type: 'noul', noul: 0.9} }, usage: {input_tokens: 10} }));
    };
  `);
  const launch = () => spawn(process.execPath, ['--import', fixture, 'server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(port), HARNESS_TOKEN: 'execution-test', HARNESS_DATA_DIR: dir,
    ORCHESTRATOR_PUBLIC_URL: origin, ORCHESTRATOR_NODE_NAME: name,
  }, stdio: 'ignore' });
  const child = launch();
  const closed = once(child, 'exit');
  const request = (route, method = 'GET', body) => fetch(origin + route, { method,
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'execution-test' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const call = async (...args) => { const r = await request(...args); const v = await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v; };
  const host = { child, closed, call, request, dir, restart: async () => {
    host.child = launch(); host.closed = once(host.child, 'exit');
    for (let i = 0; i < 60; i++) { try { await call('/api/cluster/status'); return; } catch { await pause(); } }
    throw Error('server did not restart');
  } }; hosts.push(host);
  for (let i = 0; i < 60; i++) { try { host.status = await call('/api/cluster/status'); return host; } catch { await pause(); } }
  throw Error('server did not start');
}
try {
  // A real listener on a reused port belongs to its directory, not the old app.
  const groceryDir = path.join(root, 'grocery');
  await fs.mkdir(groceryDir);
  const listener = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('grocery')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: groceryDir });
  const listenerExit = once(listener, 'exit');
  try {
    const [data] = await once(listener.stdout, 'data');
    const port = Number(String(data).trim());
    const processes = await listeningProcesses();
    const actual = processes.find(p => p.pid === listener.pid && p.port === port);
    assert.ok(actual, 'running listener discovered');
    assert.equal(runningInfo({ dir: path.join(root, 'parallel'), port }, processes).running, false);
    if (actual.cwd) assert.equal(runningInfo({ dir: groceryDir, port }, processes).running, true);
    const parent = { id: 'parent', dir: root, port };
    const grocery = { id: 'grocery', dir: groceryDir, port };
    assert.equal(runningInfo(parent, processes, [parent, grocery]).running, false);
    const registry = path.join(root, 'app-registry');
    await fs.mkdir(registry);
    await fs.writeFile(path.join(registry, 'apps.json'), JSON.stringify({ apps: [
      { id: 'parallel', name: 'Parallel', dir: path.join(root, 'parallel'), port },
    ] }));
    await stopApp(registry, 'parallel');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'grocery');
  } finally { listener.kill(); await listenerExit; }
  const a = await start('model-a'), b = await start('model-b');
  const boardGame = await b.call('/api/apps', 'POST', { name: 'Board game', dir: path.join(root, 'board-game') });
  await fs.writeFile(path.join(boardGame.dir, 'saved-game.txt'), 'unsaved-to-git game');
  const existingProject = await a.call('/api/apps', 'POST', { name: 'Existing project', dir: path.join(root, 'existing-project') });
  assert.equal((await a.request('/api/cluster/admit', 'POST', { member: b.status.hosts[0] })).status, 409,
    'an older joining host must update before its registry can be lost');
  const colliding = await b.call('/api/apps', 'POST', { name: 'Different project with same ID', dir: path.join(root, 'collision-project') });
  const registryPath = path.join(b.dir, 'apps.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  registry.apps.find(p => p.id === colliding.id).id = existingProject.id;
  await fs.writeFile(registryPath, JSON.stringify(registry));
  const collisionSessionPath = path.join(b.dir, 'sessions', colliding.sessionId + '.json');
  const collisionSession = JSON.parse(await fs.readFile(collisionSessionPath, 'utf8'));
  collisionSession.appId = existingProject.id;
  await fs.writeFile(collisionSessionPath, JSON.stringify(collisionSession));
  await b.call('/api/cluster/join', 'POST', { url: a.status.hosts[0].url, ownUrl: b.status.hosts[0].url, token: 'execution-test' });
  // Host-local diagnostics: served browser actions correlate with real HTTP work.
  const historySource = await (await a.request('/diagnostics.js')).text();
  const listeners = {}, documentListeners = {};
  const browserWindow = { fetch: (route, opts = {}) => fetch(a.status.hosts[0].url + route, { ...opts,
      headers: { ...Object.fromEntries(new Headers(opts.headers)), 'x-harness-token':'execution-test' } }),
    addEventListener: (event, fn) => { listeners[event] = fn; } };
  const browserUi = vm.createContext({ window: browserWindow, crypto: {randomUUID: () => 'browser-e2e'},
    localStorage: { getItem() {}, setItem() {} }, navigator: {userAgent:'iPhone'}, Headers, Request, performance, Date,
    innerWidth:390, innerHeight:844, setInterval: fn => { listeners.flush = fn; },
    document: { addEventListener: (event, fn) => { documentListeners[event] = fn; }, visibilityState:'visible' } });
  vm.runInContext(historySource, browserUi);
  documentListeners.click({ target: { closest: () => ({id:'h-history'}) } });
  browserWindow.harnessTrace('visible', {screen:'history',outcome:'shown'});
  await browserWindow.fetch('/api/jev/evaluate', {method:'POST',body:'{}'});
  browserWindow.harnessTrace('visible', {screen:'banner',outcome:'error'});
  await listeners.flush();
  await a.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action',control:'send',
    correlationId:'redaction-e2e', text:'PRIVATE-CONTENT', token:'SECRET', url:'https://private.example'}]});
  let history = await a.call('/api/diagnostics?action=events');
  assert.equal(history.maxMB, 2048, 'new hosts default to a 2 GiB history budget');
  assert.ok(history.events.some(e => e.event === 'browser.action' && e.device === 'phone'));
  assert.ok(history.events.some(e => e.event === 'browser.visible' && e.outcome === 'error'));
  assert.ok(history.events.some(e => e.event === 'browser.request' && e.status === 400));
  assert.ok(history.events.some(e => e.event === 'request.finished' && e.status === 400 && e.correlationId === 'browser-e2e'));
  assert.equal((await fetch(a.status.hosts[0].url + '/api/diagnostics')).status,401);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE-CONTENT|SECRET|private.example/);
  assert.ok(history.freeBytes > 0);
  assert.equal((await a.request('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:99999,days:14})).status,400);
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:4,days:1});
  // Old/oversized segments rotate without touching another host's history.
  await fs.writeFile(path.join(a.dir,'diagnostics','000-old.jsonl'), 'x'.repeat(5 * 1048576));
  history = await a.call('/api/diagnostics');
  assert.ok(history.bytes <= 4 * 1048576);
  await b.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action',correlationId:'only-b'}]});
  const allHistory = await a.call('/api/diagnostics?action=all');
  assert.equal(allHistory.histories.length,2);
  assert.ok(allHistory.histories.find(h => h.host === b.status.self).events.some(e => e.correlationId === 'only-b'));
  assert.ok(!(await a.call('/api/diagnostics?action=events')).events.some(e => e.correlationId === 'only-b'));
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:false,maxMB:4,days:1});
  await a.call('/api/diagnostics', 'POST', {action:'clear'});
  await a.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action',control:'send'}]});
  assert.equal((await a.call('/api/diagnostics?action=events')).events.length,0);
  assert.ok((await a.call('/api/diagnostics?host='+b.status.self+'&action=events')).events.length > 0);
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:128,days:14});
  // A failed trace write must not fail the project API.
  await fs.rename(path.join(a.dir,'diagnostics'),path.join(a.dir,'diagnostics-saved'));
  await fs.writeFile(path.join(a.dir,'diagnostics'),'unwritable directory fixture');
  await a.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action'}]});
  assert.ok((await a.call('/api/state')).apps.length);
  await fs.unlink(path.join(a.dir,'diagnostics'));
  await fs.rename(path.join(a.dir,'diagnostics-saved'),path.join(a.dir,'diagnostics'));
  assert.ok((await a.call('/api/diagnostics')).failed > 0);

  const emptyProject = await b.call('/api/apps', 'POST', {name:'Recently emptied',dir:path.join(root,'recently-emptied')});
  const beforeDelete = Date.now();
  await a.call(`/api/sessions/${emptyProject.sessionId}`, 'DELETE');
  const emptyRecord = (await a.call('/api/apps')).apps.find(p => p.id === emptyProject.id);
  assert.ok(emptyRecord.updatedAt >= beforeDelete, 'deletion preserves project recency across hosts');
  const joined = await a.call('/api/apps');
  assert.ok(joined.apps.some(p => p.id === existingProject.id));
  const importedId = `${existingProject.id}-${b.status.self}`;
  assert.equal(joined.apps.find(p => p.id === existingProject.id).dir, existingProject.dir);
  assert.equal(joined.apps.find(p => p.id === importedId).dir, colliding.dir);
  assert.equal((await a.call('/api/state')).sessions.find(s => s.id === colliding.sessionId).appId, importedId);
  assert.equal(joined.apps.find(p => p.id === boardGame.id).ownerNode, b.status.self);
  assert.deepEqual(joined.apps.find(p => p.id === boardGame.id).machines.filter(m => m.placed).map(m => m.id), [b.status.self]);
  assert.equal((await a.call('/api/state')).sessions.find(s => s.id === boardGame.sessionId).appId, boardGame.id);
  assert.equal(await fs.readFile(path.join(boardGame.dir, 'saved-game.txt'), 'utf8'), 'unsaved-to-git game');

  // Simulate the missing registry and tabs left by the old join/conflict path.
  // Original standalone sessions and the pre-join archive still exist on B.
  await a.call(`/api/apps/${boardGame.id}?sessions=1`, 'DELETE');
  const recover = body => a.call('/api/cluster/recovery', 'POST', { host: b.status.self, ...body });
  const candidates = await recover({ action: 'list' });
  assert.equal(candidates.projects.find(p => p.id === boardGame.id).tabs, 1);
  assert.equal(JSON.stringify(candidates).includes('execution-test'), false);
  await recover({ action: 'restore', appId: boardGame.id, correlationId: 'recovery-e2e' });
  assert.ok((await a.call('/api/apps')).apps.some(p => p.id === boardGame.id));
  assert.equal((await a.call('/api/state')).sessions.find(s => s.id === boardGame.sessionId).appId, boardGame.id);
  assert.equal(await fs.readFile(path.join(boardGame.dir, 'saved-game.txt'), 'utf8'), 'unsaved-to-git game');
  assert.equal((await a.request('/api/cluster/recovery', 'POST', { host: b.status.self, action: 'restore', appId: 'missing', correlationId: 'recovery-error-e2e' })).status, 400);
  const recoveryTraces = (await recover({ action: 'traces' })).events;
  assert.ok(recoveryTraces.some(e => e.event === 'recovery.restored' && e.correlationId === 'recovery-e2e'));
  assert.ok(recoveryTraces.some(e => e.event === 'recovery.error' && e.correlationId === 'recovery-error-e2e'));
  assert.deepEqual(await a.call('/api/jev'), { configured: false });
  assert.equal((await a.request('/api/jev/evaluate', 'POST', {})).status, 400);
  assert.equal((await b.request('/api/jev', 'PUT', {apiKey: ''})).status, 400);
  const savedJev = await b.call('/api/jev', 'PUT', { apiKey: 'synthetic-jev-key' });
  assert.deepEqual(savedJev, { configured: true });
  assert.deepEqual(await a.call('/api/jev'), { configured: true });
  assert.equal((await a.request('/api/jev/evaluate', 'POST', {})).status, 400);
  const evaluated = await b.call('/api/jev/evaluate', 'POST', {state: 'urgent', questions: {urgent: {type: 'noul', instructions: 'Urgent?'}}});
  assert.equal(evaluated.answers.urgent.noul, 0.9);
  assert.equal(JSON.stringify(evaluated).includes('synthetic-jev-key'), false);
  assert.deepEqual(await b.call('/api/jev', 'DELETE'), { configured: false });
  assert.deepEqual(await a.call('/api/jev'), { configured: false });
  // New-session inventories must follow the selected computer from either browser host.
  for (const browser of [a, b]) {
    for (const [owner, model] of [[a, 'model-a'], [b, 'model-b']]) {
      const choices = await browser.call(`/api/execution-models?app=__harness&host=${owner.status.self}`);
      assert.deepEqual(Object.keys(choices.models), [model]);
      assert.equal(choices.default, model);
    }
  }
  // Exercise the served frontend with reordered status replies and tab switches.
  const frontend = await (await a.request('/app.js')).text();
  // Render the served reply formatter, including a table arriving in chunks.
  const formattingUi = vm.createContext({ state: {session: {id:'formatting'}}, nodeApi: value => value });
  vm.runInContext(frontend.slice(frontend.indexOf('const esc ='), frontend.indexOf('/** Local date')), formattingUi);
  const tableReply = '**Replication**\n\n| Data | When it reconnects |\n|---|---|\n| Saved chats | Catch up through the log |\n| Files | Stay on their **owner** |\n\n- More work remains';
  assert.doesNotMatch(formattingUi.render('| Data | When it reconnects |\n|--'), /<table>/);
  const formatted = formattingUi.render(tableReply);
  assert.match(formatted, /<thead><tr><th scope="col"/);
  assert.match(formatted, /<td[^>]*>Stay on their <strong>owner<\/strong><\/td>/);
  assert.match(formatted, /<\/table><\/div><br><ul><li>More work remains/);
  assert.doesNotMatch(formatted, /\|---\|/);
  assert.match(formattingUi.render('A | B\n:--- | ---:\n`a\\|b` | <script>bad</script>'), /<code>a\|b<\/code>/);
  assert.doesNotMatch(formattingUi.render('A | B\n--- | ---\n<script>bad</script> | safe'), /<script>/);
  assert.doesNotMatch(formattingUi.render('```\nA | B\n--- | ---\n```'), /<table>/);
  assert.doesNotMatch(formattingUi.render('A | B\n---\nplain text'), /<table>/);
  // Stream into the saved progress slot, including collapsed progress and redraws.
  const streamTab = { session: { model: 'demo', events: [{ type: 'user', id: 'question' }] }, live: null };
  let progressChildren = [];
  const activity = {};
  const progress = { querySelector: () => activity, insertBefore(node, before) {
    assert.equal(before, activity);
    progressChildren = [node, activity];
  } };
  const streamUi = vm.createContext({ state: {tab:'chat',models:{}}, tabs: {chat:streamTab},
    window: {harnessTrace() {}}, esc: String,
    turnsFrom: events => events.map(user => ({user})), foldKey: turn => turn.user.id,
    document: { getElementById(id) { assert.equal(id, 'fold-question'); return progress; },
      createElement() { return { remove() { progressChildren = progressChildren.filter(n => n !== this); } }; } },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('function mountLive('), frontend.indexOf('// ---------------------------------------------------------------- session')), streamUi);
  const streaming = streamUi.liveTurn();
  assert.equal(progressChildren[0], streaming, 'first delta starts inside progress, before tools');
  assert.equal(streamUi.liveTurn(), streaming, 'subsequent chunks retain the same node');
  progressChildren = []; // A transcript redraw creates a fresh progress body.
  streamUi.mountLive();
  assert.equal(progressChildren[0], streaming, 'redraw preserves the live reply');
  progress.hidden = true;
  streamUi.mountLive();
  assert.equal(progress.hidden, true, 'streaming respects manually collapsed progress');
  streamUi.clearLive();
  assert.equal(streamTab.live, null);
  assert.equal(progressChildren.includes(streaming), false);

  // Separate browser windows share localStorage but restore their own chat.
  const windowSessions = await Promise.all(['window one', 'window two'].map(name =>
    a.call('/api/sessions', 'POST', {appId:'__harness', name, mode:'chat', model:'model-a'})));
  const sharedStorage = new Map([['lastSession', 'obsolete-other-window']]);
  const storage = map => ({getItem:key=>map.get(key)||null, setItem:(key,value)=>map.set(key,value)});
  function selectionWindow(href, remembered = new Map()) {
    const location = new URL(href);
    const traces = [];
    const context = vm.createContext({location, URL, URLSearchParams,
      sessionStorageKey:'lastSession', sessionStorage:storage(remembered), localStorage:storage(sharedStorage),
      history:{state:null, replaceState:(_state,_title,url)=>{location.href=new URL(url,location).href;}},
      window:{harnessTrace:(event,details)=>traces.push({event,...details})},
      state:{sessions:windowSessions, models:{}, session:null}, tabs:{chat:{}},
      $:()=>({dataset:{}}), clearTimeout, setTimeout, sessionOffline:()=>false, closeSheet(){}, clearLive(){}, showSession(){},
      listen(){}, paintHeader(){}, showBanner(){}, drawTranscript(){}, machinesSheet(){},
      refreshState:async()=>{}, api:route=>a.call(route),
    });
    vm.runInContext(frontend.slice(frontend.indexOf('function modelSourceName('),frontend.indexOf('async function sessionSettingsSheet(')),context);
    vm.runInContext(frontend.slice(frontend.indexOf('let openingSession ='), frontend.indexOf('async function editTranscript(')), context);
    vm.runInContext(frontend.slice(frontend.indexOf('let startupRunning ='), frontend.indexOf('let networkChecking =')), context);
    return {context, location, remembered, traces};
  }
  const firstWindow = selectionWindow('http://harness/?session=stale&node=test-node');
  const secondWindow = selectionWindow('http://harness/');
  await firstWindow.context.openSession(windowSessions[0].id);
  await secondWindow.context.openSession(windowSessions[1].id);
  assert.equal(firstWindow.location.searchParams.get('node'),'test-node');
  assert.equal(firstWindow.location.searchParams.get('session'),windowSessions[0].id,'selection replaces stale deep link');
  for (const [index, original] of [firstWindow, secondWindow].entries()) {
    const refreshed = selectionWindow(original.location.href, original.remembered);
    await refreshed.context.initializeApp();
    assert.equal(refreshed.context.state.session.id,windowSessions[index].id,'refresh restores this window');
  }
  // A startup election can end without any network-disconnect event. Retry reads
  // and restore this window's actual server conversation without replaying work.
  const recovering = selectionWindow(firstWindow.location.href);
  let retryStartup, startupReads = 0, startupBanner = '';
  const startupElement = {dataset:{}};
  recovering.context.$ = () => startupElement;
  recovering.context.showBanner = text => { startupBanner = text; };
  recovering.context.setTimeout = fn => { retryStartup = fn; return 1; };
  recovering.context.clearTimeout = () => {};
  recovering.context.machinesSheet = () => assert.fail('election must not force open settings');
  recovering.context.refreshState = async () => {
    startupReads++;
    if (startupReads === 1) throw Object.assign(Error('Coordinator election in progress. No operation was replayed.'), {status:503});
    await a.call('/api/state');
  };
  let failOpen = true;
  recovering.context.api = async route => {
    assert.ok(!route.endsWith('/send') && !route.endsWith('/queue'));
    if (failOpen) { failOpen = false; throw Object.assign(Error('Coordinator unavailable'), {status:503}); }
    return a.call(route);
  };
  await recovering.context.initializeApp();
  assert.match(startupBanner, /automatically/);
  assert.equal(recovering.context.state.session,null);
  await retryStartup(); // election ended, but opening the transcript can still fail
  assert.equal(recovering.context.state.session,null);
  await retryStartup();
  assert.equal(recovering.context.state.session.id,windowSessions[0].id);
  assert.equal(startupBanner,'');
  assert.deepEqual(recovering.traces.filter(e=>e.screen === 'startup').map(e=>e.outcome), ['waiting','waiting','ready']);
  await recovering.context.openSession(windowSessions[1].id);
  await recovering.context.initializeApp();
  assert.equal(recovering.context.state.session.id,windowSessions[1].id,'reconnection preserves a newer selection');
  const beforeFailure = firstWindow.location.href;
  firstWindow.context.api = async()=>{throw Error('Host unavailable');};
  await firstWindow.context.openSession('missing-session');
  assert.equal(firstWindow.location.href,beforeFailure,'failed navigation preserves last displayed chat');
  assert.ok(firstWindow.traces.some(event=>event.outcome==='open-failed'));
  assert.equal(sharedStorage.get('lastSession'),'obsolete-other-window','selection never writes shared browser storage');
  const restartNotice = {textContent:'', hidden:true};
  const noticeUi = vm.createContext({window:{}, $:()=>restartNotice});
  vm.runInContext(frontend.slice(frontend.indexOf('const pendingRestarts ='),frontend.indexOf('async function refreshState()')),noticeUi);
  const versions = await a.call('/api/harness/versions');
  const host = versions.hosts.find(h => h.id === a.status.self);
  noticeUi.paintRestartNotice({checkedAt:'1',hosts:[{...host,update:{restartRequired:true,head:'next-build'},state:'Restart needed'}]});
  assert.equal(restartNotice.hidden,false);
  noticeUi.paintRestartNotice({checkedAt:'2',hosts:[{id:host.id,state:'Unreachable'}]});
  assert.equal(restartNotice.hidden,false,'unreachable does not mean updated');
  noticeUi.paintRestartNotice({checkedAt:'3',hosts:[{...host,update:{}}]});
  assert.equal(restartNotice.hidden,false,'missing update flags cannot clear pending restart');
  noticeUi.paintRestartNotice({checkedAt:'4',hosts:[{...host,version:{revision:'next-build'},update:{}}]});
  assert.equal(restartNotice.hidden,true,'verified running target clears the notice');
  noticeUi.paintRestartNotice({checkedAt:'1',hosts:[{...host,update:{restartRequired:true,head:'next-build'}}]});
  assert.equal(restartNotice.hidden,true,'stale responses cannot restore an old notice');

  const historyElements = new Map();
  let historyHtml = '', historyError = '';
  const historyUi = vm.createContext({ window:{}, state:{machines:{hosts:[{id:a.status.self,name:'model-a'},{id:b.status.self,name:'model-b'}]}},
    sheetView:'', esc:String, encodeURIComponent, Number,
    nativeFetch: (route,opts={}) => a.request(route,opts.method || 'GET',opts.body ? JSON.parse(opts.body) : undefined),
    $: id => { if(!historyElements.has(id)) historyElements.set(id,{}); return historyElements.get(id); },
    openSheet(html,view) { historyUi.sheetView = view; historyHtml = html; },
    settingsSheet() {}, showBanner: text => {historyError = text;} });
  vm.runInContext(frontend.slice(frontend.indexOf('let historyRequest ='),frontend.indexOf('async function jevSheet()')),historyUi);
  await historyUi.historySheet();
  assert.match(historyHtml,/Free disk/);
  Object.assign(historyUi.$('history-enabled'),{value:'on'});
  historyUi.$('history-mb').value = '1';
  historyUi.$('history-days').value = '14';
  await historyElements.get('history-save').onclick();
  assert.match(historyError,/4–2048/);
  historyUi.$('history-mb').value = '128';
  await historyElements.get('history-save').onclick();
  assert.equal(historyElements.get('history-result').textContent,'History settings saved.');
  await historyElements.get('history-clear').onclick();
  assert.match(historyElements.get('history-result').textContent,/History cleared/);
  let deleteHtml = '';
  const deleteControls = new Map();
  const deleteUi = vm.createContext({
    state:{apps:[{id:emptyProject.id}],sessions:[]}, esc:String, shortDir:String,
    refreshState:async()=>{}, openSheet:html=>{deleteHtml=html;deleteControls.clear();},
    $:id=>{
      if (!deleteHtml.includes('id="'+id+'"')) return null;
      if (!deleteControls.has(id)) deleteControls.set(id,{dataset:{},checked:false});
      return deleteControls.get(id);
    },
    appsSheet(){}, appEditSheet(){}, showBanner:message=>assert.fail(message)
  });
  vm.runInContext(frontend.slice(frontend.indexOf('async function appDeleteSheet('),frontend.indexOf('async function usageSheet(')),deleteUi);
  await deleteUi.appDeleteSheet(emptyRecord);
  assert.doesNotMatch(deleteHtml,/id="del-sessions"/);
  vm.runInContext(frontend.slice(frontend.indexOf('async function deleteSessionSheet('),frontend.indexOf('function showSession()')),deleteUi);
  deleteUi.state.sessions = [{id:'last-tab',appId:emptyProject.id}];
  await deleteUi.deleteSessionSheet(deleteUi.state.sessions[0]);
  assert.match(deleteHtml,/id="session-delete-project"/);
  deleteUi.state.sessions.push({id:'other-tab',appId:emptyProject.id});
  await deleteUi.deleteSessionSheet(deleteUi.state.sessions[0]);
  assert.doesNotMatch(deleteHtml,/id="session-delete-project"/);

  // Drive the served recovery screen against the real API and a conflict archive.
  const archived = { id: 'archived-game', name: 'Archived game', dir: path.join(root, 'archived-game'), ownerNode: b.status.self };
  await fs.mkdir(archived.dir);
  await fs.writeFile(path.join(b.dir, 'cluster', 'conflict-e2e.json'), JSON.stringify({ base: 0, commit: 2, log: [
    { command: { type: 'value', id: 'settings:apps.json', value: JSON.stringify({ apps: [archived] }) } },
    { command: { type: 'session', id: 'archived-tab', value: { id: 'archived-tab', appId: archived.id, ownerNode: b.status.self,
      projectDir: archived.dir, name: 'Saved tab', events: [], updatedAt: 1 } } },
  ], secret: 'must-not-appear-in-recovery' }));
  const recoveryButtons = [];
  let recoveryHtml = '', recoveryBanner = '';
  const recoveryUi = vm.createContext({ crypto: { randomUUID: () => 'recovery-ui-e2e' },
    state: { machines: { hosts: [{ id: b.status.self, name: 'model-b', member: true }] } },
    sheetView: '', esc: String,
    api: (route, opts) => a.call(route, opts.method, JSON.parse(opts.body)),
    refreshState: () => a.call('/api/state'), appsSheet() {}, showBanner: text => { recoveryBanner = text; },
    $: id => id === 'sheet' ? { querySelectorAll: () => recoveryButtons } : {},
    openSheet(html, view) {
      recoveryUi.sheetView = view; recoveryHtml = html;
      recoveryButtons.splice(0, recoveryButtons.length, ...[...html.matchAll(/data-recover="(\d+)"/g)].map(m => ({ dataset: { recover: m[1] } })));
    },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('async function recoverProjectsSheet('), frontend.indexOf('async function runApp(')), recoveryUi);
  await recoveryUi.recoverProjectsSheet();
  assert.match(recoveryHtml, /Archived game/);
  assert.doesNotMatch(recoveryHtml, /must-not-appear/);
  assert.equal(recoveryButtons.length, 1);
  const restoreButton = recoveryButtons[0];
  await restoreButton.onclick();
  assert.equal(restoreButton.textContent, 'restored');
  assert.ok((await a.call('/api/state')).sessions.some(s => s.id === 'archived-tab'));
  // A stale second click is rejected and visibly reported without replacing data.
  await restoreButton.onclick();
  assert.match(recoveryBanner, /No missing project/);
  await recoveryUi.recoverProjectsSheet();
  assert.match(recoveryHtml, /No missing projects found/);
  let visibleStates = [];
  for (let i = 0; i < 30; i++) {
    visibleStates = (await recover({ action: 'traces' })).events.filter(e => e.correlationId === 'recovery-ui-e2e' && e.event === 'recovery.visible').map(e => e.visible);
    if (['loading', 'results', 'success', 'error', 'empty'].every(s => visibleStates.includes(s))) break;
    await pause();
  }
  for (const expected of ['loading', 'results', 'success', 'error', 'empty']) assert.ok(visibleStates.includes(expected), expected);
  const classes = new Set(), pendingStatus = [];
  const pushButton = { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } } };
  const ui = vm.createContext({ state: { session: { id: 'first' } },
    $: () => pushButton,
    api: route => new Promise((resolve, reject) => pendingStatus.push({ route, resolve, reject })),
  });
  vm.runInContext(frontend.slice(frontend.indexOf('const pushStates ='), frontend.indexOf('async function refreshState()')), ui);
  const oldStatus = ui.readPushStatus('first');
  const newStatus = ui.readPushStatus('first');
  pendingStatus[1].resolve({ pending: true, busy: false }); await newStatus;
  pendingStatus[0].resolve({ pending: false, busy: false }); await oldStatus;
  assert.ok(classes.has('push-pending'), 'older clean response cannot overwrite newer pending changes');
  const busyStatus = ui.readPushStatus('first');
  pendingStatus[2].resolve({ pending: false, busy: true }); await busyStatus;
  assert.ok(classes.has('push-pending'), 'temporary clean files during work do not flash the indicator');
  const failedStatus = ui.refreshPushStatus();
  pendingStatus[3].reject(new Error('offline')); await failedStatus;
  assert.ok(classes.has('push-pending'), 'network failure preserves last known pending state');
  assert.match(pushButton.title, /unavailable/);
  ui.state.session = { id: 'second' }; ui.paintPushStatus();
  assert.ok(!classes.has('push-pending'), 'different session never inherits pending state');
  ui.state.session = { id: 'first' }; ui.paintPushStatus();
  assert.ok(classes.has('push-pending'), 'returning to a session restores its known state immediately');
  const cleanStatus = ui.readPushStatus('first');
  pendingStatus[4].resolve({ pending: false, busy: false }); await cleanStatus;
  assert.ok(!classes.has('push-pending'), 'confirmed idle status clears pending changes');
  // A sheet opened during a turn must still accept a click after that turn.
  const gitNodes = new Map(['s-git', 'g-now', 'g-push-status'].map(id => [id, {
    innerHTML: '', textContent: '', classList: { toggle() {} }, insertAdjacentHTML() {},
  }]));
  let publishCalls = 0;
  const pushBanners = [];
  const panel = vm.createContext({
    closeSheet() {}, window: {},
    state: { session: { id: 'panel' } }, $: id => gitNodes.get(id),
    esc: String, clock: String, showBanner: text => pushBanners.push(text),
    api: async route => {
      if (route.startsWith('/api/git/push?')) {
        publishCalls++;
        throw new Error('Finish the current task before pushing');
      }
      return { repo: true, pending: true, busy: true, history: [] };
    },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('const pushStates ='), frontend.indexOf('async function refreshState()')), panel);
  vm.runInContext(frontend.slice(frontend.indexOf('async function paintGit('), frontend.indexOf('/** Repoint a session')), panel);
  await panel.paintGit(panel.state.session);
  assert.equal(gitNodes.get('g-now').disabled, false, 'busy snapshot does not leave an inert button');
  await gitNodes.get('g-now').onclick();
  assert.equal(publishCalls, 1, 'click checks current server state');
  assert.match(gitNodes.get('g-push-status').textContent, /Not published: Finish the current task/);
  assert.equal(gitNodes.get('g-now').disabled, false, 'refused push can be retried without reopening');
  pushBanners.length = 0;
  panel.api = async route => route.startsWith('/api/git/push?')
    ? { ok: true, pushed: true, files: ['app.js'], sha: 'abc123' }
    : { repo: true, pending: false, busy: false, history: [] };
  await gitNodes.get('g-now').onclick();
  assert.deepEqual(pushBanners, [], 'successful push stays in chat without a banner');
  const state = await a.call('/api/state');
  assert.equal(state.apps.find(app => app.id === '__harness').executionHosts.length, 2);
  const s = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'remote', mode: 'chat', model: 'model-b', ownerNode: b.status.self });
  const inventory = await a.call(`/api/sessions/${s.id}/models`);
  assert.deepEqual(Object.keys(inventory.models), ['model-b'], 'models stay local to the owner');
  const events = await a.request(`/api/sessions/${s.id}/events`);
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /hello/);
  await reader.cancel();
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'wait' });
  for (let i = 0; i < 80 && !release; i++) await pause();
  assert.ok(release, 'a follower executed the model request');
  const queued = await a.call(`/api/sessions/${s.id}/queue`, 'POST', {text:'queued original'});
  assert.equal(queued.queued, true);
  const pending = (await a.call(`/api/sessions/${s.id}/pending`)).pending[0];
  assert.equal(pending.text,'queued original');
  assert.equal((await b.call(`/api/sessions/${s.id}/pending`)).pending[0].pendingId,pending.pendingId);
  await a.call(`/api/sessions/${s.id}/pending`, 'PATCH', {pendingId:pending.pendingId,text:'edited before sending'});
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending[0].text,'edited before sending');
  assert.equal((await a.request(`/api/sessions/${s.id}/pending`,'DELETE',{pendingId:'stale'})).status,409);
  await a.call(`/api/sessions/${s.id}/pending`, 'DELETE', {pendingId:pending.pendingId});
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending.length,0);
  // Drive the served pending panel, including editing and cancelling on the owner.
  const panelQueued = await a.call(`/api/sessions/${s.id}/queue`, 'POST', {text:'panel draft'});
  const pendingElements = new Map();
  const pendingUi = vm.createContext({ window:{}, cur:()=>({session:{id:s.id}}),
    $: id => { if (!pendingElements.has(id)) pendingElements.set(id,{querySelector:()=>({}),replaceChildren(){}}); return pendingElements.get(id); },
    api:(route,opts)=>a.call(route,opts.method,JSON.parse(opts.body)),
    showBanner: text => assert.fail(text) });
  vm.runInContext(frontend.slice(frontend.indexOf('const pendingVersions ='),frontend.indexOf('async function send(queue')),pendingUi);
  pendingUi.message = panelQueued.pending;
  pendingUi.sessionId = s.id;
  vm.runInContext('pendingMessages.set(sessionId,message); paintMessagePending();',pendingUi);
  assert.match(pendingElements.get('message-pending').innerHTML,/pending-stack/);
  const disclosure = pendingElements.get('pending-disclosure');
  assert.match(pendingElements.get('message-pending').innerHTML, /<details id="pending-disclosure">/);
  disclosure.open = true; disclosure.ontoggle();
  vm.runInContext('paintMessagePending();', pendingUi);
  assert.equal(pendingElements.get('pending-disclosure'), disclosure);
  pendingElements.get('pending-edit').onclick();
  pendingElements.get('pending-text-edit').value = 'panel edited';
  vm.runInContext('paintMessagePending();', pendingUi);
  assert.equal(pendingElements.get('pending-text-edit').value, 'panel edited', 'refresh preserves pending edits');
  await pendingElements.get('pending-save').onclick();
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending[0].text,'panel edited');
  await pendingElements.get('pending-cancel').onclick();
  assert.equal(pendingElements.get('message-pending').hidden,true);

  assert.ok((await a.call('/api/state')).running.includes(s.id),'cancelling pending leaves current turn running');

  const activeState = await a.call('/api/state');
  const activeSession = activeState.sessions.find(row => row.id === s.id);
  assert.equal(activeSession.turnHost, b.status.self);
  assert.ok(activeSession.lastMessageAt > 0);
  const ordering = vm.createContext({ state: { busy: activeState.running } });
  vm.runInContext(frontend.slice(frontend.indexOf('function sessionOffline('), frontend.indexOf('function paintSessionTabs(')), ordering);
  const rows = [
    { id: 'recent', lastMessageAt: activeSession.lastMessageAt + 100 },
    { id: 'renamed', lastMessageAt: 1, updatedAt: Date.now() + 10000 },
    activeSession,
  ].sort(ordering.sessionOrder);
  assert.equal(rows[0].id, s.id, 'remote active session sorts first');
  assert.equal(rows[1].id, 'recent', 'message time wins over incidental saves');

  ordering.state.sessions = [
    { id: 'do-tab', appId: '__harness', lastMessageAt: 1 },
    { id: 'grocery-old', name: 'Older tab', appId: 'grocery', lastMessageAt: 2, model: 'model-a', turns: 1 },
    { id: 'grocery-new', name: 'Newer tab', appId: 'grocery', lastMessageAt: 30, model: 'model-a', turns: 4 },
    { id: 'grocery-away', name: 'Away tab', appId: 'grocery', lastMessageAt: 10, model: 'model-a', turns: 2, ownerNode: 'away-host' },
    { id: 'other-tab', appId: 'other', lastMessageAt: 20, updatedAt: 100, turnHost: 'busy-host' },
  ];
  vm.runInContext(frontend.slice(frontend.indexOf('function orderProjects('), frontend.indexOf('let peerCatalog')), ordering);
  const projects = [
    { id: 'other', name: 'Other', running: true },
    { id: 'grocery', name: 'Grocery', running: false },
    { id: '__harness', name: 'DO', builtin: true },
  ];
  assert.deepEqual(Array.from(ordering.orderProjects(projects), p => p.id), ['__harness', 'grocery', 'other']);
  assert.deepEqual(Array.from(ordering.orderProjects([...projects, {id:'empty',updatedAt:Date.now()}]), p => p.id),
    ['__harness','empty','grocery','other']);
  let projectHtml;
  const elements = new Map();
  const groceryArrow = { dataset: { appExpand: 'grocery' } };
  const projectTraces = [];
  ordering.state.models = { 'model-a': { label: 'Readable model' } };
  ordering.state.machines = { leader: 'here-host', hosts: [{ id: 'here-host', active: true }, { id: 'away-host', active: false }] };
  Object.assign(ordering, {
    sheetView: 'apps', esc: String, shortDir: String, clock: String, expandedApps: new Set(),
    sessionStatus: () => '', showPeerSessions() {}, document: {},
    window: { harnessTrace: (event, details) => projectTraces.push({ event, ...details }) },
    $: id => {
      if (!elements.has(id)) elements.set(id, {
        scrollTop: 0,
        getBoundingClientRect: () => id === 'sheet' ? { bottom: 100, height: 100 } : { top: 90, height: 200 },
        querySelectorAll: selector => selector === '[data-app-expand]' ? [groceryArrow] : [],
      });
      return elements.get(id);
    },
    openSheet: html => { projectHtml = html; },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('function renderAppsSheet('), frontend.indexOf('async function runApp(')), ordering);
  ordering.renderAppsSheet({ apps: projects });
  assert.ok(projectHtml.indexOf('data-app-toggle="__harness"') < projectHtml.indexOf('data-app-toggle="grocery"'));
  assert.ok(projectHtml.indexOf('data-app-toggle="grocery"') < projectHtml.indexOf('data-app-toggle="other"'));
  assert.doesNotMatch(projectHtml, /data-open=|Working now|Recently messaged/);

  // The arrow on a project really opens a list of that project's sessions.
  const openableRows = () => Array.from(projectHtml.matchAll(/data-open="([^"]+)"/g), match => match[1]);
  assert.match(projectHtml, /data-app-expand="grocery" aria-expanded="false"/);
  groceryArrow.onclick({ stopPropagation() {} });
  assert.match(projectHtml, /data-app-expand="grocery" aria-expanded="true"/);
  assert.match(projectHtml, /data-app-expand="other" aria-expanded="false"/, 'other projects stay closed');
  assert.deepEqual(openableRows(), ['grocery-new', 'grocery-old'], 'most recent session first, offline ones cannot be opened');
  assert.equal(ordering.$('sheet').scrollTop, 40, 'a list opening below the fold is brought into view');
  assert.match(projectHtml, /data-new-in="grocery"/);
  assert.match(projectHtml, /Readable model · 4 turns/);
  assert.match(projectHtml, /Readable model · 1 turn</);
  assert.match(projectHtml, /Away tab\s+<span[^>]*>computer offline</);
  assert.doesNotMatch(projectHtml, /data-(rename|del)="grocery-away"/, 'the server cannot edit or delete a tab on an offline computer');
  ordering.renderAppsSheet({ apps: projects });
  assert.deepEqual(openableRows(), ['grocery-new', 'grocery-old'], 'the live refresh keeps it open');
  groceryArrow.onclick({ stopPropagation() {} });
  assert.match(projectHtml, /data-app-expand="grocery" aria-expanded="false"/);
  assert.deepEqual(openableRows(), []);
  assert.deepEqual(projectTraces, [
    { event: 'visible', screen: 'project-sessions', outcome: 'shown', count: 3 },
    { event: 'visible', screen: 'project-sessions', outcome: 'hidden', count: 3 },
  ]);
  ordering.expandedApps.add('empty');
  ordering.renderAppsSheet({ apps: [...projects, { id: 'empty', name: 'Empty' }] });
  assert.match(projectHtml, /no sessions yet/);
  assert.match(projectHtml, /data-new-in="empty"/);

  assert.ok((await a.call('/api/state')).running.includes(s.id));
  assert.equal((await a.request(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self })).status, 409);
  const parallel = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'parallel', mode: 'chat', model: 'model-a', ownerNode: a.status.self });
  await b.call(`/api/sessions/${parallel.id}/send`, 'POST', { text: 'hello' });
  let parallelResult;
  for (let i = 0; i < 80; i++) {
    parallelResult = await a.call(`/api/sessions/${parallel.id}`);
    if (!parallelResult.busy && !parallelResult.turnHost && parallelResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(parallelResult.events.some(e => e.type === 'assistant'));
  assert.ok((await a.call('/api/state')).running.includes(s.id), 'another tab completes while the first is busy');
  assert.equal((await a.call('/api/state')).projectQueues, undefined);
  for (const text of ['fifo-one','fifo-remove','fifo-three'])
    await a.call(`/api/sessions/${s.id}/queue`, 'POST', {text});
  const queuedMany = (await b.call(`/api/sessions/${s.id}/pending`)).pending;
  assert.deepEqual(queuedMany.map(m=>m.text), ['fifo-one','fifo-remove','fifo-three']);
  await a.call(`/api/sessions/${s.id}/pending`, 'DELETE', {pendingId:queuedMany[1].pendingId});
  await a.call(`/api/sessions/${s.id}/pending`, 'PATCH', {pendingId:queuedMany[2].pendingId,text:'fifo-edited'});
  assert.deepEqual((await a.call(`/api/sessions/${s.id}/pending`)).pending.map(m=>m.text),['fifo-one','fifo-edited']);
  release();
  let finished;
  for (let i = 0; i < 80; i++) {
    finished = await a.call(`/api/sessions/${s.id}`);
    if (!finished.busy && !finished.turnHost && finished.events.filter(e=>e.type === 'assistant').length >= 3) break;
    await pause();
  }
  assert.ok(!finished.turnHost);
  assert.deepEqual(finished.events.filter(e=>e.type === 'user').map(e=>e.text), ['wait','fifo-one','fifo-edited']);
  // Pause stops the running turn but holds queued messages; Resume continues first, then runs the queue.
  release = null;
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'wait' });
  for (let i = 0; i < 80 && !release; i++) await pause();
  await a.call(`/api/sessions/${s.id}/queue`, 'POST', { text: 'after-pause' });
  assert.equal((await a.request(`/api/sessions/${s.id}/resume`, 'POST', {})).status, 409, 'nothing to resume before a pause');
  await a.call(`/api/sessions/${s.id}/pause`, 'POST', {});
  let pausedState;
  for (let i = 0; i < 80; i++) {
    pausedState = await a.call(`/api/sessions/${s.id}`);
    if (!pausedState.turnHost && pausedState.events.filter(e=>e.type === 'user').length >= 4) break;
    await pause();
  }
  await pause(); await pause();
  pausedState = await a.call(`/api/sessions/${s.id}`);
  assert.equal(pausedState.paused, true);
  assert.deepEqual((await a.call(`/api/sessions/${s.id}/pending`)).pending.map(m=>m.text), ['after-pause'], 'queued message waits while paused');
  assert.ok(!modelRequests.some(r=>r.messages.at(-1)?.content === 'after-pause'));
  release(); release = null;
  await a.call(`/api/sessions/${s.id}/resume`, 'POST', {});
  let resumed;
  for (let i = 0; i < 100; i++) {
    resumed = await a.call(`/api/sessions/${s.id}`);
    if (!resumed.busy && !resumed.turnHost && resumed.events.filter(e=>e.type === 'user').length >= 6) break;
    await pause();
  }
  assert.equal(resumed.paused, false);
  const resumedUsers = resumed.events.filter(e=>e.type === 'user').map(e=>e.text);
  assert.match(resumedUsers.at(-2), /^Resume: the previous turn was paused/);
  assert.equal(resumedUsers.at(-1), 'after-pause', 'the held queue runs after the continuation');
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending.length,0);
  assert.equal(finished.ownerNode, b.status.self);
  assert.ok(finished.events.some(e => e.type === 'assistant' && e.text === 'model-b'));
  assert.equal((await a.request(`/api/sessions/${s.id}/rewind`, 'POST', { eventId: finished.events[0].id, revertFiles: true })).status, 409, 'file rewind cannot bypass publication order');
  const stale = structuredClone(finished);
  const moved = await a.call(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self });
  assert.equal(moved.ownerNode, a.status.self);
  assert.equal(moved.model, 'model-a');
  // Test only synthetic credentials in this test's temporary directory.
  const identity = JSON.parse(await fs.readFile(path.join(a.dir, 'cluster', 'replica.json'), 'utf8'));
  const late = await fetch(a.status.hosts[0].url + '/api/cluster/worker-save', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ host: b.status.self, session: stale }) });
  assert.equal(late.status, 409, 'a delayed previous-owner write cannot undo assignment');
  assert.equal((await a.call(`/api/sessions/${s.id}`)).ownerNode, a.status.self);
  assert.equal((await a.request('/api/cluster/worker-save', 'POST', { host: a.status.self, session: moved })).status, 403);
  // A restarted worker may never have been offline long enough for the
  // coordinator's liveness timeout. Simulate its persisted abandoned turn.
  const abandoned = { ...stale, id: 'abandoned-worker-turn', turnHost: b.status.self,
    turnStartedAt: 123, executionEpoch: 0 };
  const seeded = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: abandoned.id, value: abandoned }),
  });
  assert.equal(seeded.status, 200);
  let recovered;
  for (let i = 0; i < 80; i++) {
    recovered = await a.call('/api/sessions/' + abandoned.id);
    if (!recovered.turnHost) break;
    await pause();
  }
  assert.ok(!recovered.turnHost, 'an online worker recovers its own abandoned turn');
  assert.equal(recovered.executionEpoch, 1);
  assert.equal(recovered.ownerNode, b.status.self);
  assert.ok(recovered.events.some(e => /nothing was automatically published or replayed/.test(e.text || '')));
  assert.equal((await a.call('/api/sessions/' + s.id)).ownerNode, a.status.self);
  const project = await a.call('/api/apps', 'POST', { name: 'local only', dir: path.join(root, 'local-project'), hosts: [a.status.self] });
  const disallowed = await b.request('/api/sessions', 'POST', { appId: project.id, model: 'model-b', ownerNode: b.status.self });
  assert.equal(disallowed.status, 400);
  const local = await b.call('/api/sessions', 'POST', { appId: project.id, mode: 'chat', model: 'model-a' });
  assert.equal(local.ownerNode, a.status.self, 'another computer can create a tab on the only enabled owner');
  const dependency = { host: a.status.self, alias: 'model-a', label: 'Analysis model', purpose: 'Product analysis' };
  await b.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [dependency] });
  await a.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [{ ...dependency, host: b.status.self }] });
  const wrongHostLaunch = await a.request('/api/apps/' + project.id + '/start', 'POST');
  assert.equal(wrongHostLaunch.status, 400);
  assert.match((await wrongHostLaunch.json()).error, /source computer/);
  await a.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [dependency] });
  const configured = await a.call('/api/apps');
  assert.deepEqual(configured.apps.find(app => app.id === project.id).aiDependencies, [dependency]);
  const blockedRemoval = await a.request('/api/cluster/sources', 'POST', { host: a.status.self, action: 'remove', alias: 'model-a' });
  assert.equal(blockedRemoval.status, 400);
  assert.match((await blockedRemoval.json()).error, /Used by local only/);
  const invalidDependency = await b.request('/api/apps/' + project.id, 'PATCH', { aiDependencies: [{ purpose: 'missing source' }] });
  assert.equal(invalidDependency.status, 400);

  const creation = await b.call(`/api/git?session=${local.id}&history=1`);
  assert.equal(creation.projectName, 'local only');
  assert.equal(creation.repositoryName, 'local-only');
  assert.equal(creation.createRepository, true);
  assert.ok(!creation.remote);
  const invalidVisibility = await b.request(`/api/git/push?session=${local.id}`, 'POST', { session: local.id, visibility: 'invalid' });
  assert.equal(invalidVisibility.status, 400);

  assert.equal((await b.call(`/api/sessions/${local.id}/models`)).default, 'model-a');
  await b.call(`/api/sessions/${local.id}/send`, 'POST', { text: 'hello' });
  for (let i = 0; i < 80; i++) {
    const value = await b.call(`/api/sessions/${local.id}`);
    if (!value.turnHost) { assert.ok(value.events.some(e => e.text === 'model-a')); break; }
    await pause();
  }
  assert.equal((await a.request(`/api/sessions/${local.id}/machine`, 'POST', { ownerNode: b.status.self })).status, 409);
  // Legacy durable queue values cannot block new turns or replay old requests.
  const legacy = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'value', id: 'turn-queue:__harness', value: { next: 2, entries: [
      { id: 'old', sessionId: s.id, owner: a.status.self, state: 'blocked', number: 1 },
    ] } }),
  });
  assert.equal(legacy.status, 200);
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'continue without a queue' });
  for (let i = 0; i < 80; i++) {
    const value = await a.call(`/api/sessions/${s.id}`);
    if (!value.turnHost && value.events.some(e => e.text === 'continue without a queue')
      && !(await a.call('/api/state')).running.includes(s.id)) break;
    await pause();
  }
  // Pending summaries include committed, unstaged and untracked session work.
  const summaryDir = path.join(root, 'summary-project');
  await fs.mkdir(summaryDir);
  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd: dir, stdio: 'pipe' });
  git(summaryDir, 'init', '-b', 'main');
  await fs.writeFile(path.join(summaryDir, 'README.md'), 'original');
  git(summaryDir, 'add', '.'); git(summaryDir, 'commit', '-m', 'initial');
  const summarySession = await a.call('/api/sessions', 'POST', { name: 'summary', projectDir: summaryDir, model: 'model-a' });
  await prepareTab(summarySession);
  const work = summarySession.tabWorkspace.dir;
  // Push prepares public AI requirements in the isolated worktree, even if
  // project validation subsequently blocks publication.
  summarySession.appId = project.id;

  await fs.writeFile(path.join(work, 'README.md'), 'saved documentation');
  git(work, 'commit', '-am', 'documentation');
  await fs.mkdir(path.join(work, 'server/public'), { recursive: true });
  await fs.writeFile(path.join(work, 'server/public/app.js'), 'new interface');
  const seededSummary = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: summarySession.id, value: summarySession }),
  });
  assert.equal(seededSummary.status, 200);
  const summary = await b.call(`/api/git?session=${summarySession.id}&history=1`);
  assert.equal(summary.pending, true);
  assert.match(summary.summary, /documentation/);
  assert.match(summary.summary, /interface/);
  assert.match(summary.summary, /2 files/);
  assert.equal(summary.machine, 'model-a', 'summary comes from the session owner');
  const attempted = await a.request('/api/git/push?session=' + summarySession.id, 'POST', { session: summarySession.id });
  assert.equal(attempted.status, 409, 'missing project checks still prevent publication');
  const pushChat = await a.call('/api/sessions/' + summarySession.id);
  assert.ok(pushChat.events.some(e => e.type === 'user' && e.operation === 'push'));
  assert.ok(pushChat.events.some(e => e.publication === 'pushing'));
  assert.ok(pushChat.events.some(e => e.type === 'assistant' && e.operation === 'push' && /Push did not complete/.test(e.text)));
  assert.ok(!pushChat.turnHost);
  const pushRemote = path.join(root, 'push-target.git');
  git(root, 'init', '--bare', pushRemote);
  git(summaryDir, 'remote', 'add', 'origin', pushRemote);
  await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  const published = await a.call('/api/git/push?session=' + summarySession.id, 'POST', {session:summarySession.id});
  assert.equal(published.pushed,true);
  const publishedChat = await a.call('/api/sessions/' + summarySession.id);
  assert.ok(publishedChat.events.some(e => e.type === 'assistant' && e.operation === 'push' && e.outcome === 'success' && /Push done/.test(e.text)));
  assert.ok(publishedChat.events.some(e => e.publication === 'published' && e.commitUrl !== undefined || e.pushReceipt?.status === 'Published'));
  assert.ok(!publishedChat.turnHost);
  // Draw those real Push events as the open chat does, including every moment mid-push.
  const pushUi = vm.createContext({ state: { models: {}, session: publishedChat, machines: { hosts: [] } },
    esc: v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), clock: () => '12:00', compact: String, humanSize: String,
    render: v => String(v), safeHref: () => '#', nodeApi: v => v, window: {} });
  vm.runInContext(frontend.slice(frontend.indexOf('function toolBlock('), frontend.indexOf('let startShown =')), pushUi);
  vm.runInContext(frontend.slice(frontend.indexOf('function sessionActive('), frontend.indexOf('function sessionOrder(')), pushUi);
  const drawPush = (events, running = false) => {
    Object.assign(pushUi, { shownEvents: events, shownRunning: running });
    return vm.runInContext('(() => { const turns = turnsFrom(shownEvents); return turnHtml(turns.at(-1), turns.length - 1, shownRunning, turns.length, true); })()', pushUi);
  };
  const countOf = (html, pattern) => html.match(pattern)?.length || 0;
  const pushStarts = publishedChat.events.flatMap((e, i) => e.type === 'user' && e.operation === 'push' ? [i] : []);
  const failedAttempt = publishedChat.events.slice(pushStarts.at(-2), pushStarts.at(-1));
  const realPush = publishedChat.events.slice(pushStarts.at(-1));
  const stepNotes = realPush.filter(e => e.publication === 'pushing');
  assert.ok(stepNotes.length >= 3, 'a real Push saves a note for each step');
  stepNotes.forEach((note, done) => {
    const midPush = drawPush(realPush.slice(0, realPush.indexOf(note) + 1), true);
    assert.equal(countOf(midPush, />Push in progress</g), 1, 'one title, however many steps have run');
    assert.doesNotMatch(midPush, /in progress ·|Progress ·/, 'no step repeats the title, and no empty fold sits above it');
    assert.equal(countOf(midPush, /class="push-step done"/g), done, 'every finished step is ticked');
    assert.equal(countOf(midPush, /class="push-step now"/g), 1, 'the step it is on is shown as going');
  });
  const finishedPush = drawPush(realPush);
  assert.match(finishedPush, /push-steps ok[^]*Published to GitHub · /, 'the title becomes the result');
  assert.doesNotMatch(finishedPush, /in progress|class="push-step (now|open|failed)"/);
  assert.equal(countOf(finishedPush, /class="push-step done"/g), stepNotes.length);
  for (const step of ['Preparing changes', 'Running project checks', 'Publishing to GitHub']) assert.equal(countOf(finishedPush, new RegExp(step, 'g')), 1, step);
  assert.ok(finishedPush.indexOf('push-steps') < finishedPush.indexOf('Push done'), 'the steps read before the result');
  const failedPush = drawPush(failedAttempt);
  assert.match(failedPush, /push-steps bad[^]*>Push failed</);
  assert.equal(countOf(failedPush, /class="push-step failed"/g), 1, 'the step it stopped on is not ticked');
  assert.match(failedPush, /Push did not complete/, 'the reply still says why');
  // The states a normal test run cannot reach, in the shapes the server saves them.
  const pushUser = { ...userEvent('Push changes'), operation: 'push' };
  const stepEvents = (...texts) => texts.map(text => noteEvent(text, { publication: 'pushing' }));
  const preparing = 'Push in progress · preparing changes.', checking = 'Push in progress · running project checks.', publishing = 'Checks passed · publishing to GitHub.';
  const anotherPublished = drawPush([pushUser, ...stepEvents(preparing, checking, publishing, checking)], true);
  assert.equal(countOf(anotherPublished, /Running project checks/g), 1, 'checks running again are not listed twice');
  assert.doesNotMatch(anotherPublished, /Publishing to GitHub/, 'a publish that lost the race is not left ticked');
  const repairing = drawPush([pushUser, ...stepEvents(preparing, checking, 'Checks failed · attempting AI repair in this tab.')]);
  assert.match(repairing, /push-step failed"><span class="push-mark">✕<\/span><span>Running project checks/, 'failed checks are never ticked');
  assert.match(repairing, /class="push-title">Push</, 'repair goes on in its own turn, so this one claims no result');
  const cutOff = drawPush([pushUser, ...stepEvents(preparing, checking)]);
  assert.match(cutOff, /Push · no result recorded/, 'a Push cut off by a restart does not read as still going');
  assert.doesNotMatch(cutOff, /in progress|class="push-step now"/);
  pushUi.state.busy = [publishedChat.id];
  assert.match(drawPush([pushUser, ...stepEvents(preparing, checking)]), />Push in progress</, 'a page reopened mid-push never flashes as cut off');
  pushUi.state.busy = [];
  const merging = drawPush([{ ...userEvent('Merge latest changes into this tab'), operation: 'push' }, ...stepEvents('Merge in progress · fetching latest changes.')], true);
  assert.match(merging, />Merge in progress</);
  assert.match(merging, /Fetching latest changes/);
  const uncertain = drawPush([pushUser, ...stepEvents(preparing, publishing), noteEvent('Remote publication outcome is uncertain: lost', { publication: 'remote-outcome-unknown' })]);
  assert.match(uncertain, /push-steps bad[^]*Push outcome uncertain/);
  assert.equal(countOf(uncertain, /class="push-step done"/g), 1, 'an uncertain publish is not ticked');
  assert.match(drawPush([pushUser, noteEvent('Already published; no new changes.', { publication: 'published', pushReceipt: { status: 'No changes' } })]), /Already up to date/);
  assert.match(drawPush([pushUser, noteEvent('Published abc; follow-up failed: lost', { publication: 'published', pushReceipt: { status: 'Published; follow-up failed' } })]), /push-steps warn[^]*Published; follow-up failed/);
  const turnEnd = drawPush([userEvent('change it'), { ...noteEvent('2 files ready to Push.', { publication: 'pending' }) }]);
  assert.match(turnEnd, /<div class="note" role="status">2 files ready to Push/, 'the end-of-turn note stays a single plain line');
  assert.doesNotMatch(turnEnd, /push-steps/);
  // Another tab can absorb published work without publishing its own changes.
  const publisher = path.join(root,'publisher');
  git(root,'clone',pushRemote,publisher);
  git(publisher,'checkout','main');
  await fs.writeFile(path.join(publisher,'peer.txt'),'from peer');
  git(publisher,'add','.'); git(publisher,'commit','-m','peer update'); git(publisher,'push','origin','main');
  const remoteBeforeMerge = git(publisher,'rev-parse','HEAD').toString().trim();
  const modelCount = modelRequests.length;
  const merged = await b.call('/api/git/merge?session='+summarySession.id,'POST',{session:summarySession.id});
  assert.equal(merged.merged,true);
  assert.equal(merged.pushed,false);
  assert.equal(await fs.readFile(path.join(work,'peer.txt'),'utf8'),'from peer');
  assert.equal(modelRequests.length,modelCount,'clean merge never calls AI');
  assert.equal(git(root,'--git-dir='+pushRemote,'rev-parse','main').toString().trim(),remoteBeforeMerge);
  // Divergent changes invoke repair, but a model that only talks cannot publish.
  await fs.writeFile(path.join(work,'peer.txt'),'local intent');
  git(work,'add','.'); git(work,'commit','-m','local intent');
  await fs.writeFile(path.join(publisher,'peer.txt'),'remote intent');
  git(publisher,'add','.'); git(publisher,'commit','-m','remote intent'); git(publisher,'push','origin','main');
  const remoteConflict = git(publisher,'rev-parse','HEAD').toString().trim();
  const conflict = await a.request('/api/git/merge?session='+summarySession.id,'POST',{session:summarySession.id});
  assert.equal(conflict.status,409);
  assert.ok(modelRequests.length > modelCount,'conflict invokes configured AI');
  assert.equal(git(root,'--git-dir='+pushRemote,'rev-parse','main').toString().trim(),remoteConflict,'unresolved repair cannot publish');
  git(work,'merge','--no-edit','-X','theirs','origin/main');
  await fs.writeFile(path.join(work,'package.json'), JSON.stringify({scripts:{test:'node -e "process.exit(1)"'}}));
  const beforeCheckRepair = modelRequests.length;
  const failedChecks = await a.request('/api/git/merge?session='+summarySession.id,'POST',{session:summarySession.id});
  assert.equal(failedChecks.status,409);
  assert.ok(modelRequests.length > beforeCheckRepair,'failed configured checks invoke repair');
  assert.equal(git(root,'--git-dir='+pushRemote,'rev-parse','main').toString().trim(),remoteConflict);




  const readme = await fs.readFile(path.join(work, 'README.md'), 'utf8');
  assert.match(readme, /AI requirements/);
  assert.match(readme, /Analysis model/);
  assert.match(readme, /HARNESS_APP_AI/);
  assert.ok(!readme.includes(dependency.host), 'private machine IDs are excluded from public requirements');

  // Check the instructions actually delivered to a model by a project turn.
  const traceDir = path.join(root, 'tracing-project');
  await fs.mkdir(traceDir);
  const traceSession = await a.call('/api/sessions', 'POST', { name: 'tracing', projectDir: traceDir, mode: 'agent', model: 'model-a' });
  await a.call(`/api/sessions/${traceSession.id}/send`, 'POST', { text: 'check project tracing' });
  let traceResult;
  for (let i = 0; i < 80; i++) {
    traceResult = await a.call(`/api/sessions/${traceSession.id}`);
    if (!traceResult.busy && !traceResult.turnHost && traceResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(traceResult.events.some(e => e.type === 'assistant'));
  const traceRequest = modelRequests.find(r => r.messages.at(-1)?.content === 'check project tracing');
  assert.ok(traceRequest, 'project request reached provider');
  const instructions = traceRequest.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(instructions, /Jev \(TypeSafe\)/);
  assert.match(instructions, /api\/jev\/evaluate/);
  assert.match(instructions, /Tracing for future AI work/);
  assert.match(instructions, /screen or state actually shown/);
  assert.match(instructions, /inspect the relevant recent traces before guessing/);
  assert.match(instructions, /Do not record secrets/);
  const chatRequest = modelRequests.find(r => r.messages.at(-1)?.content === 'wait');
  assert.ok(chatRequest);
  assert.doesNotMatch(JSON.stringify(chatRequest.messages), /Tracing for future AI work/);

  // Refresh discovery and preserve source-specific levels for existing models.
  const capabilityDir = path.join(root,'capability-source'); await fs.mkdir(capabilityDir);
  await fs.writeFile(path.join(capabilityDir,'models.json'),JSON.stringify({models:{native:{provider:'codex-cli',model:'fixture-native',reasoningEffort:'high'}}}));
  const capabilities = createAISources(capabilityDir,{discoverCodex:async()=>[{model:'fixture-native',label:'Native',supportedEffortLevels:['low','high','xhigh'],defaultEffort:'high',effortSource:'Codex model/list'}]});
  await capabilities.discover('codex-cli');
  const nativeCatalog = await capabilities.catalog();
  assert.deepEqual(nativeCatalog.models.native.effortCapability.levels,['low','high','xhigh']);
  assert.equal(nativeCatalog.models.native.effortCapability.configured,'high');
  await capabilities.add({kind:'codex-cli',models:['fixture-native']});
  const refreshedCatalog = await capabilities.catalog();
  assert.equal(Object.keys(refreshedCatalog.models).length,1,'native discovery reuses existing provider aliases');
  capabilities.close();
  const claudeCatalog = createAISources(capabilityDir,{discoverClaude:async()=>[
    {model:'sonnet',label:'Sonnet',supportsEffort:true,supportedEffortLevels:['low','high']},
    {model:'opus',label:'Opus',supportsEffort:true,supportedEffortLevels:['low','high','max']} ]});
  const discoveredClaude = await claudeCatalog.discover('claude-cli');
  await claudeCatalog.add({kind:'claude-cli',models:discoveredClaude.models.map(m=>m.model)});
  const allClaude = Object.values((await claudeCatalog.catalog()).models).filter(m=>m.provider==='claude-cli');
  assert.equal(allClaude.length,2);
  assert.deepEqual(allClaude.find(m=>m.model==='opus').effortCapability.levels,['low','high','max']);
  claudeCatalog.close();

  // Use the owning model's capabilities, including header and form rendering.
  const effortInventory = await a.call('/api/models/catalog');
  assert.deepEqual(effortInventory.models['model-a'].effortCapability.levels,['low','high','max']);
  const effortUi = vm.createContext({state:{models:effortInventory.models},esc:String});
  vm.runInContext(frontend.slice(frontend.indexOf('function modelSourceName('),frontend.indexOf('async function sessionSettingsSheet(')),effortUi);
  const effortSession = {model:'model-a',effort:'max'};
  assert.equal(effortUi.modelEffortLabel(effortSession),'Local · model-a · max');
  // The model wizard groups sources by provider and names the chosen model and effort.
  assert.equal(effortUi.modelGroup(effortInventory.models['model-a']),'local','a loopback endpoint is a Local model');
  assert.equal(effortUi.modelGroup({provider:'claude-cli'}),'claude');
  assert.equal(effortUi.modelGroup({provider:'openai',baseUrl:'https://api.openai.com/v1'}),'openai');
  assert.equal(vm.runInContext(`modelChoiceLabel(state.models['model-a'],'max')`,effortUi),'model-a · max effort');
  assert.equal(effortUi.modelEffortLabel({model:'model-a'}),'Local · model-a','no effort shown unless one is set');
  effortUi.state.models.claude = {provider:'claude-cli',model:'opus',label:'Opus',effortCapability:{levels:['low','high']}};
  assert.equal(effortUi.modelEffortLabel({model:'claude',effort:'high'}),'Claude · Subscription · Opus · high');
  effortUi.state.models.gpt = {provider:'openai-responses',model:'gpt-x',baseUrl:'https://api.openai.com/v1'};
  assert.equal(effortUi.modelEffortLabel({model:'gpt'}),'OpenAI · API · gpt-x');
  effortUi.state.models.unknown = {model:'private-model'};
  assert.match(effortUi.modelEffortLabel({model:'unknown',effort:'max'}),/private-model · max$/);
  effortUi.state.models.unsupported = {model:'no-effort',effortCapability:{levels:[],source:'fixture'}};
  assert.equal(effortUi.modelEffortLabel({model:'unsupported'}),'no-effort','a model without effort shows none');
  assert.match(effortUi.modelEffortLabel({model:'claude',effort:'max'}),/max \(unsupported\)$/);
  assert.equal((await a.request(`/api/sessions/${traceSession.id}`, 'PATCH', {effort:'ultra'})).status,400);
  // Session effort is passed through unchanged; message retries do not run twice.
  await a.call(`/api/sessions/${traceSession.id}`, 'PATCH', {effort:'max'});
  const message = {text:'effort-and-idempotency',clientMessageId:'stable-message-1'};
  await Promise.all([a.call(`/api/sessions/${traceSession.id}/send`, 'POST', message),
    b.call(`/api/sessions/${traceSession.id}/send`, 'POST', message)]);
  for (let i=0;i<100;i++) {
    const current = await a.call(`/api/sessions/${traceSession.id}`);
    if (!current.busy && !current.turnHost && current.events.some(e=>e.clientMessageId === message.clientMessageId)) break;
    await pause();
  }
  await a.call(`/api/sessions/${traceSession.id}/send`, 'POST', message);
  assert.equal(modelRequests.filter(r=>r.messages.at(-1)?.content === message.text).length,1);
  assert.equal(modelRequests.find(r=>r.messages.at(-1)?.content === message.text).reasoning_effort,'max');
  assert.equal((await a.request(`/api/sessions/${traceSession.id}`, 'PATCH', {effort:'invented'})).status,400);

  // Settings → Default model: each computer's default model and effort seed new sessions.
  assert.equal((await a.request('/api/cluster/sources','POST',{host:b.status.self,action:'default',alias:'model-b',effort:'invented'})).status,400,'remote default effort is validated by its computer');
  await a.call('/api/cluster/sources','POST',{host:a.status.self,action:'default',alias:'model-a',effort:'low'});
  assert.equal((await a.call('/api/cluster/sources','POST',{host:a.status.self,action:'catalog'})).defaultEffort,'low');
  const defaulted = await a.call('/api/sessions','POST',{name:'defaulted',projectDir:path.join(root,'default-project'),mode:'chat'});
  assert.equal(defaulted.model,'model-a');
  assert.equal(defaulted.effort,'low');
  const picked = await a.call('/api/sessions','POST',{name:'picked',projectDir:path.join(root,'default-project'),mode:'chat',model:'model-a',effort:'max'});
  assert.equal(picked.effort,'max','New session keeps the effort chosen in the wizard');
  assert.equal((await a.request('/api/sessions','POST',{name:'bad',projectDir:path.join(root,'default-project'),mode:'chat',model:'model-a',effort:'invented'})).status,400);
  // The wizard's last step switches model and effort in one change.
  assert.equal((await a.call(`/api/sessions/${picked.id}`,'PATCH',{model:'model-a',effort:'high'})).effort,'high');
  await a.call('/api/cluster/sources','POST',{host:a.status.self,action:'default',alias:'model-a',effort:''});
  assert.equal((await a.call('/api/cluster/sources','POST',{host:a.status.self,action:'catalog'})).defaultEffort,null);

  const longTurn = await a.call('/api/sessions','POST',{name:'long turn',projectDir:path.join(root,'long-project'),model:'model-a',mode:'agent'});
  await a.call(`/api/sessions/${longTurn.id}/send`,'POST',{text:'continue-past-forty'});
  let longResult;
  for(let i=0;i<200;i++) {
    longResult = await a.call(`/api/sessions/${longTurn.id}`);
    if(!longResult.busy && longResult.events.some(e=>e.type === 'assistant')) break;
    await pause();
  }
  assert.equal(longResult.events.filter(e=>e.type === 'tool_result').length,41,'no hidden 40-step cutoff');
  assert.ok(longResult.events.some(e=>e.type === 'assistant' && e.text === 'model-a'));
  const rejected = await a.call('/api/sessions','POST',{name:'unsupported effort',model:'model-a',mode:'chat',projectDir:path.join(root,'unsupported-project')});
  await a.call(`/api/sessions/${rejected.id}`,'PATCH',{effort:'max'});
  await a.call(`/api/sessions/${rejected.id}/send`,'POST',{text:'unsupported-effort'});
  for(let i=0;i<100 && (await a.call(`/api/sessions/${rejected.id}`)).busy;i++) await pause();
  const rejectedRequests = modelRequests.filter(r=>r.messages.some(m=>m.content === 'unsupported-effort'));
  assert.ok(rejectedRequests.length);
  assert.ok(rejectedRequests.every(r=>r.reasoning_effort === 'max'),'never silently retry with reasoning disabled');

  // Exercise the installed Agent SDK against a deterministic CLI protocol peer.
  const configFile = path.join(a.dir,'models.json');
  const config = JSON.parse(await fs.readFile(configFile,'utf8'));
  config.models['native-test'] = {provider:'claude-cli',model:'fixture',bin:path.resolve('test/fixtures/claude-control.mjs')};
  await fs.writeFile(configFile,JSON.stringify(config));
  const native = await a.call('/api/sessions','POST',{name:'native',model:'native-test',mode:'agent',projectDir:path.join(root,'native-project')});
  await a.call(`/api/sessions/${native.id}`, 'PATCH', {effort:'max'});
  const waitQuestion = async () => {
    for(let i=0;i<100;i++) {
      const result = await b.call(`/api/sessions/${native.id}/interaction`);
      if(result.request) return result.request;
      await pause();
    }
    throw Error('Native question never reached DO');
  };
  const waitNativeDone = async count => {
    for(let i=0;i<100;i++) {
      const result = await a.call(`/api/sessions/${native.id}`);
      if(!result.busy && !result.turnHost && result.events.filter(e=>e.type === 'assistant').length >= count) return result;
      await pause();
    }
    throw Error('Native turn did not finish');
  };
  for (let turn=0;turn<2;turn++) {
    await a.call(`/api/sessions/${native.id}/send`,'POST',{text:turn === 0 ? 'HISTORY-MARKER ' + 'old conversation '.repeat(12000) + ' ask me' : 'ask me'});
    const question = await waitQuestion();
    assert.equal(question.kind,'question');
    assert.equal((await b.request(`/api/sessions/${native.id}/interaction`,'POST',{id:question.id,allow:true,answers:{}})).status,400);
    const answer = {id:question.id,allow:true,answers:{'Which behavior?':'Keep'}};
    await b.call(`/api/sessions/${native.id}/interaction`,'POST',answer);
    assert.equal((await a.request(`/api/sessions/${native.id}/interaction`,'POST',answer)).status,409);
    const saved = await waitNativeDone(turn+1);
    const reply = JSON.parse(saved.events.findLast(e=>e.type === 'assistant').text);
    assert.equal(reply.resumed,turn === 1,'native history resumes after the first turn');
    assert.equal(reply.effort,'max');
    assert.ok(reply.promptLength < 45000);
    if (turn === 0) assert.equal(reply.historyReadable,true);
    if (reply.historyFile) await assert.rejects(fs.stat(reply.historyFile), {code:'ENOENT'});
    assert.equal(reply.answer.updatedInput.answers['Which behavior?'],'Keep');
  }
  // A Push between messages is DO's own record, not an edit: Claude resumes and is told about it.
  const {busy:_busy, paused:_paused, checkpoint:_checkpoint, projectDirMissing:_missing, projectDirIsHome:_home, ...beforePush} = await a.call(`/api/sessions/${native.id}`);
  beforePush.events.push({...userEvent('Push changes'), operation:'push'}, noteEvent('Published to GitHub · abc1234', {publication:'published'}),
    {...assistantEvent({text:'Push done · 1 file · abc1234.'}), operation:'push', outcome:'success'});
  const seededPush = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': JSON.parse(await fs.readFile(path.join(a.dir, 'cluster', 'replica.json'), 'utf8')).secret },
    body: JSON.stringify({ type: 'session', id: native.id, value: beforePush }),
  });
  assert.equal(seededPush.status, 200);
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask me'});
  const afterPushQuestion = await waitQuestion();
  await b.call(`/api/sessions/${native.id}/interaction`,'POST',{id:afterPushQuestion.id,allow:true,answers:{'Which behavior?':'Keep'}});
  const afterPush = JSON.parse((await waitNativeDone(4)).events.findLast(e=>e.type === 'assistant').text);
  assert.equal(afterPush.resumed,true,'a Push does not start a new Claude session');
  assert.equal(afterPush.doNote,true,'the resumed session is told what the Push did');
  const oversizedChat = await a.call('/api/sessions','POST',{name:'large import',model:'native-test',mode:'chat',projectDir:path.join(root,'native-project')});
  await a.call(`/api/sessions/${oversizedChat.id}/send`,'POST',{text:'large history '.repeat(12000)});
  let rejectedChat;
  for (let i=0;i<100;i++) {
    rejectedChat = await a.call(`/api/sessions/${oversizedChat.id}`);
    if (rejectedChat.events.some(e=>e.type==='note' && /searchable history handoff/.test(e.text))) break;
    await pause();
  }
  assert.ok(rejectedChat.events.some(e=>e.type==='note' && /searchable history handoff/.test(e.text)));
  assert.equal(rejectedChat.events.find(e=>e.type==='user').text,'large history '.repeat(12000).trim());
  // A message's header shows the model and effort as the provider reported them, and nothing else.
  const reportedTurn = async (sessionId, text) => {
    const stream = await a.request(`/api/sessions/${sessionId}/events`);
    const reader = stream.body.getReader();
    await a.call(`/api/sessions/${sessionId}/send`,'POST',{text});
    let live = '';
    while (!live.includes('"kind":"done"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      live += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    const saved = await a.call(`/api/sessions/${sessionId}`);
    return { saved, sent: saved.events.findLast(e=>e.type === 'user'),
      deltas: live.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).filter(e=>e.kind === 'delta' && e.delta.kind === 'model_report') };
  };
  const reported = await a.call('/api/sessions','POST',{name:'reported',model:'native-test',mode:'agent',projectDir:path.join(root,'native-project')});
  await a.call(`/api/sessions/${reported.id}`,'PATCH',{effort:'max'});
  const plainReport = await reportedTurn(reported.id,'model-report:plain');
  assert.equal(plainReport.sent.modelReport.by,'Claude Code');
  assert.equal(plainReport.sent.modelReport.version,'9.9.9');
  assert.equal(plainReport.sent.modelReport.effort,'max','the effort is the one Claude Code says it applied');
  assert.match(plainReport.sent.modelReport.effortSource,/get_settings/);
  assert.equal(plainReport.sent.modelReport.model,'fixture-claude-served','the model is the one the API response names, not the configured alias');
  assert.match(plainReport.sent.modelReport.modelSource,/API response/);
  assert.equal(plainReport.deltas.at(-1).delta.eventId,plainReport.sent.id,'an open page is told as soon as it is known');
  assert.equal(plainReport.deltas.at(-1).delta.report.effort,'max');
  const subagentStep = plainReport.saved.events.find(e=>e.subagent);
  assert.equal(subagentStep.servedModel,'fixture-subagent','a subagent step names its own model');
  const cappedReport = await reportedTurn(reported.id,'model-report:capped');
  assert.equal(cappedReport.sent.modelReport.effort,'high','a provider downgrade shows, not the setting');
  assert.equal(cappedReport.sent.modelReport.requestedEffort,'max');
  const refusedReport = await reportedTurn(reported.id,'model-report:refused');
  assert.ok(!('effort' in refusedReport.sent.modelReport),'when Claude Code does not say, no effort is filled in from the setting');
  assert.equal(refusedReport.sent.modelReport.requestedEffort,'max');
  assert.ok(refusedReport.sent.modelReport.model);

  const codexConfig = JSON.parse(await fs.readFile(configFile,'utf8'));
  codexConfig.models['codex-test'] = {provider:'codex-cli',model:'fixture-codex',supportedEffortLevels:['medium','high'],bin:path.resolve('test/fixtures/codex-exec.mjs')};
  await fs.writeFile(configFile,JSON.stringify(codexConfig));
  const codexChat = await a.call('/api/sessions','POST',{name:'reported codex',model:'codex-test',mode:'agent',projectDir:path.join(root,'native-project')});
  await a.call(`/api/sessions/${codexChat.id}`,'PATCH',{effort:'high'});
  const codexReport = await reportedTurn(codexChat.id,'hello codex');
  assert.equal(codexReport.sent.modelReport.by,'Codex');
  assert.equal(codexReport.sent.modelReport.model,'fixture-codex');
  assert.equal(codexReport.sent.modelReport.effort,'high');
  assert.match(codexReport.sent.modelReport.effortSource,/rollout-fixture-.*turn_context\.effort/,'it names the Codex file the value came from');
  const codexCapped = await reportedTurn(codexChat.id,'codex-capped');
  assert.equal(codexCapped.sent.modelReport.effort,'medium','what Codex recorded wins over the setting');
  assert.equal(codexCapped.sent.modelReport.requestedEffort,'high');
  const codexSilent = await reportedTurn(codexChat.id,'codex-silent');
  assert.equal(codexSilent.sent.modelReport,undefined,'no Codex record means no claim at all');
  assert.equal(codexSilent.saved.events.findLast(e=>e.type === 'assistant').text,'codex fixture reply');

  // Draw those reports as the open chat does.
  const reportUi = vm.createContext({ state: { models: {}, session: reported, machines: { hosts: [] } },
    esc: v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), clock: () => '12:00', compact: String, humanSize: String,
    render: v => String(v), safeHref: () => '#', nodeApi: v => v, window: {} });
  vm.runInContext(frontend.slice(frontend.indexOf('function toolBlock('), frontend.indexOf('let startShown =')), reportUi);
  vm.runInContext(frontend.slice(frontend.indexOf('function sessionActive('), frontend.indexOf('function sessionOrder(')), reportUi);
  const drawReport = (events, running = false) => {
    Object.assign(reportUi, { shownEvents: events, shownRunning: running });
    return vm.runInContext('(() => { const turns = turnsFrom(shownEvents); return turnHtml(turns.at(-1), turns.length - 1, shownRunning, turns.length, true); })()', reportUi);
  };
  const turnOf = result => result.saved.events.slice(result.saved.events.findLastIndex(e=>e.type === 'user'));
  const plainHtml = drawReport(turnOf(plainReport));
  assert.match(plainHtml,/<summary>Claude Code: fixture-claude-served · max<\/summary>/);
  assert.match(plainHtml,/class="served">fixture-claude-served · max</,'a reply header names the same model and effort');
  assert.match(plainHtml,/class="served">fixture-subagent</,'a subagent step never claims the effort');
  assert.doesNotMatch(plainHtml,/class="model-report warn/);
  assert.match(plainHtml,/Effort max, from Claude Code settings \(get_settings applied\.effort\)/,'tapping it shows where each value came from');
  assert.match(drawReport(turnOf(cappedReport)),/<details class="model-report warn"[\s\S]*<summary>Claude Code: fixture-claude-served · high · you set max<\/summary>/,'a difference from the setting is flagged');
  const refusedHtml = drawReport(turnOf(refusedReport));
  assert.match(refusedHtml,/<summary>Claude Code: fixture-claude-served · effort not reported<\/summary>/);
  assert.doesNotMatch(refusedHtml,/class="served">[^<]*max/,'the setting never stands in for a report');
  const codexHtml = drawReport(turnOf(codexReport));
  assert.match(codexHtml,/<summary>Codex: fixture-codex · high<\/summary>/);
  assert.match(codexHtml,/class="served">fixture-codex · high</);
  const silentHtml = drawReport(turnOf(codexSilent));
  assert.doesNotMatch(silentHtml,/class="model-report/,'no report, no header');
  assert.match(drawReport(turnOf(codexSilent),true),/waiting for the model’s report/,'a running turn says it is still waiting');
  const hostile = {...plainReport.sent, modelReport:{...plainReport.sent.modelReport, model:'<img src=x>', effort:'<b>', by:'<i>'}};
  assert.doesNotMatch(drawReport([hostile]),/<img|<b>|<i>/,'provider text is escaped');
  assert.doesNotMatch(drawReport([{...plainReport.sent, operation:'push', modelReport:undefined}],true),/class="model-report/,'a Push goes to no model');
  // A family alias matches its full name; a different family, or no effort sent, is flagged.
  const headerOf = report => drawReport([{...plainReport.sent, modelReport:{by:'Claude Code',at:1,...report}}]);
  assert.doesNotMatch(headerOf({model:'claude-opus-5-5',requestedModel:'opus[1m]',effort:'max',requestedEffort:'max'}),/class="model-report warn/);
  assert.match(headerOf({model:'claude-sonnet-5-5',requestedModel:'opus',effort:'max',requestedEffort:'max'}),/<summary>Claude Code: claude-sonnet-5-5 · max · you chose opus<\/summary>/);
  assert.doesNotMatch(headerOf({model:'claude-opus-5-5',requestedModel:'default',effort:'high'}),/class="model-report warn/);
  assert.match(headerOf({model:'claude-opus-5-5',effort:null,requestedEffort:'max'}),/<summary>Claude Code: claude-opus-5-5 · no effort sent · you set max<\/summary>/);
  assert.match(headerOf({model:'served',by:'API response'}),/<summary>API response: served · effort not reported<\/summary>/,'an API that does not echo effort is shown as not reporting one');
  assert.match(drawReport([{...plainReport.sent, modelReport:{by:'API response',at:1,model:'served'}}],true),/effort not reported yet/,'a running turn may still hear it');

  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask permission'});
  const permission = await waitQuestion();
  assert.equal(permission.kind,'permission');
  const stream = await b.request(`/api/sessions/${native.id}/events`);
  const interactionReader = stream.body.getReader();
  const hello = new TextDecoder().decode((await interactionReader.read()).value);
  assert.ok(hello.includes(permission.id),'reconnected viewer receives the pending request');
  await b.call(`/api/sessions/${native.id}/interaction`,'POST',{id:permission.id,allow:false});
  let streamText = hello;
  while (!streamText.includes('"kind":"done"')) {
    const chunk = await interactionReader.read();
    if (chunk.done) break;
    streamText += new TextDecoder().decode(chunk.value);
  }
  await interactionReader.cancel();
  const liveMessages = streamText.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  assert.equal(liveMessages.filter(event=>event.kind === 'delta' && event.delta.kind === 'text').length,1,'partial text is not duplicated by the final native event');
  const declined = await waitNativeDone(5);
  assert.equal(JSON.parse(declined.events.findLast(e=>e.type === 'assistant').text).answer.behavior,'deny');
  // Always allow sends back Claude's own suggested rule; Allow everything raises the session's mode.
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask permission always'});
  const alwaysRequest = await waitQuestion();
  assert.deepEqual(alwaysRequest.always,['Bash(echo fixture)'],'the prompt names the rule Always allow adds');
  assert.equal((await b.request(`/api/sessions/${native.id}/interaction`,'POST',{id:alwaysRequest.id,allow:true,scope:'forever'})).status,400);
  await b.call(`/api/sessions/${native.id}/interaction`,'POST',{id:alwaysRequest.id,allow:true,scope:'always'});
  const allowedAlways = JSON.parse((await waitNativeDone(6)).events.findLast(e=>e.type === 'assistant').text).answer;
  assert.equal(allowedAlways.behavior,'allow');
  assert.deepEqual(allowedAlways.updatedPermissions,[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo fixture'}],behavior:'allow',destination:'localSettings'}]);
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask permission everything'});
  const everythingRequest = await waitQuestion();
  await b.call(`/api/sessions/${native.id}/interaction`,'POST',{id:everythingRequest.id,allow:true,scope:'all'});
  const everything = await waitNativeDone(7);
  assert.deepEqual(JSON.parse(everything.events.findLast(e=>e.type === 'assistant').text).answer.updatedPermissions,[{type:'setMode',mode:'bypassPermissions',destination:'session'}]);
  assert.equal(everything.claudePermission,'bypassPermissions','Allow everything applies to later turns');
  assert.equal((await a.call(`/api/sessions/${native.id}`,'PATCH',{claudePermission:'auto'})).claudePermission,'auto');
  assert.equal((await a.request(`/api/sessions/${native.id}`,'PATCH',{claudePermission:'everything'})).status,400);
  await a.call(`/api/sessions/${native.id}`,'PATCH',{claudePermission:'default'});
  // Finish notifications say how the turn ended, from its recorded outcome.
  for (const host of [a, b]) await host.call('/api/notify','POST',{enabled:true,kind:'webhook',url:`http://127.0.0.1:${mock.address().port}/notify`,minSeconds:0});
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask again'});
  await waitQuestion();
  const waitingLists = await Promise.all([a.call('/api/state'), b.call('/api/state')]);
  assert.ok(waitingLists.some(list => list.waiting.includes(native.id)), 'the running computer lists the session as waiting for an answer');
  // Stop hands a queued follow-up back unsent, as interrupting Claude Code does, and says so durably.
  await a.call(`/api/sessions/${native.id}/queue`,'POST',{text:'queued while asking'});
  const stopReply = await b.call(`/api/sessions/${native.id}/stop`,'POST',{});
  assert.deepEqual(stopReply.returned,[{text:'queued while asking',attachments:[]}],'Stop returns the queued message to the browser');
  for(let i=0;i<100 && (await a.call(`/api/sessions/${native.id}`)).turnHost;i++) await pause();
  assert.equal((await a.call(`/api/sessions/${native.id}/interaction`)).request,null,'stop clears pending approval');
  let stoppedNative;
  for(let i=0;i<100;i++) {
    stoppedNative = await a.call(`/api/sessions/${native.id}`);
    if (!stoppedNative.busy && !stoppedNative.turnHost && stoppedNative.events.some(e => e.unsent)) break;
    await pause();
  }
  const stopNotes = stoppedNative.events.slice(stoppedNative.events.findLastIndex(e => e.type === 'user')).filter(e => e.type === 'note');
  assert.equal(stopNotes[0].outcome,'stopped','a stop is recorded as stopped, not as an error');
  assert.match(stopNotes.find(e => e.unsent).text,/Not sent: .*queued while asking/,'the cancelled message survives in the transcript');
  assert.ok(stopNotes.findIndex(e => e.outcome) < stopNotes.findIndex(e => e.unsent),'the stop is noted before what it cancelled');
  assert.deepEqual((await a.call(`/api/sessions/${native.id}/pending`)).pending,[]);
  assert.equal((await a.call('/api/state')).sessions.find(x => x.id === native.id).outcome,'stopped');
  // An expired Claude login is a failure with a fix, not a reply saying "Please run /login".
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'login expired'});
  let signedOut;
  for(let i=0;i<100;i++) {
    signedOut = await a.call(`/api/sessions/${native.id}`);
    if (!signedOut.busy && !signedOut.turnHost && signedOut.events.at(-1)?.type !== 'user' && signedOut.events.some(e => e.reason === 'auth')) break;
    await pause();
  }
  const signedOutTurn = signedOut.events.slice(signedOut.events.findLastIndex(e => e.type === 'user'));
  assert.equal(signedOutTurn.filter(e => e.type === 'assistant' && /login/i.test(e.text)).length,0,'the CLI status line is not shown as the model replying');
  const authNote = signedOutTurn.find(e => e.type === 'note' && e.outcome === 'error');
  assert.equal(authNote?.reason,'auth','a missing login keeps its reason, so the browser can show the sign-in fix');
  assert.ok(!/native-test/.test(authNote.text) && /not signed in/.test(authNote.text),'the note names the model, not its alias, and says what is wrong');
  assert.equal((await a.call('/api/state')).sessions.find(x => x.id === native.id).outcome,'error','the session list shows the last turn failed');
  for (let i=0;i<60 && !notifications.some(n => /^native · .* · failed/.test(n));i++) await pause();
  assert.ok(notifications.some(n => /^native · .* · stopped by you/.test(n)),'a stopped turn is not announced as finished work');
  assert.ok(notifications.some(n => /^native · .* · failed/.test(n)),'an expired login is announced as a failure, whatever its wording');
  for (const host of [a, b]) await host.call('/api/notify','POST',{enabled:false});
  // Lists come from the coordinator; a question from a turn on the other computer must show there too.
  const coordinator = (await a.call('/api/cluster/status')).leader;
  const worker = [a, b].find(host => host.status.self !== coordinator);
  const workerConfig = JSON.parse(await fs.readFile(path.join(worker.dir,'models.json'),'utf8'));
  workerConfig.models['native-test'] = config.models['native-test'];
  await fs.writeFile(path.join(worker.dir,'models.json'),JSON.stringify(workerConfig));
  const remoteNative = await a.call('/api/sessions','POST',{appId:'__harness',name:'native elsewhere',model:'native-test',mode:'chat',ownerNode:worker.status.self});
  assert.equal(remoteNative.ownerNode,worker.status.self);
  await a.call(`/api/sessions/${remoteNative.id}/send`,'POST',{text:'ask me'});
  let remoteWaiting = false;
  for (let i=0;i<100 && !(remoteWaiting = (await a.call('/api/state')).waiting.includes(remoteNative.id));i++) await pause();
  assert.ok(remoteWaiting,'a question on the other computer is listed as waiting for you');
  const remoteQuestion = (await a.call(`/api/sessions/${remoteNative.id}/interaction`)).request;
  await a.call(`/api/sessions/${remoteNative.id}/interaction`,'POST',{id:remoteQuestion.id,allow:true,answers:{'Which behavior?':'Keep'}});
  for (let i=0;i<100 && (await a.call('/api/state')).running.includes(remoteNative.id);i++) await pause();
  assert.ok(!(await a.call('/api/state')).waiting.includes(remoteNative.id),'an answered question is no longer listed');
  await a.call(`/api/sessions/${remoteNative.id}`,'DELETE');
  // Drive the served transcript renderer with that saved turn, as the open session draws it.
  const outcomeUi = vm.createContext({ state: { models: {}, session: signedOut, machines: { leader: a.status.self, hosts: [{ id: signedOut.ownerNode || a.status.self, name: 'Studio Mac' }] } },
    esc: v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), clock: () => '', compact: String, humanSize: String,
    render: v => String(v), safeHref: () => '#', nodeApi: v => v, window: {} });
  vm.runInContext(frontend.slice(frontend.indexOf('function toolBlock('), frontend.indexOf('const copyTexts =')), outcomeUi);
  vm.runInContext(frontend.slice(frontend.indexOf('const copyTexts ='), frontend.indexOf('let startShown =')), outcomeUi);
  outcomeUi.events = signedOut.events;
  const failedHtml = vm.runInContext('const shownTurns = turnsFrom(events); turnHtml(shownTurns.at(-1), shownTurns.length - 1, false, shownTurns.length, true)', outcomeUi);
  assert.match(failedHtml, /Progress · failed/, 'the turn reads as failed, not done');
  const foldBody = failedHtml.match(/<div class="fold-body"[^>]*>([\s\S]*?)<\/div>\s*<div class="turn-outcome"/);
  assert.ok(foldBody, 'the failure is drawn after the collapsed progress, not inside it');
  assert.ok(!/not signed in/.test(foldBody[1]), 'the failure is not hidden in the collapsed fold');
  assert.match(failedHtml, /On Studio Mac, open Terminal and run <code>claude auth login<\/code>/, 'the fix names the session’s computer');
  assert.match(failedHtml, /data-retry=/, 'the latest failed request offers Retry');

  await a.call(`/api/sessions/${s.id}`, 'DELETE');
  b.child.kill('SIGTERM');
  await b.closed;
  const unavailable = await a.request(`/api/execution-models?app=__harness&host=${b.status.self}`);
  assert.ok(!unavailable.ok, 'an offline computer never falls back to the serving computer’s models');
  const offlineApps = await a.call('/api/apps');
  const remoteProject = offlineApps.apps.find(app=>app.id === boardGame.id);
  assert.ok(remoteProject,'remote project metadata survives an offline owner');
  assert.equal(remoteProject.ownerNode,b.status.self);
  assert.equal(remoteProject.runtimeKnown,false,'local listeners do not establish remote app status');

  assert.equal((await unavailable.json()).models, undefined);
  const versionStart = Date.now();
  const offlineVersions = await a.call('/api/harness/versions');
  assert.ok(Date.now() - versionStart < 2000, 'display metadata does not wait for an offline peer timeout');
  assert.ok(offlineVersions.hosts.find(h => h.id === a.status.self).version);
  assert.ok(offlineVersions.hosts.find(h => h.id === b.status.self));
  const offlineHistory = await a.call('/api/diagnostics?action=all');
  assert.equal(offlineHistory.histories.find(h => h.host === b.status.self).unavailable, true);
  assert.ok(offlineHistory.histories.find(h => h.host === a.status.self).events.length);
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:16,days:7});
  // A computer that is asleep or off the tailnet drops packets instead of
  // refusing them. Saving a session must not wait on it: sending a message
  // saves the whole conversation before it is acknowledged.
  const silentPeer = net.createServer(() => {});
  await new Promise(r => silentPeer.listen(Number(new URL(b.status.hosts.find(h => h.id === b.status.self).url).port), '127.0.0.1', r));
  try {
    const quiet = await a.call('/api/sessions', 'POST', { name: 'peer asleep', projectDir: path.join(root, 'quiet-project'), mode: 'chat', model: 'model-a' });
    for (let i = 0; i < 25; i++) await pause(); // let the silent peer age out of the recent set
    const sentAt = Date.now();
    await a.call(`/api/sessions/${quiet.id}/send`, 'POST', { text: 'hello while the other computer sleeps' });
    const acknowledged = Date.now() - sentAt;
    console.log(`send acknowledged in ${acknowledged} ms with a silent peer`);
    assert.ok(acknowledged < 1500, `sending waited ${acknowledged} ms on a computer that cannot answer`);
    for (let i = 0; i < 100 && (await a.call(`/api/sessions/${quiet.id}`)).busy; i++) await pause();
    await a.call(`/api/sessions/${quiet.id}`, 'DELETE');
  } finally { silentPeer.close(); }
  // Pause survives a restart of a lone computer, as when the other one is off:
  // the pause, its queued message and a checkpoint file are saved, and Resume
  // points the agent at that file.
  const pausedDir = path.join(root, 'paused-project');
  await fs.mkdir(pausedDir);
  git(pausedDir, 'init', '-b', 'main');
  await fs.writeFile(path.join(pausedDir, 'README.md'), 'paused project');
  git(pausedDir, 'add', '.'); git(pausedDir, 'commit', '-m', 'initial');
  const pausedTab = await a.call('/api/sessions', 'POST', { name: 'paused work', projectDir: pausedDir, mode: 'agent', model: 'model-a' });
  release = null;
  await a.call(`/api/sessions/${pausedTab.id}/send`, 'POST', { text: 'checkpoint-work' });
  for (let i = 0; i < 80 && !release; i++) await pause();
  assert.ok(release, 'the project turn took a step and is still working');
  await a.call(`/api/sessions/${pausedTab.id}/queue`, 'POST', { text: 'after-checkpoint' });
  const paused = await a.call(`/api/sessions/${pausedTab.id}/pause`, 'POST', {});
  assert.equal(paused.saved, true, 'the pause is saved, not only held in memory');
  assert.match(paused.checkpoint, /\.harness-resume[\\/][^\\/]+\.md$/);
  release(); release = null;
  let stopped;
  for (let i = 0; i < 80; i++) {
    stopped = await a.call(`/api/sessions/${pausedTab.id}`);
    if (!stopped.turnHost && stopped.events.some(e => e.paused) && stopped.events.some(e => e.publication === 'pending')) break;
    await pause();
  }
  const pauseNote = stopped.events.find(e => e.paused);
  assert.ok(pauseNote, 'the transcript says the turn was paused and where its checkpoint is');
  assert.equal(pauseNote.checkpoint, paused.checkpoint);
  assert.ok(paused.checkpoint.startsWith(stopped.tabWorkspace.dir + path.sep), 'the checkpoint is inside the folder the agent works in');
  const checkpointText = await fs.readFile(paused.checkpoint, 'utf8');
  assert.match(checkpointText, /## Request being worked on\n\ncheckpoint-work/);
  assert.match(checkpointText, /1\. ok · list_dir · \./);
  assert.match(checkpointText, /## Last update from the assistant\n\nmodel-a/, 'what the assistant was saying when paused');
  assert.match(checkpointText, /## Queued to run after this work[\s\S]*after-checkpoint/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: stopped.tabWorkspace.dir, encoding: 'utf8' }), '',
    'Git ignores the checkpoint, so Push never publishes it');
  assert.match(stopped.events.findLast(e => e.publication === 'pending').text, /No pending changes/);
  a.child.kill('SIGTERM'); await a.closed;
  await a.restart();
  let afterRestart;
  for (let i = 0; i < 200; i++) {
    afterRestart = await a.call(`/api/sessions/${pausedTab.id}`).catch(() => null);
    if (afterRestart && !afterRestart.ownerOffline && afterRestart.paused) break;
    await pause();
  }
  assert.equal(afterRestart.paused, true, 'Resume is still offered after the owner restarts');
  assert.equal(afterRestart.checkpoint, paused.checkpoint);
  assert.equal((await a.call('/api/state')).sessions.find(x => x.id === pausedTab.id).paused, true, 'the session list shows it paused');
  assert.deepEqual((await a.call(`/api/sessions/${pausedTab.id}/pending`)).pending.map(m => m.text), ['after-checkpoint'],
    'the queued message survived the restart and still waits');
  const pausedStream = await a.request(`/api/sessions/${pausedTab.id}/events`);
  const pausedReader = pausedStream.body.getReader();
  const pausedHello = JSON.parse(new TextDecoder().decode((await pausedReader.read()).value).match(/data: (.*)/)[1]);
  await pausedReader.cancel();
  assert.equal(pausedHello.paused, true, 'a reopened page shows the Resume bar');
  assert.equal(pausedHello.checkpoint, paused.checkpoint);
  // Drive the served paused bar with that hello, as the reopened page does.
  const barElements = new Map();
  const bar = vm.createContext({ window: {}, tabs: { chat: {} }, state: { tab: 'chat' }, hello: pausedHello,
    $: id => { if (!barElements.has(id)) barElements.set(id, { hidden: true, textContent: '' }); return barElements.get(id); },
    paintComposerAction() {}, idlePlaceholder: () => '', pausedPlaceholder: 'Paused' });
  vm.runInContext(frontend.slice(frontend.indexOf('function setPaused('), frontend.indexOf('function setRunning(')), bar);
  vm.runInContext('setPaused(Boolean(hello.paused), "chat", hello.checkpoint)', bar);
  assert.equal(barElements.get('paused').hidden, false, 'Resume is visible after the restart');
  assert.equal(barElements.get('paused-checkpoint').hidden, false, 'the checkpoint can be opened from the paused bar');
  assert.match(barElements.get('paused-detail').textContent, /saved checkpoint/);
  await a.call(`/api/sessions/${pausedTab.id}/resume`, 'POST', {});
  let continued;
  for (let i = 0; i < 100; i++) {
    continued = await a.call(`/api/sessions/${pausedTab.id}`);
    if (!continued.busy && !continued.turnHost && continued.events.filter(e => e.type === 'user').length >= 3) break;
    await pause();
  }
  const continuedUsers = continued.events.filter(e => e.type === 'user');
  assert.deepEqual(continuedUsers.map(e => e.resume ? 'resume' : e.text), ['checkpoint-work', 'resume', 'after-checkpoint'],
    'the interrupted work continues first, then the queued message');
  assert.ok(continuedUsers[1].text.includes(paused.checkpoint), 'Resume tells the agent to re-read the checkpoint');
  assert.ok(modelRequests.some(r => String(r.messages.at(-1)?.content).includes(paused.checkpoint)), 'the checkpoint path reached the model');
  assert.equal(continued.paused, false);
  assert.equal(continued.pause, undefined, 'the saved pause is cleared once resumed');
  const pauseHistory = (await a.call('/api/diagnostics?action=events')).events;
  const pauseRequest = pauseHistory.find(e => e.event === 'turn.paused' && e.outcome === 'interrupted' && e.count === 1);
  assert.ok(pauseRequest, 'the pause was saved, with its queued message');
  assert.ok(pauseHistory.some(e => e.event === 'turn.checkpoint' && e.outcome === 'written' && e.correlationId === pauseRequest.correlationId));
  assert.ok(pauseHistory.some(e => e.event === 'turn.finished' && e.outcome === 'paused'), 'a paused turn is not recorded as an error');
  assert.ok(pauseHistory.some(e => e.event === 'turn.pause-restored' && e.outcome === 'interrupted' && e.count === 1));
  assert.ok(pauseHistory.some(e => e.event === 'turn.resumed' && e.outcome === 'continued-file'));

  // A compacted replica with no tail still owns recoverable history.
  a.child.kill('SIGTERM'); await a.closed;
  const raftFile = path.join(a.dir, 'cluster', 'replica.json');
  const raftDisk = JSON.parse(await fs.readFile(raftFile, 'utf8'));
  const members = [a.status.hosts[0], b.status.hosts[0]];
  const archivedState = {sessions:{saved:{id:'saved',name:'Preserve me'}}, values:{}, viewers:{},
    history:Object.fromEntries(members.map(h => [h.id,h])), preferred:a.status.self};
  const boundary = 50000, oldTerm = raftDisk.term + 10;
  Object.assign(raftDisk, {base:boundary,baseTerm:oldTerm,baseId:'old-boundary',commit:boundary,log:[],term:oldTerm});
  await fs.writeFile(raftFile,JSON.stringify(raftDisk));
  await fs.writeFile(path.join(a.dir,'cluster','snapshot.json'),JSON.stringify({index:boundary,term:oldTerm,id:'old-boundary',configuration:{members},state:archivedState}));
  await a.restart();
  assert.equal((await a.call('/api/diagnostics')).maxMB,16,'history settings survive restart');
  const snapshotResponse = await fetch(a.status.hosts[0].url + '/api/cluster/rpc', {method:'POST',
    headers:{'Content-Type':'application/json','x-cluster-key':raftDisk.secret},
    body:JSON.stringify({kind:'snapshot',from:b.status.self,term:oldTerm+10,index:boundary+1,snapTerm:oldTerm+10,snapId:'replacement',
      configuration:{members},state:{...archivedState,sessions:{}}})});
  assert.equal(snapshotResponse.status,200);
  const archives = (await fs.readdir(path.join(a.dir,'cluster'))).filter(n => n.startsWith('conflict-') && n.endsWith('-snapshot.json'));
  let preserved = false;
  for(const name of archives) {
    const saved = JSON.parse(await fs.readFile(path.join(a.dir,'cluster',name),'utf8'));
    if(saved.state.sessions.saved?.name === 'Preserve me') preserved = true;
  }
  assert.ok(preserved,'snapshot-only history must be archived before replacement');

  console.log('PASS follower-owned turns, local model inventories, SSE proxy, busy assignment guard, single-host eligibility and commands from another computer');
} finally {
  release?.();
  for (const h of hosts) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGTERM');
  await Promise.all(hosts.map(h => h.closed));
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
