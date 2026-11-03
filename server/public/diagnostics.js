/* Metadata only. Never collect input values, visible text, URLs or screenshots. */
(() => {
  const original = window.fetch.bind(window);
  const uuid = () => crypto.randomUUID();
  let browser = uuid();
  try { browser = localStorage.getItem('diagnostics-browser') || browser; localStorage.setItem('diagnostics-browser', browser); } catch {}
  const page = uuid(), device = /iPhone|Android.*Mobile/i.test(navigator.userAgent) ? 'phone' : /iPad|Tablet/i.test(navigator.userAgent) ? 'tablet' : 'computer';
  let previousVisible = '', previousAt = 0;
  let dropped = 0;
  let events = [], sending = false, correlationId = uuid();
  function record(event, details = {}) {
    if (event === 'visible') {
      const key = JSON.stringify(details);
      if (key === previousVisible && Date.now() - previousAt < 10000) return;
      previousVisible = key; previousAt = Date.now();
    }
    if (events.length >= 100) { events.shift(); dropped++; }
    events.push({ event, clientAt: Date.now(), browser, page, device, correlationId, ...details });
  }
  async function flush() {
    if (sending || !events.length) return;
    sending = true;
    if (dropped) { const count = dropped; dropped = 0; record('lifecycle', {outcome:'dropped', count}); }
    const batch = events.splice(0, 100);
    try { const response = await original('/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'append', events: batch }), keepalive: true }); if (!response.ok) dropped += batch.length; } catch { dropped += batch.length; }
    finally { sending = false; }
  }
  window.harnessTrace = record;
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (!url?.startsWith('/api/') || url.startsWith('/api/diagnostics')) return original(input, options);
    const id = correlationId, start = performance.now();
    const route = url.split('?')[0].split('/').slice(1, 3).join('.');
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('x-harness-trace', id);
    try {
      const response = await original(input, { ...options, headers });
      record('request', { correlationId: id, route, status: response.status, durationMs: Math.round(performance.now() - start) });
      return response;
    } catch (e) {
      record('request', { correlationId: id, route, outcome: 'network-error', durationMs: Math.round(performance.now() - start) });
      throw e;
    }
  };
  document.addEventListener('click', e => {
    const el = e.target.closest?.('button,a,summary,[data-open],[data-app-toggle]');
    if (!el) return;
    correlationId = uuid();
    // Attribute names describe controls; attribute values may contain project names.
    const control = el.id || [...el.attributes].find(a => a.name.startsWith('data-'))?.name || el.tagName.toLowerCase();
    record('action', { control, width: innerWidth, height: innerHeight });
  }, true);
  document.addEventListener('visibilitychange', () => { record('lifecycle', { outcome: document.visibilityState }); flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('error', () => record('error', { outcome: 'uncaught' }));
  window.addEventListener('unhandledrejection', () => record('error', { outcome: 'unhandled-rejection' }));
  window.addEventListener('online', () => record('lifecycle', { outcome: 'online' }));
  window.addEventListener('offline', () => record('lifecycle', { outcome: 'offline' }));
  setInterval(flush, 3000);
  record('lifecycle', { outcome: 'opened', width: innerWidth, height: innerHeight });
})();
