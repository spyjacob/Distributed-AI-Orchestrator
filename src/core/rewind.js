/**
 * Editing the past: removing a message from a session, and winding one back.
 *
 * Context is the product here. A transcript is re-sent in full on every turn, so
 * a message that took the work in a wrong direction keeps costing tokens and
 * keeps steering the model until it is actually gone. Hiding it in the UI would
 * not do that; these functions remove it from the events the providers see.
 *
 * Both operations have to preserve the one invariant every provider enforces:
 * a tool call and its result travel together. Removing an assistant message
 * therefore takes its tool results with it, and removing a tool result takes the
 * call that asked for it out of the assistant message. Anything else leaves a
 * transcript that the next send would reject.
 */

/** Ids of the calls an assistant event made, matching transcript.js's fallback. */
function callIds(event) {
  return (event.toolCalls ?? []).map((tc, i) => tc.id || `call_${i}`);
}

/**
 * Remove one event, plus whatever would be left dangling without it.
 *
 * Returns the new event list and what went, so the caller can say so in a note.
 */
export function eraseEvent(events, eventId) {
  const target = events.find((e) => e.id === eventId);
  if (!target) throw new Error('That message is no longer in this conversation.');

  const drop = new Set([target.id]);
  let describe = 'a message';

  if (target.type === 'user') {
    // A question and the work it set off are one thing in the transcript, and
    // one thing on screen. Deleting the question alone would leave replies
    // answering nothing, so the turn goes with it — except the notes that carry
    // a commit sha, which are never sent to a model and are the only record of
    // where the files stood. Keeping them is what lets a later rewind still
    // find a file state to go back to.
    const at = events.indexOf(target);
    let steps = 0;
    for (let i = at + 1; i < events.length && events[i].type !== 'user'; i += 1) {
      if (events[i].type === 'note' && events[i].sha) continue;
      drop.add(events[i].id);
      steps += 1;
    }
    describe = `one of your messages${steps ? ` and the ${steps} event(s) it produced` : ''}`;
  }

  if (target.type === 'assistant') {
    const ids = new Set(callIds(target));
    for (const e of events) {
      if (e.type === 'tool_result' && ids.has(e.callId)) drop.add(e.id);
    }
    describe = `a reply${ids.size ? ` and its ${ids.size} tool result(s)` : ''}`;
  }

  let out = events.filter((e) => !drop.has(e.id));

  if (target.type === 'tool_result') {
    // The call that produced it cannot stay: an unanswered tool call is the one
    // shape both APIs reject outright.
    out = out.map((e) => {
      if (e.type !== 'assistant' || !callIds(e).includes(target.callId)) return e;
      const kept = (e.toolCalls ?? []).filter((tc, i) => (tc.id || `call_${i}`) !== target.callId);
      return { ...e, toolCalls: kept };
    }).filter((e) => !(e.type === 'assistant' && !e.text?.trim() && !(e.toolCalls ?? []).length));
    describe = `the ${target.name} step`;
  }

  return { events: out, removed: events.length - out.length, describe };
}

/**
 * Wind the conversation back to a message: it and everything after it go.
 *
 * The message's own text comes back as a draft rather than being thrown away —
 * the reason to rewind is almost always to ask for the same thing differently.
 */
export function rewindTo(events, eventId) {
  const at = events.findIndex((e) => e.id === eventId);
  if (at < 0) throw new Error('That message is no longer in this conversation.');
  const removed = events.slice(at);
  return {
    events: events.slice(0, at),
    removed: removed.length,
    draft: events[at].type === 'user' ? (events[at].text ?? '') : '',
    attachments: events[at].attachments ?? [],
  };
}
