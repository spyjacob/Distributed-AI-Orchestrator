/* Distributed Orchestrator, phone edition. Talks to the same core the desktop app drives. */

// Each page targets one execution machine. Never retry a mutation on another node.
const executionNode = new URLSearchParams(location.search).get('node') || '';
const nativeFetch = window.fetch.bind(window);
const nodeApi = (url) => executionNode && url.startsWith('/api/') && !url.startsWith('/api/nodes')
  ? `/api/nodes/${encodeURIComponent(executionNode)}${url}` : url;
const fetch = (url, options) => nativeFetch(typeof url === 'string' ? nodeApi(url) : url, {
  ...options, headers: { ...options?.headers,
    ...(!url.startsWith('/api/models') && typeof state !== 'undefined' && state.session?.id ? { 'x-harness-session': state.session.id } : {}),
  },
});
const sessionStorageKey = `lastSession${executionNode ? ':' + executionNode : ''}`;

const $ = (id) => document.getElementById(id);

// Anything that throws where nobody is catching used to vanish and leave a
// dead-looking UI. Surface it instead.
window.addEventListener('unhandledrejection', (e) => {
  showBanner(e.reason?.message ?? String(e.reason));
});
window.addEventListener('error', (e) => showBanner(e.message));
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `${res.status}`), {status:res.status, code:body.code});
  return body;
};

// The open session owns its transcript and stream.
const tabs = {
  chat: { session: null, stream: null, running: false, live: null, startedAt: null },
};

const state = {
  models: {}, default: null, sessions: [], beacons: {},
  session: null,          // the currently open session
  home: '',
  tab: 'chat',
};

const cur = () => tabs[state.tab];

