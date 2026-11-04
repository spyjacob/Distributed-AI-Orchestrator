// Starting DO with its one button: a real checkout, remote, launcher, server and restart.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exited, launcherCheckout, openWindow, pause, until } from '../fixtures/launcher-checkout.mjs';

const fixture = await launcherCheckout('launcher');
const { checkout, data, origin, env, launch, serving, startDirectly, events } = fixture;
const instance = async () => (await (await fetch(`${origin}/api/harness/status`, { signal: AbortSignal.timeout(2000) })).json()).instanceId;

try {
  // One click: the window has something to say straight away, then DO is online.
  const first = await launch();
  const page = await fetch(first.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /stops DO on this computer/);
  assert.match(await (await fetch(`${first.url}styles.css`)).text(), /--bg:/, 'it shares DO’s design');
  assert.equal((await fetch(`http://127.0.0.1:${new URL(first.url).port}/wrong-key/`)).status, 404, 'only the window has the key');
  const rebinding = await new Promise((resolve, reject) => {
    http.get(first.url, { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(rebinding, 404, 'another site cannot reach it by name');
  const window = openWindow(first.url);
  const online = await window.until('DO to be online', view => view.state === 'online');
  assert.equal(online.computer, 'Laptop');
  assert.equal(online.version, 'v1.0');
  assert.deepEqual(online.hosts.map(host => [host.name, host.self, host.active, host.main]), [['Laptop', true, true, true]]);
  assert.deepEqual(online.viewers, []);
  assert.ok(await serving());
  await window.say({ action: 'shown', state: 'online' });

  // A phone connects through Tailscale, exactly as Serve presents it to DO.
  const viewer = await fetch(`${origin}/api/cluster/viewer`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'iPhone', 'tailscale-user-login': 'someone', 'x-forwarded-for': '100.100.100.7' }, body: '{"id":"phone"}' });
  assert.equal(viewer.status, 200);
  const watched = await window.until('the phone to appear', view => view.viewers.length === 1);
  assert.equal(watched.viewers[0].name, 'Phone');
  assert.equal(watched.viewers[0].via, 'Laptop');

  // A second click starts nothing: it brings the first window forward and leaves.
  const second = spawn(process.execPath, ['scripts/launcher.mjs'], { cwd: checkout, env, stdio: 'ignore' });
  assert.equal(await exited(second), 0);
  await until('the window to be asked forward', () => window.views.some(view => view.focus));
  assert.equal(first.child.exitCode, null);

  // A reload comes straight back, so it must not stop anything.
  await window.say({ action: 'closing' });
  await window.close();
  const reloaded = openWindow(first.url);
  await pause(3500);
  assert.equal(reloaded.latest().state, 'online');
  assert.equal(first.child.exitCode, null);
  assert.ok(await serving());

  // Updating restarts DO in place: same window, new server, and closing still stops it.
  const before = await instance();
  assert.equal((await fetch(`${origin}/api/harness/restart`, { method: 'POST' })).status, 200);
  await until('the replacement server', async () => await instance() !== before);
  await reloaded.until('the window to show it online', view => view.state === 'online');
  assert.equal(first.child.exitCode, null, 'a restart does not end the launcher');

  // Closing the window stops DO on this computer, and the launcher with it.
  await reloaded.say({ action: 'closing' });
  await reloaded.close();
  assert.equal(await exited(first.child), 0);
  assert.equal(await serving(), false, 'DO stopped, including the server the restart left detached');
  await assert.rejects(fs.access(path.join(checkout, '.launcher/window.json')));
  const names = (await events()).map(event => event.event);
  for (const name of ['launcher.start', 'window.opened', 'page.connected', 'server.starting', 'server.online', 'page.shown', 'window.focus', 'launcher.second-click', 'stop.started', 'stop.done']) assert.ok(names.includes(name), `traced ${name}`);
  assert.equal((await events()).findLast(event => event.event === 'stop.started').reason, 'window-closed');

  // DO already running: the window attaches to it, and closing still stops it.
  await startDirectly();
  const attached = await launch();
  const attachedWindow = openWindow(attached.url);
  await attachedWindow.until('it to find DO running', view => view.state === 'online');
  assert.equal((await events()).findLast(event => event.event === 'server.online').attached, true);
  assert.ok((await events()).some(event => event.event === 'server.attached'));
  await attachedWindow.say({ action: 'closing' });
  await attachedWindow.close();
  assert.equal(await exited(attached.child), 0);
  assert.equal(await serving(), false);

  // Closing during a restart: the new server must not outlive the window. With nothing
  // of the launcher's own left running, nothing else would catch it coming back.
  await startDirectly();
  const restarted = await launch();
  const restartedWindow = openWindow(restarted.url);
  await restartedWindow.until('DO to be online', view => view.state === 'online');
  assert.equal((await fetch(`${origin}/api/harness/restart`, { method: 'POST' })).status, 200);
  await restartedWindow.say({ action: 'stop' });
  assert.equal(await exited(restarted.child), 0);
  await pause(3000);
  assert.equal(await serving(), false, 'nothing came back after the launcher left');
  await restartedWindow.close();

  // With an access token: the window still reads DO, and the token stays out of the logs.
  const guarded = await launch({ HARNESS_TOKEN: 'auto' });
  const guardedWindow = openWindow(guarded.url);
  await guardedWindow.until('DO to be online', view => view.state === 'online');
  const secret = (await fs.readFile(path.join(data, 'server-token'), 'utf8')).trim();
  assert.ok(secret.length > 8);
  await guardedWindow.say({ action: 'stop' });
  await guardedWindow.until('the window to say it stopped', view => view.state === 'stopped');
  assert.equal(await exited(guarded.child), 0);
  await guardedWindow.close();
  assert.match(await fs.readFile(path.join(checkout, '.launcher/output.log'), 'utf8'), /\?t=\[hidden\]/);
  for (const file of ['output.log', 'trace.jsonl']) assert.ok(!(await fs.readFile(path.join(checkout, '.launcher', file), 'utf8')).includes(secret), `no token in ${file}`);
  console.log('PASS one launcher starts DO with a live status window, shows computers and viewers, survives restarts, and stops DO when closed, even mid-restart');
} finally {
  await fixture.cleanUp();
}
