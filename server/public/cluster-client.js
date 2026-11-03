/* A phone is a viewer, never a coordinator or a voter. */
(() => {
  const storageKey = 'orchestrator-cluster';
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
  let viewer = crypto.randomUUID();
  try { viewer = localStorage.getItem('orchestrator-viewer') || viewer; localStorage.setItem('orchestrator-viewer', viewer); } catch {}
  let failures = 0, busy = false;
  const originalFetch = window.fetch.bind(window);
  async function check() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await originalFetch('/api/cluster/viewer', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: viewer }),
        signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('Host unavailable');
      const current = await response.json();
      saved = current; failures = 0;
      try { localStorage.setItem(storageKey, JSON.stringify(current)); } catch {}
    } catch {
      failures++;
      if (failures < 3 || !saved?.ticket) return;
      // Probe only previously authenticated cluster members. Never retry send,
      // upload or another mutation whose result might already have committed.
      const reachable = await Promise.all(saved.hosts.filter((n) => n.member && n.url && n.url !== location.origin).map(async (node) => {
        try {
          const response = await originalFetch(node.url + '/api/cluster/health', { signal: AbortSignal.timeout(4000), credentials: 'omit' });
          const health = await response.json();
          return health.id === saved.id && health.ready ? node : null;
        } catch { return null; }
      }));
      const target = reachable.find(Boolean);
      if (target) {
        const url = new URL('/', target.url);
        url.searchParams.set('t', saved.ticket);
        url.searchParams.set('viewer', viewer);
        const current = new URL(location.href);
        const node = current.searchParams.get('node');
        if (node) url.searchParams.set('node', node);
        let session = current.searchParams.get('session');
        try { session ||= sessionStorage.getItem(`lastSession${node ? ':' + node : ''}`); } catch {}
        if (session) url.searchParams.set('session', session);
        // Carry an unsent text draft without ever submitting it automatically.
        const draft = document.getElementById('input')?.value;
        if (draft) url.hash = 'draft=' + encodeURIComponent(draft);
        location.replace(url.href);
      }
    } finally { busy = false; }
  }
  const incoming = new URLSearchParams(location.search).get('viewer');
  if (incoming && /^[a-zA-Z0-9-]{16,80}$/.test(incoming)) {
    viewer = incoming; try { localStorage.setItem('orchestrator-viewer', viewer); } catch {}
  }
  window.addEventListener('DOMContentLoaded', () => {
    if (location.hash.startsWith('#draft=')) {
      const input = document.getElementById('input');
      if (input) { input.value = decodeURIComponent(location.hash.slice(7)); input.dispatchEvent(new Event('input')); }
      history.replaceState(null, '', location.pathname + location.search);
    }
    check();
  });
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  setInterval(check, 10000);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