// Images chosen but not yet sent. Uploaded immediately so the send is quick and
// so a failed conversion is visible before you commit to the message.
let pendingShots = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// URLs in attributes need a scheme policy as well as HTML escaping.
const safeHref = value => {
  const text = String(value ?? '');
  if (/^https?:\/\//i.test(text) && !/[\u0000-\u0020\u007f]/.test(text)) return esc(text);
  return '#';
};

/**
 * Enough markdown to read like prose rather than source. Headings, bold, lists, tables
 * and code - not a full parser, because anything it does not recognise should
 * survive as literal text rather than disappear.
 */
function render(text) {
  const parts = String(text ?? '').split(/```/);
  return parts
    .map((chunk, i) => {
      if (i % 2) {
        const body = chunk.replace(/^[\w+-]*\n/, '');
        return `<pre><code>${esc(body)}</code></pre>`;
      }
      return inline(chunk);
    })
    .join('');
}

// Split already-escaped table text without treating an escaped pipe as a column.
function tableCells(line) {
  const cells = line.trim().split(/(?<!\\)\|/);
  if (!cells[0]?.trim()) cells.shift();
  if (!cells.at(-1)?.trim()) cells.pop();
  return cells.map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function inline(chunk) {
  const lines = esc(chunk).split('\n');
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const openList = (tag) => {
    if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trimEnd();
    const headers = tableCells(line);
    const separators = tableCells(lines[index + 1] || '');
    if (line.includes('|') && headers.length && headers.length === separators.length
        && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
      closeList();
      const alignment = separators.map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left');
      const row = (cells, tag) => `<tr>${headers.map((_, column) =>
        `<${tag}${tag === 'th' ? ' scope="col"' : ''} style="text-align:${alignment[column]}">${emphasis(cells[column] || '')}</${tag}>`).join('')}</tr>`;
      out.push(`<div class="message-table" role="region" aria-label="Message table" tabindex="0"><table><thead>${row(headers, 'th')}</thead><tbody>`);
      index++;
      while (index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes('|')) {
        out.push(row(tableCells(lines[++index]), 'td'));
      }
      out.push('</tbody></table></div>');
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length + 2); // h1 in a chat is shouting
      out.push(`<h${level}>${emphasis(heading[2])}</h${level}>`);
    } else if (bullet) {
      openList('ul');
      out.push(`<li>${emphasis(bullet[1])}</li>`);
    } else if (numbered) {
      openList('ol');
      out.push(`<li>${emphasis(numbered[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
      out.push('<br>');
    } else {
      closeList();
      out.push(`${emphasis(line)}<br>`);
    }
  }
  closeList();
  return out.join('');
}

/** Applied to already-escaped text, so it can only add the markup it intends. */
function emphasis(t) {
  return t
    // Markdown links. A model handing back a file writes one constantly, and
    // unrendered they spill an absolute path across several lines.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      // Only schemes that are safe to put in an href; a local path becomes a
      // preview link into the orchestrator rather than a dead file:// URL.
      if (/^https?:\/\//i.test(href)) {
        return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      }
      if (href.startsWith('/')) {
        return `<a href="${nodeApi('/api/file')}?path=${encodeURIComponent(href.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity])))}&session=${encodeURIComponent(state.session?.id || '')}" target="_blank" rel="noopener">${label}</a>`;
      }
      return label;   // relative or unknown: show the words, drop the link
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

/** Local date and time, so chats from different days are distinguishable. */
const clock = (ts) => (ts
  ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '');

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const shortDir = (p) => String(p ?? '').replace(state.home, '~');

// ------------------------------------------------------------------ sheet

// Which sheet is showing. A slow fetch that lands after you have moved on
// must not redraw over the sheet you are now looking at.
let sheetView = null;

function openSheet(html, view = null) {
  sheetView = view;
  $('sheet').innerHTML = html;
  $('sheet-back').hidden = false;
  window.harnessTrace?.('visible', { screen: view || html.match(/\bid="([a-z][a-z-]{1,50})"/)?.[1] || 'sheet', outcome: 'shown' });
}
function closeSheet() {
  window.harnessTrace?.('visible', { screen: 'chat', outcome: 'shown' });
  sheetView = null;
  $('sheet-back').hidden = true;
  $('sheet').innerHTML = '';
}

// ------------------------------------------------------------- transcript

/**
 * @param reveal  show the output without a tap. Used when the assistant said
 *                nothing of its own: a collapsed tool call would otherwise be
 *                the entire reply, which reads as no answer at all.
 */
function toolBlock(call, result, reveal = false) {
  const status = !result
    ? '<span class="tool-status pending">running…</span>'
    : result.ok
      ? '<span class="tool-status ok">ok</span>'
      : '<span class="tool-status err">failed</span>';
  const arg = describe(call);
  const body = result
    ? `<pre class="tool-body"${reveal ? '' : ' hidden'}>${esc(result.output)}</pre>`
    : '';
  return `<div class="tool" data-call="${esc(call.id)}">
      <div class="tool-head"><span class="tool-name">${esc(call.name)}</span>
      <span class="tool-arg">${esc(arg)}</span>
      <span class="at">${clock(result?.ts)}</span>${status}</div>${body}</div>`;
}

function describe(call) {
  const a = call.args ?? {};
  switch (call.name) {
    case 'bash': return a.command ?? '';
    case 'read_file':
    case 'list_dir': return a.path ?? '.';
    case 'write_file': return `${a.path ?? ''} (${String(a.content ?? '').split('\n').length} lines)`;
    case 'edit_file': return a.path ?? '';
    default: return JSON.stringify(a).slice(0, 120);
  }
}

/**
 * The plain text behind each reply, so it can be copied out and pasted into
 * another session as context.
 *
 * Kept in a map rather than a data- attribute because `esc` above deliberately
 * leaves quotes alone, and a reply containing one would break out of the
 * attribute. The map is rebuilt with the transcript, so it cannot drift from
 * what is on screen or grow without bound.
 */
const copyTexts = new Map();

/**
 * Copy text, on a phone, over both of the ways this harness is reached.
 *
 * The async clipboard API exists only in a secure context. Over Tailscale that
 * is HTTPS and it works; over plain HTTP on the LAN `navigator.clipboard` is
 * simply undefined, so the old selection trick is kept as the path for that
 * rather than letting the button do nothing. iOS ignores a readonly textarea,
 * hence the contentEditable range dance.
 */
async function copyText(text) {
  // Neither route can write to the clipboard while the document is unfocused,
  // and `execCommand` will still cheerfully return true when it wrote nothing.
  // Checking first is what keeps the button from claiming a copy that did not
  // happen - a button that lies is worse than one that says it could not.
  if (!document.hasFocus()) {
    window.focus();
    if (!document.hasFocus()) return false;
  }

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* denied or unavailable - fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.contentEditable = 'true';
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  try {
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Last resort: put the reply under a selection so it can be copied by hand. */
function selectReply(button) {
  const body = button.closest('.turn.assistant')?.querySelector('.body');
  if (!body) return;
  const range = document.createRange();
  range.selectNodeContents(body);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * A turn is what a person actually thinks in: something I asked, some work, an
 * answer. The event log is flatter than that - assistant, tool_result,
 * assistant, tool_result - so it gets regrouped here.
 */
function turnsFrom(events) {
  const turns = [];
  let cur = null;
  const start = (user) => {
    cur = { user, steps: [], texts: [], notes: [], files: [], model: null, endedOn: null };
    turns.push(cur);
    return cur;
  };

  for (const e of events) {
    if (e.type === 'user') { start(e); continue; }
    if (!cur) start(null);

    if (e.type === 'assistant') {
      cur.model = e.model || cur.model;
      if (e.text?.trim()) { cur.texts.push(e); cur.endedOn = 'reply'; }
      for (const c of e.toolCalls ?? []) cur.steps.push({ call: c, result: null });
    } else if (e.type === 'tool_result') {
      const step = cur.steps.find((x) => x.call.id === e.callId && !x.result);
      if (step) step.result = e;
      else cur.steps.push({ call: { id: e.callId, name: e.name, args: {} }, result: e });
      cur.endedOn = 'tool';
    } else if (e.type === 'note') {
      cur.notes.push(e);
    } else if (e.type === 'files') {
      cur.files.push(...(e.files ?? []));
    }
  }
  return turns;
}

/**
 * One chip for a whole turn's work.
 *
 * Deliberately not a progress bar: an agent turn has no known length, so a bar
 * would have to invent a denominator and would lie. A chip that pulses while
 * work is happening says the true thing - something is going on - and the
 * colour says how it is going.
 *
 * Green while it is getting somewhere, red only when a failure actually ended
 * the turn: a command that failed and was then worked around is not something
 * to alarm the user about. Amber marks that recovery, because "it worked, but
 * not first try" is worth knowing and is neither of the other two.
 */
function activityChip(turn, key, running) {
  const total = turn.steps.length;
  if (!total) return '';

  const done = turn.steps.filter((s) => s.result).length;
  const failures = turn.steps.filter((s) => s.result && !s.result.ok).length;
  const last = turn.steps[total - 1];
  // Paused on purpose: the step it cut off is not a failure to alarm anyone with.
  const paused = pausedTurn(turn, running);
  const endedBadly = !running && !paused && last?.result && !last.result.ok;

  // A turn that ran tools and then said nothing is not the same as one that
  // finished and explained itself. Without this it reads as "done, fine,
  // nothing to see" while the answer sits collapsed two taps away.
  const silent = !running && !paused && !turn.texts.length;

  const tone = endedBadly ? 'bad' : paused || failures || silent ? 'warn' : 'ok';
  const label = running
    ? 'working'
    : paused
      ? `paused · ${done} step${done === 1 ? '' : 's'}`
      : endedBadly
      ? `stopped on ${esc(last.call.name)}`
      : silent
        ? `${done} step${done === 1 ? '' : 's'} · no summary, output below`
        : failures
          ? `${done} steps · ${failures} recovered`
          : `${done} step${done === 1 ? '' : 's'}`;

  return `<button class="act ${tone}${running ? ' live' : ''}" data-act="${key}">
      <span class="act-dot"></span>
      <span class="act-label">${label}</span>
      <span class="act-at">${clock(turn.steps[0]?.result?.ts ?? turn.user?.ts)}</span>
      <span class="act-caret">${silent ? '▴' : '▾'}</span>
    </button>
    <div class="act-detail" id="act-${key}"${silent ? '' : ' hidden'}>
      ${turn.steps.map((s, i) => toolBlock(s.call, s.result, silent && i === total - 1)).join('')}
    </div>`;
}

/**
 * What one question cost.
 *
 * A backend that streams its own agent loop reports fragments per message and
 * the real total once at the end, flagged. When that flag is present it is the
 * answer; otherwise every message carried its own true figure and they sum.
 */
function turnUsage(turn) {
  const authoritative = turn.texts.find((a) => a.usage?.total)
    ?? [...turn.texts].reverse().find((a) => a.usage?.total);
  if (authoritative) return authoritative.usage;

  return turn.texts.reduce((acc, a) => ({
    input: acc.input + (a.usage?.input ?? 0),
    cached: acc.cached + (a.usage?.cached ?? 0),
    output: acc.output + (a.usage?.output ?? 0),
    ms: acc.ms + (a.usage?.ms ?? 0),
  }), { input: 0, cached: 0, output: 0, ms: 0 });
}

/**
 * Which turns are open.
 *
 * Keyed by the user message's own id rather than a position, because the
 * transcript re-renders on every streamed event and an index-keyed set would
 * silently reassign what the reader had opened. Progress opens while running
 * and closes on completion unless the reader chose otherwise.
 */
const openedFolds = new Set();
const closedFolds = new Set();

const foldKey = (turn, i) => turn.user?.id ?? `t${i}`;

function foldIsOpen(turn, i, isLast, running) {
  const key = foldKey(turn, i);
  if (openedFolds.has(key)) return true;
  if (closedFolds.has(key)) return false;
  return running; // completed progress closes independently of the final reply
}

/** A turn the user paused: it ends on the pause note the server writes. */
const pausedTurn = (turn, running) => !running && turn.notes.some((n) => n.paused);

/**
 * How a finished turn ended, from the note the server wrote for it: error,
 * interrupted or stopped. Transcripts saved before notes carried an outcome
 * fall back to the exact wording the old server used for those notes.
 */
function turnOutcome(turn) {
  for (const n of [...turn.notes].reverse()) {
    if (n.outcome) return n;
    if (n.paused || n.publication || n.unsent || /^notify:/.test(n.text)) continue;
    if (/^turn interrupted|^This computer restarted or stopped the turn/.test(n.text)) return { ...n, outcome: 'interrupted' };
    if (/^([\w.-]+: )?stopped by user$/.test(n.text)) return { ...n, outcome: 'stopped' };
    if (/^[A-Za-z0-9][\w.-]*: |is not in models\.json|no-tools mode|response token limit/.test(n.text)) return { ...n, outcome: 'error' };
  }
  return null;
}

/**
 * A failure is said where the turn ends, never folded away: what went wrong,
 * the specific fix when there is one, and Retry for the latest request.
 * Retry sends the same message again as a new one; nothing is replayed for you.
 */
function outcomeHtml(turn, note, isLast) {
  if (note.outcome === 'stopped') return `<div class="note" role="status">${esc(note.text)}</div>`;
  const auth = note.reason === 'auth';
  const retry = note.outcome === 'error' && isLast && turn.user?.id && !turn.user.optimistic;
  const host = state.machines?.hosts?.find(h => h.id === (state.session?.ownerNode || state.machines?.leader))?.name || 'this computer';
  const actions = [
    auth ? '<button class="ghost" data-copy-login="claude auth login">copy command</button>' : '',
    retry ? `<button class="primary" data-retry="${esc(turn.user.id)}">retry</button>` : '',
  ].join('');
  return `<div class="turn-outcome" role="status">
      <p class="turn-outcome-title">${note.outcome === 'interrupted' ? 'Interrupted' : 'Failed'}</p>
      <p>${esc(note.text)}</p>
      ${auth ? `<p>On ${esc(host)}, open Terminal and run <code>claude auth login</code>, finish the browser sign-in, then retry.</p>` : ''}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>`;
}

/** One line describing everything a question set off. */
function foldSummary(turn, running) {
  const steps = turn.steps.length;
  const done = turn.steps.filter((s) => s.result).length;
  if (pausedTurn(turn, running)) return { tone: 'warn', text: `paused${steps ? ` · ${done} step${done === 1 ? '' : 's'}` : ''} · resume continues it` };
  const outcome = running ? null : turnOutcome(turn);
  const ran = steps ? ` · ${done} step${done === 1 ? '' : 's'}` : '';
  if (outcome?.outcome === 'stopped') return { tone: 'warn', text: `stopped by you${ran}` };
  if (outcome) return { tone: 'bad', text: `${outcome.outcome === 'interrupted' ? 'interrupted' : 'failed'}${ran} · details below` };
  const failures = turn.steps.filter((s) => s.result && !s.result.ok).length;
  const last = turn.steps[steps - 1];
  const endedBadly = !running && last?.result && !last.result.ok;
  const silent = !running && steps > 0 && !turn.texts.length;

  // A turn that stopped straight after a tool, with no closing message, is the
  // case that reads as "still going" when it is not. Name it.
  const stoppedShort = !running && turn.endedOn === 'tool';

  const tone = endedBadly ? 'bad' : (failures || silent || stoppedShort) ? 'warn' : 'ok';
  const parts = [];
  if (running) {
    parts.push('working');
  } else if (endedBadly) {
    parts.push(`stopped on ${esc(last.call.name)}`);
  } else {
    // "done" first, so the state is the first thing read rather than inferred.
    parts.push(stoppedShort ? 'ended without a summary' : 'done');
    if (turn.texts.length) parts.push(`${turn.texts.length} repl${turn.texts.length === 1 ? 'y' : 'ies'}`);
    if (steps) parts.push(`${done} step${done === 1 ? '' : 's'}`);
    if (failures) parts.push(`${failures} recovered`);
    if (silent) parts.push('output below');
  }
  // A turn that produced nothing at all is not a green outcome.
  const empty = !running && !turn.texts.length && !turn.steps.length;
  return { tone: empty ? 'warn' : tone, text: parts.join(' · ') };
}

/**
 * Per-message controls: take it out of the context, or wind back to it.
 *
 * Both edit what the model will be sent next turn, which is why they live on
 * the message itself rather than in a menu somewhere: the thing being changed
 * is the thing you are looking at.
 */
function messageActions(eventId, { rewind = false } = {}) {
  return `<span class="msg-acts">${rewind
    ? `<button class="msg-act" data-rewind="${esc(eventId)}" aria-label="Rewind the conversation to this message" title="Rewind to here">${ICON_REWIND}</button>` : ''}
    <button class="msg-act" data-erase="${esc(eventId)}" aria-label="Delete this message from the conversation" title="Delete">${ICON_TRASH}</button></span>`;
}

// Drawn in currentColor rather than emoji, so they take the theme's dim grey
// like the pills around them instead of arriving in their own colours.
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const ICON_REWIND = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>';

function messageToggle(key, label) {
  const open = !closedFolds.has(key);
  return `<button class="message-toggle" data-fold="${esc(key)}" aria-label="Toggle ${label}" aria-expanded="${open}"><span class="act-caret">${open ? '▴' : '▾'}</span></button>`;
}

function turnCommitLink(turn) {
  const note = [...(turn.notes || [])].reverse().find(n =>
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[a-f0-9]{7,40}$/i.test(n.commitUrl || ''));
  return note ? `<a class="turn-commit" href="${safeHref(note.commitUrl)}" target="_blank" rel="noopener noreferrer" aria-label="View this turn’s commit on GitHub">Published ${esc((note.sha || '').slice(0, 8))} · ${clock(note.ts)} ↗</a>` : '';
}

/**
 * A Push or Merge as one checklist: a single title, then each step, ticked when
 * the next one starts. Built from the note the server saves for each step, so
 * older chats read the same way. A step that comes round again, as when another
 * computer published first, takes the list back to it instead of repeating it.
 */
let pushShown = '';
function pushStepsHtml(turn, running, isLast) {
  const notes = turn.notes.filter(n => n.publication && n.publication !== 'pending');
  if (!notes.length) return '';

  const steps = [];
  for (const n of notes) {
    if (n.publication !== 'pushing') continue;
    const step = n.text.replace(/^(?:(?:Push|Merge) in progress|Checks passed) · |\.$/g, '').replace(/^./, c => c.toUpperCase());
    const seen = steps.indexOf(step);
    if (seen < 0) steps.push(step); else steps.length = seen + 1;
  }
  const last = steps.length - 1;
  const end = notes.at(-1).publication === 'pushing' ? null : notes.at(-1);
  const verb = notes.some(n => /^Merge in progress/.test(n.text)) ? 'Merge' : 'Push';
  const finished = ['published', 'merged'].includes(end?.publication);
  const version = end?.pushReceipt?.version || end?.sha;

  // A reopened page draws before its stream says a turn is running; the state it
  // already loaded knows. Repair carries on as its own turn, so has no result here.
  const going = !end && (running || (isLast && sessionActive(state.session)));
  const repairing = !end && !going && /AI repair/.test(steps[last]);
  let title, tone, outcome;
  if (!end) {
    title = going ? `${verb} in progress` : repairing ? verb : `${verb} · no result recorded`;
    tone = going ? 'live' : repairing ? '' : 'warn';
    outcome = going ? 'in-progress' : repairing ? 'repairing' : 'no-result';
  } else if (end.pushReceipt?.status === 'Published; follow-up failed') {
    [title, tone, outcome] = [esc(end.pushReceipt.status), 'warn', 'follow-up-failed'];
  } else if (end.publication === 'published') {
    title = version ? `Published to GitHub · ${esc(version)}` : 'Already up to date';
    [tone, outcome] = ['ok', 'published'];
  } else if (end.publication === 'merged') {
    [title, tone, outcome] = [esc(end.text.replace(/\.$/, '')), 'ok', 'merged'];
  } else if (end.publication === 'failed') {
    [title, tone, outcome] = [`${verb} failed`, 'bad', 'failed'];
  } else {
    [title, tone, outcome] = [`${verb} outcome uncertain`, 'bad', 'uncertain'];
  }

  const rows = steps.map((step, s) => {
    const state = s < last
      ? (/^Checks failed/.test(steps[s + 1]) ? 'failed' : 'done')
      : finished ? 'done' : end?.publication === 'failed' ? 'failed' : going ? 'now' : 'open';
    const mark = { done: '✓', failed: '✕' }[state] || '<span class="act-dot"></span>';
    return `<div class="push-step ${state}"><span class="push-mark">${mark}</span><span>${esc(step)}</span></div>`;
  }).join('');

  if (isLast) {
    const shown = JSON.stringify([turn.user?.id, outcome, steps.length]);
    if (shown !== pushShown) window.harnessTrace?.('visible', { screen: 'push', outcome, count: steps.length });
    pushShown = shown;
  }
  return `<div class="push-steps ${tone}" role="status"><div class="push-title">${title}</div>${rows}</div>`;
}

/**
 * The model and effort a message went to, exactly as its provider reported them.
 * Everything named here comes from the report; with no report, nothing is claimed.
 * What DO asked for is only compared against it, and labelled as DO's when shown.
 */
const openReports = new Set();
let reportShown = '';
function modelReportHtml(user, running, isLast) {
  if (user.operation) return '';
  const r = user.modelReport;
  const asked = r?.requestedModel?.replace(/\[.*$/, '');
  // An alias names a family ("opus"); "default" and friends name nothing to compare.
  const modelDiffers = r?.model && asked && !/^(default|best|opusplan)$/i.test(asked) && !r.model.toLowerCase().includes(asked.toLowerCase());
  const effortDiffers = r?.requestedEffort && r.effort !== undefined && r.effort !== r.requestedEffort;
  const differs = modelDiffers || effortDiffers;
  if (isLast) {
    const outcome = !r ? (running ? 'waiting' : 'none') : differs ? 'differs' : r.effort === undefined ? 'effort-unreported' : 'reported';
    const shown = JSON.stringify([user.id, outcome, r?.model, r?.effort]);
    if (shown !== reportShown) window.harnessTrace?.('visible', { screen: 'model-report', outcome, model: r?.model, effort: r?.effort ?? undefined });
    reportShown = shown;
  }
  if (!r) return running ? '<div class="model-report waiting" role="status">waiting for the model’s report…</div>' : '';
  const effort = r.effort === undefined ? `effort not reported${running ? ' yet' : ''}` : r.effort === null ? 'no effort sent' : r.effort;
  const summary = [r.model, effort, modelDiffers && `you chose ${asked}`, effortDiffers && `you set ${r.requestedEffort}`].filter(Boolean).join(' · ');
  return `<details class="model-report${differs ? ' warn' : ''}" data-report="${esc(user.id)}"${openReports.has(user.id) ? ' open' : ''}>
        <summary>${esc(r.by)}: ${esc(summary)}</summary>
        <div class="model-report-proof">
          <div>Reported by ${esc([r.by, r.version].filter(Boolean).join(' '))} at ${esc(clock(r.at))}</div>
          ${r.model ? `<div>Model ${esc(r.model)}, from ${esc(r.modelSource)}</div>` : ''}
          <div>${r.effortSource ? `Effort ${esc(effort)}, from ${esc(r.effortSource)}` : `Effort: ${esc(r.by)} did not report one`}</div>
          <div>DO asked for: ${esc([r.requestedModel || 'default model', r.requestedEffort || 'default effort'].join(' · '))}</div>
        </div>
      </details>`;
}

function turnHtml(turn, i, running, number, isLast) {
  const key = foldKey(turn, i);
  const open = foldIsOpen(turn, i, isLast, running);
  const bits = [];

  if (turn.user) {
    const u = turnUsage(turn);
    const read = (u.input ?? 0) + (u.cached ?? 0);
    const cost = [];
    if (read) cost.push(`${compact(read)} in`);
    if (u.output) cost.push(`${compact(u.output)} out`);
    if (u.ms > 1500) cost.push(`${(u.ms / 1000).toFixed(0)}s`);

    bits.push(`<div class="turn user">
      <div class="who"><span class="qn">${turn.user.turnNumber ?? number}</span> you
        <span class="at">${turn.user.optimistic ? 'Sending…' : clock(turn.user.ts)}</span>${turnCommitLink(turn)}${modelReportHtml(turn.user, running, isLast)}${
  turn.user.optimistic ? '' : messageActions(turn.user.id, { rewind: true })}${messageToggle(key + '-input', 'your message')}</div>
      <div id="fold-${esc(key)}-input"${closedFolds.has(key + '-input') ? ' hidden' : ''}><div class="user-message">${esc(turn.user.text)}${
  (turn.user.attachments ?? []).length
    ? `<div class="shots">${turn.user.attachments.map((a) => (a.role === 'document'
      ? `<button class="file-card sent-doc" data-open-file="${esc(a.path)}" data-file-kind="${a.mime === 'application/pdf' ? 'pdf' : 'text'}">
           <span class="file-icon">${a.mime === 'application/pdf' ? '📕' : '📄'}</span>
           <span class="file-meta"><span class="file-name">${esc(a.name)}</span>
           <span class="file-sub">${humanSize(a.bytes ?? 0)}</span></span>
         </button>`
      : `<img src="${nodeApi('/api/file')}?path=${encodeURIComponent(a.path)}&session=${encodeURIComponent(state.session?.id || '')}" alt="${esc(a.name)}">`)).join('')}</div>`
    : ''}</div>
      ${cost.length ? `<div class="usage turn-cost">${cost.join(' · ')}</div>` : ''}</div></div>`);
  }

  // Only the terminal reply is final; earlier commentary belongs to progress.
  const finalIndex = !running && turn.endedOn === 'reply' && !turn.texts.at(-1)?.toolCalls?.length ? turn.texts.length - 1 : -1;
  let finalReply = '';
  const inner = [];
  for (const [j, a] of turn.texts.entries()) {
    const think = a.thinking ? `<div class="thinking">${esc(a.thinking)}</div>` : '';
    // The markdown source, not the rendered text: code fences and list markers
    // are exactly what makes it worth pasting somewhere else.
    const copyId = `${key}-${j}`;
    copyTexts.set(copyId, a.text);
    const isFinal = j === finalIndex;
    const replyKey = key + '-final';
    // A subagent's reply names its own model, and the report's effort is not about it.
    const report = a.subagent || a.operation === 'push' ? null : turn.user?.modelReport;
    const served = a.servedModel || report?.model || '';
    const servedChip = [served !== a.model && served, report?.effort].filter(Boolean).join(' · ');
    const reply = `<div class="turn assistant${isFinal ? ' final-reply' : ''}">
      <div class="who">${a.operation === 'push' && a.outcome === 'success' ? '<span class="operation-success" aria-label="Success">✓</span>' : ''}<span class="tag">${esc(a.operation === 'push' ? 'Result' : state.models[a.model]?.label || a.servedModel || a.model)}</span>
        ${servedChip ? `<span class="served">${esc(servedChip)}</span>` : ''}
        <span class="at">${clock(a.ts)}</span>
        <button class="copy-reply" data-copy="${esc(copyId)}"
          aria-label="Copy this reply as plain text">copy</button>${messageActions(a.id)}${isFinal ? messageToggle(replyKey, 'final reply') : ''}</div>
      <div${isFinal ? ` id="fold-${esc(replyKey)}"${closedFolds.has(replyKey) ? ' hidden' : ''}` : ''}>${think}<div class="body">${render(a.text)}</div></div></div>`;
    if (isFinal) finalReply = reply; else inner.push(reply);
  }
  inner.push(activityChip(turn, key, running));
  const outcome = running || pausedTurn(turn, running) ? null : turnOutcome(turn);
  for (const n of turn.notes) {
    // Shown below, where they cannot be missed. Push and Merge steps have their own checklist.
    if (n.id === outcome?.id || n.unsent || (n.publication && n.publication !== 'pending')) continue;
    // A stop or pause is deliberate, not an error.
    const bad = ['error', 'interrupted'].includes(n.outcome) || (!n.outcome && !n.paused && /error|failed|not in models/i.test(n.text));
    inner.push(`<div class="note${bad ? ' error' : ''}">${esc(n.text)}</div>`);
  }

  const body = inner.join('').trim();

  const sum = foldSummary(turn, running);
  // A Push with no tool work has only its checklist; nothing to fold above that.
  if (body || (running && !turn.user?.operation)) bits.push(`<button class="fold ${sum.tone}${running ? ' live' : ''}" data-fold="${esc(key)}">
      <span class="act-dot"></span>
      <span class="fold-label">Progress · ${sum.text}</span>
      <span class="act-caret">${open ? '▴' : '▾'}</span>
    </button>
    <div class="fold-body" id="fold-${esc(key)}"${open ? '' : ' hidden'}>${body}</div>`);

  bits.push(pushStepsHtml(turn, running, isLast));
  bits.push(finalReply);
  if (outcome) bits.push(outcomeHtml(turn, outcome, isLast));
  for (const n of turn.notes.filter(n => n.unsent)) bits.push(`<div class="note" role="status">${esc(n.text)}</div>`);
  const pending = [...turn.notes].reverse().find(n => n.publication === 'pending');
  if (pending) bits.push(`<div class="note" role="status">${esc(pending.text)}</div>`);

  return bits.join('');
}

/**
 * Nothing open: whether a model is ready, the sessions you were last in and
 * what state each is in, and how to start. One tap continues the right one.
 */
let startShown = '';
function drawStart(el) {
  const ready = Object.values(state.models || {}).some(m => m.available !== false);
  const recent = [...state.sessions].sort(sessionOrder).slice(0, 6);
  const row = sn => {
    const app = state.apps?.find(a => a.id === sn.appId);
    const offline = sessionOffline(sn);
    const where = [app?.name || shortDir(sn.projectDir), offline ? 'computer offline' : '', clock(sn.lastMessageAt ?? sn.createdAt)].filter(Boolean).join(' · ');
    return `<button class="item start-session" data-start-open="${esc(sn.id)}"${offline ? ' disabled' : ''}>
        <span class="grow"><span class="t">${esc(sn.name)} ${sessionStatus(sn)}</span><span class="s">${esc(where)}</span></span><span class="chev">›</span></button>`;
  };
  const html = `<div class="start">
      <h2>${recent.length ? 'Continue where you left off' : 'Start your first session'}</h2>
      <p class="dim">A session is a conversation with Claude Code, Codex or another model, working in one project folder on one of your computers.</p>
      ${ready ? '' : `<div class="item start-setup"><span class="grow"><span class="t">Set up a model first</span><span class="s">Connect Claude Code, Codex, an API key or a local model.</span></span><button class="primary" id="start-model">set up</button></div>`}
      ${recent.length ? `<h3>Recent sessions</h3>${recent.map(row).join('')}` : ''}
      <div class="actions"><button class="primary" id="start-new"${ready ? '' : ' disabled'}>new session</button><button class="ghost" id="start-all">all projects &amp; sessions</button></div>
    </div>`;
  if (html === startShown && el.querySelector('.start')) return;
  startShown = html;
  el.innerHTML = html;
  window.harnessTrace?.('visible', { screen: 'start', outcome: !ready ? 'setup-needed' : recent.length ? 'recent' : 'first-session', count: recent.length });
}

function drawTranscript() {
  const s = cur().session;
  const el = $('transcript');
  if (!s) return drawStart(el);
  startShown = '';
  window.harnessTrace?.('visible', { screen: 'transcript', outcome: s.events?.length ? 'content' : 'empty' });
  if (!s.events.length) {
    el.innerHTML = `<div class="empty"><p>${esc(s.name)}</p><p class="dim">${esc(shortDir(s.projectDir))}</p><p class="dim">say what you want built</p></div>`;
    return;
  }
  const turns = turnsFrom(s.events);
  copyTexts.clear();
  let n = 0;
  el.innerHTML = turns
    .map((t, i) => turnHtml(
      t, i,
      cur().running && i === turns.length - 1,
      t.user ? (n += 1) : n,
      i === turns.length - 1,
    ))
    .join('');
  mountLive();
  scrollDown();
}

let pinned = true;
function scrollDown(force = false) {
  const el = $('transcript');
  if (force || pinned) el.scrollTop = el.scrollHeight;
}

// Streaming occupies the same progress slot as the saved commentary.
function mountLive(tab = state.tab) {
  const t = tabs[tab];
  if (tab !== state.tab || !t.live) return;
  const turns = turnsFrom(t.session?.events || []);
  const i = turns.length - 1;
  if (i < 0) return;
  const progress = document.getElementById(`fold-${foldKey(turns[i], i)}`);
  if (!progress) return;
  progress.insertBefore(t.live, progress.querySelector(':scope > .act, :scope > .note'));
}

function liveTurn(tab = state.tab) {
  const t = tabs[tab];
  if (!t.live) {
    const div = document.createElement('div');
    div.className = 'turn assistant';
    div.innerHTML = `<div class="who"><span class="tag">${esc(state.models[t.session?.model]?.label || t.session?.model || '')}</span></div>
      <div class="thinking" hidden></div><div class="body"></div>`;
    t.live = div;
    mountLive(tab);
    if (tab === state.tab) window.harnessTrace?.('visible', { screen: 'transcript', outcome: 'streaming-progress' });
  }
  return t.live;
}
function clearLive(tab = state.tab) {
  tabs[tab].live?.remove();
  tabs[tab].live = null;
}

// ---------------------------------------------------------------- session

let openingSession = null;   // the tap we are still fetching for

async function openSession(id, { startup = false } = {}) {
  if (sessionOffline(state.sessions.find(s => s.id === id))) return showBanner('This tab’s computer is offline. Reconnect it to open the tab.');
  window.cancelDictation?.();
  openingSession = id;

  // Answer the tap before doing the work. Fetching a session pulls its whole
  // transcript down - a long one is a few hundred kilobytes even compressed -
  // and leaving the list sitting there until it arrived made the tap look like
  // it had been missed. The name and model are already known from the list,
  // so the header can be right immediately and only the body has to wait.
  closeSheet();
  const meta = state.sessions.find((x) => x.id === id);
  if (meta) {
    $('title-name').textContent = state.apps?.find((a) => a.id === meta.appId)?.name || 'Distributed Orchestrator';
    $('title-sub').textContent = modelEffortLabel(meta);
  }
  window.harnessTrace?.('visible', { screen: 'transcript', outcome: 'loading' });
  $('transcript').innerHTML = '<div class="empty"><p class="dim">loading…</p></div>';

  let session;
  try {
    session = await api(`/api/sessions/${id}`);
  } catch (e) {
    if (openingSession !== id) return;
    openingSession = null;
    window.harnessTrace?.('visible', { screen: 'transcript', outcome: 'open-failed' });
    if (startup) throw e;
    showBanner(e.message);
    drawTranscript();     // back to whatever was open before
    return;
  }
  // Tapping a second session while the first is still coming: the later tap wins.
  if (openingSession !== id) return;
  openingSession = null;

  state.session = session;
  if (state.session?.id !== id) return;
  tabs.chat.session = session;
  // A browser tab owns its selection; localStorage is shared by every window.
  const url = new URL(location.href);
  url.searchParams.set('session', id);
  history.replaceState(history.state, '', url.href);
  try {
    sessionStorage.setItem(sessionStorageKey, id);
    if (session.appId) sessionStorage.setItem(`${sessionStorageKey}:app:${session.appId}`, id);
  } catch { /* The URL still preserves selection when storage is unavailable. */ }

  clearLive('chat');
  showSession();
  listen('chat', id);
  // Model discovery must not hold the conversation behind a host probe.
  api(`/api/sessions/${id}/models`).then(inventory => {
    if (state.session?.id !== id) return;
    state.models = inventory.models;
    paintHeader();
  }).catch(() => {});
}

/**
 * Apply a delete or a rewind, and show the conversation as it now stands.
 *
 * The server returns the whole session rather than a patch: the transcript is
 * the thing that changed, and re-rendering from the truth is cheaper to reason
 * about than replaying the edit on the copy held here.
 */
async function editTranscript(verb, body) {
  const id = cur().session?.id;
  if (!id) return;
  try {
    const res = await api(`/api/sessions/${id}/${verb}`, { method: 'POST', body: JSON.stringify(body) });
    cur().session = res.session;
    if (state.session?.id === id) state.session = res.session;
    // A rewind is nearly always a prelude to asking for the same thing
    // differently, so the message comes back to the composer instead of being
    // thrown away with the turn it started.
    if (res.draft && !$('input').value.trim()) {
      $('input').value = res.draft;
      $('input').style.height = 'auto';
      $('input').style.height = `${Math.min($('input').scrollHeight, window.innerHeight * 0.4)}px`;
      paintComposerAction();
    }
    showSession();
    showBanner('');
  } catch (e) { showBanner(e.message, true); }
}

function nextTabName(appId) {
  const sessions = state.sessions.filter((s) => (s.appId ?? null) === (appId || null));
  let number = sessions.length + 1;
  for (const session of sessions) {
    const match = /^Tab (\d+)$/.exec(session.name);
    if (match) number = Math.max(number, Number(match[1]) + 1);
  }
  return `Tab ${number}`;
}

function projectSession(app) {
  const sessions = state.sessions.filter((s) => s.appId === app.id).sort((a,b) => Number(sessionOffline(a)) - Number(sessionOffline(b)));
  let remembered;
  try { remembered = sessionStorage.getItem(`${sessionStorageKey}:app:${app.id}`); } catch {}
  return sessions.find((s) => s.id === state.session?.id)
    || sessions.find((s) => s.id === remembered) || sessions[0];
}

const openingProjects = new Set();

async function openProject(app) {
  if (openingProjects.has(app.id)) return;
  openingProjects.add(app.id);
  try {
    const session = projectSession(app);
    if (!session) {
      if (state.sessions.some(s => s.appId === app.id)) return showBanner('This app’s tabs are on offline computers. Reconnect a computer to open its tabs.');
      draft = { appId: app.id };
      await newSheet();
      return;
    }
    await openSession(session.id);
  } catch (e) { showBanner(e.message, true); }
  finally { openingProjects.delete(app.id); }
}

function sessionOffline(session) {
  if (!session || !state.machines?.hosts) return false;
  const owner = session.ownerNode || state.machines.leader;
  return Boolean(owner) && !state.machines.hosts.some(h => h.id === owner && h.active !== false);
}

function tabComputerBadge(session) {
  const app = state.apps?.find(a => a.id === session.appId);
  if ((app?.executionHosts?.length || 0) < 2) return '';
  const host = state.machines?.hosts?.find(h => h.id === (session.ownerNode || state.machines.leader));
  if (!host) return '';
  const label = esc(`Computer ${host.number}: ${host.name}`).replace(/"/g, '&quot;');
  return `<span class="tab-computer" title="${label}" aria-label="${label}"><svg viewBox="0 0 28 24" aria-hidden="true"><rect x="1" y="1" width="26" height="17" rx="2"/><path d="M14 18v5M8 23h12"/><text x="14" y="13">${host.number}</text></svg></span>`;
}

function sessionActive(session) {
  return (state.busy || []).includes(session.id) || Boolean(session.turnHost);
}
function sessionOrder(a, b) {
  return Number(sessionActive(b)) - Number(sessionActive(a))
    || (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0)
    || a.id.localeCompare(b.id);
}

function paintSessionTabs() {
  const bar = $('session-tabs');
  if (!bar) return;
  const current = state.session;
  bar.hidden = !current;
  if (!current) { bar.innerHTML = ''; return; }
  const sessions = current.appId ? state.sessions.filter((s) => s.appId === current.appId) : [current];
  if (!sessions.some((s) => s.id === current.id)) sessions.push(current);
  // Active work first, then the sessions the user messaged most recently.
  sessions.sort(sessionOrder);
  bar.innerHTML = `<div class="session-tab-list" aria-label="Sessions">${sessions.map((s) =>
    `<button class="ghost${s.id === current.id ? ' on' : ''}${sessionOffline(s) ? ' offline' : ''}" ${sessionOffline(s) ? 'disabled aria-label="' + esc(s.name) + ' · computer offline"' : ''} data-session-id="${esc(s.id)}" aria-current="${s.id === current.id ? 'page' : 'false'}" title="${esc(s.name)}${sessionOffline(s) ? ' · computer offline' : ''}"><span class="session-tab-name">${esc(s.name)}</span>${tabComputerBadge(s)}${sessionActive(s) ? '<span class="session-busy-dot" role="img" aria-label="Working"></span>' : ''}</button>`).join('')}</div>
    <button class="tap" id="session-add" aria-label="New session" title="New session">＋</button>
    <button class="tap" id="session-options" aria-label="Session options" title="Session options">⋯</button>`;
  bar.querySelectorAll('[data-session-id]').forEach((el) => {
    el.onclick = () => { if (!el.disabled && el.dataset.sessionId !== state.session?.id) openSession(el.dataset.sessionId); };
  });
  $('session-add').onclick = () => { draft = { appId: current.appId }; newSheet(); };
  $('session-options').onclick = sessionOptionsSheet;
}

function sessionOptionsSheet() {
  const session = state.session;
  openSheet(`<h2>${esc(session.name)}</h2>
    <button class="rowlink" id="session-edit">Edit session <span>›</span></button>
    <button class="rowlink" id="session-delete">Delete session <span>›</span></button>`);
  $('session-edit').onclick = sessionSettingsSheet;
  $('session-delete').onclick = () => deleteSessionSheet(session);
}

async function deleteSessionSheet(session) {
  try {
    await refreshState();
    const app = state.apps?.find(a => a.id === session.appId);
    const last = app && app.id !== '__harness' && state.sessions.filter(s => s.appId === app.id).length === 1;
    openSheet(`<h2>Delete session</h2><p>${last ? 'This is the last session in this project. Keep the project or delete it too?' : 'Delete this session and its transcript?'}</p>
      <div class="actions"><button class="ghost" id="session-delete-back">cancel</button>
      <button class="danger" id="session-delete-only">delete session</button></div>
      ${last ? '<div class="actions"><button class="danger" id="session-delete-project">delete project too…</button></div>' : ''}`, 'delete-session');
    $('session-delete-back').onclick = appsSheet;
    $('session-delete-only').onclick = async () => {
      try {
        await api(`/api/sessions/${session.id}`, {method:'DELETE'});
        if (state.session?.id === session.id) {
          tabs.chat.stream?.close();
          tabs.chat.session = state.session = null;
          clearLive('chat'); showSession();
        }
        await appsSheet();
      } catch(e) { showBanner(e.message, true); }
    };
    if (last) $('session-delete-project').onclick = async () => {
      try {
        const data = await api('/api/apps');
        const project = data.apps.find(a => a.id === app.id);
        if (project) await appDeleteSheet(project, true);
      } catch(e) { showBanner(e.message, true); }
    };
  } catch(e) { showBanner(e.message, true); }
}

function showSession() {
  drawTranscript();
  paintHeader();
  paintSessionTabs();
  const t = cur();
  setRunning(t.running, t.startedAt);
  scrollDown(true);
}

function paintHeader() {
  refreshPushStatus();
  const s = state.session;
  const t = cur();
  // The project is the folder: name it, so the header says what you are working on.
  const folder = s?.mode !== 'chat' && String(s?.projectDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  $('title-name').textContent = state.apps?.find((a) => a.id === s?.appId)?.name || (s ? folder || s.name : 'Distributed Orchestrator');
  $('title-sub').textContent = s
    ? modelEffortLabel(s)
    : 'pick a session';
  $('send').disabled = !t.session || sessionOffline(t.session);
  // Nothing to send to yet: the start screen says how to begin instead.
  $('composer').hidden = !s;
  $('model-gear').hidden = !s;
  $('model-gear').disabled = !s || sessionOffline(s);
  $('input').placeholder = cur().paused ? pausedPlaceholder : idlePlaceholder();
  const model = s && state.models[s.model];
  if (sessionOffline(s)) {
    const owner = state.machines?.hosts?.find(h => h.id === s.ownerNode);
    showBanner(`${owner?.name || 'This session’s computer'} is offline. You can read the saved conversation; reconnect that computer to continue.`, true);
  } else if (s && s.projectDir === state.home) {
    showBanner('this session is rooted at your home folder — every project is in its scope. Use Edit session to give it its own directory.', true);
  } else if (s?.projectDirMissing) {
    showBanner(`${shortDir(s.projectDir)} no longer exists — use Edit session to choose another folder`, true);
  } else if (s && model && !model.hasKey) {
    showBanner(`${s.model} has no API key — tap ⚙ to add one`, true);
  } else {
    showBanner('');
  }
}

function showBanner(msg, warn = false) {
  window.harnessTrace?.('visible', { screen: 'banner', outcome: msg ? (warn ? 'error' : 'notice') : 'cleared' });
  const b = $('banner');
  delete b.dataset.startup;
  b.textContent = msg;
  b.hidden = !msg;
  b.classList.toggle('warn', warn);
}

function paintComposerAction() {
  paintMessagePending();
  const busy = cur().running;
  $('send').disabled = !cur().session || sessionOffline(cur().session);
  $('queue').disabled = sessionOffline(cur().session);
  const hasDraft = Boolean($('input').value.trim()) || pendingShots.length > 0;
  $('send').hidden = busy;
  $('stop').hidden = !busy || hasDraft;
  $('pause').hidden = !busy || hasDraft || Boolean(cur().paused);
  $('queue').hidden = !busy || !hasDraft;
}

// Paused: the turn was stopped on purpose and queued messages are held until Resume.
// The server saves the pause, so it is still here after a restart, along with
// the checkpoint file Resume asks the agent to re-read.
function setPaused(on, tab = state.tab, checkpoint = null) {
  tabs[tab].paused = on;
  tabs[tab].checkpoint = on ? checkpoint || tabs[tab].checkpoint || null : null;
  if (tab !== state.tab) return;
  $('paused').hidden = !on;
  $('paused-checkpoint').hidden = !tabs[tab].checkpoint;
  $('paused-detail').textContent = tabs[tab].checkpoint
    ? 'Resume picks up from the saved checkpoint; queued messages wait.'
    : 'Resume continues the work; queued messages wait.';
  $('input').placeholder = on ? pausedPlaceholder : tabs[tab].running ? 'Write a follow-up, then tap Queue next…' : idlePlaceholder();
  paintComposerAction();
  window.harnessTrace?.('visible', { screen: 'paused', outcome: on ? (tabs[tab].checkpoint ? 'shown-checkpoint' : 'shown') : 'cleared' });
}

function setRunning(on, startedAt = null, tab = state.tab) {
  const changed = tabs[tab].running !== on;
  tabs[tab].running = on;
  if (startedAt) tabs[tab].startedAt = startedAt;
  if (tab !== state.tab) return;   // background tab: remember, do not repaint
  paintComposerAction();
  if (on && changed) $('working-label').textContent = 'working';
  $('working').hidden = !on;
  $('input').placeholder = on ? 'Write a follow-up, then tap Queue next…' : tabs[tab].paused ? pausedPlaceholder : idlePlaceholder();
  if (on) startClock(startedAt); else stopClock();
  if (changed) drawTranscript();
}

const idlePlaceholder = () => 'Describe what to build…';
const pausedPlaceholder = 'Paused — tap Resume, or send a message to continue with it…';



// A turn can be quiet for a long time. Show that it is alive, and for how long.
let clockFrom = 0;
let clockTimer = null;
function startClock(startedAt) {
  // Anchor on the server's start time so a reload continues the count instead
  // of restarting at zero and implying the turn just began.
  if (startedAt) clockFrom = startedAt;
  else if (!clockTimer) clockFrom = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - clockFrom) / 1000);
    $('working-time').textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}
function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

// Recover events missed while the browser was asleep. Keep the retry flag until
// a snapshot is applied, and never overwrite a different session or newer events.
async function recoverTranscript(tab) {
  const t = tabs[tab];
  if (!t.needsTranscript || t.recovering || !t.session) return;
  const session = t.session;
  const count = session.events.length;
  t.recovering = true;
  try {
    const fresh = await api(`/api/sessions/${session.id}`);
    if (t.session !== session || session.events.length !== count) return;
    // A snapshot can arrive before the server has accepted this browser's send.
    // Keep provisional messages until their authoritative event arrives.
    fresh.events.push(...session.events.filter(e => e.optimistic && !fresh.events.some(saved => saved.clientMessageId && saved.clientMessageId === e.clientMessageId)));
    t.session = fresh;
    t.needsTranscript = false;
    if (tab === 'chat') state.session = fresh;
    clearLive(tab);
    if (tab === state.tab) drawTranscript();
  } catch {
    // Reconciliation retries even after the composer has returned to idle.
  } finally {
    t.recovering = false;
  }
}

function listen(tab, id) {
  const t = tabs[tab];
  t.stream?.close();
  showInteraction(null, id);
  setPaused(false, tab);
  const es = new EventSource(nodeApi(`/api/sessions/${id}/events`));
  t.stream = es;

  es.onmessage = (msg) => {
    if (t.stream !== es) return;
    const p = JSON.parse(msg.data);
    const active = tab === state.tab;
    if (p.kind === 'interaction') { if (active) showInteraction(p.request, id); return; }
    if (p.kind === 'hello' && active) showInteraction(p.interaction, id);
    if (p.kind === 'paused') { setPaused(Boolean(p.paused), tab, p.checkpoint); return; }
    if (p.kind === 'hello') setPaused(Boolean(p.paused), tab, p.checkpoint);

    if (p.kind === 'pending' && p.starting && t.session) {
      t.session.events.push({id:'pending-' + p.starting.pendingId, ts:Date.now(), type:'user', text:p.starting.text, attachments:p.starting.attachments, clientMessageId:p.starting.clientMessageId, optimistic:true});
      if (active) drawTranscript();
    }
    if (p.kind === 'pending' || p.kind === 'hello') {
      pendingVersions.set(id, (pendingVersions.get(id) || 0) + 1);
      pendingMessages.set(id, p.pending || []);
      if (active) paintMessagePending();
      if (p.kind === 'pending') return;
    }
    if (p.kind === 'hello') {
      t.needsTranscript = true;
      setRunning(p.running, p.startedAt, tab);
      recoverTranscript(tab);
      return;
    }

    if (p.kind === 'delta') {
      const d = p.delta;
      if (d.kind === 'text') {
        const body = liveTurn(tab).querySelector('.body');
        body.dataset.raw = (body.dataset.raw ?? '') + d.text;
        body.innerHTML = render(body.dataset.raw);
      } else if (d.kind === 'thinking') {
        const el = liveTurn(tab).querySelector('.thinking');
        el.hidden = false;
        el.textContent += d.text;
      } else if (d.kind === 'tool_start') {
        liveTurn(tab).insertAdjacentHTML('beforeend', toolBlock(d.call, null));
      } else if (d.kind === 'tool_end') {
        const el = liveTurn(tab).querySelector(`[data-call="${CSS.escape(d.result.callId)}"] .tool-status`);
        if (el) {
          el.className = `tool-status ${d.result.ok ? 'ok' : 'err'}`;
          el.textContent = d.result.ok ? 'ok' : 'failed';
        }
      } else if (d.kind === 'model_report') {
        const sent = t.session?.events.find(e => e.id === d.eventId);
        if (sent) sent.modelReport = d.report;
        if (active) drawTranscript();
      }
      if (active) scrollDown();
      return;
    }

    if (p.kind === 'started') setRunning(true, p.startedAt, tab);
    if (p.kind === 'event') {
      if (p.event.type === 'assistant') clearLive(tab);
      if (p.event.type === 'user' && t.session) t.session.events = t.session.events.filter(e => !e.optimistic || (p.event.clientMessageId ? e.clientMessageId !== p.event.clientMessageId : e.text !== p.event.text));
      if (t.session && !t.session.events.some(e => e.id === p.event.id)) t.session.events.push(p.event);

      if (active) drawTranscript();
      if (p.event.type === 'assistant') setRunning(true, t.startedAt || null, tab);
      return;
    }

    if (p.kind === 'error' && active) showBanner(p.error);

    if (p.kind === 'done') {
      if (active) window.harnessTrace?.('visible', {screen:'transcript',outcome:'turn-ended'});
      clearLive(tab);
      setRunning(false, null, tab);
      t.startedAt = null;
      if (active) {
        // Repaint: the fold and chip were rendered in their running state and
        // would otherwise keep claiming "working" after the turn had ended.
        drawTranscript();
        refreshState();
      }
    }
  };
  let dropped = false;
  es.onerror = () => { dropped = true; }; // EventSource reconnects on its own
  es.onopen = () => {
    if (t.stream !== es || !dropped) return;
    dropped = false;
    // A running turn replays itself; an idle tab may have missed a note from startup.
    if (!t.running) { t.needsTranscript = true; recoverTranscript(tab); }
    checkServedVersion();
  };
}

function showInteraction(request, sessionId) {
  const box = $('provider-interaction');
  if (!box) return;
  if (box.dataset.request === request?.id) return;
  box.dataset.request = request?.id || '';
  box.hidden = !request;
  if ($('working-label')) $('working-label').textContent = request ? 'waiting for your response' : 'working';
  if (!request) { box.replaceChildren(); return; }
  const questions = request.kind === 'question' ? request.input.questions || [] : [];
  box.innerHTML = `<details open><summary>${request.kind === 'question' ? 'Claude needs your answer' : 'Claude requests permission'}</summary>
    ${questions.length ? questions.map((q,i) => `<fieldset class="question" data-question="${i}"><legend>${esc(q.question)}</legend>
      ${q.options?.length ? `<div class="choice-grid question-options" role="group" aria-label="${esc(q.multiSelect ? 'Choose any' : 'Choose one')}">${q.options.map((o, j) =>
        `<button type="button" class="rowlink" data-option="${j}" aria-pressed="false"><span>${esc(o.label)}</span><span>${esc(o.description || '')}</span></button>`).join('')}</div>` : ''}
      <textarea data-answer="${i}" aria-label="Your own answer" placeholder="${q.options?.length ? 'Or type your own answer' : 'Type your answer'}"></textarea></fieldset>`).join('')
      : `<p>${esc(request.tool)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto"></pre>`}
    ${request.always?.length ? `<p class="dim">Always allow adds Claude’s rule: ${request.always.map(esc).join(', ')}</p>` : ''}
    <div class="actions interaction-actions"><button class="primary" data-approve>${questions.length ? 'answer' : 'allow once'}</button>
      ${request.always?.length ? '<button class="ghost" data-scope="always">always allow</button>' : ''}
      ${request.kind === 'permission' ? '<button class="ghost" data-scope="all" title="No more prompts in this session; full access on its computer">allow everything</button>' : ''}
      <button class="ghost" data-decline>decline</button></div>
    <p class="dim" data-error></p></details>`;
  if (!questions.length) box.querySelector('pre').textContent = JSON.stringify(request.input, null, 2);
  // Typed text wins over picked options; several picks are sent comma-separated, as Claude Code does.
  const answerFor = (q, i) => box.querySelector(`[data-answer="${i}"]`).value.trim()
    || [...box.querySelectorAll(`[data-question="${i}"] [data-option][aria-pressed="true"]`)].map(b => q.options[b.dataset.option].label).join(', ');
  const respond = async (allow, scope) => {
    if (allow && questions.some((q, i) => !answerFor(q, i))) {
      box.querySelector('[data-error]').textContent = questions.length > 1 ? 'Answer each question first.' : 'Choose an option or type an answer first.';
      return;
    }
    box.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const answers = Object.fromEntries(questions.map((q,i) => [q.question, answerFor(q, i)]));
      await api(`/api/sessions/${sessionId}/interaction`, {method:'POST', body:JSON.stringify({id:request.id,allow,answers,...(scope ? {scope} : {})})});
      window.harnessTrace?.('visible', {screen:'provider-request',outcome:allow ? scope || 'answered' : 'declined',correlationId:request.id});
      if (scope === 'all' && cur().session?.id === sessionId) showBanner('Allow everything is on for this session. Change it under Session → Claude access.');
      if (box.dataset.request === request.id) showInteraction(null, sessionId);
    } catch(e) {
      if (box.dataset.request !== request.id) return;
      box.querySelector('[data-error]').textContent = e.message;
      box.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  };
  box.querySelectorAll('[data-question]').forEach(field => {
    const q = questions[field.dataset.question];
    field.querySelectorAll('[data-option]').forEach(option => { option.onclick = () => {
      const on = option.getAttribute('aria-pressed') !== 'true';
      if (!q.multiSelect) field.querySelectorAll('[data-option]').forEach(o => { o.setAttribute('aria-pressed', 'false'); o.classList.remove('on'); });
      option.setAttribute('aria-pressed', String(on || !q.multiSelect));
      option.classList.toggle('on', on || !q.multiSelect);
      box.querySelector('[data-error]').textContent = '';
      // One single-choice question answers on the tap, like picking it in Claude Code.
      if (questions.length === 1 && !q.multiSelect && !field.querySelector('textarea').value.trim()) respond(true);
    }; });
  });
  box.querySelector('[data-approve]').onclick = () => respond(true);
  box.querySelector('[data-decline]').onclick = () => respond(false);
  box.querySelectorAll('[data-scope]').forEach(b => { b.onclick = () => respond(true, b.dataset.scope); });
  window.harnessTrace?.('visible', {screen:'provider-request',outcome:request.kind,correlationId:request.id});
}

const pendingVersions = new Map();
const pendingMessages = new Map();
function paintMessagePending() {
  const box = $('message-pending');
  if (!box) return;
  const id = cur().session?.id;
  const saved = pendingMessages.get(id);
  const messages = Array.isArray(saved) ? saved : saved ? [saved] : [];
  box.hidden = !messages.length;
  if (!messages.length) { box.replaceChildren(); delete box.pendingRenderKey; return; }
  const renderKey = JSON.stringify([id, messages]);
  if (box.pendingRenderKey === renderKey) return;
  const wasOpen = $('pending-disclosure')?.open;
  box.pendingRenderKey = renderKey;
  box.innerHTML = '<details id="pending-disclosure"><summary></summary><div class="pending-stack"></div></details>';
  const disclosure = $('pending-disclosure');
  disclosure.open = Boolean(wasOpen);
  disclosure.querySelector('summary').textContent = messages.length + ' queued · click to expand or collapse';
  disclosure.ontoggle = () => window.harnessTrace?.('visible', {screen:'pending-message',outcome:disclosure.open ? 'expanded' : 'collapsed'});
  const stack = box.querySelector('.pending-stack');
  stack.innerHTML = messages.map((message, i) => {
    const suffix = i ? '-' + i : '';
    return '<div class="pending-row"><div class="pending-text" id="pending-preview'+suffix+'"></div>' +
      (message.pendingId ? '<div class="actions"><button class="ghost" id="pending-edit'+suffix+'">edit</button><button class="ghost" id="pending-cancel'+suffix+'">cancel message</button></div>' : '<div class="dim">Sending…</div>') + '</div>';
  }).join('');
  messages.forEach((message, i) => {
    const suffix = i ? '-' + i : '';
    $('pending-preview'+suffix).textContent = (i+1) + '. ' + (message.text || 'Attachment');
    if (!message.pendingId) return;
    const change = async (method, text) => {
      try {
        const version = pendingVersions.get(id) || 0;
        const result = await api(`/api/sessions/${id}/pending`, {method, body:JSON.stringify({pendingId:message.pendingId,text})});
        if ((pendingVersions.get(id) || 0) !== version) return;
        pendingMessages.set(id,result.pending);
        if (cur().session?.id !== id) return;
        delete box.pendingRenderKey; paintMessagePending();
      } catch(e) { showBanner(e.message); }
    };
    $('pending-cancel'+suffix).onclick = () => change('DELETE');
    $('pending-edit'+suffix).onclick = () => {
      const preview = $('pending-preview'+suffix);
      preview.innerHTML = '<textarea id="pending-text-edit'+suffix+'"></textarea><div class="actions"><button class="primary" id="pending-save'+suffix+'">save</button><button class="ghost" id="pending-back'+suffix+'">back</button></div>';
      $('pending-text-edit'+suffix).value = message.text;
      $('pending-save'+suffix).onclick = () => change('PATCH', $('pending-text-edit'+suffix).value);
      $('pending-back'+suffix).onclick = () => { delete box.pendingRenderKey; paintMessagePending(); };
      window.harnessTrace?.('visible', {screen:'pending-message',outcome:'editing'});
    };
  });
  window.harnessTrace?.('visible', {screen:'pending-message',outcome:'queued',count:messages.length});
}

// `retry` resends an earlier message as a new one and leaves the composer's draft alone.
async function send(queue = false, retry = null) {
  if (!retry && window.dictationBusy?.()) return showBanner('Finish or cancel dictation before sending.');
  const text = retry ? String(retry.text || '').trim() : $('input').value.trim();
  const shots = retry ? (retry.attachments || []) : pendingShots.filter((a) => !a.uploading && a.path);
  if (!text && !shots.length) return;
  if (!retry && pendingShots.some((a) => a.uploading)) return showBanner('still uploading — one moment');
  const t = cur();
  if (!t.session) return showBanner('open a session first — tap ☰');
  if (sessionOffline(t.session)) return showBanner('This session’s computer is offline. Reconnect it to send; your draft is still here.');
  if (t.running && !queue) return showBanner('Tap Queue next to send after this turn, or Stop to interrupt.');
  const sessionId = t.session.id;

  const draft = $('input').value;
  const button = $(queue ? 'queue' : 'send');
  if (button.disabled) return;
  button.disabled = true;
  const clientMessageId = crypto.randomUUID();
  const optimistic = { clientMessageId, id: 'pending-' + clientMessageId, ts: Date.now(), type: 'user', text, attachments: shots, optimistic: true };
  const previousQueue = pendingMessages.get(sessionId) || [];
  const pendingVersion = pendingVersions.get(sessionId) || 0;
  if (queue) pendingMessages.set(sessionId, [...previousQueue, {text}]);
  else { t.session.events.push(optimistic); drawTranscript(); }
  if (!retry) {
    $('input').value = '';
    $('input').style.height = 'auto';
    pendingShots = pendingShots.filter(a => !shots.includes(a));
  }
  paintPending();
  paintMessagePending();
  if (!queue) setRunning(true);
  showBanner('');
  pinned = true;
  try {
    const result = await api(`/api/sessions/${sessionId}/${queue ? 'queue' : 'send'}`, {
      method: 'POST',
      body: JSON.stringify({
        text, clientMessageId,
        attachments: shots.map(({ name, path, mime, bytes }) => ({ name, path, mime, bytes })),
      }),
    });
    if (cur().session?.id === sessionId) {
      pendingShots = pendingShots.filter(a => !shots.includes(a));
      paintPending();
      if ((pendingVersions.get(sessionId) || 0) === pendingVersion) {
        if (result.pending?.length) pendingMessages.set(sessionId, result.pending);
        else pendingMessages.delete(sessionId);
      }
      paintMessagePending();
    }
  } catch (e) {
    // An SSE acknowledgement can arrive even if the HTTP response was lost.
    if (t.session?.id === sessionId && t.session.events.some(event => !event.optimistic && event.clientMessageId === clientMessageId)) {
      showBanner('Message saved; reconnecting to its progress.');
      return;
    }
    if (t.session?.id === sessionId) t.session.events = t.session.events.filter(e => e.id !== optimistic.id);
    if (cur().session?.id === sessionId) {
      if (!retry) {
        if (!$('input').value) $('input').value = draft;
        pendingShots.push(...shots.filter(a => !pendingShots.includes(a)));
      }
      paintPending(); drawTranscript();
    }
    if ((pendingVersions.get(sessionId) || 0) === pendingVersion) pendingMessages.set(sessionId, previousQueue);
    paintMessagePending();
    if (!queue && cur().session?.id === sessionId) setRunning(false);
    showBanner(e.message);
  } finally { button.disabled = false; }
}

// ------------------------------------------------------------------ menus

// Keep one ordered status stream per session; polling never resets a known state.
const pushStates = new Map();
function paintPushStatus() {
  const button = $('push-panel');
  if (!button) return;
  const id = state.session?.id;
  const value = pushStates.get(id);
  button.disabled = !id;
  button.textContent = value?.pushing ? 'Pushing…' : 'Push';
  button.classList.toggle('push-pending', Boolean(value?.pending));
  button.title = !id ? 'Open a session' : value?.error ? 'Status unavailable — open Push to retry'
    : value?.pushing ? 'Publishing this session' : value?.pending ? 'This session has changes to push'
    : typeof value?.pending === 'boolean' ? 'No pending changes in this session' : 'Checking this session';
}
async function readPushStatus(id, history = false) {
  const value = pushStates.get(id) || {};
  pushStates.set(id, value);
  const request = value.request = (value.request || 0) + 1;
  if (history) value.details = true;
  let g;
  try { g = await api(`/api/git?session=${encodeURIComponent(id)}${history ? '&history=1' : ''}`); }
  finally { if (history && value.request === request) value.details = false; }
  if (value.request !== request) return null;
  // During a turn/integration files can be temporarily clean. Wait for idle
  // confirmation before removing the pending indicator.
  if (!g.busy || !value.pending) value.pending = Boolean(g.pending);
  value.error = false;
  paintPushStatus();
  return { ...g, pending: Boolean(value.pending) };
}
async function refreshPushStatus() {
  paintPushStatus();
  const id = state.session?.id;
  if (!id || pushStates.get(id)?.pushing || pushStates.get(id)?.polling || pushStates.get(id)?.details) return;
  const value = pushStates.get(id) || {};
  pushStates.set(id, value);
  value.polling = true;
  try { await readPushStatus(id); }
  catch { value.error = true; paintPushStatus(); }
  finally { value.polling = false; }
}

const pendingRestarts = new Map();
let restartNoticeCheckedAt = '';
function paintRestartNotice(result) {
  if (result.checkedAt && result.checkedAt < restartNoticeCheckedAt) return;
  restartNoticeCheckedAt = result.checkedAt || restartNoticeCheckedAt;
  for (const host of result.hosts) {
    const update = host.update || {};
    const previous = pendingRestarts.get(host.id);
    if (update.restartRequired || update.available) {
      pendingRestarts.set(host.id, { name: host.name || host.id,
        target: update.available ? update.latest : update.head,
        text: host.state });
    } else if (previous && !host.stale && host.version?.revision === previous.target && !host.version.dirty) {
      pendingRestarts.delete(host.id);
    }
  }
  const notice = $('update-notice');
  const text = [...pendingRestarts.values()].map(host => `${host.name}: ${host.text}`).join('; ');
  if (notice.textContent !== text) window.harnessTrace?.('visible', {
    screen: 'update-notice', outcome: text ? 'restart-pending' : 'verified-current', count: pendingRestarts.size });
  notice.textContent = text;
  notice.hidden = pendingRestarts.size === 0;
}

/**
 * Keep this page on what its computer runs. The label follows every change. The
 * page reloads itself only when the interface really changed, and never over
 * something the user is in the middle of; then it offers a button instead.
 */
function reloadKeepingDraft() {
  const draft = $('input')?.value;
  if (draft) location.hash = 'draft=' + encodeURIComponent(draft);
  location.reload();
}
function safeToReload() {
  const input = $('input');
  return $('sheet-back').hidden && !pendingShots.length && !(document.activeElement === input && input.value.trim())
    && !$('provider-interaction')?.dataset.request && !document.querySelector('.recording')
    && !Object.values(tabs).some(tab => tab.running);
}
async function checkServedVersion() {
  const label = $('serving-label');
  if (!label) return;
  let status;
  try {
    const response = await nativeFetch('/api/harness/status', { cache: 'no-store' });
    if (!response.ok) return;
    status = await response.json();
  } catch { return; } // restarting; the stream's reconnect checks again
  if (status.label && label.textContent !== status.label) {
    label.textContent = status.label;
    window.harnessTrace?.('visible', { screen: 'serving-label', outcome: status.version?.testing ? 'testing' : 'published', count: status.version?.testing?.files });
  }
  if (status.title) label.title = status.title;
  const notice = $('ui-reload');
  if (!status.ui || !label.dataset.ui || status.ui === label.dataset.ui) { notice.hidden = true; return; }
  let reloaded = null;
  try { reloaded = sessionStorage.getItem('ui-reloaded-for'); } catch {}
  // Reloading did not help once already: do not loop, leave it to the button.
  if (reloaded !== status.ui && safeToReload()) {
    try { sessionStorage.setItem('ui-reloaded-for', status.ui); } catch {}
    window.harnessTrace?.('visible', { screen: 'ui-reload', outcome: 'reloading' });
    reloadKeepingDraft();
    return;
  }
  if (notice.hidden) window.harnessTrace?.('visible', { screen: 'ui-reload', outcome: 'offered' });
  notice.hidden = false;
}

let refreshGeneration = 0;
async function refreshState() {
  const generation = ++refreshGeneration;
  const s = await api('/api/state');
  if (generation !== refreshGeneration) return s;
  // Assign field by field. A blanket Object.assign once let the server's
  // `running` (an array of busy session ids) land on top of the local boolean
  // of the same name - and [] is truthy, so send() silently refused forever.
  if (!state.harnessCheckedAt || Date.now() - state.harnessCheckedAt > 30_000) {
    state.harnessCheckedAt = Date.now();
    api('/api/harness/versions').then(paintRestartNotice).catch(() => {});
  }
  state.machines = s.machines;
  state.apps = s.apps ?? [];
  state.models = s.models ?? {};
  state.default = s.default;
  const modelSession = state.session?.id;
  api(modelSession ? `/api/sessions/${modelSession}/models` : '/api/models/catalog').then(inventory => {
    if (generation !== refreshGeneration || state.session?.id !== modelSession) return;
    if (inventory.models) state.models = inventory.models;
    if (inventory.default) state.default = inventory.default;
    paintHeader();
  }).catch(() => {});
  refreshPushStatus();
  state.sessions = s.sessions ?? [];
  state.home = s.home ?? '';
  state.busy = s.running ?? [];
  state.waiting = s.waiting ?? [];
  state.beacons = s.beacons ?? {};
  if (s.error) showBanner(s.error);
  // Keep the composer honest if the page was reloaded mid-turn.
  // Reconcile the open session against the server's running turn.
  for (const [name, tab] of Object.entries(tabs)) {
    if (!tab.session) continue;
    const id = tab.session.id;
    const info = s.turns?.[id];
    const busy = state.busy.includes(id);

    // We thought a turn was running and the server says it is not: the end of
    // it was missed, so the transcript is short by however much arrived after
    // the connection dropped. Re-read it rather than showing a stale tail.
    if (tab.running && !busy) tab.needsTranscript = true;
    setRunning(busy, info?.startedAt ?? null, name);
    recoverTranscript(name);
  }
  paintSessionTabs();
  if (!cur().session && !openingSession) drawTranscript(); // keep the start screen's states current
  if (sheetView === 'apps' && lastAppsData) renderAppsSheet(lastAppsData);
  checkServedVersion();
  return s;
}

/**
 * What a session is doing, at a glance in the browser.
 *
 * Three states worth telling apart: working, waiting on you, and working but
 * gone quiet for longer than its backend should. The last one matters because
 * an agent CLI can be silent for a long time legitimately, so it is reported as
 * "quiet" rather than as a failure.
 */
function sessionStatus(s) {
  // `busy`, not `running`: a local boolean already owns that name here.
  const running = sessionActive(s);
  if ((state.waiting || []).includes(s.id)) return '<span class="sstat quiet">needs your answer</span>';
  if (!running && s.paused) return '<span class="sstat waiting">paused · resume when ready</span>';
  if (!running && s.outcome === 'error') return '<span class="sstat failed">last turn failed</span>';
  if (!running && s.outcome === 'interrupted') return '<span class="sstat failed">interrupted</span>';
  if (!running) return '<span class="sstat waiting">idle</span>';
  const b = state.beacons?.[s.id];
  if (b?.stalled) {
    return `<span class="sstat quiet">quiet ${Math.round(b.silentMs / 60000)}m</span>`;
  }
  const what = b?.lastActivity ? String(b.lastActivity).split(/\s+/)[0] : '';
  return `<span class="sstat thinking"><span class="pulse"></span>thinking${what ? ` · ${esc(what)}` : ''}</span>`;
}

// Sessions and apps live in one view (see appsSheet). Kept as an alias so
// existing callers that refresh the list still work.
async function sessionsSheet() { return appsSheet(); }

let draft = {};   // survives a detour through the directory browser

async function newSheet() {
  await refreshState();
  // Each session gets its own folder. Inheriting the previous session's meant
  // one session started at ~ and every later one did too, so every project on
  // the machine was in scope for all of them.
  const dir = draft.dir ?? '';
  // An app owns its directory. Attaching a session to one is the normal case:
  // several sessions on one app, each free to run a different model.
  let appList = [];
  try { appList = (await api('/api/apps')).apps; } catch { /* apps are optional */ }
  openSheet(`<h2>New session</h2>
    <label>Project</label>
    <select id="n-app">
      <option value="">— none, just a folder —</option>
      ${appList.map((a) => `<option value="${esc(a.id)}"${draft.appId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>
    <label>Name</label><input id="n-name" placeholder="${esc(nextTabName(draft.appId))}" />
    <div id="n-computer-row" hidden><label>Computer</label><select id="n-computer"></select></div>
    <label>Model</label>
    <div class="rowlinks"><button class="rowlink" id="n-model" disabled><span class="choice-text"><span id="n-model-label">Select a computer</span><small id="n-model-source"></small></span><span class="chev">›</span></button></div>
    <label>Mode</label>
    <select id="n-mode">
      <option value="agent">agent — tools, works in a project folder</option>
      <option value="chat">chat — plain Q&amp;A, no tools</option>
    </select>
    <label>Project directory — its own folder, created if new</label>
    <div class="row"><input id="n-dir" value="${esc(dir)}" placeholder="~/Projects/…" spellcheck="false" />
    <button class="ghost" id="n-browse" style="flex:0 0 92px">browse</button></div>
    <label>Extra instructions (optional)</label><textarea id="n-sys"></textarea>
    <div class="actions"><button class="ghost" id="n-cancel">cancel</button>
    <button class="primary" id="n-go" disabled>create</button></div>`);

  if (draft.name) $('n-name').value = draft.name;
  if (draft.system) $('n-sys').value = draft.system;
  if (draft.dir) $('n-dir').value = draft.dir;
  if (draft.mode) $('n-mode').value = draft.mode;
  // The model row shows what the session will start with; the wizard changes it.
  let chosen = { alias: '', effort: '' }, inventory = null;

  const keep = () => {
    draft = {
      ownerNode: $('n-computer').value || undefined,
      appId: $('n-app').value || null,
      name: $('n-name').value, system: $('n-sys').value,
      dir: $('n-dir').value, model: chosen.alias, effort: chosen.effort, mode: $('n-mode').value,
      claudePermission: draft.claudePermission,
    };
  };

  // Suggest a folder from the name, and stop as soon as the user edits it.
  let dirTouched = Boolean(draft.dir);
  const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suggest = () => {
    if (dirTouched) return;
    const name = slug($('n-name').value) || 'session';
    $('n-dir').value = `${state.home}/Projects/${name}`;
  };
  $('n-name').addEventListener('input', suggest);
  $('n-dir').addEventListener('input', () => { dirTouched = true; });
  suggest();

  // The app's directory wins, and the field goes read-only so the two cannot
  // disagree about where the session is working.
  let modelRequest = 0;
  const computerSelect = $('n-computer');
  const loadComputerModels = async () => {
    const request = ++modelRequest;
    $('n-go').disabled = true;
    $('n-model').disabled = true;
    $('n-model-label').textContent = 'Loading models for this computer…';
    $('n-model-source').textContent = '';
    const current = () => request === modelRequest && $('n-computer') === computerSelect;
    if (!computerSelect.value) {
      $('n-model-label').textContent = 'No computer available';
      return;
    }
    try {
      inventory = await api(`/api/execution-models?app=${encodeURIComponent($('n-app').value)}&host=${encodeURIComponent($('n-computer').value)}`);
      if (!current()) return;
      // A model picked earlier wins; otherwise this computer's default and its effort.
      chosen = inventory.models[draft.model]?.available !== false && inventory.models[draft.model]
        ? { alias: draft.model, effort: draft.effort || '' }
        : { alias: inventory.default || '', effort: inventory.defaultEffort || '' };
      const model = inventory.models[chosen.alias];
      $('n-model-label').textContent = model ? modelChoiceLabel(model, chosen.effort || model.effortCapability?.configured) : 'No available models — set up AI sources';
      $('n-model-source').textContent = model ? modelSourceName(model) + (model.provider === 'claude-cli' ? ` · ${accessTitle(draft.claudePermission || model.permissionMode)}` : '') : '';
      // Tool-less local models can only chat.
      $('n-mode').querySelector('[value="agent"]').disabled = model?.supportsTools === false;
      if (model?.supportsTools === false) $('n-mode').value = 'chat';
      $('n-model').disabled = false;
      $('n-go').disabled = !model;
    } catch (e) {
      if (!current()) return;
      $('n-model-label').textContent = 'Cannot load this computer’s models';
      showBanner(e.message);
    }
  };
  $('n-model').onclick = () => {
    keep();
    modelWizard({ host: $('n-computer').value, alias: chosen.alias, current: inventory?.models[chosen.alias], effort: chosen.effort,
      permission: draft.claudePermission || inventory?.models[chosen.alias]?.permissionMode || 'default',
      purpose: 'New session', exit: newSheet,
      save(alias, effort, model, permission) {
        draft.model = alias; draft.effort = effort;
        if (permission) draft.claudePermission = permission;
        if (model.supportsTools === false) draft.mode = 'chat';
        else if (draft.mode === 'chat' && inventory?.models[chosen.alias]?.supportsTools === false) draft.mode = 'agent';
        return '';
      } });
  };
  $('n-computer').onchange = loadComputerModels;
  const applyApp = () => {
    $('n-name').placeholder = nextTabName($('n-app').value);
    const eligible = state.apps?.find(a => a.id === $('n-app').value)?.executionHosts || [state.machines?.leader];
    const hosts = (state.machines?.hosts || []).filter(h => eligible.includes(h.id));
    $('n-computer-row').hidden = hosts.length < 2;
    $('n-computer').innerHTML = hosts.map(h => `<option value="${esc(h.id)}">${h.number} · ${esc(h.name)}${h.active ? '' : ' · offline'}</option>`).join('');
    if (hosts.some(h => h.id === draft.ownerNode)) $('n-computer').value = draft.ownerNode;
    loadComputerModels();
    const app = appList.find((a) => a.id === $('n-app').value);
    if (app) {
      $('n-dir').value = app.dir;
      $('n-dir').disabled = true;
      dirTouched = true;
    } else {
      $('n-dir').disabled = false;
    }
  };
  $('n-app').addEventListener('change', applyApp);
  applyApp();

  $('n-cancel').onclick = () => { draft = {}; sessionsSheet(); };
  $('n-browse').onclick = () => {
    keep();
    browseSheet($('n-dir').value, (chosen) => { draft.dir = chosen; newSheet(); });
  };
  let submitting = false;
  const createButton = $('n-go');
  createButton.onclick = async () => {
    if (submitting || createButton.disabled) return;
    // `chosen` is the picked model; the folder has its own name so it cannot shadow it.
    const folder = $('n-dir').value.trim().replace(/\/+$/, '');
    if (!folder && !$('n-app').value) return showBanner('give this session a folder of its own');
    if (folder === state.home.replace(/\/+$/, '')) {
      return showBanner('that is your home folder — give the session its own directory, or everything on the machine is in scope');
    }
    submitting = true;
    createButton.disabled = true;
    try {
      const session = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          appId: $('n-app').value || null,
          ownerNode: $('n-computer').value || undefined,
          name: $('n-name').value.trim() || nextTabName($('n-app').value),
          model: chosen.alias,
          effort: chosen.effort,
          ...(inventory?.models[chosen.alias]?.provider === 'claude-cli' && draft.claudePermission ? { claudePermission: draft.claudePermission } : {}),
          mode: $('n-mode').value,
          projectDir: folder,
          system: $('n-sys').value,
        }),
      });
      draft = {};
      state.sessions.unshift(session);
      await openSession(session.id);
    } catch (e) {
      showBanner(e.message, true);
      submitting = false;
      createButton.disabled = false;
    }
  };
}

async function browseSheet(start, pick, back = newSheet) {
  const load = async (p) => {
    let d;
    try {
      d = await api(`/api/dirs?path=${encodeURIComponent(p)}`);
    } catch (err) {
      openSheet(`<h2>Choose directory</h2><p class="dim">could not read that folder: ${esc(err.message)}</p>
        <div class="actions"><button class="ghost" id="b-home">go home</button></div>`);
      $('b-home').onclick = () => load(state.home);
      return;
    }
    openSheet(`<h2>Choose directory</h2><p class="dim">${esc(shortDir(d.path))}</p>
      ${d.note ? `<p class="dim warn-text">${esc(d.note)}</p>` : ''}
      ${d.parent ? `<div class="item" data-go="${esc(d.parent)}"><div class="grow"><div class="t">../</div></div></div>` : ''}
      ${d.dirs.map((x) => `<div class="item" data-go="${esc(x.path)}"><div class="grow"><div class="t">${esc(x.name)}/</div></div></div>`).join('')}
      <div class="actions"><button class="ghost" id="b-new">new folder</button>
      <button class="primary" id="b-use">use this one</button></div>
      <div class="actions"><button class="ghost" id="b-cancel">cancel</button></div>`);
    $('sheet').querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => load(el.dataset.go); });
    $('b-cancel').onclick = back;
    $('b-use').onclick = () => pick(d.path);
    $('b-new').onclick = async () => {
      const name = prompt('New folder name');
      if (!name?.trim()) return;
      const made = await api('/api/dirs', {
        method: 'POST',
        body: JSON.stringify({ parent: d.path, name: name.trim() }),
      });
      load(made.path);
    };
  };
  load(start || state.home);
}

async function settingsSheet() {
  openSheet(`
    <h2>Distributed Orchestrator settings</h2>
    <div class="rowlinks">
      <button class="rowlink" id="h-default-model"><span>Default model</span><span class="dim" id="h-default-label">›</span></button>
      <button class="rowlink" id="h-github"><span>GitHub connection</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-network"><span>Phone access · Tailscale</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-machines"><span>Machines</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-models"><span>AI sources</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-jev"><span>Jev · TypeSafe</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-voice"><span>Voice setup</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-notify"><span>Notifications</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-history"><span>Usage history · diagnostics</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-version"><span id="h-version-label">Restart and updates</span><span class="chev">›</span></button>
    </div>
    <div class="actions"><button class="primary" id="s-close">done</button></div>`);

  // New sessions on this computer start with this model and effort.
  const defaultHost = nativeFetch('/api/cluster/status').then(r => r.json()).then(status => status.self);
  const label = $('h-default-label');
  defaultHost.then(host => hostSources(host, 'catalog')).then(catalog => {
    if ($('h-default-label') === label) label.textContent = `${modelChoiceLabel(catalog.models[catalog.default], catalog.defaultEffort)} ›`;
  }).catch(() => {});
  $('h-default-model').onclick = async () => {
    window.harnessTrace?.('action', { control: 'default-model' });
    try { await modelWizard(await defaultModelTarget(await defaultHost, settingsSheet)); }
    catch (e) { showBanner(e.message, true); }
  };
  $('h-history').onclick = () => historySheet();
  $('h-github').onclick = githubSheet;
  $('h-machines').onclick = machinesSheet;
  $('h-network').onclick = networkSheet;
  $('h-models').onclick = modelsSheet;
  $('h-jev').onclick = jevSheet;
  $('h-voice').onclick = () => window.voiceSetup();
  $('h-notify').onclick = notifySheet;

  $('s-close').onclick = closeSheet;
  $('h-version').onclick = harnessVersionSheet;
}

let historyRequest = 0;
async function historySheet(host = '') {
  const ticket = ++historyRequest;
  const request = async (action, body) => {
    const url = '/api/diagnostics?host=' + encodeURIComponent(host) + '&action=' + action;
    const r = await nativeFetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const value = await r.json();
    if (!r.ok) throw Error(value.error || 'History unavailable');
    return value;
  };
  openSheet('<h2>Usage history</h2><p class="dim">Loading this computer’s history…</p>', 'history');
  try {
    const data = await request('status');
    if (sheetView !== 'history' || ticket !== historyRequest) return;
    const size = n => n == null ? 'unknown' : (n / 1048576).toFixed(1) + ' MB';
    openSheet(`<h2>Usage history</h2>
      <label>Computer</label><select id="history-host">${(state.machines?.hosts || [{id:data.host,name:'This computer'}]).map(h => `<option value="${esc(h.id)}" ${h.id === data.host ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>
      <p>History: ${size(data.bytes)} in ${data.files} files. Free disk: ${size(data.freeBytes)}.</p>
      <p class="dim">Actions, screens, timings and failures stay on this computer. No messages, typing, screenshots or credentials. Offline computers retain their own history.</p>
      <label>Record usage history</label><select id="history-enabled"><option value="on" ${data.enabled ? 'selected' : ''}>On</option><option value="off" ${!data.enabled ? 'selected' : ''}>Off</option></select>
      <label>Maximum MB (4–2048)</label><input id="history-mb" type="number" min="4" max="2048" value="${data.maxMB}">
      <label>Retention days (1–90)</label><input id="history-days" type="number" min="1" max="90" value="${data.days}">
      <p class="dim">Effective disk limit: ${size(data.effectiveMaxBytes)}. Dropped events: ${data.dropped}; write failures: ${data.failed}.</p>
      <div class="actions"><button class="primary" id="history-save">save</button><button class="ghost" id="history-read">recent history</button></div>
      <div class="actions"><button class="danger" id="history-clear">clear this history</button><button class="ghost" id="history-back">settings</button></div>
      <p id="history-result" class="dim"></p>`, 'history');
    $('history-host').onchange = e => historySheet(e.target.value);
    $('history-back').onclick = settingsSheet;
    const result = async fn => {
      try { await fn(); } catch(e) { showBanner(e.message); }
    };
    $('history-save').onclick = () => result(async () => {
      await request('settings', { action:'settings', enabled:$('history-enabled').value === 'on', maxMB:Number($('history-mb').value), days:Number($('history-days').value) });
      if (sheetView !== 'history' || ticket !== historyRequest) return;
      window.harnessTrace?.('visible', {screen:'history',outcome:'saved'});
      $('history-result').textContent = 'History settings saved.';
    });
    $('history-clear').onclick = () => result(async () => {
      await request('clear', {action:'clear'});
      if (sheetView !== 'history' || ticket !== historyRequest) return;
      await historySheet(host);
      window.harnessTrace?.('visible', {screen:'history',outcome:'cleared'});
      $('history-result').textContent = 'History cleared. New activity will be recorded if enabled.';
    });
    $('history-read').onclick = () => result(async () => {
      const data = await request('events');
      const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'harness-history.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      $('history-result').textContent = 'Downloaded up to 1,000 recent events.';
    });
  } catch (e) {
    if (sheetView !== 'history' || ticket !== historyRequest) return;
    openSheet(`<h2>Usage history</h2><p class="dim">${esc(e.message)}</p><button class="ghost" id="history-back">settings</button>`, 'history');
    $('history-back').onclick = settingsSheet;
  }
}

async function jevSheet() {
  openSheet(`<h2>Jev · TypeSafe</h2>
    <p class="dim">For classification, routing and scoring in your projects. Requests go to TypeSafe and use your API account. The saved key is shared with your paired computers.</p>
    <p class="dim"><a href="https://console.typesafe.ai" target="_blank" rel="noopener noreferrer">Get a TypeSafe key ↗</a></p>
    <label>API key</label><input id="jev-key" type="password" autocomplete="new-password" placeholder="Paste key to add or replace" />
    <p class="dim" id="jev-status" role="status">Checking…</p>
    <div class="actions"><button class="ghost" id="jev-back">back</button><button class="ghost" id="jev-remove">remove key</button><button class="primary" id="jev-save">save</button></div>`);
  const status = $('jev-status'), input = $('jev-key');
  const show = d => { status.textContent = d.configured ? 'Key saved · account access is checked when used.' : 'No key saved.'; };
  $('jev-back').onclick = settingsSheet;
  const change = async method => {
    try {
      const key = input.value.trim();
      if (method === 'PUT' && !key) throw new Error('Paste a key before saving.');
      const result = await api('/api/jev', { method, ...(method === 'PUT' ? { body: JSON.stringify({ apiKey: key }) } : {}) });
      input.value = ''; show(result);
    } catch (e) { status.textContent = e.message; }
  };
  $('jev-save').onclick = () => change('PUT');
  $('jev-remove').onclick = () => change('DELETE');
  try { show(await api('/api/jev')); } catch (e) { status.textContent = e.message; }
}

async function harnessVersionSheet() {
  openSheet('<h2>Restart Harness</h2><p class="dim">Checking paired machines…</p>');
  try {
    const result = await api('/api/harness/versions');
    const stamp = value => value ? new Date(value).toLocaleString() : 'unknown';
    openSheet(`<h2>Restart Harness</h2>
      <p class="dim">${result.aligned ? 'All paired machines run the same commit.'
        : result.hosts.every(host => /^(Same running commit|Testing )/.test(host.state)) ? 'Paired machines match, and some also run unpushed changes.'
        : 'Some machines need attention. Different commits may be ahead or behind.'}</p>
      ${result.hosts.map(host => `<div class="item machine-item"><div class="grow">
        <div class="t">${esc(host.name || host.id)}${host.version?.number ? ` · ${esc(host.version.number)}` : ''}</div>
        <div class="s">${esc(host.state)}${host.stale ? ' · last known / unverified' : ''}</div>
        <div class="s">Active commit ${(esc(host.version?.revision || 'unknown')).slice(0, 12)} · committed ${esc(stamp(host.version?.committedAt))}</div>
        <div class="s">Started ${esc(stamp(host.version?.startedAt))}</div>
        ${host.update?.head && host.update.head !== host.version?.revision ? `<div class="s">Downloaded ${esc(host.update.head.slice(0, 12))}</div>` : ''}
        ${host.update?.latest ? `<div class="s">Latest commit ${esc(host.update.latest.slice(0, 12))}</div>` : ''}
        ${host.update?.error ? `<div class="s">${esc(host.update.error)}</div>` : ''}
      </div><button class="ghost" data-restart-host="${esc(host.id)}" ${!host.version || host.busy || host.restarting ? 'disabled' : ''}>${host.busy ? 'busy' : host.restarting ? 'restarting' : 'restart'}</button></div>`).join('')}
      <p class="dim">Checked ${esc(stamp(result.checkedAt))}. Machines check GitHub every 30 seconds and download updates when idle. Restart applies downloaded changes. Unreachable machines cannot be verified.</p>
      <div class="actions"><button class="ghost" id="version-back">back</button><button class="ghost" id="version-refresh">refresh</button></div>`);
    $('version-back').onclick = settingsSheet;
    $('version-refresh').onclick = harnessVersionSheet;
    $('sheet').querySelectorAll('[data-restart-host]').forEach(button => {
      button.onclick = () => restartOrchestrator(button, button.dataset.restartHost);
    });
  } catch (e) { showBanner(e.message, true); closeSheet(); }
}

async function githubSheet() {
  openSheet(`<h2>GitHub connection</h2>
    <div class="item"><div class="grow"><div id="github-status" role="status">Checking connection…</div></div></div>
    <div id="github-code-panel" class="github-code-panel" hidden>
      <p class="dim">Enter this confirmation code on GitHub</p>
      <output id="github-code" class="github-code" aria-label="GitHub confirmation code"></output>
      <button class="ghost" id="github-copy">Copy code</button>
      <p class="dim">After approving, return here. We’ll connect automatically.</p>
    </div>
    <div id="github-actions" class="actions"></div>
    <p class="dim">Back up your projects to private GitHub repositories.</p>
    <details class="github-details"><summary>What gets shared</summary>
      <p class="dim">GitHub receives project files and commit history, not chat transcripts or saved integration credentials. The connection is shared with your paired hosts.</p>
      <p class="dim">Changes are published only when you press Push. New repositories are private. Manage visibility in Edit session → Git &amp; GitHub.</p>
    </details>
    ${backToSettings}`);
  const box = $('github-status');
  $('sub-back').onclick = settingsSheet;
  const present = () => $('github-status') === box;
  const post = (path) => api('/api/github/' + path, { method: 'POST', body: '{}' });
  const fail = (e) => { if (present()) box.textContent = e.message; };
  const poll = async () => {
    if (!present()) return;
    try {
      const result = await api('/api/github/login');
      if (!present()) return;
      if (result.state === 'ready') { await post('finish'); if (present()) await githubSheet(); return; }
      if (result.state === 'connected') { await githubSheet(); return; }
      if (result.state === 'failed' || result.state === 'idle') {
        box.textContent = result.error || 'No login in progress. Reopen GitHub connection to try again.';
        return;
      }
      box.textContent = result.code ? 'Waiting for approval' : 'Preparing GitHub login…';
      $('github-code-panel').hidden = !result.code;
      $('github-code').textContent = result.code || '';
      $('github-copy').onclick = async () => {
        const copied = await copyText(result.code);
        if (present()) $('github-copy').textContent = copied ? 'Copied' : 'Select the code to copy';
      };
      $('github-actions').innerHTML = result.code
        ? '<a class="primary" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Continue on GitHub</a>' : '';
      setTimeout(poll, 2000);
    } catch (e) { fail(e); }
  };
  try {
    const status = await api('/api/github');
    if (!present()) return;
    box.textContent = status.authenticated
      ? `Connected as ${status.login}`
      : 'GitHub is not connected. Your work stays on your hosts.';
    if (status.authenticated) return;
    $('github-actions').innerHTML = `<button class="primary" id="github-connect">Connect GitHub</button>`;
    $('github-connect').onclick = async () => {
      $('github-connect').disabled = true;
      try {
        {
          const result = await post('login');
          if (result.state === 'connected') { if (present()) await githubSheet(); }
          else await poll();
        }
      } catch (e) { fail(e); if ($('github-connect')) $('github-connect').disabled = false; }
    };
    if (status.missingCli) box.textContent += ' Install GitHub CLI on the host first (cli.github.com).';
    const pending = await api('/api/github/login');
    if (present() && ['starting', 'waiting', 'ready'].includes(pending.state)) await poll();
  } catch (e) { fail(e); }
}

function modelVersionDetails(m, events = []) {
  const last = events.findLast(e => e.type === 'assistant' && e.model === m.alias);
  const parts = [];
  if (last?.servedModel) parts.push(`Last reply used: ${last.servedModel}`);
  if (m.provider === 'claude-cli') {
    if (/^(opus|sonnet|haiku|default|best|fable|opusplan)(\[1m\])?$/i.test(m.model || '')) {
      parts.push('Automatic model alias');
      if (!last?.servedModel) parts.push('version unconfirmed — shown after a reply');
    }
    if (/\[1m\]$/i.test(m.model || '')) parts.push('1 million token context');
  }
  return parts.join(' · ');
}

function modelSourceName(model = {}) {
  return {'claude-cli':'Claude Code · subscription login','codex-cli':'Codex · OpenAI login',
    anthropic:'Anthropic API · API key',openai:'OpenAI-compatible API', 'openai-responses':'OpenAI Responses API'}[model.sourceKind || model.provider]
    || (model.sourceKind === 'ollama' ? 'Ollama · local models' : model.provider || 'Unknown source');
}

// Header line: Claude / OpenAI / Local · Subscription / API · model · effort (when set).
function modelEffortLabel(session) {
  const model = state.models[session.model];
  if (!model) return `${session.model} · not on this computer`;
  const group = MODEL_GROUPS.find(g => g.id === modelGroup(model));
  const access = !['claude','openai'].includes(group?.id) ? '' : ['claude-cli','codex-cli'].includes(model.provider) ? 'Subscription' : 'API';
  const cap = model.effortCapability;
  const effort = session.effort || cap?.configured;
  const unsupported = effort && cap?.levels && !cap.levels.includes(effort) ? ' (unsupported)' : '';
  return [group?.name || model.provider, access, model.label || model.model || session.model, effort && effort + unsupported].filter(Boolean).join(' · ');
}

// Provider → model → effort, shared by the header gear, Edit session, New
// session and the default in Settings. Nothing is saved until the last choice,
// so closing the sheet at any step leaves everything as it was.
const MODEL_GROUPS = [
  {id:'claude', name:'Claude', hint:'Claude Code login or Anthropic API key', discover:'claude-cli', login:'claude auth login'},
  {id:'openai', name:'OpenAI', hint:'Codex login or OpenAI API', discover:'codex-cli', login:'codex login'},
  {id:'local', name:'Local', hint:'Ollama models on this computer', discover:'ollama'},
];
function modelGroup(m = {}) {
  if (m.sourceKind === 'ollama' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(m.baseUrl || '')) return 'local';
  if (['claude-cli','anthropic'].includes(m.provider)) return 'claude';
  if (['codex-cli','openai','openai-responses'].includes(m.provider)) return 'openai';
  return null;
}
// Claude Code permission modes, offered for Claude Code sessions only.
const CLAUDE_ACCESS = [
  {mode:'default', title:'Ask each time', detail:'Claude asks here before risky actions'},
  {mode:'acceptEdits', title:'Accept edits', detail:'File edits go through; other actions still ask'},
  {mode:'auto', title:'Auto', detail:'A safety classifier approves or blocks each action without asking; needs a Claude plan with auto mode'},
  {mode:'bypassPermissions', title:'Allow everything', detail:'No prompts; full access on this computer, including outside the project'},
  {mode:'plan', title:'Plan only', detail:'Claude plans but changes nothing'},
];
const accessTitle = mode => CLAUDE_ACCESS.find(a => a.mode === (mode || 'default'))?.title || mode;
const modelChoiceLabel = (model, effort) => model ? `${model.label || model.model}${effort ? ` · ${effort} effort` : ''}` : 'No model chosen';

async function hostSources(host, action, args = {}) {
  const response = await nativeFetch('/api/cluster/sources', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host,action,...args})});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Source unavailable');
  return result;
}

/** What the wizard changes: a live session. */
function sessionModelTarget(session, exit = closeSheet) {
  return {host:session.ownerNode, alias:session.model, current:state.models[session.model], effort:session.effort || '',
    permission:session.claudePermission || state.models[session.model]?.permissionMode || 'default',
    purpose:'This session', exit, live:() => cur().session?.id === session.id,
    async save(alias, effort, model, permission) {
      const patch = {model:alias, effort, ...(permission ? {claudePermission:permission} : {})};
      // Tool-less local models can only chat; leaving one returns to agent mode.
      if (model.supportsTools === false) patch.mode = 'chat';
      else if (session.mode === 'chat' && state.models[session.model]?.supportsTools === false) patch.mode = 'agent';
      const updated = await api(`/api/sessions/${session.id}`, {method:'PATCH', body:JSON.stringify(patch)});
      if (cur().session?.id === session.id) { cur().session = updated; state.session = updated; }
      // New source rows must reach state.models before the header can name them.
      const inventory = await api(`/api/sessions/${session.id}/models`).catch(() => null);
      if (inventory?.models && state.session?.id === session.id) state.models = inventory.models;
      if (state.session?.id === session.id) drawTranscript();
      return `Now using ${modelChoiceLabel(model, effort)}${patch.mode === 'chat' ? ' · chat only' : ''}${permission ? ` · ${accessTitle(permission)}` : ''}.`;
    }};
}

/** What the wizard changes: the model and effort new sessions start with on one computer. */
async function defaultModelTarget(host, exit) {
  const catalog = await hostSources(host, 'catalog');
  const machine = catalog.machine?.name || 'this computer';
  return {host, alias:catalog.default, current:catalog.models[catalog.default], effort:catalog.defaultEffort || '',
    purpose:`Default for new sessions on ${machine}`, exit,
    async save(alias, effort, model) {
      await hostSources(host, 'default', {alias, effort});
      return `New sessions on ${machine} start with ${modelChoiceLabel(model, effort)}.`;
    }};
}

let modelWizardRequest = 0;
async function modelWizard(target, choice = {}) {
  const request = ++modelWizardRequest;
  const exit = target.exit || closeSheet;
  const host = target.host;
  const machine = state.machines?.hosts?.find(h => h.id === host)?.name || host || 'This computer';
  const group = MODEL_GROUPS.find(g => g.id === choice.group);
  let models = choice.models;
  const model = models?.[choice.alias];
  // Access is a fourth step for Claude Code models when the target has a permission setting.
  const needsAccess = m => target.permission !== undefined && m?.provider === 'claude-cli';
  const step = !group ? 0 : !model ? 1 : !choice.effortDone ? 2 : 3;
  const stepName = ['provider','model','effort','access'][step];
  const names = ['Provider','Model','Effort', ...((model ? needsAccess(model) : target.permission !== undefined && group?.id === 'claude') ? ['Access'] : [])];
  const current = target.current;
  const live = () => request === modelWizardRequest && sheetView === 'model-wizard' && (target.live?.() ?? true);
  const crumbs = [group?.name, model && (model.label || model.model)].filter(Boolean).map(esc).join(' › ');
  openSheet(`<div class="wizard-head"><ol class="wizard-steps">${names.map((name, i) =>
      `<li class="${i === step ? 'on' : i < step ? 'done' : ''}">${name}</li>`).join('')}</ol>
      <button class="tap" id="wizard-close" aria-label="Close without changing the model">✕</button></div>
    <h2>${['Choose a provider','Choose a model','Choose effort','Choose access'][step]}</h2>
    <p class="dim">${esc(target.purpose || machine)} · ${crumbs || `now ${esc(modelChoiceLabel(current, target.effort))}`}</p>
    <p id="wizard-status" role="status" hidden></p>
    <div id="wizard-choices" class="choice-grid"></div>
    <div id="wizard-recovery" hidden></div>
    ${step ? '<div class="actions"><button class="ghost" id="wizard-back">back</button></div>' : ''}`, 'model-wizard');
  window.harnessTrace?.('visible', {screen:'model-wizard', outcome:stepName, provider:group?.id});
  $('wizard-close').onclick = () => { window.harnessTrace?.('action', {control:'model-wizard-close', outcome:stepName}); exit(); };
  const hasEffort = Boolean(model?.effortCapability?.levels?.length);
  if ($('wizard-back')) $('wizard-back').onclick = () => modelWizard(target,
    step === 3 ? (hasEffort ? {...choice, effortDone:false} : {...choice, alias:null, effortDone:false}) : step === 2 ? {...choice, alias:null} : {});
  const status = text => { if (live()) { $('wizard-status').hidden = false; $('wizard-status').textContent = text; } };
  const choices = (items, pick) => {
    $('wizard-choices').innerHTML = items.map((item, i) => `<button class="rowlink${item.on ? ' on' : ''}" data-choice="${i}"><span>${esc(item.title)}</span><span>${esc(item.detail)}</span></button>`).join('');
    $('wizard-choices').querySelectorAll('[data-choice]').forEach(button => { button.onclick = () => pick(items[button.dataset.choice]); });
  };
  const recovery = () => {
    const box = $('wizard-recovery'); box.hidden = false;
    box.innerHTML = group.login
      ? `<p>If the login expired, reconnect on <b>${esc(machine)}</b>:</p><ol><li>Open Terminal on that computer.</li><li>Run <code>${group.login}</code> and finish the browser sign-in.</li><li>Return here and check again.</li></ol><p class="dim">DO cannot renew a provider login itself. Never paste credentials here. API-key models are added in Settings → AI sources.</p><div class="actions"><button class="ghost" id="wizard-copy">copy login command</button><button class="primary" id="wizard-retry">check again</button></div>`
      : `<p>Install Ollama on <b>${esc(machine)}</b> and download a model with <code>ollama pull &lt;model&gt;</code>, then check again.</p><div class="actions"><button class="primary" id="wizard-retry">check again</button></div>`;
    if ($('wizard-copy')) $('wizard-copy').onclick = async () => { try { await navigator.clipboard.writeText(group.login); $('wizard-copy').textContent = 'copied'; } catch { status('Copy the command shown above into Terminal.'); } };
    $('wizard-retry').onclick = () => modelWizard(target, {group:group.id});
  };
  // After effort: the Access step for Claude Code, otherwise save.
  const next = (alias, effort) => needsAccess(models[alias])
    ? modelWizard(target, {...choice, models, alias, effort, effortDone:true}) : apply(alias, effort);
  async function apply(alias, effort, permission) {
    $('wizard-choices').querySelectorAll('button').forEach(b => { b.disabled = true; });
    status('Saving…');
    try {
      const message = await target.save(alias, effort, models[alias], permission);
      window.harnessTrace?.('visible', {screen:'model-wizard', outcome:'applied', provider:group.id, effort:effort || 'default'});
      if (request === modelWizardRequest && sheetView === 'model-wizard') await exit();
      if (message) { paintHeader(); showBanner(message); }
    } catch (e) {
      window.harnessTrace?.('visible', {screen:'model-wizard', outcome:'apply-error', provider:group.id});
      if (!live()) return showBanner(e.message, true);
      status(e.message);
      $('wizard-choices').querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  if (step === 0) return choices(MODEL_GROUPS.map(g => ({...g, title:g.name, on:modelGroup(current) === g.id,
    detail:g.hint + (modelGroup(current) === g.id ? ' · current' : '')})), g => modelWizard(target, {group:g.id}));

  if (step === 1) {
    let refreshError = null;
    if (!models) {
      status(`Loading ${group.name} models on ${machine}…`);
      try { models = (await hostSources(host, 'catalog')).models; }
      catch (e) { if (live()) { status(e.message); recovery(); } window.harnessTrace?.('visible', {screen:'model-wizard', outcome:'error', provider:group.id}); return; }
      try {
        const found = await hostSources(host, 'discover', {kind:group.discover});
        // Re-adding a saved local model would reset its helper setting, so only new ones are added.
        const saved = Object.values(models).filter(m => (m.sourceKind || m.provider) === group.discover).map(m => m.model);
        const fresh = found.models.map(m => m.model).filter(m => group.id !== 'local' || !saved.includes(m));
        if (fresh.length) { await hostSources(host, 'add', {kind:group.discover, models:fresh}); models = (await hostSources(host, 'catalog')).models; }
      } catch (e) { refreshError = e; }
      if (!live()) return;
    }
    const list = Object.entries(models).filter(([, m]) => modelGroup(m) === group.id);
    window.harnessTrace?.('visible', {screen:'model-wizard', outcome:list.length ? 'models' : refreshError ? 'error' : 'empty', provider:group.id});
    if (!list.length) { status(refreshError?.message || `No ${group.name} models on ${machine} yet.`); return recovery(); }
    const note = refreshError ? `Couldn’t refresh ${group.name}: ${refreshError.message} Showing saved models.`
      : group.id === 'local' ? 'Local models without tool support run in chat mode.'
      : target.purpose === 'This session' ? 'Your conversation stays here.' : '';
    if (note) status(note);
    return choices(list.map(([alias, m]) => ({alias, title:m.label || m.model, on:alias === target.alias,
      detail:[m.label && m.label !== m.model ? m.model : '', modelSourceName(m), m.supportsTools === false ? 'chat only' : '', alias === target.alias ? 'current' : ''].filter(Boolean).join(' · ')})), item => {
      const levels = models[item.alias].effortCapability?.levels;
      if (levels?.length) return modelWizard(target, {...choice, models, alias:item.alias});
      // No effort step: keep a saved override only when the model is unchanged and its levels are unknown.
      next(item.alias, item.alias === target.alias && levels == null ? target.effort || '' : '');
    });
  }

  if (step === 3) {
    status('How much Claude may do without asking. Prompts can also switch this.');
    return choices(CLAUDE_ACCESS.map(a => ({...a, on:a.mode === target.permission, detail:a.detail + (a.mode === target.permission ? ' · current' : '')})),
      item => apply(choice.alias, choice.effort, item.mode));
  }
  const cap = model.effortCapability;
  const kept = choice.alias === target.alias ? target.effort || '' : null;
  status('Higher effort thinks longer before answering.');
  choices(['', ...cap.levels].map(level => ({level, title:level || 'Default', on:level === kept,
    detail:[level ? '' : cap.configured ? `${cap.configured} configured` : cap.default || 'provider chooses', level === kept ? 'current' : ''].filter(Boolean).join(' · ')})),
    item => next(choice.alias, item.level));
}

async function sessionSettingsSheet() {
  try { await refreshState(); } catch (e) { if (executionNode) return machinesSheet(); throw e; }
  const session = cur().session;
  if (!session) {
    openSheet(`<h2>Session</h2><p class="dim">No session open.</p><div class="actions"><button class="primary" id="s-close">done</button></div>`);
    $('s-close').onclick = closeSheet;
    return;
  }
  const model = state.models[session.model];
  const chatOnly = model?.supportsTools === false;
  const owner = state.machines?.hosts?.find(h => h.id === session.ownerNode);
  const app = state.apps?.find(a => a.id === session.appId);
  const others = (state.machines?.hosts || []).filter(h => h.id !== session.ownerNode && app?.executionHosts?.includes(h.id));
  const stuck = session.tabWorkspace ? 'This tab has Git work on its computer, so it stays there. Start a new tab on another computer to work there.'
    : session.turnHost ? 'Wait for the current turn to finish before moving this tab.' : '';
  openSheet(`<h2>Session</h2>
    <label>Name</label>
    <div class="row"><input id="s-name" value="${esc(session.name ?? '')}" spellcheck="false" />
    <button class="ghost" id="s-rename" style="flex:0 0 80px">rename</button></div>

    <label>Computer</label>
    <p>Runs on <b>${esc(owner?.name || session.ownerNode || 'this computer')}</b>${owner && !owner.active ? ' · offline' : ''}</p>
    ${others.length ? `<div id="s-computers">${others.map(h => `
      <button class="rowlink" data-tab-computer="${esc(h.id)}" ${stuck || !h.active ? 'disabled' : ''}><span>${h.number} · ${esc(h.name)}</span><span class="dim">${h.active ? 'move here' : 'offline'}</span></button>`).join('')}</div>
      <p class="dim">${esc(stuck || 'Moving uses that computer’s models and files; the conversation comes along.')}</p>`
      : '<p class="dim">Only this computer is enabled for this project. Add computers in the project’s Machines settings.</p>'}

    <label>Model</label>
    <div class="rowlinks"><button class="rowlink" id="s-choose-model"><span class="choice-text"><span>${esc(modelChoiceLabel(model, session.effort || model?.effortCapability?.configured))}</span><small>${esc(model ? modelSourceName(model) : session.model + ' · not on this computer')}</small></span><span class="chev">›</span></button></div>
    <div class="row mode-row">
      <button class="ghost${session.mode !== 'chat' ? ' on' : ''}" data-mode="agent"${chatOnly ? ' disabled' : ''}>agent</button>
      <button class="ghost${session.mode === 'chat' ? ' on' : ''}" data-mode="chat">chat</button>
    </div>
    <p class="dim">${chatOnly ? 'This local model has no tool support, so it can only chat.' : 'Agent works in the project with tools. Chat sends no tools or project rules — lighter, for plain questions.'}</p>
    ${model?.provider === 'claude-cli' ? `<label>Claude access</label><select id="s-permission">${CLAUDE_ACCESS.map(a => `<option value="${a.mode}"${(session.claudePermission || model.permissionMode || 'default') === a.mode ? ' selected' : ''}>${esc(a.title)} — ${esc(a.detail)}</option>`).join('')}</select><p class="dim">Prompts in the chat also offer Always allow and Allow everything.</p>` : ''}
    ${model?.softLimitTokens ? (() => {
      const on = Boolean(session.allowLongContext);
      return `<label>Context band</label>
        <div class="row">
          <button class="ghost${on ? '' : ' on'}" data-band="off">stay under ${compact(model.softLimitTokens)}</button>
          <button class="ghost${on ? ' on' : ''}" data-band="on">allow up to ${compact(model.contextTokens)}</button>
        </div>
        <p class="dim">${esc(model.label ?? model.alias)} reprices the whole request past
          ${compact(model.softLimitTokens)} input tokens — roughly double. Staying under trims old tool
          output to fit; allowing it keeps everything and pays the higher rate.</p>`;
    })() : ''}

    <details class="github-details"><summary>Folders and details</summary>
      <label>Project folder${session.projectDirMissing ? ' — missing!' : ''}</label>
      <div class="row"><input id="s-dir" value="${esc(session.projectDir)}" spellcheck="false" />
      <button class="ghost" id="s-browse" style="flex:0 0 92px">browse</button></div>
      <div class="actions"><button class="ghost" id="s-dir-save">save folder</button></div>
      <label>Reference folders (read-only)</label>
      <textarea id="s-readable" spellcheck="false"
        placeholder="/Users/you/Projects/otherProject">${esc((session.readableDirs ?? []).join('\n'))}</textarea>
      <p class="dim">Let the agent’s file tools read reference material outside this project without granting write access. Enter one folder per line; leave empty if unneeded.</p>
      <div class="actions"><button class="ghost" id="s-readable-save">save folders</button></div>
      <p class="dim">${model?.provider === 'claude-cli' ? 'Claude Code SDK: native tools, interactive questions and permissions, and native history on this host.' : model?.provider === 'codex-cli' ? 'Codex exec: native tools, transcript replay each turn. Native interactive approvals are not yet supported by this adapter; check its sandbox configuration before running host actions.' : 'API model: DO tools and transcript. Native Claude Code / Codex extensions are not available through this API adapter.'}</p>
      <p class="dim">Turn steps: no DO cutoff. Output limit: ${esc(String(model?.maxTokens || (model?.provider === 'anthropic' ? '32,000 tokens per response' : 'provider default')))}.${model?.maxTurns ? ` Native turn limit configured: ${esc(String(model.maxTurns))}.` : ''}</p>
    </details>

    <div class="actions"><button class="ghost" id="session-git">Git &amp; GitHub</button><button class="primary" id="s-close">done</button></div>`);
  const replace = updated => { if (cur().session?.id === session.id) { cur().session = updated; if (state.tab === 'chat') state.session = updated; } };
  $('sheet').querySelectorAll('[data-tab-computer]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const updated = await api(`/api/sessions/${session.id}/machine`, { method: 'POST', body: JSON.stringify({ ownerNode: button.dataset.tabComputer }) });
        replace(updated);
        await openSession(updated.id);
        await sessionSettingsSheet();
      } catch (e) { showBanner(e.message); button.disabled = false; }
    };
  });
  $('s-choose-model').onclick = () => modelWizard(sessionModelTarget(session, sessionSettingsSheet));
  $('session-git').onclick = gitSheet;
  $('s-close').onclick = closeSheet;
  if ($('s-permission')) $('s-permission').onchange = async () => {
    try {
      replace(await api(`/api/sessions/${session.id}`, {method:'PATCH', body:JSON.stringify({claudePermission:$('s-permission').value})}));
      window.harnessTrace?.('visible', {screen:'session-settings', outcome:'permission-saved'});
      showBanner(`Claude access: ${accessTitle($('s-permission').value)} from the next turn.`);
    } catch (e) { showBanner(e.message, true); sessionSettingsSheet(); }
  };
  const rename = async () => {
    const name = $('s-name').value.trim();
    if (!name || name === session.name) return;
    replace(await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
    paintHeader();
    await refreshState();          // the ☰ list shows the old name otherwise
    showBanner(`renamed to "${name}"`);
  };
  $('s-rename').onclick = rename;
  // Enter should work too; a phone keyboard offers "done", not a button.
  $('s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
  $('s-readable-save').onclick = async () => {
    const dirs = $('s-readable').value.split('\n').map((x) => x.trim()).filter(Boolean);
    replace(await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ readableDirs: dirs }) }));
    showBanner(dirs.length ? `${dirs.length} folder(s) readable` : 'no extra folders');
    sessionSettingsSheet();
  };
  $('sheet').querySelectorAll('[data-band]').forEach((el) => {
    el.onclick = async () => {
      try {
        replace(await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ allowLongContext: el.dataset.band === 'on' }) }));
        sessionSettingsSheet();
      } catch (e) { showBanner(`couldn't change that: ${e.message}`, true); }
    };
  });
  $('sheet').querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = async () => {
      // Always send it — never trust local state to decide "already there", or a
      // stale copy could block the very switch the user is trying to make.
      el.textContent = '…';
      try {
        replace(await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ mode: el.dataset.mode }) }));
        paintHeader();
        sessionSettingsSheet();
      } catch (e) {
        showBanner(`couldn't switch mode: ${e.message} — tap again`, true);
        sessionSettingsSheet();   // restore the buttons to their true state
      }
    };
  });
  $('s-browse').onclick = () => browseSheet($('s-dir').value, async (chosen) => {
    await setProjectDir(chosen);
    sessionSettingsSheet();
  }, sessionSettingsSheet);
  $('s-dir-save').onclick = () => setProjectDir($('s-dir').value.trim()).then(sessionSettingsSheet);
}

