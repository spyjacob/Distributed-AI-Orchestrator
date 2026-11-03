/**
 * Resume checkpoints: what a paused turn was doing, in a file the agent re-reads.
 *
 * Pause stops a turn mid-flight. The transcript keeps every step, but a long
 * conversation reaches the next model only as a bounded excerpt, so a pause
 * also writes one short file: the request, the steps that ran, the working
 * tree at that moment and anything queued behind it. Resume asks the agent to
 * read it first. The file is rebuilt from the transcript whenever it is
 * missing, so neither a restart nor a deleted file loses the way back.
 *
 * It lives in the session's own folder, inside a directory that ignores
 * itself, so Push never publishes it and a clean tree stays clean.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicFile, serializedFile } from './atomic-file.js';
import { run as git } from './git.js';
import { usesTools } from './agent.js';

export const CHECKPOINT_DIR = '.harness-resume';
const IGNORE_ALL = '# Written by Distributed Orchestrator: resume checkpoints for paused turns. Safe to delete.\n*\n';
const RESUME_LEAD = 'Resume: the previous turn was paused before it finished.';
const MAX_STEPS = 80;

const clip = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max)}… (${(value.length - max).toLocaleString()} more characters in the conversation)` : value;
};
const oneLine = (text, max = 160) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** Where the agent works, and so where it can read the checkpoint without asking. */
export function workingDir(session) {
  return session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir;
}

/** Chat sessions have no file tools; their resume carries no file. */
export function checkpointFile(session) {
  const dir = workingDir(session);
  if (!usesTools(session) || !dir) return null;
  return path.join(dir, CHECKPOINT_DIR, `${String(session.id).replace(/[^a-zA-Z0-9-]/g, '_')}.md`);
}

/** What the paused work was asked for, looking past earlier resumes of it. */
function pausedRequest(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'user' && !events[i].resume) return i;
  }
  return -1;
}

function stepDetail(args = {}) {
  return oneLine(args.command ?? args.file_path ?? args.path ?? args.notebook_path ?? args.pattern
    ?? args.url ?? args.query ?? args.description ?? '');
}

/** The checkpoint text. Pure: everything it reports is passed in or in the transcript. */
export function renderCheckpoint(session, { pausedAt, host, model, tree, queue = [] } = {}) {
  const events = session.events ?? [];
  const start = pausedRequest(events);
  const request = start >= 0 ? events[start] : null;
  const since = start >= 0 ? events.slice(start + 1) : [];

  const steps = [];
  for (const e of since) {
    if (e.type === 'assistant') for (const call of e.toolCalls ?? []) steps.push({ call, result: null });
    if (e.type === 'tool_result') {
      const step = steps.find(s => s.call.id === e.callId && !s.result);
      if (step) step.result = e;
    }
  }
  const said = since.filter(e => e.type === 'assistant' && e.text?.trim()).at(-1)?.text;
  const shown = steps.slice(-MAX_STEPS);
  const at = new Date(pausedAt ?? Date.now());

  const lines = [
    '# Resume checkpoint: paused turn',
    '',
    'Distributed Orchestrator wrote this when the user paused the turn below. Read it to resume.',
    `It is not part of the project: Git ignores the ${CHECKPOINT_DIR} folder.`,
    '',
    `- Session: ${oneLine(session.name)} (${session.id})`,
    `- Paused: ${at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} (${at.toISOString()})`,
    ...(model ? [`- Model: ${oneLine(model)}`] : []),
    ...(host ? [`- Computer: ${oneLine(host)}`] : []),
    `- Working directory: ${workingDir(session)}`,
    '',
    '## Request being worked on',
    '',
    request ? clip(request.text, 6000) || '(attachments only)' : '(no request found in the conversation)',
    ...(request?.attachments?.length ? ['', ...request.attachments.map(a => `[attached: ${a.path}]`)] : []),
    '',
    '## Progress before the pause',
    '',
  ];
  if (!steps.length) lines.push('No tool steps had run yet.');
  else {
    lines.push(`${steps.length} step${steps.length === 1 ? '' : 's'} ran, oldest first${steps.length > shown.length ? `; the last ${shown.length} are listed` : ''}:`);
    shown.forEach(({ call, result }, i) => {
      const status = !result ? 'cut off by the pause' : result.ok ? 'ok' : 'failed';
      const detail = stepDetail(call.args);
      lines.push(`${steps.length - shown.length + i + 1}. ${status} · ${call.name}${detail ? ` · ${detail}` : ''}`);
    });
  }
  lines.push('', '## Last update from the assistant', '', said ? clip(said, 3000) : '(none yet)');

  lines.push('', '## Working tree when this was written', '');
  if (!tree?.repo) lines.push('Not a Git repository.');
  else if (!tree.changes.length) lines.push('Clean: no uncommitted changes.');
  else lines.push('```', ...tree.changes, ...(tree.more ? [`… ${tree.more} more`] : []), '```');

  if (queue.length) {
    lines.push('', '## Queued to run after this work', '',
      'These are delivered separately once the resumed work finishes; do not start them now.', '');
    queue.slice(0, 10).forEach((m, i) => lines.push(`${i + 1}. ${oneLine(m.text, 500) || '(attachments only)'}`));
  }

  lines.push('', '## How to resume', '',
    '1. Re-check the files listed above (`git status`, `git diff`). The last step may have stopped part-way.',
    '2. Continue the request from where it stopped. Do not repeat steps that already succeeded.',
    '3. Finish with what changed and how it was verified.', '');
  return lines.join('\n');
}

