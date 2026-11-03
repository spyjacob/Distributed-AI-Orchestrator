// Share a short-lived status probe across concurrent HTTP requests.
export function createNetworkGate(probe, { ttl = 2000, now = Date.now } = {}) {
  let pending, cached, checkedAt = -Infinity;
  return async () => {
    if (cached && now() - checkedAt < ttl) return cached;
    if (!pending) pending = Promise.resolve().then(probe).catch(() => ({ connected: false }))
      .then(status => {
        cached = { ...status, error: status.connected ? null : 'Turn on Tailscale on this computer. Harness will reconnect automatically.' };
        checkedAt = now();
        return cached;
      }).finally(() => { pending = null; });
    return pending;
  };
}