/**
 * Distributed Orchestrator-wide settings, one sheet each.
 *
 * These used to sit inline below the session settings, which made one very
 * long scroll — and put a second full list of model cards under the first,
 * which was mistaken for the switcher more than once. Each now has its own
 * sheet with a way back, so the main settings stay one screen.
 */
const backToSettings = '<div class="actions"><button class="ghost" id="sub-back">‹ settings</button></div>';

async function networkSheet() {
  openSheet(`<h2>Phone access</h2>
    <p class="dim">Install Tailscale on this host and your phone, then sign into the same network. The host must stay awake and running.</p>
    <p><a href="https://tailscale.com/download" target="_blank" rel="noopener">Get Tailscale</a></p>
    <p class="dim">Use the installed Tailscale app.</p>
    <div id="network-status" role="status">Checking connection…</div>
    <div class="actions"><button class="ghost" id="network-check">check again</button><button class="primary" id="network-setup" disabled>set up phone access</button></div>
    <p class="dim">Setup publishes private HTTPS within your Tailscale network. Other Orchestrator hosts in Machines use the same address. Existing routes are preserved. If this server requires an access token, open its new address with that token on your phone.</p>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  const box = $('network-status');
  const setup = $('network-setup');
  const check = $('network-check');
  const refresh = async (configure = false) => {
    setup.disabled = check.disabled = true;
    box.textContent = configure ? 'Setting up private HTTPS…' : 'Checking connection…';
    try {
      const n = await api(configure ? '/api/network/setup' : '/api/network', configure ? { method: 'POST', body: '{}' } : {});
      if ($('network-status') !== box) return;
      box.replaceChildren();
      const message = document.createElement('p'); message.textContent = n.message; box.append(message);
      for (const [label, url] of [['This host', n.localUrl], ['Phone / away from home', n.phoneUrl], ['Approve HTTPS in Tailscale', n.approvalUrl]]) {
        if (!url) continue;
        const row = document.createElement('p'); row.style.overflowWrap = 'anywhere';
        row.append(document.createTextNode(label + ': '));
        const link = document.createElement('a'); link.href = url; link.textContent = url; link.target = '_blank'; link.rel = 'noopener'; row.append(link); box.append(row);
      }
      setup.disabled = !n.connected || n.ready;
    } catch (e) { box.textContent = e.message; }
    finally { check.disabled = false; }
  };
  check.onclick = () => refresh();
  setup.onclick = () => refresh(true);
  await refresh();
}

// Errors may carry a Tailscale approval link; make it tappable without innerHTML.
function showLinked(box, text) {
  box.replaceChildren();
  for (const part of text.split(/(https:\/\/[^\s]+)/)) {
    if (!part.startsWith('https://')) { box.append(document.createTextNode(part)); continue; }
    const link = document.createElement('a'); link.href = part; link.textContent = part; link.target = '_blank'; link.rel = 'noopener';
    link.style.overflowWrap = 'anywhere'; box.append(link);
  }
}

function machineAddressLink(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '<div class="s">Address unavailable</div>';
    const address = esc(url.origin).replace(/"/g, '&quot;');
    return `<a class="machine-address" href="${safeHref(url.origin)}" target="_blank" rel="noopener noreferrer">${address}</a>`;
  } catch { return '<div class="s">Address not configured</div>'; }
}

async function machinesSheet() {
  openSheet(`<h2>Machines</h2>
    <div id="cluster-summary" role="status">Checking machines…</div>
    <h3>Orchestrator hosts</h3><p class="dim">Preferred main is used at the next election; it does not interrupt a healthy main.</p><div id="machine-list"></div>
    <h3>Tailscale viewers</h3><div id="viewer-list"></div>
    <h3>Tailscale devices</h3><p class="dim">Network presence is separate from running this app. Only current Tailscale devices are listed; joining requires your approval.</p>
    <div id="tailnet-list">Checking Tailscale…</div>
    <h3>Add another host</h3>
    <ol class="dim join-steps">
      <li>On the <b>new</b> computer, tap <b>request to join</b> next to your existing main below. It sets up this computer’s private Tailscale HTTPS address automatically if needed.</li>
      <li>On the <b>existing main</b>, open Machines, tap <b>refresh</b>, then <b>Approve host</b>.</li>
    </ol>
    <p class="dim">Approved hosts receive shared sessions, project files, and API credentials; subscription logins stay on each computer.</p>
    <div id="discovered-hosts">Looking for Orchestrator hosts…</div>
    <p id="pairing-status" class="dim" role="status"></p>
    <div id="cluster-join">
      <label>Main host’s HTTPS address (if not listed)</label><input id="cluster-url" type="url" placeholder="https://laptop.your-tailnet.ts.net" />
      <div class="actions"><button class="ghost" id="cluster-connect">request to join</button><button class="ghost" id="cluster-cancel">cancel request</button></div>
    </div>
    <p id="machine-error" class="dim" role="status"></p>
    <div class="actions"><button class="ghost" id="machines-refresh">refresh</button></div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  $('machines-refresh').onclick = machinesSheet;
  const list = $('machine-list');
  const call = async (route, body) => {
    const response = await nativeFetch('/api/cluster/' + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  };
  const seen = (at) => at ? new Date(at).toLocaleString() : 'not yet observed';
  try {
    const data = await call('status');
    if ($('machine-list') !== list) return;
    $('cluster-summary').textContent = `${data.hosts.filter((n) => n.member).length} hosts · ${data.viewers.filter((v) => v.active).length} connected viewers · ${data.mode}`;
    if (data.mode === 'two-host availability') $('cluster-summary').append(document.createTextNode('. Both hosts may become main during a network split; divergent history is preserved for recovery.'));
    list.innerHTML = data.hosts.map((n) => `<div class="item machine-item"><div class="grow"><div class="t"><span class="computer-badge">🖥 ${n.number}</span> ${esc(n.name)}</div>
      <div class="s">${n.active ? 'active' : 'offline'} · ${n.id === data.leader ? 'main' : 'replica'}${n.id === data.preferred ? ' · preferred main' : ''}</div>
      <div class="s">${esc(n.platform === 'darwin' ? 'Mac' : n.platform === 'win32' ? 'Windows PC' : n.platform === 'linux' ? 'Linux PC' : n.platform || 'Computer')}</div>
      ${machineAddressLink(n.url)}
      <div class="s">Last contact: ${esc(seen(n.lastSeen))}</div></div>
      ${n.member ? `<button class="ghost" data-machine-name="${esc(n.id)}">rename</button>` : ''}
      ${n.member && n.id !== data.preferred ? `<button class="ghost" data-prefer="${esc(n.id)}">prefer main</button>` : ''}</div>`).join('');
    list.querySelectorAll('[data-prefer]').forEach((button) => { button.onclick = async () => {
      try { await call('preferred', { id: button.dataset.prefer }); await machinesSheet(); }
      catch (e) { if ($('machine-error')) $('machine-error').textContent = e.message; }
    }; });
    list.querySelectorAll('[data-machine-name]').forEach((button) => { button.onclick = async () => {
      const host = data.hosts.find((n) => n.id === button.dataset.machineName);
      openSheet(`<h2>Rename computer ${host.number}</h2><label>Name</label><input id="machine-name-input" maxlength="100" /><div class="actions"><button class="ghost" id="machine-name-cancel">cancel</button><button class="primary" id="machine-name-save">save</button></div>`);
      $('machine-name-input').value = host.name;
      $('machine-name-cancel').onclick = machinesSheet;
      $('machine-name-save').onclick = async () => {
        try {
          await call('name', { id: host.id, name: $('machine-name-input').value });
          await refreshState();
          paintHeader();
          await machinesSheet();
        } catch (e) { showBanner(e.message); }
      };
    }; });
    $('viewer-list').innerHTML = data.viewers.filter(v => v.active).map((v) => `<div class="item machine-item"><div class="grow"><div class="t">${esc(v.name)}</div><div class="s">Connected via Tailscale</div></div></div>`).join('') || '<p class="dim">No Tailscale viewers connected.</p>';
    $('cluster-join').hidden = data.hosts.filter((n) => n.member).length > 1;
    for (const issue of data.placementIssues || []) {
      const message = document.createElement('p');
      message.textContent = `${issue.project} on ${issue.host}: ${issue.error}`;
      $('cluster-summary').append(message);
    }
    if (data.conflicts) $('cluster-summary').append(document.createTextNode(` ${data.conflicts} divergent history branch(es) were preserved in the cluster recovery files.`));
    const action = async (route, body, button) => {
      button.disabled = true;
      try {
        await call(route, body);
        if ($('machine-list') === list) await machinesSheet();
      } catch (e) { if ($('machine-list') === list) showLinked($('machine-error'), e.message); }
      finally { button.disabled = false; }
    };
    $('cluster-connect').onclick = () => action('request-join', { url: $('cluster-url').value.trim() }, $('cluster-connect'));
    $('cluster-cancel').onclick = () => action('cancel-join', {}, $('cluster-cancel'));
    // Discovery can take a few seconds; the existing hosts stay usable meanwhile.
    call('discover').then(found => {
      if ($('machine-list') !== list) return;
      $('pairing-status').textContent = found.local.message || found.error;
      $('cluster-cancel').hidden = !found.local.pending;
      $('cluster-connect').disabled = found.local.joining;
      const peers = found.hosts.filter(n => !data.hosts.some(h => h.member && h.id === n.node));
      $('discovered-hosts').innerHTML = peers.map(n => {
        const approval = n.pending?.target === data.self && data.self === data.leader;
        const canRequest = data.mode === 'standalone' && n.main && !found.local.joining;
        return `<div class="item machine-item"><div class="grow"><div class="t">${esc(n.device || n.name)}</div><div class="s">${esc(n.url)}</div><div class="s">${n.joining ? 'joining' : approval ? 'requests access to this system' : 'Orchestrator detected'}</div></div>
          ${approval ? `<button class="primary" data-pair-approve="${esc(n.url)}">Approve host</button>` : canRequest ? `<button class="ghost" data-pair-request="${esc(n.url)}">request to join</button>` : ''}</div>`;
      }).join('') || '<p class="dim">No other hosts found yet. The main must be running and have Phone access set up (it does if you already use it from your phone). Refresh to check again, or enter its address below.</p>';
      $('discovered-hosts').querySelectorAll('[data-pair-approve]').forEach(button => {
        button.onclick = () => action('approve-host', { url: button.dataset.pairApprove }, button);
      });
      $('discovered-hosts').querySelectorAll('[data-pair-request]').forEach(button => {
        button.onclick = () => action('request-join', { url: button.dataset.pairRequest }, button);
      });
    }).catch(e => { if ($('machine-list') === list) $('pairing-status').textContent = e.message; });
    const inventory = await call('devices');
    if ($('machine-list') !== list) return;
    $('tailnet-list').innerHTML = inventory.devices.map((n) => `<div class="item machine-item"><div class="grow"><div class="t">${esc(n.name)}</div><div class="s">${n.active ? 'online on Tailscale' : 'offline on Tailscale'} · ${esc(n.platform || 'device')}</div></div></div>`).join('') || '<p class="dim">No Tailscale devices available.</p>';
    if (inventory.error) $('tailnet-list').append(document.createTextNode(inventory.error));
  } catch (e) { if ($('machine-list') === list) $('machine-error').textContent = e.message; }
}

const sourceAttr = value => esc(value).replace(/"/g, '&quot;');
let sourceHost = '';
let sourceViewRequest = 0;
const sourcesCall = async (action, args = {}) => {
  const response = await nativeFetch('/api/cluster/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: sourceHost || undefined, action, ...args }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Source request failed.');
  return value;
};

async function modelsSheet() {
  const request = ++sourceViewRequest;
  const loading = () => {
    openSheet('<h2>AI sources</h2><p class="dim">Loading sources for the selected computer…</p>' + backToSettings);
    $('sub-back').onclick = settingsSheet;
  };
  loading();
  try {
    const machines = await nativeFetch('/api/cluster/status').then(r => r.json());
    if (request !== sourceViewRequest) return;
    sourceHost ||= machines.self;
    const host = sourceHost;
    const catalog = await sourcesCall('catalog', { host });
    if (request !== sourceViewRequest || host !== sourceHost) return;
    if (catalog.machine?.id !== host) throw new Error('Source response came from another computer. Refresh to retry.');
    const configured = provider => Object.values(catalog.models).some(m => m.provider === provider);
    const sourceLabel = (provider, name) => (configured(provider) ? 'Manage ' : 'Set up ') + name;

    openSheet(`<h2>AI sources</h2>
      <label>Computer</label><select id="sources-host">${machines.hosts.filter(h => h.member).map(h => `<option value="${sourceAttr(h.id)}" ${h.id === sourceHost ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>
      <p class="dim"><b>${esc(catalog.machine.name)}</b> — sources configured on this computer only. New computers start empty. Connect a source, discover its models, then choose which to add.</p>
      <div class="rowlinks"><button class="rowlink" id="source-default"><span>Default for new sessions</span><span class="dim">${esc(modelChoiceLabel(catalog.models[catalog.default], catalog.defaultEffort))} ›</span></button></div>
      <button class="rowlink" id="source-claude">${sourceLabel('claude-cli', 'Claude Code')} <span>›</span></button>
      <button class="rowlink" id="source-codex">${sourceLabel('codex-cli', 'Codex')} <span>›</span></button>
      <button class="rowlink" id="source-local">${Object.values(catalog.models).some(m => m.sourceKind === 'ollama') ? 'Manage' : 'Set up'} local models · Ollama <span>›</span></button>
      ${Object.values(catalog.models).map(m => `<div class="item machine-item"><div class="grow"><div class="t">${esc(m.label || m.model)}</div><div class="s">${esc(m.provider)} · ${esc(m.model)}</div><div class="s">${esc(modelVersionDetails(m))}</div>${m.sourceKind === 'ollama' ? `<div class="s" data-runtime-model="${sourceAttr(m.alias)}">${esc(m.runtimeStatus)}</div>` : ''}</div>
        ${m.sourceKind === 'ollama' ? `<button class="ghost" data-local-load="${sourceAttr(m.model)}">load</button><button class="ghost" data-local-unload="${sourceAttr(m.model)}">unload</button><button class="ghost" data-helper="${sourceAttr(m.alias)}" data-enabled="${!m.allowDelegate}">helper ${m.allowDelegate ? 'on' : 'off'}</button>` : ''}
        ${sourceHost === machines.self ? `<button class="ghost" data-source-edit="${sourceAttr(m.alias)}">edit</button>` : ''}
        <button class="ghost" data-source-remove="${sourceAttr(m.alias)}">remove</button></div>`).join('') || '<p class="dim">No sources added on this computer.</p>'}
      ${catalog.runtime ? `<p class="dim">Local runtime: ${catalog.runtime.unavailable ? 'stopped or unavailable' : catalog.runtime.models?.length ? catalog.runtime.models.map(m => esc(m.name) + ' · GPU ' + Math.round((m.size_vram || 0) / 1073741824 * 10) / 10 + ' GiB').join(', ') : 'running · no models loaded'}</p>` : ''}
      <p class="dim">Local models load automatically on use. Load prewarms for 10 minutes of inactivity; unload frees memory. Requests may change the idle expiry.</p>
      <p class="dim" id="sources-status">${catalog.jobs.map(j => esc(`${j.action} ${j.model || ''}: ${j.state}${j.error ? ' — ' + j.error : ''}`)).join('<br>')}</p>
      <div class="actions"><button class="ghost" id="sources-refresh">refresh</button><button class="ghost" id="source-add">advanced API source</button></div>${backToSettings}`);
    const statusNode = $('sources-status');
    const refreshRuntime = async () => {
      if ($('sources-status') !== statusNode || sourceHost !== host) return;
      try {
        const next = await sourcesCall('catalog', { host });
        if ($('sources-status') !== statusNode || sourceHost !== host) return;
        $('sheet').querySelectorAll('[data-runtime-model]').forEach(el => {
          el.textContent = next.models[el.dataset.runtimeModel]?.runtimeStatus || 'unknown';
        });
        statusNode.textContent = next.jobs.map(j => `${j.action} ${j.model || ''}: ${j.state}${j.error ? ' - ' + j.error : ''}`).join(' / ');
      } catch { if ($('sources-status') === statusNode) statusNode.textContent = 'Unable to refresh model status'; }
      if ($('sources-status') === statusNode) setTimeout(refreshRuntime, 2000);
    };
    setTimeout(refreshRuntime, 2000);
    $('sources-host').onchange = () => { sourceHost = $('sources-host').value; modelsSheet(); };
    $('sub-back').onclick = settingsSheet;
    $('sources-refresh').onclick = modelsSheet;
    $('source-default').onclick = async () => {
      try { await modelWizard(await defaultModelTarget(host, modelsSheet)); } catch (e) { showBanner(e.message, true); }
    };
    $('source-claude').onclick = () => onboardSource('claude-cli');
    $('source-codex').onclick = () => onboardSource('codex-cli');
    $('source-local').onclick = () => onboardSource('ollama');
    $('source-add').onclick = () => {
      if (sourceHost !== machines.self) return showBanner('Open Harness on the selected computer to add an advanced API endpoint.');
      sourceSheet();
    };
    const perform = async (action, args) => {
      try { await sourcesCall(action, args); await modelsSheet(); } catch (e) { showBanner(e.message); }
    };
    $('sheet').querySelectorAll('[data-source-edit]').forEach(b => { b.onclick = () => modelSheet(b.dataset.sourceEdit, catalog.models[b.dataset.sourceEdit]); });
    $('sheet').querySelectorAll('[data-source-remove]').forEach(b => { b.onclick = () => {
      if (confirm('Remove this source from this computer? Existing sessions will need another model.')) perform('remove', { alias: b.dataset.sourceRemove });
    }; });
    $('sheet').querySelectorAll('[data-helper]').forEach(b => { b.onclick = () => perform('helper-setting', { alias: b.dataset.helper, enabled: b.dataset.enabled === 'true' }); });
    for (const operation of ['load', 'unload']) $('sheet').querySelectorAll('[data-local-' + operation + ']').forEach(b => {
      b.onclick = () => perform('local', { operation, model: b.dataset[operation === 'load' ? 'localLoad' : 'localUnload'] });
    });
  } catch (e) {
    if (request !== sourceViewRequest) return;
    openSheet('<h2>AI sources</h2><p class="dim">' + esc(e.message) + '</p><button class="ghost" id="sources-refresh">retry</button>' + backToSettings);
    $('sources-refresh').onclick = modelsSheet;
    $('sub-back').onclick = settingsSheet;
  }
}

function onboardSource(kind) {
  const local = kind === 'ollama';
  const name = local ? 'Local models · Ollama' : kind === 'claude-cli' ? 'Claude Code' : 'Codex';
  const install = local ? 'https://ollama.com/download' : kind === 'claude-cli' ? 'https://code.claude.com/docs/en/setup' : 'https://developers.openai.com/codex/cli/';
  openSheet(`<h2>${name}</h2><p class="dim">Check the source on this computer to load its available models. If login expired, reconnect below and check again.</p>
    <a class="rowlink" href="${install}" target="_blank" rel="noopener">Installation instructions <span>↗</span></a>
    ${local ? '<p class="dim">Ollama uses the GPU when supported. Model fit depends on weights and context size. Downloads can be large.</p><label>Ollama model name to download</label><input id="local-model-name" placeholder="Exact model:tag" /><div class="actions"><button class="ghost" id="local-start">start Ollama</button><button class="ghost" id="local-pull">download model</button></div>' : `<p class="dim">In a terminal on that computer, run <code>${kind === 'claude-cli' ? 'claude auth login' : 'codex login'}</code>. Your login stays in the CLI.</p>`}
    <div class="actions"><button class="primary" id="source-discover">check login &amp; discover models</button></div>
    <div id="source-discovered"></div>
    ${local ? '<label><input type="checkbox" id="source-delegate" /> Allow paired agents to use these models as text helpers</label>' : ''}
    <p class="dim" id="onboard-status" role="status"></p>
    <div class="actions"><button class="ghost" id="onboard-back">back</button><button class="primary" id="onboard-add" disabled>use selected models</button></div>`);
  $('onboard-back').onclick = modelsSheet;
  const status = $('onboard-status');
  if (local) for (const operation of ['start', 'pull']) $('local-' + operation).onclick = async () => {
    try {
      const job = await sourcesCall('local', { operation, model: $('local-model-name').value.trim() || undefined });
      status.textContent = `${job.action} started. Return to AI sources and refresh to check completion.`;
    } catch (e) { status.textContent = e.message; }
  };
  $('source-discover').onclick = async () => {
    const button = $('source-discover'); button.disabled = true; status.textContent = 'Checking source…';
    try {
      const result = await sourcesCall('discover', { kind });
      if ($('onboard-status') !== status) return;
      $('source-discovered').innerHTML = result.models.map(m => `<label class="item"><input type="checkbox" checked data-discovered-model="${sourceAttr(m.model)}" /><span>${esc(m.label)}${m.tools === false ? ' · chat only' : ''}</span></label>`).join('');
      status.textContent = result.message;
      $('onboard-add').disabled = !result.models.length;
    } catch (e) { status.textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('onboard-add').onclick = async () => {
    const button = $('onboard-add'); button.disabled = true;
    try {
      const models = [...$('sheet').querySelectorAll('[data-discovered-model]:checked')].map(e => e.dataset.discoveredModel);
      await sourcesCall('add', { kind, models, allowDelegate: local && $('source-delegate').checked });
      await modelsSheet();
    } catch (e) { status.textContent = e.message; button.disabled = false; }
  };
}

function sourceSheet() {
  const choices = [
    ['Claude subscription (Claude Code)', 'claude-cli', '', ''],
    ['OpenAI subscription (Codex)', 'codex-cli', '', ''],
    ['OpenAI API', 'openai-responses', 'https://api.openai.com/v1', 'OPENAI_API_KEY'],
    ['Anthropic API', 'anthropic', '', 'ANTHROPIC_API_KEY'],
    ['Kimi / Moonshot API', 'openai', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY'],
    ['Grok / xAI API', 'openai', 'https://api.x.ai/v1', 'XAI_API_KEY'],
    ['Custom / local OpenAI-compatible API', 'openai', '', 'HARNESS_CUSTOM_API_KEY'],
  ];
  openSheet(`<h2>Add AI source</h2>
    <label>Connection</label><select id="source-kind">${choices.map((c, i) => `<option value="${i}">${c[0]}</option>`).join('')}</select>
    <p class="dim" id="source-help"></p>
    <label>Name in Distributed Orchestrator</label><input id="source-name" />
    <label>Model ID</label><input id="source-model" spellcheck="false" placeholder="Exact model ID from your provider" />
    <div id="source-api">
      <label>API endpoint</label><input id="source-url" type="url" spellcheck="false" placeholder="https://your-provider.example/v1" />
      <div id="source-auth"><label>Endpoint authentication</label><select id="source-auth-mode"><option value="key">API key</option><option value="none">No key (my private model server)</option></select></div>
      <label>API key</label><input id="source-key" type="password" autocomplete="off" />
      <p class="dim">API billing is separate from chat subscriptions. Local servers may not need a key. Keys are saved on the Distributed Orchestrator server.</p>
    </div>
    <p class="dim" id="source-error" role="status"></p>
    <div class="actions"><button class="ghost" id="source-back">back</button><button class="primary" id="source-save">add source</button></div>`);
  const change = () => {
    const [label, provider, base] = choices[$('source-kind').value];
    const subscription = provider.endsWith('-cli');
    $('source-name').value = label;
    $('source-url').value = base;
    $('source-api').hidden = subscription;
    $('source-auth').hidden = $('source-kind').value !== '6';
    $('source-help').textContent = subscription
      ? `Install ${provider === 'claude-cli' ? 'Claude Code and run claude' : 'Codex and run codex login'} on the computer hosting Distributed Orchestrator, then sign in with your own account. Distributed Orchestrator uses that computer’s CLI login. Adding this entry does not verify the login.`
      : 'Enter the model ID available in your provider account. Custom endpoints must support OpenAI chat completions; agent sessions also require tool calling.';
  };
  $('source-kind').onchange = change;
  change();
  $('source-back').onclick = modelsSheet;
  $('source-save').onclick = async () => {
    const [, provider, , apiKeyEnv] = choices[$('source-kind').value];
    $('source-save').disabled = true;
    try {
      await api('/api/models/add', { method: 'POST', body: JSON.stringify({
        apiKeyOptional: $('source-kind').value === '6' && $('source-auth-mode').value === 'none',
        label: $('source-name').value, model: $('source-model').value, provider, apiKeyEnv,
        baseUrl: provider.endsWith('-cli') ? '' : $('source-url').value.trim(),
        apiKey: provider.endsWith('-cli') ? '' : $('source-key').value.trim(),
      }) });
      await modelsSheet();
      showBanner('Source added. Select its model in session settings to use it.');
    } catch (e) {
      if ($('source-error')) $('source-error').textContent = e.message;
    } finally {
      if ($('source-save')) $('source-save').disabled = false;
    }
  };
}

function notifySheet() {
  openSheet(`<h2>Notifications</h2>
    <p class="dim">Choose which ways the harness can reach you. Email and Text can each be enabled independently.</p>
    <div class="rowlinks">
      <button class="rowlink" id="h-email"><span>Email</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-text"><span>Text</span><span class="chev">›</span></button>
    </div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  $('h-email').onclick = emailSheet;
  $('h-text').onclick = textSheet;
}

const backToNotifications = '<div class="actions"><button class="ghost" id="sub-back">‹ notifications</button></div>';

function textSheet() {
  openSheet(`<h2>Text</h2>
    <p class="dim">When a turn finishes, and when one stalls.</p>
    <div id="s-notify"><p class="dim">loading…</p></div>
    <p id="notify-status" class="dim" role="status" aria-live="polite"></p>${backToNotifications}`);
  $('sub-back').onclick = notifySheet;
  paintNotify();
}

function emailSheet() {
  openSheet(`<h2>Email</h2>
    <p class="dim">Receive email when a turn stalls or a session sends you an update.</p>
    <div id="s-email"><p class="dim">loading…</p></div>${backToNotifications}`);
  $('sub-back').onclick = notifySheet;
  paintEmail();
}

/** Outbound email — one harness-wide setting, used by every session's send_email tool. */
async function paintEmail() {
  const box = $('s-email');
  if (!box) return;
  let e;
  try { e = await api('/api/email'); } catch (err) { box.innerHTML = `<p class="dim">${esc(err.message)}</p>`; return; }

  box.innerHTML = `
    <label>Email notifications</label>
    <div class="row">
      <button class="ghost${e.enabled ? '' : ' on'}" data-email="off" aria-pressed="${!e.enabled}">off</button>
      <button class="ghost${e.enabled ? ' on' : ''}" data-email="on" aria-pressed="${Boolean(e.enabled)}">on</button>
    </div>
    <label>Send to</label>
    <input id="em-to" value="${esc(e.to ?? '')}" placeholder="you@example.com" inputmode="email" spellcheck="false" />
    <label>Resend API key ${e.hasKey ? '<span class="pill ready">saved</span>' : '<span class="pill missing">none</span>'}</label>
    <input id="em-key" value="" placeholder="${e.hasKey ? 'saved — type to replace' : 're_...'}" spellcheck="false" />
    <div class="actions">
      <button class="ghost" id="em-save">save</button>
      <button class="ghost" id="em-test"${e.enabled && e.hasKey && e.to ? '' : ' disabled'}>send test</button>
    </div>
    <p class="dim" id="em-msg"></p>`;

  box.querySelectorAll('[data-email]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api('/api/email', { method: 'POST', body: JSON.stringify({ enabled: el.dataset.email === 'on' }) });
        await paintEmail();
      } catch (err) { $('em-msg').textContent = err.message; }
    };
  });
  $('em-save').onclick = async () => {
    const body = { to: $('em-to').value.trim() };
    // An empty box means "leave it alone", not "erase the key".
    const key = $('em-key').value.trim();
    if (key) body.apiKey = key;
    $('em-msg').textContent = 'saving…';
    try { await api('/api/email', { method: 'POST', body: JSON.stringify(body) }); paintEmail(); }
    catch (err) { $('em-msg').textContent = err.message; }
  };
  $('em-test').onclick = async () => {
    $('em-msg').textContent = 'sending…';
    try {
      const r = await api('/api/email/test', { method: 'POST' });
      $('em-msg').textContent = `sent to ${r.to}`;
    } catch (err) { $('em-msg').textContent = err.message; }
  };
}

/** Notification settings — global, not per session. */
async function paintNotify() {
  const box = $('s-notify');
  if (!box) return;
  const status = $('notify-status');
  const feedback = (message) => { if (status) status.textContent = message; };
  let n;
  try { n = await api('/api/notify'); } catch (e) { box.innerHTML = `<p class="dim">${esc(e.message)}</p>`; return; }

  const kinds = [
    ['sms', 'text (SMS)'],
    ['webhook', 'push (ntfy)'],
    ['messages', 'iMessage'],
    ['command', 'shell command'],
  ];
  box.innerHTML = `
    ${n.kind === 'sms' && (!n.gmailUser || !n.hasGmailPass) ? '<p class="dim">SMS setup is incomplete. Add a Gmail address and app password below, or turn notifications off.</p>' : ''}
    <div class="row">
      <button class="ghost${n.enabled ? '' : ' on'}" data-notify="off">off</button>
      <button class="ghost${n.enabled ? ' on' : ''}" data-notify="on">on</button>
    </div>
    <div class="row" style="margin-top:8px">
      ${kinds.map(([k, label]) =>
    `<button class="ghost${n.kind === k ? ' on' : ''}" data-nkind="${k}">${label}</button>`).join('')}
    </div>
    ${n.kind === 'sms'
      ? `<label>Phone number</label>
         <input id="n-to" value="${esc(n.to ?? '')}" placeholder="8045551234" inputmode="tel" />
         <label>Gmail address it sends from</label>
         <input id="n-guser" value="${esc(n.gmailUser ?? '')}" placeholder="you@gmail.com" inputmode="email" spellcheck="false" />
         <label>Gmail app password ${n.hasGmailPass ? '<span class="pill ready">saved</span>' : '<span class="pill missing">none</span>'}</label>
         <input id="n-gpass" type="password" autocomplete="new-password" value="" placeholder="${n.hasGmailPass ? 'saved — type to replace' : 'abcd efgh ijkl mnop'}" spellcheck="false" />
         <p class="dim">Not your Google password — make one at myaccount.google.com → Security → App passwords. It only works if 2-step verification is on.</p>
         <label>Carrier</label>
         <select id="n-carrier">
           <option value="">try every carrier (first test)</option>
           ${['verizon', 'att', 'tmobile', 'googlefi', 'sprint', 'uscellular', 'cricket', 'boost', 'mint', 'visible']
    .map((c) => `<option value="${c}"${n.carrier === c ? ' selected' : ''}>${c}</option>`).join('')}
         </select>
         <p class="dim">This sends mail to your carrier's SMS gateway, so it arrives as a normal text. Nothing on the Mac is involved — it works with the lid shut.</p>`
      : n.kind === 'messages'
        ? `<label>Phone number</label><input id="n-to" value="${esc(n.to ?? '')}" placeholder="+18045551234" inputmode="tel" />
           <p class="dim">Sends through the Messages app, which needs the Mac's screen awake — it cannot work with the lid shut.</p>`
      : n.kind === 'webhook'
        ? `<label>Webhook URL</label><input id="n-url" value="${esc(n.url ?? '')}" placeholder="https://ntfy.sh/your-topic" spellcheck="false" inputmode="url" />`
        : `<label>Command (<span class="mono">{{message}}</span> is substituted)</label>
           <input id="n-cmd" value="${esc(n.command ?? '')}" spellcheck="false" />`}
    <label>Only for turns longer than</label>
    <div class="row">
      ${[0, 60, 300].map((sec) =>
    `<button class="ghost${(n.minSeconds ?? 60) === sec ? ' on' : ''}" data-nmin="${sec}">${sec === 0 ? 'always' : `${sec / 60} min`}</button>`).join('')}
    </div>
    <div class="actions">
      <button class="ghost" id="n-save">save</button>
      <button class="ghost" id="n-test">send a test</button>
    </div>`;

  const patch = async (body) => { await api('/api/notify', { method: 'POST', body: JSON.stringify(body) }); await paintNotify(); };
  box.querySelectorAll('[data-notify]').forEach((el) => {
    el.onclick = async () => {
      const enabled = el.dataset.notify === 'on';
      const body = enabled ? { ...fields(), enabled } : { enabled };
      el.disabled = true;
      feedback(enabled ? 'Saving and enabling…' : 'Turning off…');
      try {
        if (enabled) await saveGmail();
        await patch(body);
        feedback(enabled ? 'Text notifications enabled.' : 'Text notifications off.');
      } catch (e) {
        feedback(`Could not ${enabled ? 'enable' : 'disable'}: ${e.message}`);
      } finally {
        el.disabled = false;
      }
    };
  });
  box.querySelectorAll('[data-nkind]').forEach((el) => {
    el.onclick = () => patch({ kind: el.dataset.nkind });
  });
  box.querySelectorAll('[data-nmin]').forEach((el) => {
    el.onclick = () => patch({ minSeconds: Number(el.dataset.nmin) });
  });

  const fields = () => ({
    ...($('n-to') ? { to: $('n-to').value.trim() } : {}),
    ...($('n-url') ? { url: $('n-url').value.trim() } : {}),
    ...($('n-cmd') ? { command: $('n-cmd').value.trim() } : {}),
  });

  // The Gmail credential belongs with the other secrets, not in notify.json,
  // so it is saved through the email settings instead.
  const saveGmail = async () => {
    if (!$('n-guser')) return;
    const body = { gmailUser: $('n-guser').value.trim(), carrier: $('n-carrier').value };
    // An empty box means "leave it alone", never "erase the password".
    const pass = $('n-gpass').value.trim();
    if (pass) body.gmailPass = pass;
    await api('/api/email', { method: 'POST', body: JSON.stringify(body) });
  };
  $('n-save').onclick = async () => {
    feedback('saving…');
    try {
      await saveGmail();
      await patch(fields());
      feedback('Notification settings saved.');
    } catch (e) {
      feedback(`Could not save: ${e.message}`);
    }
  };
  $('n-test').onclick = async () => {
    const btn = $('n-test');
    btn.textContent = 'sending…';
    btn.disabled = true;
    feedback('Sending test…');
    try {
      await saveGmail();
      await api('/api/notify', { method: 'POST', body: JSON.stringify(fields()) });
      const r = await api('/api/notify/test', { method: 'POST', body: JSON.stringify({}) });
      feedback(r.ok ? `sent (${r.via})` : `failed: ${r.reason}`);
    } catch (e) {
      // A thrown request used to leave the button reading "sending…" for good,
      // which is indistinguishable from the thing still being in flight.
      feedback(`test failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      paintNotify();
    }
  };
}

