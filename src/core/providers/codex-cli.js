/**
 * OpenAI models through the local `codex` CLI.
 *
 * The reason this exists is billing, not capability. Codex borrows whichever
 * credential it was signed in with: sign in with a ChatGPT plan and usage is
 * charged against that plan; sign in with an API key and it is metered
 * per-token like any API call. So routing Astra through a Codex session signed
 * in with ChatGPT avoids per-token API charges entirely — the same trick as
 * `claude-cli`, in the other ecosystem.
 *
 * The trade is rate limits instead of a meter, and, as with Claude Code, Codex
 * brings its own agent loop and tools. What comes back is a record of what it
 * did rather than a request for the harness to run tools.
 */

import spawn from 'cross-spawn';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loginPath } from '../tools.js';
import { renderForPrompt } from '../transcript.js';

export const kind = 'codex-cli';

export function makeClient(spec) {
  return { bin: spec.bin || 'codex' };
}

/** Codex inherits a parent agent's environment; strip it so it runs clean. */
async function childEnv() {
  const env = { ...process.env, PATH: await loginPath() };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') {
      delete env[k];
    }
  }
  return env;
}

/**
 * Codex's plan usage, which the `--json` stream does not carry.
 *
 * `codex exec --json` reports token counts but never a rate-limit figure, so
 * this card used to say the CLI does not publish one. It does: every turn
 * appends an `event_msg`/`token_count` line carrying a `rate_limits` object to
 * that thread's rollout file, under
 * `$CODEX_HOME/sessions/<local date>/rollout-<local time>-<thread id>.jsonl`.
 * The figure is therefore read back from disk once the turn is done and
 * translated into the shape `claude-cli` emits, which is what the usage card
 * already knows how to draw.
 */
const WINDOW_NAMES = new Map([[300, 'five_hour'], [10080, 'seven_day'], [43200, 'month']]);

