import path from 'node:path';
import { tailscale } from '../tailscale.js';
import { atomic } from './raft.js';

/** Inventory only: seeing a tailnet device never grants it cluster access. */
export function deviceInventory(dir, run = tailscale) {
  const file = path.join(dir, 'cluster', 'devices.json');
  let cached, checked = 0, pending;
  return async () => {
    if (pending) return pending;
    if (cached && Date.now() - checked < 30000) return cached;
    pending = (async () => {
      const devices = new Map();
      let error = '';
      try {
        const status = JSON.parse((await run(['status', '--json'])).stdout);
        for (const peer of [status.Self, ...Object.values(status.Peer || {})].filter(Boolean)) {
          const id = peer.ID || peer.PublicKey;
          const name = (peer.HostName || peer.DNSName || '').trim();
          if (!id || !name) continue;
          const lastSeen = Date.parse(peer.LastSeen);
          devices.set(id, { id, name, dns: peer.DNSName?.replace(/\.$/, ''),
            addresses: peer.TailscaleIPs || [], platform: peer.OS, active: Boolean(peer.Online),
            lastSeen: peer.Online ? Date.now() : lastSeen > 0 ? lastSeen : null,
            local: peer === status.Self });
        }
        // Replace the old accumulated history with the current tailnet snapshot.
        await atomic(file, Object.fromEntries(devices));
      } catch { error = 'Tailscale inventory unavailable. Reconnect Tailscale and refresh.'; }
      checked = Date.now(); cached = { devices: [...devices.values()], error }; return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}