/** Uncommitted changes at the pause, bounded so a huge tree cannot bloat the file. */
async function workingTree(dir) {
  const status = await git(['status', '--porcelain=v1'], dir, { timeout: 15_000 });
  if (!status.ok) return { repo: false };
  const changes = status.out ? status.out.split('\n') : [];
  return { repo: true, changes: changes.slice(0, 60), more: Math.max(0, changes.length - 60) };
}

/**
 * Write the checkpoint. Returns the file, or null when this session has no
 * file tools or no usable folder. Throws only on a failed write, which the
 * caller reports without letting it undo the pause. Writes run in call order,
 * so the turn's own final write is never replaced by an earlier snapshot.
 */
export async function writeCheckpoint(session, info = {}) {
  const file = checkpointFile(session);
  if (!file) return null;
  const dir = workingDir(session);
  return serializedFile(file, async () => {
    if (!(await fs.stat(dir).then(s => s.isDirectory()).catch(() => false))) return null;
    const tree = await workingTree(dir).catch(() => ({ repo: false }));
    const ignore = path.join(path.dirname(file), '.gitignore');
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (!(await fs.stat(ignore).catch(() => null))) await atomicFile(ignore, IGNORE_ALL);
      await atomicFile(file, renderCheckpoint(session, { ...info, tree }));
    } catch (error) {
      // An older checkpoint left in place would send Resume to the wrong point.
      await fs.rm(file, { force: true }).catch(() => {});
      throw error;
    }
    return file;
  });
}

export async function checkpointExists(file) {
  return Boolean(file) && fs.stat(file).then(s => s.isFile()).catch(() => false);
}

/** The message a Resume sends. Without a file it carries the checkpoint itself. */
export function resumeText({ file = null, inline = null } = {}) {
  if (file) return `${RESUME_LEAD} Read the resume checkpoint first: ${file}\nIt records the request, the steps that already ran and the working tree at the pause. Then continue from where it stopped, without repeating completed steps.`;
  if (inline) return `${RESUME_LEAD} Its checkpoint follows. Continue from where it stopped, without repeating completed steps.\n\n${inline}`;
  return `${RESUME_LEAD} Check what was already done, then continue from there without repeating completed steps.`;
}