/**
 * Git panel for a session. Shows the repo as it really is, rather than assuming
 * — a missing remote is the usual reason a push silently does nothing.
 */
function gitSheet() {
  const session = cur().session;
  openSheet('<h2>Push changes</h2><div id="s-git"></div>');
  if (session) { paintGit(session); return; }
  $('s-git').innerHTML = '<p class="dim">Open a session to push changes.</p><div class="actions"><button class="primary" id="g-close">done</button></div>';
  $('g-close').onclick = closeSheet;
}

async function paintGit(session) {
  const box = $('s-git');
  if (!box) return;
  const footer = (push = '') => `<div class="actions push-footer"><button class="ghost" id="sub-back">‹ edit session</button><button class="ghost" id="g-close">close</button>${push}</div>`;
  const paint = html => {
    box.innerHTML = html;
    if ($('sub-back')) $('sub-back').onclick = sessionSettingsSheet;
    if ($('g-close')) $('g-close').onclick = closeSheet;
  };
  paint(`<p class="dim">Checking changes…</p>${footer()}`);
  let g;
  try {
    g = await readPushStatus(session.id, true);
    if (!g || $('s-git') !== box || state.session?.id !== session.id) return;
  } catch (e) {
    if ($('s-git') !== box) return;
    paint(`<p class="dim warn-text">${esc(e.message)}</p>${footer()}`);
    window.harnessTrace?.('visible', {screen:'push-sheet',outcome:'unreadable'});
    return;
  }

  const creating = g.repo && !g.remote && g.createRepository;
  const testing = g.testing && g.pending ? testingLine(g.testing) : null;
  const pushing = Boolean(pushStates.get(session.id)?.pushing);
  const [shown, tone, headline] = pushing ? ['pushing', 'busy', 'Pushing…']
    : !g.repo ? ['not-a-repository', 'warn', 'Not a Git repository']
    : g.busy ? ['busy', 'busy', 'Finish the current task before pushing']
    : creating ? ['ready-to-create', 'ready', 'Ready to create on GitHub']
    : !g.remote ? ['no-remote', 'warn', 'No remote to push to']
    : g.pending ? ['ready', 'ready', 'Ready to push']
    : ['up-to-date', '', 'Up to date'];
  const addRemote = label => `<label>${label}</label>
    <div class="row"><input id="g-remote" placeholder="git@github.com:you/repo.git" spellcheck="false" />
    <button class="ghost" id="g-connect" style="flex:0 0 80px">connect</button></div>`;
  const fact = (name, value) => `<div class="push-fact"><span>${name}</span><span>${value}</span></div>`;
  const testable = g.repo && g.testing && g.pending;
  const actions = [
    testable ? '<button class="rowlink" id="g-test">Test these changes</button>' : '',
    g.repo && g.isolated ? '<button class="rowlink" id="g-merge">Merge latest</button>' : '',
    testable ? '<button class="rowlink push-danger" id="g-discard">Discard changes</button>' : '',
  ].join('');
  paint(`<p class="dim push-where">${[g.projectName, session.name, g.machine || 'This computer'].filter(Boolean).map(esc).join(' · ')}</p>
    <div class="push-state ${tone}"><span class="act-dot"></span><div>
      <div class="push-headline">${headline}</div>
      <div>${g.repo ? esc(g.summary || 'No pending changes.') : esc(shortDir(session.projectDir))}</div>
      ${creating ? `<div>Not on GitHub yet · <strong>${esc(g.repositoryName)}</strong></div>` : ''}
      ${testing ? `<div id="g-testing"${testing.problem ? ' class="warn-text"' : ''}>${esc(testing.text)}</div>` : ''}
    </div></div>
    ${!g.repo ? addRemote('Connect a remote (creates the repo)') : g.remote || creating ? '' : addRemote('Add a remote')}
    ${creating ? `<label for="g-create-visibility">Repository visibility</label>
      <select id="g-create-visibility"><option value="private">Private · only invited people</option><option value="public">Public · anyone can see the code</option></select>` : ''}
    ${actions ? `<div class="rowlinks push-rows">${actions}</div>` : ''}
    <div class="rowlinks push-rows">
      ${g.repo ? `<details class="push-more"><summary id="g-repository">Repository<span class="chev">›</span></summary><div class="push-more-body">
        ${fact('Branch', `<span class="mono">${esc(g.branch ?? '?')}</span>`)}
        ${fact('Remote', g.remote ? `<span class="mono">${esc(g.remote)}</span>` : '<span class="warn-text">none</span>')}
        ${fact('Last commit', g.lastCommit ? `<span class="mono">${esc(g.lastCommit)}</span>` : 'none yet')}
        ${fact('Uncommitted', `${g.changed} file${g.changed === 1 ? '' : 's'}`)}
        ${g.remote ? '<div id="g-vis"></div>' : ''}
      </div></details>` : ''}
      <details class="push-more"><summary id="g-history">Recent pushes<span class="chev">›</span></summary><div class="push-more-body">
        ${(g.history || []).map(h => `<div class="push-receipt">
          <div${h.error ? ' class="warn-text"' : ''}>${[h.status, h.version || h.sha].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="push-receipt-when">${clock(h.ts)} · ${esc(h.machine)}</div>
          ${h.error ? `<div class="push-receipt-when">${esc(h.error)}</div>` : ''}
        </div>`).join('') || '<p class="dim">No pushes yet.</p>'}
      </div></details>
    </div>
    <p id="g-push-status" class="dim" role="status"></p>
    ${footer(g.repo ? `<button class="ghost" id="g-now">${pushing ? 'Pushing…' : creating ? 'Create repository &amp; push' : 'Push to GitHub'}</button>` : '')}`);
  window.harnessTrace?.('visible', {screen:'push-sheet',outcome:shown});
  if ($('g-connect')) {
    $('g-connect').onclick = async () => {
      const remote = $('g-remote').value.trim();
      if (!remote) return;
      const r = await api('/api/git/connect', {
        method: 'POST', body: JSON.stringify({ session: session.id, remote }),
      });
      if (!r.ok) showBanner(r.error);
      paintGit(session);
    };
  }
  if ($('g-vis')) {
    api('/api/git/visibility', { method: 'POST', body: JSON.stringify({ session: session.id }) })
      .then((v) => {
        if ($('s-git') !== box || state.session?.id !== session.id) return;
        const visibilityBox = $('g-vis');
        if (!visibilityBox) return;
        if (!v.ok) { visibilityBox.innerHTML = `<p class="dim">${esc(v.reason)}</p>`; return; }
        const pub = v.visibility === 'public';
        visibilityBox.innerHTML = `${fact('Visibility', `<strong class="${pub ? 'warn-text' : ''}">${esc(v.visibility)}</strong>`)}
          <div class="row">
            <button class="ghost${pub ? '' : ' on'}" data-vis="private">private</button>
            <button class="ghost${pub ? ' on' : ''}" data-vis="public">public</button>
          </div>`;
        visibilityBox.querySelectorAll('[data-vis]').forEach((el) => {
          el.onclick = async () => {
            const want = el.dataset.vis;
            if (want === v.visibility) return;
            if (want === 'public'
              && !confirm(`Make ${v.repo} public? Anyone will be able to read it and its full history.`)) return;
            const r = await api('/api/git/visibility', {
              method: 'POST', body: JSON.stringify({ session: session.id, visibility: want }),
            });
            showBanner(r.ok ? `${v.repo} is now ${r.visibility}` : `could not change: ${r.reason}`);
            paintGit(session);
          };
        });
      })
      .catch(() => {});
  }
  if ($('g-test')) $('g-test').onclick = async () => {
    const button = $('g-test');
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      await api(`/api/git/test?session=${encodeURIComponent(session.id)}`, { method: 'POST', body: JSON.stringify({ session: session.id }) });
    } catch (e) { showBanner(e.message, true); }
    if ($('s-git') === box && state.session?.id === session.id) await paintGit(session);
    refreshState().catch(() => {});
  };
  if ($('g-discard')) $('g-discard').onclick = () => discardSheet(session.id, session.name, gitSheet);
  if ($('g-merge')) $('g-merge').onclick = async () => {
    const button = $('g-merge');
    button.disabled = true;
    closeSheet();
    try {
      await api(`/api/git/merge?session=${encodeURIComponent(session.id)}`, {
        method:'POST', body:JSON.stringify({session:session.id}) });
      await refreshState();
    } catch(e) { showBanner(e.message, true); }
    finally { button.disabled = false; }
  };
  if ($('g-now')) {
    // Busy is a snapshot: the task may finish while this sheet stays open.
    // Let the server check it at click time and explain any refusal.
    $('g-now').disabled = pushing;
    $('g-now').classList.toggle('push-pending', Boolean(g.pending));
    if (pushStates.get(session.id)?.pushError) $('g-push-status').textContent = 'Not published: ' + pushStates.get(session.id).pushError;
    $('g-now').onclick = async () => {
      const visibility = $('g-create-visibility')?.value || 'private';
      if (creating && visibility === 'public' && !confirm(`Create ${g.repositoryName} publicly? Anyone can see its code and history.`)) return;
      const button = $('g-now');
      const value = pushStates.get(session.id);
      value.request++;
      value.pushError = '';
      value.pushing = true;
      paintPushStatus();
      button.textContent = 'Pushing…';
      button.disabled = true;
      closeSheet();
      window.harnessTrace?.('visible', {screen:'transcript',outcome:'push-starting'});
      try {
        const r = await api(`/api/git/push?session=${encodeURIComponent(session.id)}`, { method: 'POST', body: JSON.stringify({ session: session.id, visibility }) });
        if (!r.ok) throw new Error(r.error || 'Push did not complete.');
      } catch (e) { value.pushError = e.message; showBanner(e.message, true); }
      finally {
        value.pushing = false;
        // Reopened during the push, the sheet is a new one and still says Pushing…
        if ($('s-git') && state.session?.id === session.id) await paintGit(session);
        else await refreshPushStatus();
      }
    };
  }
}

