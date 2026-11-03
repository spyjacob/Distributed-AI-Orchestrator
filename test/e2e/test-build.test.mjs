// Changing DO on a real computer: a real checkout, remote, server and restarts.
// Unpushed changes must run here, survive restarts, fail safely, reach other
// computers only as a report, and go away by Push or Discard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-build-'));
const checkout = path.join(root, 'checkout'), remote = path.join(root, 'remote.git'), data = path.join(root, 'data');
await fs.mkdir(checkout); await fs.mkdir(data);
for (const entry of ['server', 'src', 'scripts']) await fs.cp(entry, path.join(checkout, entry), { recursive: true });
for (const file of ['package.json', '.gitignore']) await fs.copyFile(file, path.join(checkout, file));
await fs.writeFile(path.join(checkout, 'VERSION'), '1.0\n'); // fixed: every real Push changes the repo's own
await fs.writeFile(path.join(checkout, '.harness-integration.json'), '{"command":"node -e 0"}');
await fs.symlink(path.resolve('node_modules'), path.join(checkout, 'node_modules'), 'junction');
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(root, 'init', '--bare', '-b', 'main', remote);
git(checkout, 'init', '-b', 'main');
await fs.appendFile(path.join(checkout, '.git/info/exclude'), 'node_modules\n');
git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'published');
git(checkout, 'remote', 'add', 'origin', remote); git(checkout, 'push', '-qu', 'origin', 'main');

