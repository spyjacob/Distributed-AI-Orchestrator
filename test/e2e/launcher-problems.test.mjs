// What the Start DO window says when DO cannot just run, and that closing it still works.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exited, launcherCheckout, openWindow, pause, until } from '../fixtures/launcher-checkout.mjs';
import { listeners } from '../../scripts/stop-server.mjs';

const fixture = await launcherCheckout('launcher-problems');
const { root, remote, port, origin, env, git, launch, serving, startDirectly, events, track } = fixture;

try {
  // Something else holds the port: closing ends the launcher and leaves that program alone.
  const other = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => other.listen(port, '0.0.0.0', resolve));
  const givenUp = await launch();
  const givenUpWindow = openWindow(givenUp.url);
  await givenUpWindow.until('the failure to show', view => view.state === 'offline');
  await givenUpWindow.say({ action: 'closing' });
  await givenUpWindow.close();
  assert.equal(await exited(givenUp.child), 0, 'closing ends the launcher even though the port was never DO’s');
  assert.equal((await fetch(origin)).status, 404, 'and leaves the other program running');

  // The window says what is wrong, and Start DO tries again.
  const blocked = await launch();
  const blockedWindow = openWindow(blocked.url);
  const failed = await blockedWindow.until('the failure to show', view => view.state === 'offline');
  assert.match(failed.detail, new RegExp(`Port ${port} is already in use`));
  assert.ok(failed.log.length > 0, 'the window can show what happened');
  assert.ok((await events()).some(event => event.event === 'server.failed'), 'the failure is traced');
  await new Promise(resolve => other.close(resolve));
  await blockedWindow.say({ action: 'retry' });
  await blockedWindow.until('DO to recover', view => view.state === 'online');
  await blockedWindow.say({ action: 'stop' });
  await blockedWindow.until('the window to say it stopped', view => view.state === 'stopped');
  assert.equal(await exited(blocked.child), 0);
  assert.equal(await serving(), false);
  await blockedWindow.close();

  // Tailscale off: DO runs but refuses to work on purpose, so the window says that and
  // carries on by itself, both when it started DO and when it found DO already waiting.
  const tailscale = path.join(root, 'tailscale-state');
  await fs.writeFile(tailscale, 'Stopped');
  const blockedByNetwork = { HARNESS_TEST_TAILSCALE_STATE: tailscale };
  const off = await launch(blockedByNetwork);
  const offWindow = openWindow(off.url);
  const waiting = await offWindow.until('it to say what DO needs', view => view.state === 'waiting');
  assert.equal(waiting.needsTailscale, true);
  assert.match(waiting.detail, /until Tailscale is connected/);
  assert.deepEqual(waiting.hosts.map(host => host.name), ['Laptop'], 'it still knows the computers');
  assert.ok((await events()).some(event => event.event === 'server.waiting' && event.for === 'tailscale'));
  await fs.writeFile(tailscale, 'Running');
  const reconnected = await offWindow.until('DO to come online by itself', view => view.state === 'online');
  assert.equal(reconnected.needsTailscale, false);
  await offWindow.say({ action: 'stop' });
  assert.equal(await exited(off.child), 0);
  await offWindow.close();
  await fs.writeFile(tailscale, 'Stopped');
  await startDirectly(blockedByNetwork);
  const offAttached = await launch(blockedByNetwork);
  const offAttachedWindow = openWindow(offAttached.url);
  await offAttachedWindow.until('it to find DO waiting', view => view.state === 'waiting');
  await offAttachedWindow.say({ action: 'closing' });
  await offAttachedWindow.close();
  assert.equal(await exited(offAttached.child), 0);
  assert.equal(await serving(), false, 'closing stops DO even while it waits for Tailscale');

  // DO dies while the window waits for Tailscale: the window must not go on saying Waiting.
  await startDirectly(blockedByNetwork);
  const dying = await launch(blockedByNetwork);
  const dyingWindow = openWindow(dying.url);
  await dyingWindow.until('it to find DO waiting', view => view.state === 'waiting');
  for (const pid of listeners(port)) process.kill(Number(pid));
  await dyingWindow.until('it to notice', view => view.state === 'restarting');
  dying.child.kill('SIGKILL');
  await exited(dying.child);
  await dyingWindow.close();

  // A second copy of DO from another folder is not this window's to show or stop.
  const otherCheckout = path.join(root, 'other'), otherData = path.join(root, 'other-data');
  git(root, 'clone', '-q', remote, otherCheckout);
  // A symlink travels in the clone; a Windows junction stays out of Git.
  await fs.symlink(path.resolve('node_modules'), path.join(otherCheckout, 'node_modules'), 'junction').catch(() => {});
  await fs.mkdir(otherData);
  const otherCopy = track(spawn(process.execPath, ['server/boot.js'], { cwd: otherCheckout, stdio: 'ignore',
    env: { ...env, HARNESS_PORT: String(port), HARNESS_DATA_DIR: otherData, ORCHESTRATOR_NODE_NAME: 'Other' } }));
  await until('the other copy', serving);
  const refused = await launch();
  const refusedWindow = openWindow(refused.url);
  const refusal = await refusedWindow.until('it to refuse', view => view.state === 'offline');
  assert.match(refusal.detail, /Another copy of DO is using port/);
  assert.ok((await events()).some(event => event.event === 'server.other-copy'));
  await pause(2500);
  assert.equal(refusedWindow.latest().state, 'offline', 'it never claims the other copy as its own');
  assert.deepEqual(refusedWindow.latest().hosts, []);
  await refusedWindow.say({ action: 'closing' });
  await refusedWindow.close();
  assert.equal(await exited(refused.child), 0);
  assert.ok(await serving(), 'the other copy is still running');
  otherCopy.kill();
  await exited(otherCopy);
  console.log('PASS the Start DO window explains a taken port, another copy of DO and Tailscale being off, recovers by itself, and still closes cleanly');
} finally {
  await fixture.cleanUp();
}