/** One line on whether a DO tab's changes are what this computer runs. */
function testingLine(testing) {
  if (testing.error) return { problem: true, text: `Not running on this computer. ${testing.error}` };
  if (testing.conflict) return { problem: true, text: `Not running on this computer: conflicts with another tab's unpushed changes${testing.conflict.files?.length ? ` in ${testing.conflict.files.slice(0, 3).join(', ')}` : ''}.` };
  if (testing.running) return { text: 'Running on this computer. Other computers get it when you push.' };
  if (testing.recorded && testing.waiting) return { text: 'Loads on this computer when DO restarts.' };
  return { text: 'Not running on this computer yet.' };
}

function discardSheet(id, name, back) {
  openSheet(`<h2>Discard changes</h2>
    <p>Remove the unpushed changes in ${esc(name)}? The tab goes back to the published version, and this computer stops running them.</p>
    <p class="dim">A copy stays in Git under refs/harness/discarded in case this was a mistake.</p>
    <div class="actions"><button class="ghost" id="discard-cancel">cancel</button><button class="danger" id="discard-confirm">discard changes</button></div>`, 'discard-changes');
  $('discard-cancel').onclick = back;
  $('discard-confirm').onclick = async () => {
    $('discard-confirm').disabled = true;
    try {
      await api(`/api/git/discard?session=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ session: id }) });
      closeSheet();
      refreshPushStatus();
      refreshState().catch(() => {});
    } catch (e) { showBanner(e.message, true); back(); }
  };
}

/** Tapping the version in the header: what this computer runs, and the way back. */
async function testBuildSheet() {
  openSheet('<h2>What is running here</h2><p class="dim">Checking…</p>', 'test-build');
  let t;
  try {
    const response = await nativeFetch('/api/harness/test-build', { cache: 'no-store' });
    t = await response.json();
    if (!response.ok) throw new Error(t.error || 'Could not read what is running.');
  } catch (e) {
    if (sheetView === 'test-build') { showBanner(e.message, true); closeSheet(); }
    return;
  }
  if (sheetView !== 'test-build') return;
  const running = t.running?.tabs || [];
  const row = (tab) => {
    const conflict = t.conflicts?.find(entry => entry.session === tab.session);
    const line = running.some(entry => entry.session === tab.session) ? 'Running here'
      : conflict ? `Not running: conflicts with another tab${conflict.files?.length ? ` in ${conflict.files.slice(0, 3).join(', ')}` : ''}`
      : t.waiting ? 'Loads when DO restarts' : 'Not running';
    return `<div class="item machine-item"><div class="grow"><div class="t">${esc(tab.name)}</div><div class="s">${esc(line)}</div></div>
      <button class="ghost" data-build-open="${esc(tab.session)}">open</button>
      <button class="ghost" data-build-discard="${esc(tab.session)}" data-name="${esc(tab.name)}">discard</button></div>`;
  };
  const problem = t.error?.message || t.failure?.message;
  openSheet(`<h2>What is running here</h2>
    <p class="dim">${esc(t.label)}</p>
    ${t.tabs.map(row).join('')}
    <p class="dim">${running.length ? `These changes run only on this computer. Other computers stay on ${esc(t.number || 'the published version')} until you push. Open a tab to push it.`
      : 'This computer runs the published version. When a DO tab finishes a turn with changes, they load here on their own, before any push.'}</p>
    ${problem ? `<p class="dim warn-text">Last problem: ${esc(problem)}</p>` : ''}
    <div id="build-peers"></div>
    <div class="actions"><button class="ghost" id="build-close">close</button>${t.tabs.length ? '<button class="ghost" id="build-stop">back to published</button>' : ''}</div>`, 'test-build');
  // What the other computers run; drawn when known so a slow one holds nothing up.
  api('/api/harness/versions').then((versions) => {
    const box = $('build-peers');
    const others = (versions.hosts || []).filter(host => host.id !== t.node);
    if (!box || !others.length) return;
    box.innerHTML = `<label>Other computers</label>${others.map(host => `<div class="item machine-item"><div class="grow">
      <div class="t">${esc(host.name || host.id)}${host.version?.number ? ` · ${esc(host.version.number)}` : ''}</div>
      <div class="s">${esc(host.state)}${host.stale ? ' · last known' : ''}</div></div></div>`).join('')}`;
  }).catch(() => {});
  $('build-close').onclick = closeSheet;
  if ($('build-stop')) $('build-stop').onclick = async () => {
    $('build-stop').disabled = true;
    try {
      const response = await nativeFetch('/api/harness/test-build/stop', { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not go back.');
      closeSheet();
      refreshPushStatus();
      refreshState().catch(() => {});
    } catch (e) { showBanner(e.message, true); testBuildSheet(); }
  };
  $('sheet').querySelectorAll('[data-build-open]').forEach(button => {
    button.onclick = async () => { closeSheet(); await openSession(button.dataset.buildOpen); };
  });
  $('sheet').querySelectorAll('[data-build-discard]').forEach(button => {
    button.onclick = () => discardSheet(button.dataset.buildDiscard, button.dataset.name, testBuildSheet);
  });
}

/** Repoint a session at another folder, creating it if it isn't there. */
async function setProjectDir(dir) {
  if (!dir) return;
  state.session = await api(`/api/sessions/${state.session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ projectDir: dir }),
  });
  state.session = await api(`/api/sessions/${state.session.id}`);
  paintHeader();
}

