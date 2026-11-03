// Keep ordered follow-ups per session on the server, independent of browser lifetime.
// Pending messages are not persisted here; a paused session saves its held
// messages with the pause and parks them again after a restart.
export function createMessageQueue() {
  const active = new Map();
  const held = new Set(); // paused sessions: queued messages wait for release()
  async function drain(id, entry, task) {
    try { await task.run(); }
    catch (e) { task.onError(e); }
    finally {
      if (held.has(id) && entry.next.length) { entry.idle = true; return; }
      const next = entry.next.shift();
      if (next) void drain(id, entry, next);
      else active.delete(id);
    }
  }
  return {
    // Sessions with work in flight. A paused, idle queue is saved and waits, so it does not count.
    get size() { return [...active.values()].filter(entry => !entry.idle).length; },
    busy: id => active.has(id),
    pending(id) { return (active.get(id)?.next || []).map(task => task.body); },
    edit(id, expected, text) {
      const body = active.get(id)?.next.find(task => task.body.pendingId === expected)?.body;
      if (!body || body.pendingId !== expected) throw new Error("This message has already started or changed.");
      body.text = text;
      return body;
    },
    cancel(id, expected) {
      const entry = active.get(id);
      if (!entry) return;
      entry.next = expected ? entry.next.filter(task => task.body.pendingId !== expected) : [];
      if (entry.idle && !entry.next.length) active.delete(id);
    },
    hold(id) { held.add(id); },
    // Restore a held message without starting it; release() runs it in order.
    park(id, run, { onError = () => {}, body = null } = {}) {
      held.add(id);
      if (!active.has(id)) active.set(id, { next: [], idle: true });
      active.get(id).next.push({ run, onError, body });
    },
    release(id) {
      held.delete(id);
      const entry = active.get(id);
      if (!entry?.idle) return;
      entry.idle = false;
      const next = entry.next.shift();
      if (next) void drain(id, entry, next); else active.delete(id);
    },
    submit(id, run, { queue = false, front = false, onError = () => {}, body = null } = {}) {
      const entry = active.get(id);
      const task = { run, onError, body };
      if (entry) {
        if (!queue) throw new Error('A turn is already running. Use Queue next.');
        entry.next[front ? 'unshift' : 'push'](task);
      } else {
        const fresh = { next: [] };
        active.set(id, fresh);
        void drain(id, fresh, task);
      }
    },
  };
}