// A model that makes the edits it is told to, through the real tools.
const seen = [];
const sse = (delta, finish) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
const model = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  seen.push(JSON.stringify(body.messages));
  const last = body.messages.findLastIndex(m => m.role === 'user');
  const text = [body.messages[last]?.content].flat().map(part => part?.text ?? part).join('');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (text.startsWith('plan:') && !body.messages.slice(last).some(m => m.role === 'tool')) {
    const plan = JSON.parse(text.slice(5));
    const calls = [...Object.entries(plan.write || {}).map(([file, content]) => ['write_file', { path: file, content }]),
      ...(plan.edit || []).map(([file, oldText, newText]) => ['edit_file', { path: file, old_string: oldText, new_string: newText }])];
    return res.end(sse({ tool_calls: calls.map(([name, args], index) => ({ index, id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls'));
  }
  res.end(sse({ content: 'Done.' }, 'stop'));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(data, 'models.json'), JSON.stringify({ default: 'mock', models: { mock: { provider: 'openai', model: 'mock', label: 'mock', baseUrl: `http://127.0.0.1:${model.address().port}/v1` } } }));

const freePort = async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
};
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const { ORCHESTRATOR_TEST_BUILDS: _off, ...env } = process.env;
// Someone's own address, in their global Git settings, must never be published.
const personalGit = path.join(root, 'personal.gitconfig');
await fs.writeFile(personalGit, '[user]\n\tname = Someone Personal\n\temail = personal@example.invalid\n');
const first = spawn(process.execPath, ['server/boot.js'], { cwd: checkout, stdio: 'ignore',
  env: { ...env, GIT_CONFIG_GLOBAL: personalGit, HARNESS_PORT: String(port), HARNESS_TOKEN: 'build-test', HARNESS_DATA_DIR: data, ORCHESTRATOR_PUBLIC_URL: origin, ORCHESTRATOR_NODE_NAME: 'Laptop' } });
const pids = new Set([first.pid]);

const request = (route, method = 'GET', body, target = origin) => fetch(target + route, { method,
  headers: { 'Content-Type': 'application/json', 'x-harness-token': 'build-test' },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
const call = async (route, method, body, target) => {
  const response = await request(route, method, body, target);
  const value = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(value)}`);
  return value;
};
const until = async (what, read, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; error = null; } catch (e) { error = e; }
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${what}${error ? `: ${error.message}` : ''}`);
};
const status = async () => { const value = await call('/api/harness/status'); pids.add(value.pid); return value; };
const page = async (route) => {
  const response = await request(route);
  return { status: response.status, text: await response.text() };
};
const label = async () => (await page('/')).text.match(/<div id="header-revision">.*?>([^<]*)<\/a><\/div>/)[1];
const sessions = new Map();
const tab = async (name) => {
  const session = await until('a new session', () => call('/api/sessions', 'POST', { appId: '__harness', name, mode: 'agent', model: 'mock' }));
  sessions.set(name, session.id);
  return session.id;
};
const read = id => call(`/api/sessions/${id}`);
/** Send one turn and wait for it to finish, across any restart it causes. */
const turn = async (id, plan) => {
  const before = (await read(id)).events.length;
  await call(`/api/sessions/${id}/send`, 'POST', { text: 'plan:' + JSON.stringify(plan) });
  return until('the turn to finish', async () => {
    const session = await read(id);
    return !session.busy && !session.turnHost && session.events.length > before && session.events.some((e, i) => i >= before && e.publication === 'pending') ? session : null;
  });
};
const noteOf = session => session.events.findLast(e => e.publication === 'pending')?.text;
const gitStatus = id => call(`/api/git?session=${id}`);
const unchangedInstance = async (instanceId) => { await pause(1800); assert.equal((await status()).instanceId, instanceId, 'no restart'); };
const newInstance = (instanceId) => until('DO to restart itself', async () => { const value = await status(); return value.instanceId !== instanceId ? value : null; });
const remoteFile = (file) => git(remote, 'show', `main:${file}`);
const INDEX = 'server/index.js', STATIC = '// ---- static';
const addRoute = (route) => [INDEX, STATIC, `${STATIC}\n    if (pathname === '/${route}') return json(res, 200, { route: '${route}' });`];
const css = await fs.readFile(path.join(checkout, 'server/public/styles.css'), 'utf8');
let peer;
try {
  const started = await until('the server', status);
  assert.equal(started.version.number, 'v1.0');
  assert.equal(started.version.testing, null);
  assert.equal(await label(), 'Laptop · v1.0');
  assert.ok(!(await page('/')).text.includes('doAppReady'), 'published code has no broken-page link');

  // An interface change runs at once, with no restart, and the checkout stays clean.
  const uiTab = await tab('Interface tab');
  const ui = await turn(uiTab, { write: { 'server/public/styles.css': css + '/* live-ui */\n' } });
  assert.match(noteOf(ui), /Running on this computer · 1 unpushed file\./);
  const swapped = await status();
  assert.equal(swapped.instanceId, started.instanceId, 'interface changes need no restart');
  assert.deepEqual(swapped.version.testing, { files: 1, tabs: [{ session: uiTab, name: 'Interface tab' }] });
  assert.notEqual(swapped.ui, started.ui, 'open pages learn they are stale');
  assert.ok((await page('/styles.css')).text.includes('live-ui'));
  assert.equal(await label(), 'Laptop · v1.0 + 1 unpushed file');
  assert.ok((await page('/')).text.includes(`data-ui="${swapped.ui}"`));
  assert.ok((await page('/')).text.includes('doAppReady'), 'a test build gets a way back that needs no app.js');
  assert.equal(git(checkout, 'status', '--porcelain'), '', 'the published checkout is not touched');
  assert.ok(!(await fs.readFile(path.join(checkout, 'server/public/styles.css'), 'utf8')).includes('live-ui'));
  assert.equal((await gitStatus(uiTab)).testing.running, true);
  await unchangedInstance(started.instanceId);

  // A server change restarts DO by itself once idle. Nobody presses anything.
  const restarted = await (async () => {
    const session = await turn(uiTab, { edit: [addRoute('live-route')] });
    assert.match(noteOf(session), /DO restarts to load them now/);
    return newInstance(started.instanceId);
  })();
  assert.equal((await call('/live-route')).route, 'live-route');
  assert.equal(restarted.version.testing.files, 2);
  assert.equal(restarted.node, started.node);
  assert.ok((await page('/styles.css')).text.includes('live-ui'), 'earlier changes stay');
  assert.equal(await label(), 'Laptop · v1.0 + 2 unpushed files');
  assert.equal((await read(uiTab)).id, uiTab, 'the real sessions carry over');

  // A plain restart keeps them.
  const manual = await call('/api/harness/restart', 'POST');
  assert.ok(manual.restartId);
  const afterManual = await newInstance(restarted.instanceId);
  assert.equal(afterManual.restartId, manual.restartId);
  assert.equal((await call('/live-route')).route, 'live-route');
  assert.equal(afterManual.version.testing.files, 2);

  // Code that cannot start never replaces what runs, and the AI hears why.
  const broken = await turn(uiTab, { edit: [[INDEX, STATIC, `${STATIC}\n    this is not javascript;`]] });
  assert.match(noteOf(broken), /not running on this computer/);
  const told = broken.events.findLast(e => e.operation === 'push' && e.type === 'assistant');
  assert.match(told.text, /keeps running what it had/);
  assert.match(told.text, /SyntaxError|Unexpected/);
  await unchangedInstance(afterManual.instanceId);
  assert.equal((await call('/live-route')).route, 'live-route', 'still serving the last good changes');
  assert.match((await gitStatus(uiTab)).testing.error, /SyntaxError|Unexpected/);
  // Fixing it clears the problem. The code matches what runs, so no restart either.
  const fixed = await turn(uiTab, { edit: [[INDEX, `${STATIC}\n    this is not javascript;`, STATIC]] });
  assert.ok(seen.at(-2).includes('keeps running what it had'), 'the next turn was told what went wrong');
  assert.match(noteOf(fixed), /Running on this computer/);
  assert.equal((await gitStatus(uiTab)).testing.error, null);
  await unchangedInstance(afterManual.instanceId);

  // Passing the trial but crashing for real falls back to published on its own.
  const trial = await turn(uiTab, { edit: [[INDEX, 'const PORT = Number(', `if (process.env.ORCHESTRATOR_TEST_BUILDS !== 'trial') throw new Error('boom on real start');\nconst PORT = Number(`]] });
  assert.match(noteOf(trial), /DO restarts to load them/);
  const fellBack = await newInstance(afterManual.instanceId);
  await until('published code', async () => (await status()).version.testing === null);
  assert.equal((await page('/live-route')).status === 200, false, 'test code is gone');
  assert.ok(!(await page('/styles.css')).text.includes('live-ui'));
  const failed = await call('/api/harness/test-build');
  assert.match(failed.failure.message, /boom on real start/);
  assert.deepEqual(failed.tabs, []);
  assert.equal(fellBack.version.number, 'v1.0');
  const fallbackNote = await until('the tab to be told', async () => (await read(uiTab)).events.findLast(e => /stopped DO from starting/.test(e.text || '')));
  assert.match(fallbackNote.text, /still in this tab/);
  assert.match(fallbackNote.text, /boom on real start/);
  assert.equal((await gitStatus(uiTab)).pending, true, 'nothing was lost');

  // Discard removes a tab's changes for good, keeping a recoverable copy.
  const discarded = await call(`/api/git/discard?session=${uiTab}`, 'POST', { session: uiTab });
  assert.equal(discarded.ok, true);
  assert.equal((await gitStatus(uiTab)).pending, false);
  const uiDir = (await read(uiTab)).tabWorkspace.dir;
  assert.equal(git(uiDir, 'status', '--porcelain'), '');
  assert.equal(await fs.readFile(path.join(uiDir, 'server/public/styles.css'), 'utf8'), css);
  assert.match(git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/harness/discarded'), /refs\/harness\/discarded\//);
  assert.ok((await read(uiTab)).events.findLast(e => e.operation === 'push' && e.outcome === 'success').text.startsWith('Discarded'));

  // Discarding what is running takes it away at once.
  const discardTab = await tab('Discard tab');
  await turn(discardTab, { write: { 'server/public/styles.css': css + '/* running */\n' } });
  assert.ok((await page('/styles.css')).text.includes('running'));
  await call(`/api/git/discard?session=${discardTab}`, 'POST', { session: discardTab });
  assert.equal((await status()).version.testing, null);
  assert.ok(!(await page('/styles.css')).text.includes('running'));

  // Tabs combine; a conflicting one stays out and is told why.
  const one = await tab('Tab one'), two = await tab('Tab two'), three = await tab('Tab three');
  await turn(one, { write: { 'docs/one.md': 'one\n', 'docs/same.md': 'from one\n' } });
  await turn(two, { write: { 'docs/two.md': 'two\n' } });
  const combined = await status();
  assert.equal(combined.version.testing.files, 3);
  assert.deepEqual(combined.version.testing.tabs.map(entry => entry.name), ['Tab one', 'Tab two']);
  const conflict = await turn(three, { write: { 'docs/same.md': 'from three\n' } });
  assert.match(noteOf(conflict), /conflict with another tab's unpushed changes in docs\/same\.md/);
  assert.deepEqual((await gitStatus(three)).testing.conflict.files, ['docs/same.md']);
  assert.equal((await gitStatus(three)).testing.running, false);
  assert.equal((await status()).version.testing.files, 3, 'the others keep running');

  // Back to published leaves every tab's work in place; a tab can come back by itself.
  await call('/api/harness/test-build/stop', 'POST');
  assert.equal((await status()).version.testing, null);
  assert.equal((await gitStatus(one)).pending, true);
  assert.equal((await call('/api/harness/test-build')).tabs.length, 0);
  assert.match((await page('/test-build')).text, /published version/);
  await call(`/api/git/test?session=${one}`, 'POST', { session: one });
  assert.equal((await status()).version.testing.tabs[0].name, 'Tab one');
  assert.match((await page('/test-build')).text, /Go back to published/);
  await call('/api/harness/test-build/stop', 'POST');
  for (const id of [one, two, three]) await call(`/api/git/discard?session=${id}`, 'POST', { session: id });

  // Push: what ran is what publishes, numbered, with no restart when the code matches.
  const pushTab = await tab('Push tab');
  await turn(pushTab, { edit: [addRoute('pushed-route')], write: { 'server/public/styles.css': css + '/* pushed */\n' } });
  const beforePush = await newInstance(fellBack.instanceId);
  assert.equal((await call('/pushed-route')).route, 'pushed-route');
  const pushed = await call(`/api/git/push?session=${pushTab}`, 'POST', { session: pushTab });
  assert.equal(pushed.version, 'v1.01');
  assert.equal(pushed.files.length, 2, 'the version number is not counted as a change');
  const pushedSession = await read(pushTab);
  assert.match(pushedSession.events.findLast(e => e.operation === 'push' && e.type === 'assistant').text, /^Push done · 2 files · v1\.01\.$/);
  assert.ok(!/Restart/.test(pushedSession.events.at(-1).text));
  assert.equal(remoteFile('VERSION'), '1.01');
  assert.match(git(remote, 'log', '-1', '--format=%s', 'main'), /^harness: v1\.01$/);
  const published = () => git(remote, 'log', '--format=%an <%ae> %cn <%ce>', 'main');
  assert.match(published(), /Distributed Orchestrator <orchestrator@localhost>/, 'the saved changes are in this push');
  assert.doesNotMatch(published(), /personal/i, 'a Push does not reveal someone’s global Git identity');
  git(checkout, 'config', '--local', 'user.email', 'chosen@example.invalid');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
  assert.equal(await fs.readFile(path.join(checkout, 'VERSION'), 'utf8'), '1.01\n');
  const afterPush = await status();
  assert.equal(afterPush.instanceId, beforePush.instanceId, 'it was already running');
  assert.equal(afterPush.version.testing, null);
  assert.equal(afterPush.version.number, 'v1.01');
  assert.equal(afterPush.version.revision, git(remote, 'rev-parse', 'main'));
  assert.equal(await label(), 'Laptop · v1.01');
  assert.equal((await call('/pushed-route')).route, 'pushed-route');
  assert.equal((await gitStatus(pushTab)).pending, false);
  await unchangedInstance(beforePush.instanceId);

  // A push that fails leaves no number behind; a larger step is asked for by file.
  const minorTab = await tab('Minor tab');
  await turn(minorTab, { write: { 'docs/minor.md': 'minor\n', '.harness-next-version': 'minor\n' } });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const rejected = await request(`/api/git/push?session=${minorTab}`, 'POST', { session: minorTab });
  assert.equal(rejected.status, 409);
  const minorDir = (await read(minorTab)).tabWorkspace.dir;
  assert.doesNotMatch(git(minorDir, 'log', '-1', '--format=%s'), /^harness: v/);
  assert.equal(git(minorDir, 'show', 'HEAD:VERSION'), '1.01');
  assert.equal(git(minorDir, 'show', 'HEAD:.harness-next-version'), 'minor');
  assert.equal(git(remote, 'show', 'main:VERSION'), '1.01');
  assert.equal((await status()).version.testing.tabs[0].name, 'Minor tab', 'a failed push leaves the changes running');
  await fs.rm(hook);
  assert.equal((await call(`/api/git/push?session=${minorTab}`, 'POST', { session: minorTab })).version, 'v1.1');
  assert.match(published(), /chosen@example\.invalid/, 'an identity chosen for this repository is kept');
  assert.equal(git(checkout, 'config', '--local', 'user.email'), 'chosen@example.invalid');
  assert.equal(remoteFile('VERSION'), '1.10');
  assert.throws(() => remoteFile('.harness-next-version'), 'the request is used up');
  assert.equal((await status()).version.number, 'v1.1');
  const majorTab = await tab('Major tab');
  await turn(majorTab, { write: { 'docs/major.md': 'major\n', '.harness-next-version': 'major\n' } });
  assert.equal((await call(`/api/git/push?session=${majorTab}`, 'POST', { session: majorTab })).version, 'v2.0');
  const nextTab = await tab('Next tab');
  await turn(nextTab, { write: { 'docs/next.md': 'next\n' } });
  assert.equal((await call(`/api/git/push?session=${nextTab}`, 'POST', { session: nextTab })).version, 'v2.01');
  assert.equal(await label(), 'Laptop · v2.01');

  // Another computer publishes while this one tests: its changes arrive under them.
  const reportTab = await tab('Report tab');
  await turn(reportTab, { write: { 'docs/report.md': 'report\n' } });
  const testing = await status();
  const elsewhere = path.join(root, 'elsewhere');
  git(root, 'clone', '-q', remote, elsewhere);
  await fs.writeFile(path.join(elsewhere, 'server/public/styles.css'), css + '/* from elsewhere */\n');
  await fs.writeFile(path.join(elsewhere, 'VERSION'), '2.02\n');
  git(elsewhere, 'add', '-A'); git(elsewhere, 'commit', '-qm', 'interface from elsewhere'); git(elsewhere, 'push', '-q', 'origin', 'main');
  const adopted = await until('the interface from elsewhere', async () => { const value = await status(); return value.version.number === 'v2.02' ? value : null; }, 45000);
  assert.equal(adopted.instanceId, testing.instanceId, 'an interface update needs no restart either');
  assert.equal(adopted.update.restartRequired, false);
  assert.equal(adopted.version.testing.tabs[0].name, 'Report tab', 'unpushed changes stay on top of it');
  assert.ok((await page('/styles.css')).text.includes('from elsewhere'));
  assert.equal(await label(), 'Laptop · v2.02 + 1 unpushed file');
  // A server update still restarts through the normal rollout, and keeps them too.
  const serverSource = await fs.readFile(path.join(elsewhere, INDEX), 'utf8');
  await fs.writeFile(path.join(elsewhere, INDEX), serverSource.replace(STATIC, addRoute('from-elsewhere')[2]));
  await fs.writeFile(path.join(elsewhere, 'VERSION'), '2.03\n');
  git(elsewhere, 'add', '-A'); git(elsewhere, 'commit', '-qm', 'server from elsewhere'); git(elsewhere, 'push', '-q', 'origin', 'main');
  const rolled = await until('the rollout', async () => { const value = await status(); return value.instanceId !== adopted.instanceId && value.version.number === 'v2.03' ? value : null; }, 60000)
    .catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify(await status())}`); });
  assert.equal((await call('/from-elsewhere')).route, 'from-elsewhere');
  assert.equal(rolled.version.testing.tabs[0].name, 'Report tab');
  assert.equal(rolled.version.revision, git(remote, 'rev-parse', 'main'));
  assert.equal(git(checkout, 'status', '--porcelain'), '');

  // Another computer can see that this one runs unpushed changes.
  const peerPort = await freePort(), peerOrigin = `http://127.0.0.1:${peerPort}`;
  peer = spawn(process.execPath, ['server/index.js'], { cwd: checkout, stdio: 'ignore',
    env: { ...env, ORCHESTRATOR_TEST_BUILDS: 'off', HARNESS_PORT: String(peerPort), HARNESS_TOKEN: 'build-test', HARNESS_DATA_DIR: path.join(root, 'peer'), ORCHESTRATOR_PUBLIC_URL: peerOrigin, ORCHESTRATOR_NODE_NAME: 'Desktop' } });
  await until('the second computer', () => call('/api/harness/status', 'GET', undefined, peerOrigin));
  await call('/api/cluster/join', 'POST', { url: origin, ownUrl: peerOrigin, token: 'build-test' }, peerOrigin);
  const report = await until('the report on the second computer', async () => {
    const versions = await call('/api/harness/versions', 'GET', undefined, peerOrigin);
    return versions.hosts.find(host => host.name === 'Laptop' && host.version?.testing);
  });
  assert.equal(report.state, 'Testing 1 unpushed file');
  assert.equal(report.version.number, 'v2.03');
  assert.equal(report.version.testing.tabs[0].name, 'Report tab');

  // Nothing leaked into the published checkout, and old builds were cleaned up.
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  const kept = await fs.readdir(path.join(checkout, '.git/harness-builds'));
  assert.ok(kept.length <= 2, `only the running and serving builds remain: ${kept}`);
  const traces = (await call('/api/diagnostics?action=events&limit=2000')).events.map(event => `${event.event || event.name}:${event.outcome || ''}`);
  for (const expected of ['test-build.applied:swapped', 'test-build.applied:restart', 'test-build.rejected:start', 'test-build.failed:boot', 'test-build.discard:swapped', 'test-build.stop:swapped'])
    assert.ok(traces.includes(expected), `${expected} in traces`);
  console.log('PASS unpushed DO changes run on their computer, survive restarts, fall back when broken, and leave through Discard or a numbered Push; other computers see the report');
} finally {
  if (peer && peer.exitCode === null) peer.kill();
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  try { process.kill((await status()).pid, 'SIGTERM'); } catch {}
  await pause(1200);
  model.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
