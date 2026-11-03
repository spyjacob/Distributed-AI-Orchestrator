import { HARNESS_APP_ID } from '../harness-guard.js';
import { hostsFor } from './placement.js';

export function executionHosts(app, members, fallback) {
  if (!app) return [fallback];
  if (app.builtin || app.editsHarness || app.id === HARNESS_APP_ID) return members.map(n => n.id);
  return hostsFor(app, fallback).filter(id => members.some(n => n.id === id));
}

export function executionOwner(session, app, fallback) {
  return session.tabWorkspace?.ownerNode || session.ownerNode || app?.ownerNode || fallback;
}

export function assignmentError(session, target, eligible) {
  if (!eligible.includes(target)) return 'Enable this computer in the project’s Machines settings first.';
  if (session.turnHost) return 'Wait for this tab’s turn and integration to finish.';
  if (session.tabWorkspace && session.tabWorkspace.ownerNode !== target)
    return 'This tab has work on its current computer. Create a new tab on the other computer to preserve that work.';
  return null;
}

/** A stale process cannot resurrect a turn after ownership or recovery changed. */
export function sessionWriteError(current, next) {
  if (!current) return null;
  if (current.ownerNode && current.ownerNode !== next.ownerNode) return 'Tab ownership changed; refresh before saving.';
  if ((current.executionEpoch || 0) !== (next.executionEpoch || 0)) return 'This turn was interrupted; stale writes were refused.';
  return null;
}

/** Recover only the observed turn; a newer turn must never be interrupted. */
export function recoverStoppedTurn(current, observed, note) {
  if (!current?.turnHost || current.turnHost !== observed.turnHost
    || current.turnStartedAt !== observed.turnStartedAt
    || (current.executionEpoch || 0) !== (observed.executionEpoch || 0)) return undefined;
  const next = structuredClone(current);
  delete next.turnHost;
  delete next.turnStartedAt;
  delete next.waitingFor;
  next.executionEpoch = (next.executionEpoch || 0) + 1;
  next.events.push(note);
  return next;
}