function windowName(minutes) {
  if (WINDOW_NAMES.has(minutes)) return WINDOW_NAMES.get(minutes);
  if (!minutes) return 'window';
  if (minutes % 1440 === 0) return `last ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `last ${minutes / 60} hours`;
  return `last ${minutes} minutes`;
}

function dayDir(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
}

/** The rollout file Codex wrote for this thread, if it can be found. */
export async function findRollout(threadId, { home, now = Date.now() } = {}) {
  if (!threadId) return null;
  const root = path.join(home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  // Those names use local time, so a turn begun before midnight is filed under
  // yesterday. Checking both costs one failed readdir.
  for (const ms of [now, now - 86_400_000]) {
    const dir = path.join(root, dayDir(new Date(ms)));
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    const hit = names.find((n) => n.endsWith('.jsonl') && n.includes(threadId));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** The end of a rollout file, or null. A long session's is not worth reading whole. */
async function readTail(file) {
  try {
    const { size } = await fs.stat(file);
    const TAIL = 512 * 1024;
    if (size <= TAIL) return await fs.readFile(file, 'utf8');
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(TAIL);
      await fh.read(buf, 0, TAIL, size - TAIL);
      return buf.toString('utf8');
    } finally { await fh.close(); }
  } catch { return null; }
}

/**
 * The model and effort Codex recorded for its newest turn, or null. The `--json`
 * stream names neither, but every turn writes a `turn_context` line to the rollout.
 */
export async function readTurnContext(file) {
  const lines = (await readTail(file))?.split('\n') ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"turn_context"')) continue;
    // A tail read can slice the first line in half, and a tool's output can quote this text.
    try {
      const d = JSON.parse(lines[i]);
      if (d.type === 'turn_context' && d.payload?.model) return d.payload;
    } catch { /* keep looking backwards */ }
  }
  return null;
}

/** The newest `rate_limits` recorded in a rollout file, or null. */
export async function readRateLimits(file) {
  const lines = (await readTail(file))?.split('\n');
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    // A tail read can slice the first line in half; that parse simply fails.
    try {
      const rl = JSON.parse(lines[i])?.payload?.rate_limits;
      if (rl) return rl;
    } catch { /* keep looking backwards */ }
  }
  return null;
}

/**
 * The most recent report Codex left behind, from any thread.
 *
 * Plan usage is an account-wide figure, not a per-session one, so the newest
 * rollout on disk is as true as one written by this harness. Reading it means
 * the card is right the moment it is opened rather than only after an Astra
 * turn happens to run.
 */
export async function latestRateLimits({ home, now = Date.now() } = {}) {
  const root = path.join(home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  for (const ms of [now, now - 86_400_000]) {
    const dir = path.join(root, dayDir(new Date(ms)));
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    // Those names begin with a sortable local timestamp, so newest is last.
    const files = names.filter((n) => n.endsWith('.jsonl')).sort().reverse();
    for (const n of files) {
      const rl = await readRateLimits(path.join(dir, n));
      const u = toUnified(rl);
      if (u) return u;
    }
  }
  return null;
}

/** Codex's report, in the shape `normalizeProviderLimits` already understands. */
export function toUnified(rl) {
  if (!rl) return null;
  const unifiedWindows = {};
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.used_percent !== 'number') continue;
    unifiedWindows[windowName(w.window_minutes)] = {
      // Codex says 7.0 for seven percent; the card wants a fraction.
      utilization: w.used_percent / 100,
      // Seconds, like Claude's — the normaliser scales it to milliseconds.
      resetsAt: w.resets_at ?? null,
    };
  }
  if (!Object.keys(unifiedWindows).length) return null;
  return {
    status: rl.plan_type ?? null,
    rateLimitType: rl.rate_limit_reached_type ?? null,
    unifiedWindows,
  };
}

export async function complete({
  client, spec, events, system, onText, onThinking, onToolStart, onToolEnd, onStep,
  onRateLimit, signal, cwd, onModelReport,
}) {
  const reply = {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    steps: [],          // this backend runs its own tools
    stopReason: null,
    usage: { input: 0, output: 0, cached: 0, cacheWrite: 0, ms: 0 },
  };

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...(spec.model ? ['--model', spec.model] : []),
    ...(spec.reasoningEffort ? ['-c', `model_reasoning_effort="${spec.reasoningEffort}"`] : []),
    // The harness already decides what a session may touch; Codex's own
    // sandbox would refuse writes the user has asked for, and `exec` cannot
    // prompt to escalate. Off by default, as `claude-cli` bypasses its
    // permissions by default; `"sandbox": true` in models.json keeps it.
    ...(spec.sandbox === true ? [] : ['--dangerously-bypass-approvals-and-sandbox']),
    // Read the entire prompt from stdin; Windows command arguments are bounded.
    '-',
  ];

  const started = Date.now();
  const child = spawn(client.bin, args, { cwd, env: await childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });

  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });

  // Whole transcript as one prompt, so a session can move between providers.
  //
  // Codex rejects stdin longer than 1,048,576 CHARACTERS — a hard limit on the
  // input itself, not on tokens. Deriving a character budget from the context
  // window overshot it and the turn was refused outright, so the character
  // ceiling is applied directly and wins over any token-derived figure.
  const CODEX_MAX_CHARS = 1_048_576;
  const prefix = system ? system + '\n\nConversation:\n' : '';
  const headroom = Math.max(1, Math.min(spec.maxInputChars ?? CODEX_MAX_CHARS - 16_384, CODEX_MAX_CHARS - 16_384) - prefix.length);
  const fromTokens = spec.contextTokens ? Math.floor(spec.contextTokens * 0.9 * 3.5) : Infinity;

  child.stdin.on('error', () => {}); // Early CLI exits are reported through close/stderr.
  child.stdin.end(prefix + renderForPrompt(events, {
    budgetChars: Math.min(headroom, fromTokens),
  }));

  const pending = new Map();   // call id -> name, to label results
  let stderr = '';
  let buf = '';

  // The model and effort this message went to, in Codex's own words. Only its
  // session file fills this in, never DO's settings: if it says nothing, neither do we.
  let modelReport = '';
  const reportTurn = async () => {
    const file = await findRollout(reply.threadId);
    const turn = file ? await readTurnContext(file) : null;
    if (!turn) return false;
    const where = `session file ${path.basename(file)}`;
    const next = { by: 'Codex', model: turn.model, modelSource: `${where} (turn_context.model)`,
      ...('effort' in turn ? { effort: turn.effort ?? null, effortSource: `${where} (turn_context.effort)` } : {}) };
    reply.servedModel = turn.model;
    if (JSON.stringify(next) !== modelReport) {
      modelReport = JSON.stringify(next);
      onModelReport?.(next);
    }
    return true;
  };
  // Codex writes its session file while it works, so the first report arrives
  // early in the turn. This stops at the first report or when Codex exits.
  let exited = false;
  let watching = null;
  const watchRollout = async () => {
    while (!exited && !await reportTurn()) await new Promise(resolve => setTimeout(resolve, 250));
  };

  const handle = (line) => {
    let d;
    try { d = JSON.parse(line); } catch { return; }

    switch (d.type) {
      case 'thread.started':
        reply.threadId = d.thread_id;
        watching ??= watchRollout();
        break;

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = d.item ?? {};
        if (item.type === 'agent_message' && d.type === 'item.completed') {
          const text = item.text ?? '';
          if (text) {
            reply.text += text;
            onText?.(text);
            const step = { kind: 'assistant', servedModel: reply.servedModel, text, thinking: '', toolCalls: [], usage: {} };
            reply.steps.push(step);
            onStep?.(step);
          }
        } else if (item.type === 'reasoning' && d.type === 'item.completed') {
          const t = item.text ?? item.summary ?? '';
          if (t) { reply.thinking += t; onThinking?.(t); }
        } else if (item.type === 'command_execution' || item.type === 'file_change') {
          const id = item.id ?? `${item.type}-${pending.size}`;
          const name = item.type === 'file_change' ? 'edit' : 'shell';
          const arg = item.command ?? (item.changes ? Object.keys(item.changes).join(', ') : '');

          if (d.type === 'item.started') {
            pending.set(id, name);
            const call = { id, name, args: { command: arg } };
            reply.steps.push({ kind: 'assistant', text: '', thinking: '', toolCalls: [call], usage: {} });
            onStep?.(reply.steps.at(-1));
            onToolStart?.(call);
          } else if (d.type === 'item.completed') {
            const result = {
              kind: 'tool_result',
              callId: id,
              name: pending.get(id) ?? name,
              ok: (item.exit_code ?? 0) === 0 && item.status !== 'failed',
              output: String(item.aggregated_output ?? item.output ?? '').slice(0, 24_000),
            };
            reply.steps.push(result);
            onStep?.(result);
            onToolEnd?.(result);
          }
        }
        break;
      }

      case 'turn.completed': {
        const u = d.usage ?? {};
        reply.usage.input = u.input_tokens ?? 0;
        reply.usage.cached = u.cached_input_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
        reply.usage.output = u.output_tokens ?? 0;
        reply.stopReason = 'completed';
        break;
      }

      case 'turn.failed':
      case 'error':
        reply.error = d.error?.message ?? d.message ?? 'codex reported an error';
        break;

      default:
        break;
    }
  };

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) handle(l);
  });
  child.stderr.on('data', (c) => { stderr += c; });

  const code = await new Promise((resolve) => {
    child.on('error', (e) => { reply.error = `could not run "${client.bin}": ${e.message}`; resolve(-1); });
    child.on('close', resolve);
  });

  signal?.removeEventListener('abort', abort);
  if (buf.trim()) handle(buf);
  exited = true;
  await watching;

  // Plan usage arrives on disk rather than down the pipe; the rollout file is
  // complete by the time the process is. A failure here is not the turn's
  // failure, so it only costs the percentage on the card.
  if (reply.threadId) {
    await reportTurn(); // the session file is complete now, so this is Codex's final word
    const file = await findRollout(reply.threadId);
    const info = file ? toUnified(await readRateLimits(file)) : null;
    if (info) {
      reply.rateLimit = info;
      onRateLimit?.(info);
    }
  }

  reply.usage.ms = Date.now() - started;
  if (code !== 0 && !reply.error) {
    reply.error = signal?.aborted
      ? 'stopped by user'
      : `codex exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`;
  }
  return reply;
}
