import crypto from 'node:crypto';

// Identity comes from the local Tailscale inventory plus a verified HTTPS
// callback, never from caller-supplied identity headers or an arbitrary URL.
// `publish` gives this host its Tailscale HTTPS address on demand, so joining
// does not need a separate setup step first.
export function hostPairing({ cluster, inventory, join, publish, request = fetch, now = Date.now }) {
  let pending = null;
  let joining = false;
  let message = '';
  const announced = new Map();
  async function origin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Use the host’s Tailscale HTTPS address without a path.');
    }
    const found = await inventory();
    if (found.error || !found.devices.some(d => !d.local && d.active && d.dns === url.hostname && d.dns.endsWith('.ts.net'))) {
      throw new Error('This address is not an online device in this host’s Tailscale inventory.');
    }
    return url.origin;
  }
  async function remote(url, body) {
    const response = await request(url + '/api/cluster/pairing', {
      redirect: 'error', signal: AbortSignal.timeout(5000),
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('The other host could not complete pairing.');
    return response.json();
  }
  function status() {
    if (pending && pending.expires <= now() && !joining) pending = null;
    return { service: 'distributed-orchestrator', node: cluster.self.id, name: cluster.self.name,
      url: cluster.self.url, shared: cluster.shared(), main: cluster.replica.writable(),
      pending, joining, message };
  }
  async function inspect(value) {
    const url = await origin(value);
    const peer = await remote(url);
    if (peer.service !== 'distributed-orchestrator' || peer.url !== url || !/^[a-f0-9-]{36}$/.test(peer.node)) {
      throw new Error('No matching Orchestrator host at this address.');
    }
    return peer;
  }
  return {
    status,
    async discover() {
      const found = await inventory();
      if (found.error) return { hosts: [], error: found.error, local: status() };
      const candidates = found.devices.filter(d => !d.local && d.active && d.dns?.endsWith('.ts.net') && !/iOS|android/i.test(d.platform || ''));
      const hosts = [];
      for (const [url, expires] of announced) {
        if (expires <= now()) { announced.delete(url); continue; }
        const peer = await inspect(url).catch(() => null);
        if (peer) hosts.push(peer);
      }
      // Limit concurrency. A phone or unrelated HTTPS service is not a host.
      for (let i = 0; i < candidates.length; i += 8) {
        await Promise.all(candidates.slice(i, i + 8).map(async d => {
          const ports = [...new Set(['', ':8443', new URL(cluster.self.url || 'https://local').port].map(p => p && !p.startsWith(':') ? ':' + p : p))];
          const results = await Promise.all(ports.map(p => inspect(`https://${d.dns}${p}`).catch(() => null)));
          for (const peer of results.filter(Boolean)) if (!hosts.some(h => h.node === peer.node)) hosts.push({ ...peer, device: d.name });
        }));
      }
      return { hosts, error: '', local: status() };
    },
    async requestJoin(url) {
      if (cluster.shared() || joining) throw new Error('This host is already joined or joining.');
      if (!cluster.self.url?.startsWith('https://') && publish) await publish();
      if (!cluster.self.url?.startsWith('https://')) {
        throw new Error('This computer needs a Tailscale HTTPS address so the main can reach it. Open Settings → Phone access · Tailscale and tap “set up phone access”.');
      }
      const peer = await inspect(url);
      if (peer.node === cluster.self.id || !peer.main) throw new Error('Choose the existing system’s current main host.');
      pending = { target: peer.node, url: peer.url, nonce: crypto.randomBytes(24).toString('base64url'), expires: now() + 600000 };
      message = 'Waiting for approval on ' + peer.name;
      await remote(peer.url, { action: 'request', url: cluster.self.url });
      return status();
    },
    async announce(url) {
      if (!cluster.replica.writable()) throw new Error('Request approval on the current main.');
      const peer = await inspect(url);
      if (peer.shared || peer.pending?.target !== cluster.self.id || peer.pending?.url !== cluster.self.url || !(peer.pending.expires > now())) {
        throw new Error('No matching join request on that host.');
      }
      if (announced.size >= 128 && !announced.has(peer.url)) throw new Error('Too many pending hosts. Try later.');
      announced.set(peer.url, Math.min(peer.pending.expires, now() + 600000));
      return { ok: true };
    },
    cancel() {
      if (joining) throw new Error('Joining is already in progress.');
      pending = null; message = ''; return status();
    },
    async approve(url) {
      if (!cluster.replica.writable()) throw new Error('Approve hosts on the current main.');
      const peer = await inspect(url);
      if (peer.shared || peer.joining || peer.pending?.target !== cluster.self.id || peer.pending?.url !== cluster.self.url || !(peer.pending.expires > now())) {
        throw new Error('This host has no current request to join this system.');
      }
      const invite = cluster.invite({ id: peer.node, url: peer.url });
      await remote(peer.url, { nonce: peer.pending.nonce, token: invite.code });
      return { ok: true };
    },
    // Public transport, narrowly scoped to the locally selected main. An
    // arbitrary caller cannot redirect the joining host or read a credential.
    accept(body) {
      status();
      if (!pending || joining || cluster.shared() || body.nonce !== pending.nonce || typeof body.token !== 'string' || body.token.length > 256) {
        throw new Error('No matching pending join request.');
      }
      const selected = pending;
      joining = true; message = 'Joining…';
      return Promise.resolve().then(() => join({ url: selected.url, token: body.token, ownUrl: cluster.self.url }))
        .then(() => { pending = null; message = 'Host joined.'; })
        .catch(() => { message = 'Could not join. Check that both hosts are idle and reachable, then request approval again.'; })
        .finally(() => { joining = false; });
    },
  };
}