function modelSheet(alias, m = state.models[alias]) {
  if (['claude-cli', 'codex-cli'].includes(m.provider)) {
    openSheet(`<h2>${esc(m.label ?? alias)}</h2>
      <p class="dim">Uses the ${m.provider === 'claude-cli' ? 'Claude Code' : 'Codex'} login on the computer hosting Distributed Orchestrator. No API key is needed here. Sign in on that computer before using this source.</p>
      <label>Model ID</label><input id="subscription-model" spellcheck="false" />
      ${m.provider === 'claude-cli' ? '<p class="dim">Aliases such as opus follow the version selected by your installed Claude Code and provider settings. [1m] means a million-token context window. Replies show the actual model ID when reported. To pin a version, enter its full model ID.</p>' : ''}
      <p id="subscription-error" class="dim" role="status"></p>
      <div class="actions"><button class="ghost" id="subscription-back">back</button><button class="primary" id="subscription-save">save</button></div>`);
    $('subscription-model').value = m.model ?? '';
    $('subscription-back').onclick = modelsSheet;
    $('subscription-save').onclick = async () => {
      try {
        const model = $('subscription-model').value.trim();
        if (!model) throw new Error('Enter a model ID.');
        await api('/api/models/patch', { method: 'POST', body: JSON.stringify({ alias, patch: { model } }) });
        await modelsSheet();
      } catch (e) {
        if ($('subscription-error')) $('subscription-error').textContent = e.message;
      }
    };
    return;
  }

  openSheet(`<h2>${esc(m.label ?? alias)}</h2>
    <p class="dim">${esc(m.provider)} · key falls back to $${esc(m.keyEnv || 'none')}</p>
    <label>API key ${m.keySource === 'stored' ? '(a key is already saved)' : ''}</label>
    <input id="m-key" type="password" placeholder="paste key — leave blank to keep" autocomplete="off" />
    <label>Model id</label><input id="m-model" value="${esc(m.model ?? '')}" spellcheck="false" />
    <label>Base URL ${m.provider === 'anthropic' ? '(leave blank for Anthropic default)' : ''}</label>
    <input id="m-base" value="${esc(m.baseUrl ?? '')}" placeholder="https://…/v1" spellcheck="false" inputmode="url" />
    <div class="actions"><button class="ghost" id="m-discover">what does it serve?</button></div>
    <div id="m-list"></div>
    <div class="actions"><button class="ghost" id="m-cancel">back</button>
    <button class="primary" id="m-save">save</button></div>`);

  $('m-discover').onclick = async () => {
    $('m-list').innerHTML = '<p class="dim">asking the endpoint…</p>';
    // Save whatever is typed first, so it queries the endpoint and key on screen.
    const typed = $('m-key').value.trim();
    if (typed) await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias, apiKey: typed }) });
    await api('/api/models/patch', {
      method: 'POST',
      body: JSON.stringify({ alias, patch: { baseUrl: $('m-base').value.trim() } }),
    });

    const r = await api('/api/models/discover', { method: 'POST', body: JSON.stringify({ alias }) });
    if (!r.ok) {
      $('m-list').innerHTML = `<p class="dim warn-text">${esc(r.error)}</p>`;
      return;
    }
    $('m-list').innerHTML = `<p class="dim">${r.count} models available — tap one</p>`
      + r.models.map((id) => `<div class="item" data-pick="${esc(id)}"><div class="grow">
          <div class="t">${esc(id)}</div></div></div>`).join('');
    $('m-list').querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => { $('m-model').value = el.dataset.pick; };
    });
  };

  $('m-cancel').onclick = modelsSheet;
  $('m-save').onclick = async () => {
    const key = $('m-key').value.trim();
    if (key) await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias, apiKey: key }) });
    await api('/api/models/patch', {
      method: 'POST',
      body: JSON.stringify({
        alias,
        patch: { model: $('m-model').value.trim(), baseUrl: $('m-base').value.trim() },
      }),
    });
    modelsSheet();
  };
}

// ------------------------------------------------------------------- wire

// ---------------------------------------------------------------- usage

const WINDOW_LABEL = {
  five_hour: 'last 5 hours', seven_day: 'last 7 days', month: 'last 30 days', all: 'all time',
};

const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const untilReset = (at) => {
  if (!at) return '';
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return 'resetting';
  return mins < 60 ? `resets in ${mins}m` : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};

function bar(pct, tone = '') {
  const clamped = Math.max(0, Math.min(1, pct));
  return `<div class="bar"><div class="bar-fill ${tone}" style="width:${(clamped * 100).toFixed(1)}%"></div></div>`;
}

let usageWindow = 'seven_day';


/**
 * Apps: the durable things. A session comes and goes; an app has a directory, a
 * repository, a port and two addresses, and is still here after a reboot.
 *
 * Both addresses are always shown together. The harness's tailscaled runs with
 * userspace networking, so the laptop cannot resolve its own .ts.net name —
 * showing only the tailnet link leaves you unable to open your own app on the
 * machine running it.
 */
