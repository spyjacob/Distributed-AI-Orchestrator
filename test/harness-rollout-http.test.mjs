import assert from 'node:assert/strict';
import http from 'node:http';
import { restartPeers } from '../src/core/cluster/restart.js';

// Exercise the rollout over HTTP, including an old process that exits and a
// replacement that reports the expected revision and restart receipt.
const hosts = [], servers = [], restarts = [];
const target = 'published-commit';
try {
  for (const id of ['desktop', 'laptop']) {
    const state = { node: id, instanceId: 'old-' + id, version: { revision: 'previous' }, update: { head: target }, busy: false };
    const server = http.createServer((req, res) => {
      assert.equal(req.headers['x-cluster-key'], 'test-secret');
      assert.equal(req.headers['x-harness-revision'], target);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/harness/restart') {
        restarts.push(id);
        const receipt = { node: id, instanceId: state.instanceId, restartId: 'receipt-' + id };
        res.end(JSON.stringify(receipt));
        state.instanceId = 'new-' + id;
        state.restartId = receipt.restartId;
        state.version = { revision: state.replacementRevision || target, dirty: false };
      } else res.end(JSON.stringify(state));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    hosts.push({ id, name: id, url: `http://127.0.0.1:${server.address().port}`, state });
  }
  const cluster = { self: { id: 'coordinator' }, replica: { members: () => hosts, disk: { secret: 'test-secret' } } };
  hosts[1].state.busy = true;
  await assert.rejects(restartPeers(cluster, { targetRevision: target }), /still running/);
  assert.deepEqual(restarts, [], 'preflight waits for every machine before restarting any');
  hosts[1].state.busy = false;
  hosts[1].state.update.head = 'older-download';
  await assert.rejects(restartPeers(cluster, { targetRevision: target }), /download the published commit/);
  assert.deepEqual(restarts, []);
  hosts[1].state.update.head = target;
  assert.deepEqual(await restartPeers(cluster, { targetRevision: target }), ['desktop', 'laptop']);
  assert.deepEqual(restarts, ['desktop', 'laptop']);
  assert.ok(hosts.every(host => host.state.version.revision === target));
  assert.deepEqual(await restartPeers(cluster, { targetRevision: target }), [], 'verified machines are not restarted again');
  assert.equal(restarts.length, 2);
  hosts[0].state.version.revision = 'previous';
  hosts[0].state.instanceId = 'old-desktop';
  hosts[0].state.replacementRevision = 'wrong-commit';
  await assert.rejects(restartPeers(cluster, { targetRevision: target }), /not running the expected clean commit/);
  assert.equal(restarts.length, 3, 'a failed verification stops the rollout');
  console.log('PASS HTTP rollout waits for idle matching downloads, verifies replacement revisions, and skips verified machines');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
