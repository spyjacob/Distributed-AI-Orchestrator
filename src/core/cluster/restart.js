import { setTimeout as pause } from 'node:timers/promises';

// Use the longstanding host-local endpoints so older peers can be upgraded too.
// Never replay a restart POST: a lost reply may still mean it was accepted.
export async function restartPeers(cluster, { request = fetch, sleep = pause, now = Date.now, targetRevision } = {}) {
  const peers = cluster.replica.members().filter(host => host.id !== cluster.self.id);
  const call = async (host, operation, method = 'GET') => {
    const response = await request(new URL(`/api/harness/${operation}`, host.url), {
      method, redirect: 'error', headers: { 'x-cluster-key': cluster.replica.disk.secret, ...(targetRevision ? { 'x-harness-revision': targetRevision } : {}) },
      signal: AbortSignal.timeout(operation === 'restart' ? 190000 : 5000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  const completed = [];
  const alreadyCurrent = new Set();
  let current;
  try {
    // Check every peer before stopping any of them. Each restart endpoint also
    // checks for work that started after this preflight.
    for (current of peers) {
      const status = await call(current, 'status');
      if (status.node !== current.id || !status.instanceId) throw new Error('Unexpected server identity.');
      if (targetRevision && (status.version?.dirty || status.update?.error || status.update?.skipped)) throw new Error('Update blocked; check this computer’s version details.');
      if (targetRevision && (status.update?.head || status.version?.revision) !== targetRevision) throw new Error('Waiting for this computer to download the published commit.');
      if (status.busy || status.restarting) throw new Error('A turn, queued message or restart is still running.');
      if (targetRevision && status.version?.revision === targetRevision) alreadyCurrent.add(current.id);
    }
    for (current of peers) {
      if (alreadyCurrent.has(current.id)) continue;
      const expected = await call(current, 'restart', 'POST');
      if (expected.node !== current.id || !expected.restartId || !expected.instanceId)
        throw new Error('The old server cannot verify its restart. Refresh that computer and retry.');
      const deadline = now() + 45000;
      let verified = false;
      while (now() < deadline) {
        await sleep(700);
        let status;
        try { status = await call(current, 'status'); }
        catch { continue; } // A restarting listener is temporarily unavailable.
        if (status.node === current.id && status.restartId === expected.restartId && status.instanceId !== expected.instanceId) {
          if ((expected.revision || targetRevision) && (status.version?.revision !== (expected.revision || targetRevision) || status.version?.dirty)) throw new Error('Replacement is not running the expected clean commit.');
          verified = true;
          break;
        }
      }
      if (!verified) throw new Error('The replacement server did not reconnect in time.');
      completed.push(current.name || current.id);
    }
  } catch (error) {
    throw new Error(`Restart stopped at ${current.name || current.id}: ${error.message} This computer has not restarted.${completed.length ? ` Already restarted: ${completed.join(', ')}.` : ''} Make sure every paired computer is running, then retry.`);
  }
  return completed;
}