// Which apps are expanded to show their sessions. Survives re-renders.
const expandedApps = new Set();

/**
 * One home for everything: apps at the top level, each expandable to the
 * sessions working on it. There is no separate sessions list — tapping an app
 * opens its current session, and its arrow lists the rest. Sessions not tied to
 * an app are grouped at the end.
 */
let lastAppsData = null;   // cached so expand/collapse re-renders without refetching

async function appsSheet() {
  // Draw first, fetch second. This used to wait on /api/apps - which shells out
  // to lsof and tailscale - and then on /api/state, two round trips in series,
  // before a single pixel appeared, so tapping the sidebar felt dead for about
  // a second. The last known list goes up immediately and the fresh one folds
  // in when it lands; only the very first open of the session has nothing to
  // show. The two requests now go out together rather than one after the other.
  if (!lastAppsData && state.apps?.length) lastAppsData = {apps:state.apps};
  if (lastAppsData) renderAppsSheet(lastAppsData);
  else openSheet('<h2>Projects &amp; sessions</h2><p class="dim">loading…</p>', 'apps');

  let d;
  try { [d] = await Promise.all([api('/api/apps'), refreshState()]); }
  catch (e) {
    if (sheetView !== 'apps') return;
    if (lastAppsData) return showBanner(e.message);   // stale but usable beats blank
    return openSheet(`<h2>Apps</h2><p class="dim">${esc(e.message)}</p>`, 'apps');
  }
  lastAppsData = d;
  if (sheetView === 'apps') renderAppsSheet(d);
  return undefined;
}

/**
 * Draw the apps-and-sessions sheet from already-fetched data.
 *
 * Toggling an app's expander used to call appsSheet(), which re-hit /api/apps —
 * and that endpoint probes every app over HTTP, reads the Tailscale table and
 * asks gh for visibility, so a tap felt sluggish. Expansion is a pure view
 * change, so it re-renders from the cached data instead.
 */
// Harness stays pinned; project edits and recent messages both count.
function orderProjects(apps) {
  const latest = new Map();
  for (const session of state.sessions) {
    latest.set(session.appId, Math.max(latest.get(session.appId) || 0,
      session.lastMessageAt ?? session.createdAt ?? 0));
  }
  return [...apps].sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin))
    || Math.max(latest.get(b.id) || 0, b.updatedAt || b.createdAt || 0) - Math.max(latest.get(a.id) || 0, a.updatedAt || a.createdAt || 0));
}
const openProjectGroups = new Set();

let peerCatalog = null;
async function showPeerSessions() {
  const box = $('peer-sessions');
  if (!box) return;
  peerCatalog ??= nativeFetch('/api/nodes').then(async (r) => r.ok ? r.json() : []).finally(() => {
    setTimeout(() => { peerCatalog = null; }, 5000);
  });
  try {
    const nodes = await peerCatalog;
    if ($('peer-sessions') !== box) return;
    box.innerHTML = nodes.filter((n) => n.id !== executionNode).map((n) =>
      `<h3>${esc(n.name)} · ${n.online ? 'online' : 'offline'}</h3>` + (n.online
        ? (n.sessions ?? []).map((s) => `<button class="rowlink machine-choice" data-peer="${esc(n.id)}" data-session="${esc(s.id)}"><span>${esc(s.name)}</span><span class="chev">›</span></button>`).join('')
        : '<p class="dim">This machine’s work is unavailable until it reconnects.</p>')).join('');
    box.querySelectorAll('[data-peer]').forEach((button) => { button.onclick = () => {
      location.href = `/?node=${encodeURIComponent(button.dataset.peer)}&session=${encodeURIComponent(button.dataset.session)}`;
    }; });
  } catch { if ($('peer-sessions') === box) box.textContent = 'Could not load connected machines.'; }
}

async function restartOrchestrator(button, host) {
  const query = host ? `?host=${encodeURIComponent(host)}` : '';
  button.disabled = true;
  button.textContent = 'Checking…';
  button.setAttribute('aria-live', 'polite');
  try {
    const response = await nativeFetch('/api/harness/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not identify the serving machine.');
    const local = await response.json();
    const expected = await api('/api/harness/restart' + query, { method: 'POST' });
    if (!expected.restartId) throw new Error('The old server accepted the restart but cannot verify it. Wait a few seconds, then refresh to load the updated restart control.');
    button.textContent = 'Restarting…';
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 700));
      try {
        const current = await api('/api/harness/status' + query, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (current.restartId === expected.restartId && current.instanceId !== expected.instanceId && current.node === expected.node && (!expected.revision || current.version?.revision === expected.revision)) {
          if (expected.node !== local.node) { button.textContent = 'Restarted ✓'; }
          else location.reload();
          return;
        }
      } catch { /* The listener is unavailable during a normal restart. */ }
    }
    throw new Error('Restart could not be verified. The old server may still be running, or its replacement failed. Check the server log on this host.');
  } catch (error) {
    button.textContent = 'Restart failed';
    button.title = error.message;
    if (button.isConnected) showBanner(error.message, true);
  }
  // Keep the result on this button; reopening the sheet creates a fresh control.
}

function renderAppsSheet(d) {
  // Redrawing throws the scroll position and keyboard focus away, which is wrong
  // both for an expander tap and for the refresh that lands a moment after the
  // sheet opens.
  const scroll = sheetView === 'apps' ? $('sheet').scrollTop : 0;
  const focusedArrow = sheetView === 'apps' ? document.activeElement?.dataset?.appExpand : null;
  const sessionsFor = (id) => state.sessions.filter((x) => x.appId === id).sort(sessionOrder);
  const known = new Set(d.apps.map((a) => a.id));
  const loose = state.sessions.filter((x) => !x.appId || !known.has(x.appId));

  const sessionRow = (sn) => {
    // Opening, editing and deleting all need the computer that owns the session.
    const offline = sessionOffline(sn);
    return `
    <div class="item sub-session${sn.id === state.session?.id ? ' on' : ''}${offline ? ' offline' : ''}"${offline ? '' : ` data-open="${esc(sn.id)}" tabindex="0"`}>
      <div class="grow"><div class="t">${esc(sn.name)} ${tabComputerBadge(sn)} ${offline ? '<span class="sstat waiting">computer offline</span>' : sessionStatus(sn)}</div>
        <div class="s">${esc(state.models[sn.model]?.label || sn.model)} · ${sn.turns} turn${sn.turns === 1 ? '' : 's'}</div>
        <div class="s">Last message: ${esc(clock(sn.lastMessageAt ?? sn.createdAt) || 'unknown')}</div></div>
      ${offline ? '' : `<button class="x" data-rename="${esc(sn.id)}" title="Edit session">✎</button>
      <button class="x" data-del="${esc(sn.id)}" title="Delete">×</button>`}
    </div>`;
  };

  const appCard = (a) => {
    const launchable = Boolean(a.start?.trim());
    const mine = sessionsFor(a.id);
    const expanded = expandedApps.has(a.id);
    const owner = state.machines?.hosts?.find(h => h.id === a.ownerNode);
    const offline = owner?.active === false;
    const label = offline ? 'owner offline' : a.runtimeKnown === false ? 'remote · status unknown' : !a.running ? 'stopped' : a.reachable ? 'running' : 'starting';
    const links = [];
    if (a.urls?.phone) links.push(`<a href="${safeHref(a.urls.phone)}" target="_blank" rel="noopener">phone: ${esc(a.urls.phone)}</a>`);
    if (a.urls?.desktop) links.push(`<a href="${safeHref(a.urls.desktop)}" target="_blank" rel="noopener">laptop: ${esc(a.urls.desktop)}</a>`);

    if (a.urls?.phone || a.urls?.desktop) {
      const preview = `/app-preview.html?app=${encodeURIComponent(a.id)}${executionNode ? `&node=${encodeURIComponent(executionNode)}` : ''}`;
      links.push(`<a href="${preview}&layout=phone" target="_blank" rel="noopener">Phone layout</a> · <a href="${preview}&layout=desktop" target="_blank" rel="noopener">Desktop layout</a>`);
    }

    // The built-in Distributed Orchestrator app is special: it *is* the running harness, its
    // sessions edit the orchestrator itself, and it cannot be started, edited as a
    // record, or deleted.
    const meta = a.builtin
      ? `<div class="s dim">the orchestrator itself — sessions here edit its code</div>`
      : `<div class="s">${esc(shortDir(a.dir))}</div>
         ${a.running && a.reachable && links.length ? `<div class="s app-links">${links.join('<br>')}</div>` : ''}`;
    const pill = a.builtin
      ? '<span class="pill self">self</span>'
      : offline ? '<span class="pill">owner offline</span>'
      : !launchable && !a.running && !a.lastStartedAt && !a.hasBeenApp ? '<span class="pill">chat</span>'
      : `<span class="pill ${a.reachable ? 'ready' : a.running ? 'warm' : ''}">${label}</span>`;
    const actions = a.builtin
      ? `<div class="app-actions">
          <button class="x" data-harness-restart="1" title="Restart Harness: choose a machine">⟳</button>
        </div>`
      : `<div class="app-actions">
          ${launchable || a.running ? `<button class="x" data-app-run="${esc(a.id)}" title="${a.running ? 'Stop' : 'Start'}" ${offline || a.runtimeKnown === false ? 'disabled' : ''}>${a.running ? '■' : '▶'}</button>` : ''}
          <button class="x" data-app-edit="${esc(a.id)}" title="Edit project">✎</button>
        </div>`;

    return `<div class="app-block${a.builtin ? ' builtin' : ''}">
      <div class="item app-card" data-app-toggle="${esc(a.id)}">
        <button class="app-caret" data-app-expand="${esc(a.id)}" aria-expanded="${expanded}"${expanded ? ` aria-controls="app-sessions-${esc(a.id)}"` : ''} aria-label="Sessions in ${esc(a.name)}" title="${expanded ? 'Hide' : 'Show'} sessions"><span aria-hidden="true">›</span></button>
        <div class="grow">
          <div class="t">${esc(a.name)} ${pill}</div>
          ${meta}
          ${owner && !a.builtin ? `<div class="s">Files on ${esc(owner.name)} · ${offline ? 'offline — saved chats remain readable; reconnect to run tools' : 'online'}</div>` : ''}
          ${(a.aiDependencies || []).map(dep => `<div class="s">AI: ${esc(dep.label || dep.alias)} · ${esc(state.machines?.hosts?.find(h => h.id === dep.host)?.name || dep.host)} · ${esc(dep.purpose)}</div>`).join('')}
          <div class="s dim">${mine.length} session${mine.length === 1 ? '' : 's'}</div>
        </div>
        ${actions}
      </div>
      ${expanded ? `<div class="app-sessions" id="app-sessions-${esc(a.id)}">
        ${mine.length ? mine.map(sessionRow).join('') : '<p class="dim sub-empty">no sessions yet</p>'}
        <button class="ghost sub-new" data-new-in="${esc(a.id)}" aria-label="New session in ${esc(a.name)}">+ new session</button>
      </div>` : ''}
    </div>`;
  };

  const appsHtml = (() => {
    const disclosure = (id, label, count, content) => count
      ? `<details class="project-group" data-project-group="${id}"${openProjectGroups.has(id) ? ' open' : ''}><summary>${label} (${count})</summary>${content}</details>` : '';
    return orderProjects(d.apps).map(appCard).join('')
      + disclosure('chats', 'Sessions in other folders', loose.length, loose.sort(sessionOrder).map(sessionRow).join(''));
  })();

  openSheet(`<h2>Projects &amp; sessions</h2>${appsHtml}<div id="peer-sessions"></div>
    <div class="actions">
      <button class="primary" id="app-new">new project</button>
      <button class="ghost" id="sess-new">new session</button>
    </div><div class="actions">
      <button class="ghost" id="project-recover">recover projects</button>
    </div>`, 'apps');
  $('sheet').querySelectorAll('[data-project-group]').forEach((el) => {
    el.ontoggle = () => {
      if (el.open) openProjectGroups.add(el.dataset.projectGroup);
      else openProjectGroups.delete(el.dataset.projectGroup);
    };
  });
  if (scroll) $('sheet').scrollTop = scroll;
  if (focusedArrow) [...$('sheet').querySelectorAll('[data-app-expand]')]
    .find((el) => el.dataset.appExpand === focusedArrow)?.focus({ preventScroll: true });

  // --- app-level actions ---
  showPeerSessions();
  $('app-new').onclick = () => appEditSheet(null);
  $('sess-new').onclick = () => { draft = {}; newSheet(); };
  $('project-recover').onclick = () => recoverProjectsSheet();
  $('sheet').querySelectorAll('[data-app-toggle]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.app-actions') || e.target.closest('a')) return;  // buttons/links are their own
      if (el.dataset.opening) return;
      el.dataset.opening = '1';
      openProject(d.apps.find((a) => a.id === el.dataset.appToggle))
        .finally(() => { delete el.dataset.opening; });
    };
  });
  $('sheet').querySelectorAll('[data-app-expand]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();   // the card around it opens the project
      const id = el.dataset.appExpand;
      const show = !expandedApps.has(id);
      if (show) expandedApps.add(id); else expandedApps.delete(id);
      renderAppsSheet(d);
      // An arrow near the bottom would otherwise open its list out of sight. Move
      // only that far, so the card under your finger stays put whenever it can.
      if (show) {
        const sheet = $('sheet').getBoundingClientRect(), list = $(`app-sessions-${id}`).getBoundingClientRect();
        const hidden = list.top + Math.min(list.height, sheet.height / 2) - sheet.bottom;
        if (hidden > 0) $('sheet').scrollTop += hidden;
      }
      window.harnessTrace?.('visible', { screen: 'project-sessions', outcome: show ? 'shown' : 'hidden', count: sessionsFor(id).length });
    };
  });
  $('sheet').querySelectorAll('[data-app-edit]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); appEditSheet(d.apps.find((a) => a.id === el.dataset.appEdit)); };
  });
  $('sheet').querySelectorAll('[data-app-run]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); runApp(d.apps.find((a) => a.id === el.dataset.appRun), el); };
  });
  $('sheet').querySelectorAll('[data-harness-restart]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      await harnessVersionSheet();
    };
  });
  $('sheet').querySelectorAll('[data-new-in]').forEach((el) => {
    el.onclick = () => { draft = { appId: el.dataset.newIn }; newSheet(); };
  });

  // --- session-level actions ---
  $('sheet').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.del || e.target.dataset.rename) return;
      openSession(el.dataset.open);
    };
    el.onkeydown = (e) => {
      if (e.target !== el || !['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      el.click();
    };
  });
  $('sheet').querySelectorAll('[data-rename]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      await openSession(el.dataset.rename);
      // If it could not be opened, the settings would be for the wrong session.
      if (state.session?.id === el.dataset.rename) await sessionSettingsSheet();
    };
  });
  $('sheet').querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const session = state.sessions.find(s => s.id === el.dataset.del);
      if (session) await deleteSessionSheet(session);
    };
  });
}

/** Start or stop an app, with clear feedback. Shared by the app card. */
async function recoverProjectsSheet() {
  const correlationId = crypto.randomUUID();
  const call = body => api('/api/cluster/recovery', { method: 'POST', body: JSON.stringify({ correlationId, ...body }) });
  const visible = (host, value) => call({ host, action: 'visible', visible: value }).catch(() => {});
  openSheet('<h2>Recover projects</h2><p class="dim">Searching saved histories on your computers…</p>', 'recovery');
  const hosts = (state.machines?.hosts || []).filter(h => h.member);
  const results = await Promise.all(hosts.map(async host => {
    visible(host.id, 'loading');
    try { return { host, ...await call({ host: host.id, action: 'list' }) }; }
    catch (error) { return { host, error: error.message, projects: [] }; }
  }));
  if (sheetView !== 'recovery') return;
  const choices = results.flatMap(r => r.projects.map(project => ({ ...project, host: r.host })));
  openSheet(`<h2>Recover projects</h2><p class="dim">Restore missing project records and saved tabs. Files stay on their original computer. Projects you previously deleted may also appear.</p>
    ${results.filter(r => r.error || r.unreadable).map(r => `<p class="dim">${esc(r.host.name)}: ${esc(r.error || `${r.unreadable} saved histories could not be read.`)}</p>`).join('')}
    ${choices.length ? choices.map((p, i) => `<div class="item"><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.host.name)} · ${p.tabs} saved tabs${p.inferred ? ' · launch settings unavailable' : ''}</div></div><button class="ghost" data-recover="${i}">restore</button></div>`).join('') : '<p class="dim">No missing projects found in the histories that could be read.</p>'}
    <div class="actions"><button class="ghost" id="recovery-back">back to projects</button></div>`, 'recovery');
  results.forEach(r => visible(r.host.id, r.error ? 'error' : r.projects.length ? 'results' : 'empty'));
  $('recovery-back').onclick = () => appsSheet();
  $('sheet').querySelectorAll('[data-recover]').forEach(button => {
    button.onclick = async () => {
      const project = choices[Number(button.dataset.recover)];
      button.disabled = true; button.textContent = 'restoring…';
      visible(project.host.id, 'loading');
      try {
        await call({ host: project.host.id, action: 'restore', appId: project.id });
        await refreshState();
        button.textContent = 'restored';
        if (sheetView === 'recovery') visible(project.host.id, 'success');
      } catch (error) {
        button.disabled = false; button.textContent = 'restore';
        showBanner(error.message); visible(project.host.id, 'error');
      }
    };
  });
}

async function runApp(app, el) {
  if (!app.running && !app.start?.trim()) {
    showBanner(`${app.name} has no start command yet — add one here, then tap ▶`, true);
    appEditSheet(app);
    return;
  }
  if (el) { el.disabled = true; el.textContent = '…'; }
  showBanner(app.running ? `stopping ${app.name}…` : `starting ${app.name}…`);
  try {
    const r = await api(`/api/apps/${app.id}/${app.running ? 'stop' : 'start'}`, { method: 'POST' });
    if (r.unconfirmed) showBanner(`${app.name} did not confirm it stopped — something is still holding its port`, true);
    else if (r.launchdRemoved?.length) showBanner(`${app.name} stopped — also unregistered its background service so it stays down`);
    else if (app.running) showBanner(`${app.name} stopped`);
    else {
      const fresh = (await api('/api/apps')).apps.find((x) => x.id === app.id);
      if (fresh?.reachable) showBanner(`${app.name} is running — laptop ${fresh.urls.desktop}${fresh.urls.phone ? ` · phone ${fresh.urls.phone}` : ''}`);
      else showBanner(`${app.name} was launched but is not answering yet — check its log (✎ → view log) if it doesn't come up`, true);
    }
  } catch (e) { showBanner(e.message, true); }
  appsSheet();
}

/**
 * GitHub visibility for one app, inside its edit sheet.
 *
 * Read on open so it reflects the true state on GitHub, not a guess. Making a
 * repo public is hard to undo, so that direction takes a second, deliberate
 * tap rather than a single one.
 */
async function paintAppVisibility(app) {
  const box = $('ap-vis');
  if (!box) return;
  let v;
  try { v = await api(`/api/apps/${app.id}/git`); }
  catch (e) { box.innerHTML = `<p class="dim">${esc(e.message)}</p>`; return; }
  if (!v.ok) {
    box.innerHTML = `<p class="dim">${esc(v.reason || 'visibility unavailable')} — is <span class="mono">gh</span> signed in?</p>`;
    return;
  }
  const isPublic = v.visibility === 'public';
  box.innerHTML = `
    <div class="row">
      <button class="ghost${isPublic ? '' : ' on'}" data-setvis="private">🔒 private</button>
      <button class="ghost${isPublic ? ' on' : ''}" data-setvis="public">🌐 public</button>
    </div>
    <p class="dim">${isPublic
      ? 'Anyone can see this repository.'
      : 'Only you can see this repository.'} <a href="${safeHref(v.url)}" target="_blank" rel="noopener">${esc(v.repo)}</a></p>`;

  box.querySelectorAll('[data-setvis]').forEach((el) => {
    el.onclick = async () => {
      const want = el.dataset.setvis;
      if (want === v.visibility) return;
      // Public is the irreversible-feeling direction; confirm it explicitly.
      if (want === 'public' && el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.textContent = '🌐 tap again to make public';
        setTimeout(() => { el.dataset.armed = ''; el.textContent = '🌐 public'; }, 3000);
        return;
      }
      box.innerHTML = '<p class="dim">changing…</p>';
      try {
        const r = await api(`/api/apps/${app.id}/visibility`, { method: 'POST', body: JSON.stringify({ visibility: want }) });
        showBanner(r.ok ? `${app.name} is now ${want} on GitHub` : `couldn't change: ${r.reason}`, !r.ok);
      } catch (e) { showBanner(e.message, true); }
      paintAppVisibility(app);
    };
  });
}

