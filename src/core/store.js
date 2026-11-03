import { atomicFile } from './atomic-file.js';
/**
 * Session persistence. A session is one project run: a name, a directory, a
 * model, and the neutral event transcript.
 *
 * Sessions are the unit of comparison. To A/B two models on the same work, run
 * two sessions - or fork one, which copies the history so the second model
 * starts from identical context.
 *
 * Files are replaced atomically after saved events. Accepted text is distinct
 * from an executable job: pending queues are process-local unless a pause saved
 * them (session.pause), and external side effects are not replayed after a crash.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { HARNESS_ROOT, HARNESS_APP_ID } from './harness-guard.js';

import { danglingToolCalls, noteEvent, toolResultEvent } from './transcript.js';

let sessionsDir = null;
let cluster = null;
export function useCluster(value) { cluster = value; }
const shared = () => cluster?.shared();

export function init(userDataDir) {
  sessionsDir = path.join(userDataDir, 'sessions');
  return fs.mkdir(sessionsDir, { recursive: true });
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20) || 'session'
  );
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fileFor(id) {
  return path.join(sessionsDir, `${id}.json`);
}

export function newSession({ name, model, projectDir, system = '', mode = 'agent', appId = null }) {
  return {
    id: `${stamp()}-${slug(name)}-${crypto.randomUUID().slice(0, 8)}`,
    name: name || 'untitled',
    model,
    mode,
    // Which app this session is working on. Several sessions attach to one app
    // on purpose — that is how a model comparison is run.
    appId,
    projectDir,
    system,
    confineToProjectDir: true,
    // Publishing requires the explicit frontend Push action.
    gitPush: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
  };
}

// One in-flight write per session. Steps from an agent backend arrive faster
// than a write completes, and two saves racing on a shared temp filename meant
// the second rename found nothing there — which crashed the server mid-turn.
const writing = new Map();

export async function save(session) {
  if (shared()) {
    session.updatedAt = Date.now();
    session.ownerNode ||= cluster.self.id;
    // The coordinator accepts writes from the assigned execution host.
    await cluster.saveSession(session);
    return session;
  }
  const prior = writing.get(session.id) ?? Promise.resolve();

  const run = prior
    .catch(() => {})                       // one failed write must not poison the queue
    .then(async () => {
      session.updatedAt = Date.now();
      const file = fileFor(session.id);
      await atomicFile(file, `${JSON.stringify(session, null, 2)}\n`);
      return session;
    });

  writing.set(session.id, run);
  try {
    return await run;
  } finally {
    if (writing.get(session.id) === run) writing.delete(session.id);
  }
}

/**
 * @param repair  close out unanswered tool calls left by a crash. Must be off
 *                while a turn is in flight: a tool that has been recorded but
 *                has not returned yet is normal, not damage, and "repairing"
 *                it corrupts a live transcript.
 */
export async function load(id, { repair = true } = {}) {
  const session = shared() ? await cluster.readSession(id) : JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  if (!session) throw new Error('Session not found');
  // Built-in sessions follow this checkout, not a historical folder alias.
  if (session.appId === HARNESS_APP_ID && session.projectDir !== HARNESS_ROOT) {
    session.projectDir = HARNESS_ROOT;
    if (!shared() || cluster.replica.writable()) await save(session);
  }
  if (!repair) return session;

  // Repair a transcript left mid-turn by a crash or a force-quit. Both APIs
  // reject unanswered tool calls, so the next send would fail with a confusing
  // error unless we close them out here.
  const dangling = danglingToolCalls(session.events ?? []);
  if (dangling.length) {
    for (const d of dangling) {
      session.events.push(
        toolResultEvent({
          callId: d.id,
          name: d.name,
          ok: false,
          output: 'interrupted - the app closed before this tool finished',
        }),
      );
    }
    session.events.push(noteEvent(`recovered ${dangling.length} interrupted tool call(s)`));
    await save(session);
  }

  return session;
}

function lastMessageAt(session) {
  return (session.events || []).reduce((at, event) =>
    event.type === 'user' ? Math.max(at, event.ts || 0) : at, session.createdAt || 0);
}

/** How the latest turn ended when it did not simply answer: error, interrupted or stopped. */
function lastOutcome(session) {
  const events = session.events || [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'user') return null;
    if (events[i].type === 'note' && events[i].outcome) return events[i].outcome;
  }
  return null;
}

export async function list() {
  if (shared()) return Object.values(cluster.replica.state.sessions).map((s) => ({
    id: s.id, name: s.name, model: s.model, appId: s.appId ?? null, projectDir: s.projectDir,
    lastMessageAt: lastMessageAt(s), outcome: lastOutcome(s), turnHost: s.turnHost, paused: Boolean(s.pause),
    ownerNode: s.ownerNode, createdAt: s.createdAt, updatedAt: s.updatedAt,
    turns: (s.events || []).filter((e) => e.type === 'assistant').length,
    modelsUsed: [...new Set((s.events || []).filter((e) => e.type === 'assistant').map((e) => e.model))],
  })).sort((a, b) => b.updatedAt - a.updatedAt);
  let names;
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const s = JSON.parse(await fs.readFile(path.join(sessionsDir, n), 'utf8'));
      out.push({
        id: s.id,
        name: s.name,
        model: s.model,
        appId: s.appId ?? null,
        projectDir: s.projectDir,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastMessageAt: lastMessageAt(s), outcome: lastOutcome(s), turnHost: s.turnHost, paused: Boolean(s.pause),
        turns: (s.events ?? []).filter((e) => e.type === 'assistant').length,
        modelsUsed: [...new Set((s.events ?? []).filter((e) => e.type === 'assistant').map((e) => e.model))],
      });
    } catch {
      // Skip a corrupt file rather than hiding every other session.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function remove(id) {
  if (shared()) return cluster.command({ type: 'session', id, value: null, at: Date.now() });
  await fs.rm(fileFor(id), { force: true });
}