function appEditSheet(app = null, draft = null) {
  const existing = Boolean(app?.id);
  const a = draft ?? app ?? { name: '', dir: '', start: '', repo: '' };

  openSheet(`<h2>${existing ? 'Edit project' : 'New project'}</h2>
    <label>Name</label><input id="ap-name" value="${esc(a.name ?? '')}" spellcheck="false" placeholder="what you're building" />
    ${existing ? '<p class="dim">Renaming this project also renames its linked GitHub repository. Its folder stays in place.</p>' : ''}
    <label>Folder${existing ? '' : ' — made for you from the name'}</label>
    <div class="row"><input id="ap-dir" value="${esc(a.dir ?? '')}" spellcheck="false" ${existing ? 'disabled' : ''} />
      ${existing ? '' : '<button class="ghost" id="ap-browse" style="flex:0 0 80px">browse</button>'}</div>
    <label>Start command (optional)</label>
    <p class="dim">Leave empty for a Chat with sessions and no play button. Add a command to make it a launchable app.</p>
    <input id="ap-start" value="${esc(a.start ?? '')}" spellcheck="false" placeholder="npm run dev" />
    <p class="dim">Runs in the app's folder with <span class="mono">PORT</span> set${existing ? ` to ${app.port}` : ' to the port this app is given'}.</p>
    <label>Repository (optional)</label>
    <input id="ap-repo" value="${esc(a.repo ?? '')}" spellcheck="false" placeholder="git@github.com:you/app.git" />
    <div id="ap-machines"></div>
    ${existing ? '<details><summary>AI used by this app</summary><p class="dim">Select the AI your app runs with. Changes apply on the next app launch; the app must support Harness model selection. Requirements are added to README when you push.</p><div id="ap-ai"></div></details>' : ''}

    ${existing && a.repo ? `<label>GitHub visibility</label>
      <div id="ap-vis"><p class="dim">checking…</p></div>` : ''}
    <div class="actions">
      <button class="primary" id="ap-save">${existing ? 'save' : 'create project'}</button>
      <button class="ghost" id="ap-back">back</button>
      ${existing ? '<button class="ghost" id="ap-log">view log</button><button class="ghost" id="ap-del">delete</button>' : ''}
    </div>`);

  const values = () => ({
    name: $('ap-name').value, dir: $('ap-dir').value,
    start: $('ap-start').value, repo: $('ap-repo').value,
    hosts: $('ap-machines')?.querySelector('[data-host]')
      ? [...$('ap-machines').querySelectorAll('[data-host]:checked')].map((el) => el.dataset.host) : undefined,
  });

  // Every app gets its own folder under ~/Projects without the user typing a
  // path. Typing in the field yourself stops the suggestion taking over.
  if (!existing) {
    let touched = Boolean(a.dir);
    const slugify = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const suggest = () => {
      if (touched) return;
      const name = slugify($('ap-name').value);
      $('ap-dir').value = name ? `${state.home}/Projects/${name}` : '';
    };
    $('ap-name').addEventListener('input', suggest);
    $('ap-dir').addEventListener('input', () => { touched = true; });
    suggest();
    $('ap-browse').onclick = () => browseSheet($('ap-dir').value || `${state.home}/Projects`,
      (chosen) => appEditSheet(app, { ...values(), dir: chosen }),
      () => appEditSheet(app, values()));
  }

  $('ap-back').onclick = appsSheet;
  if ($('ap-vis')) paintAppVisibility(app);
  const machines = paintAppMachines(app, a.hosts);
  const dependencies = existing ? paintAppDependencies(app) : null;

  if ($('ap-log')) $('ap-log').onclick = async () => {
    const text = await (await fetch(`/api/apps/${app.id}/log`)).text();
    openSheet(`<h2>Log — ${esc(app.name)}</h2><pre class="log">${esc(text.slice(-8000) || '(empty)')}</pre>`
      + `<div class="actions"><button class="ghost" id="lb">back</button></div>`);
    $('lb').onclick = () => appEditSheet(app);
  };
  if ($('ap-del')) $('ap-del').onclick = () => appDeleteSheet(app);
  $('ap-save').onclick = async () => {
    const v = values();
    const body = { name: v.name.trim(), start: v.start.trim(), repo: v.repo.trim() || null };
    if (dependencies) {
      const read = await dependencies;
      try { body.aiDependencies = read(); } catch (e) { return showBanner(e.message, true); }
    }
    const hosts = await machines;
    if (hosts) body.hosts = hosts();
    if (!body.name && !existing) return showBanner('give the app a name');
    try {
      if (existing) await api(`/api/apps/${app.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else {
        const made = await api('/api/apps', { method: 'POST', body: JSON.stringify({ ...body, dir: v.dir.trim() }) });
        expandedApps.add(made.id);
        await refreshState();
      }
      appsSheet();
    } catch (e) { showBanner(e.message, true); }
  };
}

/**
 * Which machines keep a copy of this project, inside its edit sheet.
 *
 * Shown only once another machine has joined. Returns a reader for the ticked
 * machines, or null when there is no choice to make. New projects start on
 * their original host; additional hosts can own their own tabs.
 */
async function paintAppDependencies(app) {
  const box = $('ap-ai');
  const deps = app.aiDependencies || [];
  box.innerHTML = deps.map((d, i) => `<label class="item"><input type="checkbox" data-ai-keep="${i}" checked /><span>${esc(d.label || d.alias)} · ${esc(state.machines?.hosts?.find(h => h.id === d.host)?.name || d.host)} · ${esc(d.purpose)}</span></label>`).join('')
    + '<label>AI computer · launch the app here</label><select id="ap-ai-host"></select><label>Use another model</label><select id="ap-ai-source"><option value="">No source to add</option></select><label>Used for</label><input id="ap-ai-purpose" placeholder="e.g. product analysis" /><p class="dim" id="ap-ai-status"></p>';
  const machines = await nativeFetch('/api/cluster/status').then(r => r.json());
  if ($('ap-ai') !== box) return () => deps;
  $('ap-ai-host').innerHTML = machines.hosts.filter(h => h.member).map(h => `<option value="${esc(h.id)}">${esc(h.name)}${h.active === false ? ' · offline' : ''}</option>`).join('');
  if (deps[0]?.host && machines.hosts.some(h => h.id === deps[0].host)) $('ap-ai-host').value = deps[0].host;
  let models = {}, request = 0;
  const discover = async () => {
    const current = ++request, host = $('ap-ai-host').value;
    models = {};
    $('ap-ai-source').innerHTML = '<option value="">No source to add</option>';
    try {
      const catalog = await sourcesCall('catalog', { host });
      if (current !== request || $('ap-ai') !== box) return;
      models = catalog.models;
      $('ap-ai-source').innerHTML += Object.values(models).map(m => `<option value="${esc(m.alias)}">${esc(m.label || m.model)}</option>`).join('');
      $('ap-ai-status').textContent = '';
    } catch { if ($('ap-ai') === box) $('ap-ai-status').textContent = 'Source computer unavailable. Existing dependencies are retained. This computer must be online to use its AI.'; }
  };
  $('ap-ai-host').onchange = discover;
  await discover();
  if (deps.length === 1) $('ap-ai-purpose').value = deps[0].purpose;
  return () => {
    const kept = [...box.querySelectorAll('[data-ai-keep]:checked')].map(el => deps[Number(el.dataset.aiKeep)]);
    const alias = $('ap-ai-source').value;
    if (alias) {
      const purpose = $('ap-ai-purpose').value.trim();
      if (!purpose) throw new Error('Describe what the app uses this AI for.');
      const replacement = { host: $('ap-ai-host').value, alias, label: models[alias]?.label || alias, purpose };
      const index = kept.findIndex(d => d.purpose.toLowerCase() === purpose.toLowerCase());
      if (index >= 0) kept[index] = replacement; else kept.push(replacement);
    }
    return kept;
  };
}

async function paintAppMachines(app, draft) {
  const box = $('ap-machines');
  let data;
  try { data = await api('/api/cluster/status'); } catch { return null; }
  const hosts = data.hosts.filter((h) => h.member);
  if (!box?.isConnected || hosts.length < 2) return null;
  const states = Object.fromEntries((app?.machines || []).map((m) => [m.id, m]));
  const placed = new Set(draft || (app?.machines ? app.machines.filter((m) => m.placed).map((m) => m.id) : [data.leader]));
  const ownerId = app?.ownerNode || app?.hosts?.[0] || data.leader;
  placed.add(ownerId);
  const owner = hosts.find((h) => h.id === ownerId);
  const note = (m) => {
    if (!m?.state) return '';
    if (m.state === 'ready') return m.error ? `copy ready · ${m.error}` : 'copy ready';
    if (m.state === 'pending') return 'copy being made';
    return m.error || m.state;
  };
  box.innerHTML = `<label>Machines</label>
    <p class="dim">Hosted on ${esc(owner?.name || 'its original computer')}. Select additional computers to replicate this app through its Git repository. Each selected computer can own tabs and use its own AI sources. Tabs sync through Git and merge and test before publishing; conflicts keep their work separate. Harness is always enabled on every joined computer. Unticking a machine deletes its copy once everything in it is pushed; a copy with unsaved work is kept and flagged.</p>
    ${hosts.map((h) => `<div class="item"><label class="grow"><input type="checkbox" data-host="${esc(h.id)}" ${placed.has(h.id) ? 'checked' : ''}${h.id === ownerId ? ' disabled' : ''} />
      ${esc(h.name)}${h.id === data.leader ? ' · main' : ''}${h.active ? '' : ' · offline'}${h.id === ownerId ? ' · app host' : ' · replicate here'}
      ${note(states[h.id]) ? `<div class="s">${esc(note(states[h.id]))}</div>` : ''}</label></div>`).join('')}`;
  return () => [...box.querySelectorAll('[data-host]')].filter((el) => el.checked).map((el) => el.dataset.host);
}

/**
 * Deleting an app, with the consequences spelled out.
 *
 * Removing the record is cheap and reversible — recreate the app and point it
 * at the same folder. Deleting the folder is neither, so it is off by default,
 * named in full, and needs a second tap that says what it is about to erase.
 */
async function appDeleteSheet(app, deleteSessions = false) {
  let mine = [];
  try {
    await refreshState();
    mine = state.sessions.filter((x) => x.appId === app.id);
  } catch { /* the counts are a courtesy, not a gate */ }

  openSheet(`<h2>Delete ${esc(app.name)}</h2>
    <p class="dim">Stopping it, retiring its Tailscale address and discarding its log happens either way.</p>
    <label>Also delete</label>
    <div class="item">
      <label class="grow"><input type="checkbox" id="del-files" />
        the folder <span class="mono">${esc(shortDir(app.dir))}</span> and everything in it</label>
    </div>
    ${mine.length ? `<div class="item">
      <label class="grow"><input type="checkbox" id="del-sessions" ${deleteSessions ? 'checked' : ''} />
        its ${mine.length} session${mine.length === 1 ? '' : 's'} and their transcripts</label>
    </div>` : ''}
    ${app.repo ? `<div class="item"><label class="grow"><input type="checkbox" id="del-github" />
      its GitHub repository: ${esc(app.repo)}</label></div>
      <label>To delete GitHub too, type owner/repository</label>
      <input id="del-repo-confirm" autocomplete="off" spellcheck="false" placeholder="owner/repository" />` : ''}
    <p class="dim" id="del-warn"></p>
    <div class="actions">
      <button class="ghost" id="del-cancel">cancel</button>
      <button class="primary danger" id="del-go">delete app</button>
    </div>`);

  const warn = () => {
    delete $('del-go').dataset.armed;
    const f = $('del-files').checked;
    const s2 = $('del-sessions')?.checked;
    const g = $('del-github')?.checked;
    $('del-warn').textContent = f || s2 || g
      ? `This cannot be undone. ${[g ? app.repo : null, f ? shortDir(app.dir) : null, s2 ? `${mine.length} transcript${mine.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')} will be erased.`
      : 'The folder stays on disk; only the orchestrator forgets the app.';
    $('del-go').textContent = f || s2 || g ? 'delete permanently' : 'remove from orchestrator';
  };
  $('del-files').onchange = warn;
  if ($('del-sessions')) $('del-sessions').onchange = warn;
  if ($('del-github')) $('del-github').onchange = warn;
  if ($('del-repo-confirm')) $('del-repo-confirm').oninput = warn;
  warn();

  $('del-cancel').onclick = () => appEditSheet(app);
  $('del-go').onclick = async () => {
    const f = $('del-files').checked;
    const s2 = $('del-sessions')?.checked;
    const g = $('del-github')?.checked;
    // A second tap for the irreversible half, because this is a phone and the
    // first one is easy to hit by accident.
    if ((f || s2 || g) && $('del-go').dataset.armed !== '1') {
      $('del-go').dataset.armed = '1';
      $('del-go').textContent = 'tap again to erase';
      return;
    }
    $('del-go').disabled = true;
    try {
      const r = await api(`/api/apps/${app.id}?files=${f ? 1 : 0}&sessions=${s2 ? 1 : 0}&github=${g ? 1 : 0}`, { method: 'DELETE', body: JSON.stringify({ confirmRepository: $('del-repo-confirm')?.value.trim() }) });
      // Report what actually happened rather than assuming it all worked.
      const bits = [];
      if (r.deletedRepo) bits.push('GitHub repository deleted: ' + r.deletedRepo);
      if (r.stopped === false) bits.push('it would not confirm it stopped');
      if (r.dirError) bits.push(`the folder was kept: ${r.dirError}`);
      if (f && r.dir) bits.push('folder deleted');
      if (r.removedSessions?.length) bits.push(`${r.removedSessions.length} session(s) deleted`);
      if (bits.length) showBanner(`${r.name}: ${bits.join(' · ')}`, Boolean(r.dirError || r.stopped === false));
      appsSheet();
    } catch (e) {
      showBanner(e.message, true);
      $('del-go').disabled = false;
    }
  };
}

async function usageSheet() {
  let d;
  try {
    d = await api(`/api/usage?window=${usageWindow}`);
  } catch (e) {
    return openSheet(`<h2>Usage</h2><p class="dim">${esc(e.message)}</p>`);
  }

  const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
  const spend = d.models.reduce((n, m) => n + (m.cost || 0), 0);

  /**
   * One card per model, all the same weight.
   *
   * Only some backends report a limit. Both subscription CLIs send real
   * window utilisation — Claude Code down its stream, Codex via the rollout
   * file its turn leaves behind — while a metered API has no ceiling to show.
   * Rather than inventing a percentage for the ones that do not publish one,
   * each card says what is actually known about it.
   */
  const card = (m) => {
    const p = d.provider?.[m.alias];
    const windows = p?.windows ?? [];

    let limit;
    if (windows.length) {
      limit = windows.map((w) => `
        <div class="meter">
          <div class="meter-head"><span>${esc(WINDOW_LABEL[w.name] ?? w.name)}</span>
            <span class="mono">${(w.pct * 100).toFixed(w.pct < 0.1 ? 1 : 0)}%</span></div>
          ${bar(w.pct, w.pct > 0.9 ? 'hot' : w.pct > 0.7 ? 'warm' : '')}
          <div class="s">${esc(untilReset(w.resetsAt))}</div>
        </div>`).join('');
    } else if (m.provider === 'codex-cli' || m.provider === 'claude-cli') {
      limit = '<p class="s">Plan limits apply — the figure arrives with this model\'s next turn.</p>';
    } else if (m.limit) {
      limit = `<div class="meter">
        <div class="meter-head"><span>${m.limit.kind === 'cost' ? 'budget' : 'token limit'}</span>
          <span class="mono">${(m.limit.pct * 100).toFixed(0)}%</span></div>
        ${bar(m.limit.pct, m.limit.pct > 0.9 ? 'hot' : m.limit.pct > 0.7 ? 'warm' : '')}</div>`;
    } else {
      limit = '<p class="s">Metered — no ceiling. You pay per token.</p>';
    }

    const cachedShare = m.input ? Math.min(100, Math.round((m.cached / m.input) * 100)) : 0;
    return `<div class="item usage-card">
      <div class="tool-head" style="padding:0">
        <span class="t" style="flex:1">${esc(m.label)}</span>
        <span class="spend-amt">${m.cost > 0 ? money(m.cost) : m.turns ? 'no charge' : '—'}</span>
      </div>
      <div class="s">${esc(m.provider)} · ${m.turns} turns · ${num(m.input)} in (${cachedShare}% cached) · ${num(m.output)} out</div>
      ${limit}
    </div>`;
  };

  // Used first, then the rest — but every card is the same size and shape.
  const ordered = [...d.models].sort((a, b) => b.turns - a.turns);

  openSheet(`<h2>Usage</h2>
    <div class="row" style="margin-bottom:12px">
      ${d.windows.map((w) => `<button class="ghost win${w === d.window ? ' on' : ''}" data-win="${w}">${esc(WINDOW_LABEL[w] ?? w)}</button>`).join('')}
    </div>
    ${ordered.map(card).join('')}
    <p class="dim">${money(spend)} metered spend in this window. Subscription models bill against
      their plan instead, so they show no charge.</p>
    <div class="actions"><button class="primary" id="u-close">done</button></div>`);

  $('u-close').onclick = closeSheet;
  $('sheet').querySelectorAll('[data-win]').forEach((el) => {
    el.onclick = () => { usageWindow = el.dataset.win; usageSheet(); };
  });
}

$('usage').onclick = usageSheet;

// ------------------------------------------------------------- file browser

const humanSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const FILE_ICON = { image: '🖼', text: '📄', pdf: '📕', other: '📦' };

let filesAt = null;   // remembered so reopening lands where you left off

async function filesSheet(start) {
  const where = start ?? filesAt ?? state.session?.projectDir ?? state.home;
  let d;
  try {
    d = await api(`/api/files?path=${encodeURIComponent(where)}`);
  } catch (e) {
    openSheet(`<h2>Files</h2><p class="dim">${esc(e.message)}</p>
      <div class="actions"><button class="ghost" id="f-home">go home</button></div>`);
    $('f-home').onclick = () => filesSheet(state.home);
    return;
  }
  filesAt = d.path;

  const rows = [
    d.parent ? `<div class="item" data-dir="${esc(d.parent)}"><div class="grow"><div class="t">../</div></div></div>` : '',
    ...d.dirs.map((x) => `<div class="item" data-dir="${esc(x.path)}">
        <div class="grow"><div class="t">📂 ${esc(x.name)}</div></div></div>`),
    ...d.files.map((f) => `<div class="item" data-file="${esc(f.path)}" data-kind="${f.kind}">
        <div class="grow"><div class="t">${FILE_ICON[f.kind]} ${esc(f.name)}</div>
        <div class="s">${humanSize(f.size)}</div></div></div>`),
  ].join('');

  openSheet(`<h2>Files</h2>
    <p class="dim">${esc(shortDir(d.path))}</p>
    ${d.note ? `<p class="dim warn-text">${esc(d.note)}</p>` : ''}
    ${rows || '<p class="dim">empty folder</p>'}
    <div class="actions">
      <button class="ghost" id="f-back">‹ settings</button>
      ${state.session ? '<button class="ghost" id="f-proj">project folder</button>' : ''}
      <button class="primary" id="f-close">done</button>
    </div>`);

  $('f-close').onclick = closeSheet;
  $('f-back').onclick = settingsSheet;
  if ($('f-proj')) $('f-proj').onclick = () => filesSheet(state.session.projectDir);
  $('sheet').querySelectorAll('[data-dir]').forEach((el) => {
    el.onclick = () => filesSheet(el.dataset.dir);
  });
  $('sheet').querySelectorAll('[data-file]').forEach((el) => {
    el.onclick = () => viewFile(el.dataset.file, el.dataset.kind);
  });
}

async function viewFile(file, kind) {
  const name = file.split('/').pop();
  const src = nodeApi(`/api/file?path=${encodeURIComponent(file)}&session=${encodeURIComponent(state.session?.id || '')}`);
  const back = `<div class="actions"><button class="ghost" id="v-back">back</button>
    <button class="primary" id="v-close">done</button></div>`;

  if (kind === 'image') {
    openSheet(`<h2>${esc(name)}</h2>
      <img src="${src}" alt="${esc(name)}" style="width:100%;border:1px solid var(--line);border-radius:10px" />
      ${back}`);
  } else if (kind === 'pdf') {
    // iOS Safari will not inline a PDF in a sheet; open it in its own tab.
    openSheet(`<h2>${esc(name)}</h2>
      <p class="dim"><a href="${src}" target="_blank" rel="noopener" style="color:var(--accent)">open ${esc(name)}</a></p>
      ${back}`);
  } else {
    let text;
    try {
      text = await (await fetch(src)).text();
    } catch (e) {
      text = `could not read: ${e.message}`;
    }
    openSheet(`<h2>${esc(name)}</h2>
      <pre class="file-body">${esc(text)}</pre>${back}`);
  }

  $('v-back').onclick = () => filesSheet(filesAt);
  $('v-close').onclick = closeSheet;
}


// --------------------------------------------------------- laptop's screen

$('menu').onclick = sessionsSheet;
$('gear').onclick = settingsSheet;
$('push-panel').onclick = gitSheet;
$('ui-reload-now').onclick = reloadKeepingDraft;
$('serving-label')?.addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return; // a new window gets the plain page
  event.preventDefault();
  testBuildSheet();
});
function paintPending() {
  paintComposerAction();
  const box = $('pending');
  box.hidden = pendingShots.length === 0;
  box.innerHTML = pendingShots.map((a, i) => `
    <div class="thumb${a.uploading ? ' busy' : ''}">
      ${a.preview ? `<img src="${esc(a.preview)}" alt="">` : ''}
      <button class="drop" data-drop-shot="${i}" aria-label="Remove">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-drop-shot]').forEach((el) => {
    el.onclick = () => {
      pendingShots.splice(Number(el.dataset.dropShot), 1);
      paintPending();
    };
  });
}

$('attach').onclick = () => {
  if (!cur().session) return showBanner('open a session first — tap ☰');
  $('pick').click();
};

async function attachFiles(files) {
  const session = cur().session;
  if (!session) return showBanner('open a session first — tap ☰');

  for (const file of files) {
    const entry = { name: file.name, uploading: true, preview: URL.createObjectURL(file) };
    pendingShots.push(entry);
    paintPending();
    try {
      const res = await fetch(`/api/sessions/${session.id}/upload`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      Object.assign(entry, body, { uploading: false });
    } catch (e) {
      pendingShots = pendingShots.filter((x) => x !== entry);
      showBanner(e.message);
    }
    paintPending();
  }
}

$('pick').onchange = () => {
  const files = [...$('pick').files];
  $('pick').value = ''; // choosing the same file again still triggers change
  return attachFiles(files);
};

// Only intercept file paste in the composer; ordinary text keeps native paste.
$('input').addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  let files = [...(clipboard.files ?? [])];
  if (!files.length) {
    files = [...(clipboard.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile()).filter(Boolean);
  }
  if (!files.length) return;
  event.preventDefault();
  attachFiles(files);
});

$('model-gear').onclick = () => {
  window.harnessTrace?.('action', { control: 'model-gear' });
  if (state.session) modelWizard(sessionModelTarget(state.session));
};
$('send').onclick = () => send();
$('queue').onclick = () => send(true);
// A hardware keyboard sends on Enter (Shift+Enter for a new line), as in Claude Code.
// Touch keyboards keep Enter for new lines; the send button sends there.
const touchKeyboard = matchMedia('(pointer: coarse)').matches;
$('input').enterKeyHint = touchKeyboard ? 'enter' : 'send';
$('input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.shiftKey || e.altKey) return;
  if (touchKeyboard && !e.metaKey && !e.ctrlKey) return;
  e.preventDefault();
  window.harnessTrace?.('action', { control: 'enter-key', outcome: cur().running ? 'queue' : 'send' });
  send(Boolean(cur().running));
});
$('stop').onclick = async () => {
  const id = cur().session?.id;
  if (!id) return;
  window.harnessTrace?.('action', { control: 'stop' });
  $('stop').disabled = true;
  $('working-label').textContent = 'stopping';
  try {
    const r = await api(`/api/sessions/${id}/stop`, { method: 'POST' });
    // Like interrupting Claude Code: queued messages come back unsent, never vanish.
    const returned = (r.returned || []).filter(m => m.text || m.attachments?.length);
    if (returned.length && cur().session?.id === id) {
      $('input').value = [$('input').value.trim(), ...returned.map(m => m.text)].filter(Boolean).join('\n\n');
      pendingShots.push(...returned.flatMap(m => m.attachments || []).filter(a => a?.path && !pendingShots.some(p => p.path === a.path)));
      $('input').dispatchEvent(new Event('input'));
      paintPending(); // the transcript's "Not sent" note says why it is back
    }
    window.harnessTrace?.('visible', { screen: 'stop', outcome: returned.length ? 'returned-queued' : 'requested', count: returned.length });
  }
  catch (e) { if (cur().session?.id === id) $('working-label').textContent = 'working'; showBanner(`Stop did not reach the computer: ${e.message} The turn may still be running.`, true); }
  finally { $('stop').disabled = false; }
};
$('pause').onclick = async () => {
  window.harnessTrace?.('action', { control: 'pause' });
  try {
    const r = await api(`/api/sessions/${cur().session.id}/pause`, { method: 'POST' });
    setPaused(true, state.tab, r.checkpoint);
    if (r.saved === false) showBanner('Paused, but the pause could not be saved. Resume before restarting the harness, or it will be lost.', true);
  } catch (e) { showBanner(e.message, true); }
};
$('paused-checkpoint').onclick = () => {
  window.harnessTrace?.('action', { control: 'paused-checkpoint' });
  if (cur().checkpoint) viewFile(cur().checkpoint, 'text');
};
$('resume').onclick = async () => {
  window.harnessTrace?.('action', { control: 'resume' });
  $('resume').disabled = true;
  try { await api(`/api/sessions/${cur().session.id}/resume`, { method: 'POST' }); setPaused(false); }
  catch (e) { showBanner(e.message, true); }
  finally { $('resume').disabled = false; }
};

$('sheet-back').onclick = (e) => {
  if (e.target.id !== 'sheet-back') return;
  closeSheet();
};

$('input').addEventListener('input', (e) => {
  paintComposerAction();
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, window.innerHeight * 0.4)}px`;
});

$('transcript').addEventListener('scroll', () => {
  const el = $('transcript');
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
});

// Tap the chip to see what actually ran; tap a step inside it for its output.
$('transcript').addEventListener('click', async (e) => {
  const copy = e.target.closest('.copy-reply');
  if (copy) {
    // Inside the fold header's own click target, so stop it toggling the fold.
    e.stopPropagation();
    const text = copyTexts.get(copy.dataset.copy);
    if (text == null) return;
    const ok = await copyText(text);
    // Say what happened. A copy button that silently failed is the sort of
    // thing you only discover after pasting nothing into the other session.
    // When it cannot copy, it selects the reply instead, so the fallback is
    // one long-press away rather than a dead end.
    if (!ok) selectReply(copy);
    // Kept short: this sits in a header beside the model name on a phone.
    copy.textContent = ok ? 'copied' : 'selected';
    copy.title = ok ? '' : 'Clipboard unavailable here — long-press the highlighted text to copy';
    copy.classList.toggle('failed', !ok);
    setTimeout(() => {
      copy.textContent = 'copy';
      copy.classList.remove('failed');
    }, ok ? 1200 : 3000);
    return;
  }

  const resume = e.target.closest('[data-start-open]');
  if (resume) {
    window.harnessTrace?.('action', { control: 'start-continue' });
    if (!resume.disabled) await openSession(resume.dataset.startOpen);
    return;
  }
  if (e.target.closest('#start-new')) { window.harnessTrace?.('action', { control: 'start-new' }); draft = {}; await newSheet(); return; }
  if (e.target.closest('#start-all')) { window.harnessTrace?.('action', { control: 'start-all' }); await appsSheet(); return; }
  if (e.target.closest('#start-model')) {
    window.harnessTrace?.('action', { control: 'start-model' });
    try {
      const host = state.machines?.self || (await nativeFetch('/api/cluster/status').then(r => r.json())).self;
      await modelWizard(await defaultModelTarget(host, async () => { closeSheet(); await refreshState().catch(() => {}); drawTranscript(); }));
    } catch (error) { showBanner(error.message, true); }
    return;
  }

  const retry = e.target.closest('[data-retry]');
  if (retry) {
    const turn = turnsFrom(cur().session?.events || []).find(t => t.user?.id === retry.dataset.retry);
    if (!turn || retry.disabled) return;
    retry.disabled = true;
    window.harnessTrace?.('action', { control: 'retry' });
    await send(false, { text: turn.user.text, attachments: turn.user.attachments });
    if (retry.isConnected) retry.disabled = false;
    return;
  }
  const login = e.target.closest('[data-copy-login]');
  if (login) {
    const ok = await copyText(login.dataset.copyLogin);
    login.textContent = ok ? 'copied' : 'copy it from above';
    window.harnessTrace?.('action', { control: 'copy-login', outcome: ok ? 'copied' : 'unavailable' });
    return;
  }

  const erase = e.target.closest('[data-erase]');
  if (erase) {
    e.stopPropagation();          // these sit inside a fold header
    if (!confirm('Delete this message? It is removed from the conversation and from the context sent to the model.')) return;
    await editTranscript('erase', { eventId: erase.dataset.erase });
    return;
  }

  const rewind = e.target.closest('[data-rewind]');
  if (rewind) {
    e.stopPropagation();
    if (!confirm('Rewind to here? This message and everything after it are removed from the conversation.')) return;
    // Offered second, so the conversation can be wound back without touching
    // the files if that is all that is wanted.
    const revertFiles = false; // File changes are reversed through a new coding turn.
    await editTranscript('rewind', { eventId: rewind.dataset.rewind, revertFiles });
    return;
  }

  const fold = e.target.closest('[data-fold]');
  if (fold) {
    const key = fold.dataset.fold;
    const body = $(`fold-${key}`);
    if (body) {
      body.hidden = !body.hidden;
      // Record the choice explicitly, so a re-render mid-stream cannot quietly
      // reopen something just closed.
      if (body.hidden) { closedFolds.add(key); openedFolds.delete(key); }
      else { openedFolds.add(key); closedFolds.delete(key); }
      fold.setAttribute('aria-expanded', String(!body.hidden));
      fold.querySelector('.act-caret').textContent = body.hidden ? '▾' : '▴';
    }
    return;
  }

  const card = e.target.closest('.file-card');
  if (card) {
    if (e.target.closest('.file-dl')) return;   // let the download link do its job
    viewFile(card.dataset.openFile, card.dataset.fileKind);
    return;
  }

  const chip = e.target.closest('.act');
  if (chip) {
    const detail = $(`act-${chip.dataset.act}`);
    if (detail) {
      detail.hidden = !detail.hidden;
      chip.querySelector('.act-caret').textContent = detail.hidden ? '▾' : '▴';
    }
    return;
  }
  const head = e.target.closest('.tool-head');
  if (!head) return;
  const body = head.parentElement.querySelector('.tool-body');
  if (body) body.hidden = !body.hidden;
});

/**
 * On a phone the stream is not reliable: the radio sleeps, the tab backgrounds,
 * the connection drops on a cell handover. EventSource reconnects itself, but a
 * missed `done` would leave the composer insisting a turn is still running, or
 * worse, showing idle while the laptop is busy. So the truth is re-checked
 * whenever the tab comes back, and on a slow timer while it is open.
 */
async function reconcile() {
  if (document.hidden) return;
  try {
    await refreshState();
  } catch {
    // offline for the moment; the next tick will try again
  }
}

$('transcript').addEventListener('toggle', (e) => {
  const id = e.target.dataset?.report;
  if (!id) return;
  if (e.target.open) openReports.add(id); else openReports.delete(id);
}, true);

document.addEventListener('visibilitychange', reconcile);
window.addEventListener('online', reconcile);
setInterval(reconcile, 20_000);

let startupRunning = false;
let startupRetry = null;
async function initializeApp() {
  if (startupRunning) return;
  clearTimeout(startupRetry);
  startupRetry = null;
  startupRunning = true;
  try {
    await refreshState();
    // Reconnection must not replace a chat the user already opened or its draft.
    if (!state.session && !openingSession) {
      let last = new URLSearchParams(location.search).get('session');
      try { last ||= sessionStorage.getItem(sessionStorageKey); } catch {}
      if (last && state.sessions.some(s => s.id === last)) await openSession(last, {startup:true});
      else { paintHeader(); drawTranscript(); }
    }
    if ($('banner').dataset.startup === 'waiting') {
      delete $('banner').dataset.startup;
      showBanner('');
    }
    window.harnessTrace?.('visible', {screen:'startup', outcome:'ready'});
  } catch (error) {
    const retryable = !error.status || [502,503,504].includes(error.status);
    if (retryable) {
      showBanner('DO is reconnecting to your computers. Your chat will reopen automatically…');
      $('banner').dataset.startup = 'waiting';
      window.harnessTrace?.('visible', {screen:'startup', outcome:'waiting'});
      // Only read state and reopen the conversation. Never replay a submission.
      startupRetry = setTimeout(() => initializeApp(), 3000);
    } else {
      showBanner(error.message);
      window.harnessTrace?.('visible', {screen:'startup', outcome:'error'});
    }
  } finally { startupRunning = false; }
}

let networkChecking = false;
let networkConnected = false;
async function checkNetworkConnection() {
  if (networkChecking) return;
  networkChecking = true;
  if (!networkConnected) {
    for (const element of document.body.children) {
      if (element.id !== 'network-gate' && element.tagName !== 'SCRIPT') element.inert = true;
    }
  }
  try {
    // Probe the page's serving host, even when a selected execution node is offline.
    // Bound both headers and body so a suspended phone connection cannot lock retries.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let status;
    try {
      const response = await nativeFetch('/api/network', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Connection check returned ${response.status}`);
      status = await response.json();
      if (typeof status.connected !== 'boolean') throw new Error('Invalid connection response');
    } finally { clearTimeout(timeout); }
    const connected = Boolean(status.connected);
    $('network-gate').hidden = connected;
    for (const element of document.body.children) {
      if (element.id !== 'network-gate' && element.tagName !== 'SCRIPT') element.inert = !connected;
    }
    $('network-gate-title').textContent = 'Turn on Tailscale';
    $('network-gate-message').textContent = status.error || status.message || 'Connect Tailscale on this computer. This screen refreshes automatically.';
    const restored = connected && !networkConnected;
    networkConnected = connected;
    traceConnection(connected ? 'connected' : 'host-offline');
    // Opening a chat is separate from transport health; it must not hold this lock.
    if (restored) initializeApp().catch(error => {
      showBanner(error.message);
      window.harnessTrace?.('visible', { screen: 'transcript', outcome: 'initialization-error' });
    });
  } catch {
    $('network-gate').hidden = false;
    $('network-gate-title').textContent = 'Waiting for Harness';
    $('network-gate-message').textContent = 'This browser could not reach Harness on the serving computer. Check that computer is awake and Tailscale is connected on your phone. Retrying automatically…';
    traceConnection('unreachable');
    networkConnected = false;
    for (const element of document.body.children) {
      if (element.id !== 'network-gate' && element.tagName !== 'SCRIPT') element.inert = true;
    }
  } finally { networkChecking = false; }
}
// Recorded when it changes, not on every check.
let tracedConnection = '';
function traceConnection(outcome) {
  if (outcome === tracedConnection) return;
  tracedConnection = outcome;
  window.harnessTrace?.('visible', { screen: 'connection', outcome });
}
// Every check costs the serving computer a Tailscale probe. Check every 3s while
// the gate is up, every 15s while connected, and not at all in a hidden tab.
let networkTick = 0;
window.addEventListener('online', checkNetworkConnection);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNetworkConnection(); });
setInterval(() => {
  if (document.hidden) return;
  networkTick = (networkTick + 1) % 5;
  if (!networkConnected || networkTick === 0) checkNetworkConnection();
}, 3000);
checkNetworkConnection();

// Runtime status is always requested from the selected session owner.
let sessionRuntimePending = false;
setInterval(async () => {
  const session = state.session;
  if (sessionRuntimePending || !session?.ownerNode || state.models[session.model]?.sourceKind !== 'ollama') return;
  sessionRuntimePending = true;
  try {
    const response = await nativeFetch('/api/cluster/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: session.ownerNode, action: 'catalog' }) });
    if (!response.ok) throw new Error('unavailable');
    const catalog = await response.json();
    if (state.session?.id !== session.id || state.session?.model !== session.model) return;
    const status = catalog.models[session.model]?.runtimeStatus || 'unknown';
    $('title-sub').textContent = `${modelEffortLabel(session)} · ${status === 'not loaded' ? 'not loaded ? loads on send' : status === 'loaded' ? 'loaded' : status}`;
  } catch {
    if (state.session?.id === session.id) $('title-sub').textContent = modelEffortLabel(session) + ' · local status unavailable';
  } finally { sessionRuntimePending = false; }
}, 2000);

// Everything above ran: a test build did not break this page. See TEST_BUILD_WATCHDOG.
window.doAppReady = true;
