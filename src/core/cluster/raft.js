/** Durable replicated log. No execution is replayed when a coordinator changes.
 * One voter is standalone; two deliberately favour availability during a split.
 * Three and up require a majority, including both sets during membership changes.
 *
 * Elections use a pre-vote round, so a host that restarts or loses a heartbeat
 * cannot depose a healthy main: it only campaigns once every reachable peer
 * agrees nobody is leading. With two hosts the first to ask wins; a peer that
 * answers "no" blocks it, a peer that does not answer at all does not.
 *
 * Committed entries are compacted into snapshot.json so replica.json stays
 * small; a follower that falls behind the compacted prefix receives the
 * snapshot instead of the entries.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { importProjects } from './project-import.js';

export const quorum = (n) => n < 3 ? 1 : Math.floor(n / 2) + 1;
const majority = (n) => Math.floor(n / 2) + 1;
const copy = (value) => structuredClone(value);
const size = (value) => Buffer.byteLength(JSON.stringify(value));
// A peer that answered within this window still counts toward quorum.
const QUORUM_MS = 3000;
// Hearing from a main this recently means an election would only disrupt it.
const LEADER_MS = 3500;
// Compact once the committed tail holds this many entries or bytes.
const COMPACT_ENTRIES = 64;
const COMPACT_BYTES = 16_000_000;
const BATCH_BYTES = 8_000_000;
export async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
  // Windows does not support opening directories for fsync; file data was flushed above.
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function blankState(initial) {
  const state = { sessions: {}, viewers: {}, preferred: initial[0].id, history: {}, values: {} };
  for (const node of initial) state.history[node.id] = node;
  return state;
}
export function applyCommand(state, c) {
  if (c.type === 'project-import') importProjects(state, c);
  else if (c.type === 'session') {
    if (c.value === null) {
      const appId = state.sessions[c.id]?.appId;
      if (appId && c.at && state.values['settings:apps.json']) {
        const registry = JSON.parse(state.values['settings:apps.json']);
        const app = registry.apps.find(a => a.id === appId);
        if (app) app.updatedAt = Math.max(app.updatedAt || 0, c.at);
        state.values['settings:apps.json'] = JSON.stringify(registry);
      }
      delete state.sessions[c.id];
    } else state.sessions[c.id] = c.value;
  } else if (c.type === 'viewer' || c.type === 'viewer-v2') {
    if (c.version === 2) {
      for (const [id, viewer] of Object.entries(state.viewers))
        if (viewer.version !== 2 || c.at - viewer.lastSeen >= 45000) delete state.viewers[id];
    }
    if (c.value) state.viewers[c.value.id] = c.value;
  } else if (c.type === 'preferred') state.preferred = c.id;
  else if (c.type === 'configuration') for (const node of c.members) state.history[node.id] = node;
  else if (c.type === 'value') { if (c.value === null) delete state.values[c.id]; else state.values[c.id] = c.value; }
}

export class Replica {
  constructor(dir, { self, send, now = () => performance.now(), random = Math.random, onChange = () => {} }) {
    Object.assign(this, { dir, self, send, now, random, onChange });
    this.file = path.join(dir, 'replica.json');
    this.snapshotFile = path.join(dir, 'snapshot.json');
    this.role = 'follower'; this.leader = null; this.lastContact = new Map();
    this.next = new Map(); this.match = new Map(); this.queue = Promise.resolve();
    this.acked = new Map(); this.inflight = new Map(); this.leaderSeen = -Infinity;
    this.proposals = Promise.resolve(); this.busy = false; this.snapshot = null; this.applied = 0;
  }
  async init() {
    try { this.disk = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.disk = { clusterId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('hex'), term: 0,
        votedFor: null, commit: 0, log: [], initial: [this.self] };
      await this.persist();
    }
    Object.assign(this.disk, { base: this.disk.base || 0, baseTerm: this.disk.baseTerm || 0, baseId: this.disk.baseId ?? null });
    try { this.snapshot = JSON.parse(await fs.readFile(this.snapshotFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (this.disk.base && !this.snapshot) throw new Error(`Cluster snapshot missing: ${this.snapshotFile}`);
    if (this.snapshot && this.snapshot.index > this.disk.base) {
      // Crashed between writing a snapshot and trimming the log. A compaction
      // only covers committed entries, so they are still here; an installed
      // snapshot replaces the log entirely.
      const compacted = this.disk.commit >= this.snapshot.index;
      this.disk.log = compacted ? this.disk.log.slice(this.snapshot.index - this.disk.base) : [];
      Object.assign(this.disk, { base: this.snapshot.index, baseTerm: this.snapshot.term, baseId: this.snapshot.id,
        commit: Math.max(this.disk.commit, this.snapshot.index) });
      await this.persist();
    }
    this.rebuild(); this.resetElection();
    await this.exclusive(() => this.compact());
    if (this.members().length === 1) await this.campaign();
    return this;
  }
  exclusive(fn) {
    const task = this.queue.catch(() => {}).then(fn); this.queue = task; return task;
  }
  persist() { return atomic(this.file, this.disk); }
  length() { return this.disk.base + this.disk.log.length; }
  entry(i) { return i > this.disk.base ? this.disk.log[i - this.disk.base - 1] : undefined; }
  termAt(i) { return i === 0 ? 0 : i === this.disk.base ? this.disk.baseTerm : this.entry(i)?.term; }
  idAt(i) { return i === 0 ? null : i === this.disk.base ? this.disk.baseId : this.entry(i)?.id; }
  resetElection() {
    const preferred = this.state?.preferred === this.self.id;
    this.deadline = this.now() + (preferred ? 3500 : 5000) + this.random() * 1500;
  }
  configuration() {
    const entry = this.disk.log.findLast((e) => e.command.type === 'configuration');
    return entry?.command || this.snapshot?.configuration || { members: this.disk.initial };
  }
  configurationAt(index) {
    const entry = this.disk.log.slice(0, index - this.disk.base).findLast((e) => e.command.type === 'configuration');
    return entry?.command || this.snapshot?.configuration || { members: this.disk.initial };
  }
  members() {
    const config = this.configuration();
    return [...new Map([...(config.old || []), ...config.members].map((n) => [n.id, n])).values()];
  }
  // One or two hosts: any single host may lead, and a split can produce two mains.
  availability() { return this.configuration().members.length <= 2; }
  enough(ids) {
    const c = this.configuration();
    const count = (members) => members.filter((n) => ids.has(n.id)).length;
    // Growing to two hosts must never need both of them: that is exactly how a
    // join interrupted before its final configuration used to leave the
    // survivor unable to elect itself once the other machine switched off.
    if (c.members.length <= 2) return count(c.members) >= 1;
    // Upgrading to three or more requires an actual old majority, even for a
    // two-host availability cluster: both hosts must acknowledge it.
    return count(c.members) >= majority(c.members.length) &&
      (!c.old || count(c.old) >= majority(c.old.length));
  }
  rebuild() {
    this.state = this.snapshot ? copy(this.snapshot.state) : blankState(this.disk.initial);
    this.applied = this.snapshot ? this.snapshot.index : 0;
    this.apply();
  }
  apply() {
    for (let i = this.applied + 1; i <= this.disk.commit; i++) applyCommand(this.state, this.entry(i).command);
    this.applied = this.disk.commit;
    this.onChange(this);
  }
  async compact(force = false) {
    let index = this.disk.commit;
    const base = this.disk.base;
    // A main keeps entries that connected hosts still need, so a host a few
    // entries behind catches up from the log rather than a full snapshot.
    if (this.role === 'leader') {
      const recent = this.recent();
      for (const [id, at] of this.match) if (id !== this.self.id && recent.has(id)) index = Math.min(index, at);
    }
    if (index <= base) return;
    const tail = this.disk.log.slice(0, index - base);
    if (!force && tail.length < COMPACT_ENTRIES && size(tail) < COMPACT_BYTES) return;
    // A connected follower can lag behind commit. A snapshot must describe
    // exactly its index, never include later commands (especially deletions).
    const state = this.snapshot ? copy(this.snapshot.state) : blankState(this.disk.initial);
    for (let i = base + 1; i <= index; i++) applyCommand(state, this.entry(i).command);
    const snapshot = { index, term: this.termAt(index), id: this.idAt(index), configuration: this.configurationAt(index), state };
    await atomic(this.snapshotFile, snapshot);
    this.snapshot = { ...snapshot, state: copy(state) };
    this.disk.log = this.disk.log.slice(index - base);
    Object.assign(this.disk, { base: index, baseTerm: snapshot.term, baseId: snapshot.id });
    await this.persist();
  }
  /** Standalone hosts may change their own published address. */
  async setStandalone(self) {
    this.disk.initial = [self];
    if (this.snapshot) {
      this.snapshot.configuration = { members: [self] };
      this.snapshot.state.history[self.id] = self;
      await atomic(this.snapshotFile, this.snapshot);
    }
    await this.persist(); this.rebuild();
  }
  exportState() { return { disk: copy(this.disk), snapshot: this.snapshot && copy(this.snapshot) }; }
  async importState({ disk, snapshot }) {
    if (snapshot) await atomic(this.snapshotFile, snapshot); else await fs.rm(this.snapshotFile, { force: true });
    this.snapshot = snapshot || null;
    this.disk = { base: 0, baseTerm: 0, baseId: null, ...disk };
    this.role = 'follower'; this.leader = null;
    await this.persist(); this.rebuild(); this.resetElection();
  }
  stepDown(term) {
    if (term > this.disk.term) { this.disk.term = term; this.disk.votedFor = null; }
    this.role = 'follower'; this.leader = null; this.acked.clear();
  }
  recent() {
    const at = this.now();
    return new Set([this.self.id, ...[...this.acked].filter(([, t]) => at - t < QUORUM_MS).map(([id]) => id)]);
  }
  writable() {
    return this.role === 'leader' && this.enough(this.recent()) && this.termAt(this.disk.commit) === this.disk.term;
  }
  leaderAlive() {
    return (this.role === 'leader' && this.writable()) || (Boolean(this.leader) && this.now() - this.leaderSeen < LEADER_MS);
  }
  logCurrent(message) {
    const last = this.length(), lastTerm = this.termAt(last);
    return message.lastTerm > lastTerm || (message.lastTerm === lastTerm && message.lastIndex >= last);
  }
  async receive(message) {
    return this.exclusive(async () => {
      if (!this.members().some((n) => n.id === message.from)) throw new Error('Unknown cluster member');
      if (message.kind === 'prevote') {
        // Changes nothing: it only asks whether a real election could succeed.
        const busy = this.leaderAlive() && this.leader !== message.from;
        return { term: this.disk.term, ok: !busy && message.term >= this.disk.term && this.logCurrent(message), leader: busy ? this.leader : null };
      }
      if (message.kind === 'vote' && message.term > this.disk.term && this.leaderAlive() && this.leader !== message.from) {
        return { term: this.disk.term, ok: false, leader: this.leader };
      }
      if (message.term > this.disk.term) { this.stepDown(message.term); await this.persist(); }
      if (message.term < this.disk.term) return { term: this.disk.term, ok: false };
      this.lastContact.set(message.from, Date.now());
      if (message.kind === 'vote') {
        const ok = this.logCurrent(message) && (!this.disk.votedFor || this.disk.votedFor === message.from);
        if (ok) { this.disk.votedFor = message.from; this.resetElection(); await this.persist(); }
        return { term: this.disk.term, ok };
      }
      if (message.kind === 'snapshot') return this.install(message);
      if (message.kind !== 'append') throw new Error('Unknown cluster message');
      this.role = 'follower'; this.leader = message.from; this.leaderSeen = this.now(); this.resetElection();
      this.sightings = { ...(message.sightings || {}), [message.from]: Date.now() };
      const commitBefore = this.disk.commit, termBefore = this.disk.term;
      let prev = message.prev, entries = message.entries;
      if (prev < this.disk.base) {
        // Entries up to our base are already compacted. Check that they are
        // the same history before skipping them.
        const skip = this.disk.base - prev;
        if (entries.length < skip) return { term: this.disk.term, ok: false, length: this.disk.base, ahead: true };
        const boundary = entries[skip - 1];
        if (boundary.term !== this.disk.baseTerm || (this.disk.baseId && boundary.id !== this.disk.baseId)) {
          await this.divergedBase();
          return { term: this.disk.term, ok: false, length: 0 };
        }
        prev = this.disk.base; entries = entries.slice(skip);
      }
      if (prev > this.length()) return { term: this.disk.term, ok: false, length: this.length() };
      if (prev && (this.termAt(prev) !== message.prevTerm || (message.prevId && this.idAt(prev) && this.idAt(prev) !== message.prevId))) {
        if (prev === this.disk.base) { await this.divergedBase(); return { term: this.disk.term, ok: false, length: 0 }; }
        return { term: this.disk.term, ok: false, length: Math.min(prev - 1, this.length()) };
      }
      let index = prev, truncated = false, changed = false;
      for (const entry of entries) {
        const old = this.entry(index + 1);
        if (old && (old.term !== entry.term || old.id !== entry.id)) {
          if (index < this.disk.commit) {
            if (!this.availability()) throw new Error('Refusing to replace a committed majority log');
            // Two isolated hosts can both accept changes. Keep the losing
            // branch on disk for recovery; never silently erase its transcript.
            await this.archive();
            this.disk.commit = index; truncated = true;
          }
          this.disk.log.length = index - this.disk.base;
        }
        if (!this.entry(index + 1)) { this.disk.log.push(copy(entry)); changed = true; }
        index++;
      }
      this.disk.commit = Math.max(this.disk.commit, Math.min(message.commit, index));
      // A heartbeat that changes nothing is not rewritten to disk.
      if (changed || truncated || this.disk.commit !== commitBefore || this.disk.term !== termBefore) {
        await this.persist();
        if (truncated) this.rebuild(); else this.apply();
        await this.compact();
      }
      return { term: this.disk.term, ok: true, length: index };
    });
  }
  async archive(conflict = true) {
    const name = `conflict-${Date.now()}-${crypto.randomUUID()}`;
    await atomic(path.join(this.dir, `${name}.json`), this.disk);
    if (this.snapshot) await fs.copyFile(this.snapshotFile, path.join(this.dir, `${name}-snapshot.json`));
    if (conflict) this.disk.conflicts = (this.disk.conflicts || 0) + 1;
  }
  /** Our compacted history is a losing two-host branch: keep it and start over. */
  async divergedBase() {
    if (!this.availability()) throw new Error('Refusing to replace a committed majority log');
    await this.archive();
    // Keep the membership so the main that replaces this history is still known.
    this.disk.initial = this.members();
    await fs.rm(this.snapshotFile, { force: true });
    this.snapshot = null;
    Object.assign(this.disk, { base: 0, baseTerm: 0, baseId: null, commit: 0, log: [] });
    await this.persist(); this.rebuild();
  }
  async install(message) {
    this.role = 'follower'; this.leader = message.from; this.leaderSeen = this.now(); this.resetElection();
    if (message.index <= this.disk.commit && this.termAt(message.index) === message.snapTerm && this.idAt(message.index) === message.snapId) {
      return { term: this.disk.term, ok: true, length: message.index };
    }
    // Usually this host was simply offline and behind. Committed entries the
    // snapshot might not contain are still kept; beyond it they are a conflict.
    if (this.snapshot || this.disk.commit > this.disk.base) await this.archive(this.disk.commit >= message.index);
    const snapshot = { index: message.index, term: message.snapTerm, id: message.snapId, configuration: message.configuration, state: message.state };
    await atomic(this.snapshotFile, snapshot);
    this.snapshot = snapshot;
    Object.assign(this.disk, { base: snapshot.index, baseTerm: snapshot.term, baseId: snapshot.id, commit: snapshot.index, log: [] });
    await this.persist(); this.rebuild();
    return { term: this.disk.term, ok: true, length: snapshot.index };
  }
  voteRequest(kind, term) {
    const last = this.length();
    return { kind, from: this.self.id, term, lastIndex: last, lastTerm: this.termAt(last) || 0 };
  }
  /** Ask every reachable peer whether an election could succeed right now. */
  async preVote() {
    const request = this.voteRequest('prevote', this.disk.term + 1);
    const grants = new Set([this.self.id]); let refused = false;
    await Promise.all(this.members().filter((n) => n.id !== this.self.id).map(async (node) => {
      try {
        const response = await this.send(node, request);
        if (response.ok) grants.add(node.id); else refused = true;
      } catch { /* An unreachable peer neither grants nor blocks. */ }
    }));
    return this.enough(grants) && !(refused && this.availability());
  }
  async campaign() {
    if (!this.members().some((n) => n.id === this.self.id)) return;
    const request = await this.exclusive(async () => {
      this.role = 'candidate'; this.leader = null; this.disk.term++; this.disk.votedFor = this.self.id;
      this.resetElection(); await this.persist();
      return this.voteRequest('vote', this.disk.term);
    });
    const votes = new Set([this.self.id]); let refused = false;
    await Promise.all(this.members().filter((n) => n.id !== this.self.id).map(async (node) => {
      try {
        const response = await this.send(node, request);
        await this.exclusive(async () => {
          if (response.term > this.disk.term) { this.stepDown(response.term); await this.persist(); }
          if (response.term === request.term && response.ok) votes.add(node.id); else refused = true;
        });
      } catch { /* Unreachable voters are never counted. */ }
    }));
    await this.exclusive(async () => {
      if (this.role !== 'candidate' || this.disk.term !== request.term || !this.enough(votes)) return;
      // Two hosts: whoever asks first leads. A peer that answered no is alive
      // and has chosen someone else, so winning alone would split the cluster.
      if (refused && this.availability()) { this.role = 'follower'; return; }
      this.role = 'leader'; this.leader = this.self.id; this.acked.clear();
      for (const id of votes) if (id !== this.self.id) this.acked.set(id, this.now());
      for (const n of this.members()) { this.next.set(n.id, this.length() + 1); this.match.set(n.id, 0); }
      this.disk.log.push({ term: this.disk.term, id: crypto.randomUUID(), command: { type: 'noop' } });
      await this.persist();
    });
    if (this.role === 'leader') await this.replicate();
  }
  async replicate() {
    if (this.role !== 'leader') return;
    const term = this.disk.term;
    // Each peer has at most one request in flight, so a slow catch-up on one
    // host never delays heartbeats or commits for the others.
    for (const node of this.members()) {
      if (node.id === this.self.id || this.inflight.has(node.id)) continue;
      this.inflight.set(node.id, this.sendTo(node, term).finally(() => this.inflight.delete(node.id)));
    }
    // Wait only for hosts that have answered recently. A sleeping computer
    // drops packets rather than refusing them, and waiting out its request on
    // every save cost each one a second. Its request still runs, and a late
    // answer advances the commit as it arrives.
    const recent = this.recent();
    const awaited = [...this.inflight].filter(([id]) => recent.has(id)).map(([, request]) => request);
    let timer;
    if (awaited.length) await Promise.race([Promise.all(awaited), new Promise((r) => { timer = setTimeout(r, 1000); timer.unref?.(); })]);
    clearTimeout(timer);
    await this.exclusive(() => this.advance(term));
  }
  async sendTo(node, term) {
    try {
      const next = this.next.get(node.id) || 1;
      const prev = next - 1;
      let message;
      if (prev < this.disk.base) {
        message = { kind: 'snapshot', from: this.self.id, term, index: this.snapshot.index, snapTerm: this.snapshot.term,
          snapId: this.snapshot.id, configuration: this.snapshot.configuration, state: this.snapshot.state };
      } else {
        const entries = [];
        let bytes = 0;
        for (const entry of this.disk.log.slice(prev - this.disk.base, prev - this.disk.base + 32)) {
          const bytesOf = size(entry);
          if (entries.length && bytes + bytesOf > BATCH_BYTES) break;
          entries.push(copy(entry)); bytes += bytesOf;
        }
        message = { kind: 'append', from: this.self.id, term, prev, prevTerm: this.termAt(prev) || 0, prevId: this.idAt(prev),
          entries, commit: this.disk.commit,
          sightings: { ...this.sightings, ...Object.fromEntries(this.lastContact), [this.self.id]: Date.now() } };
      }
      const response = await this.send(node, message);
      await this.exclusive(async () => {
        if (response.term > this.disk.term) { this.stepDown(response.term); await this.persist(); return; }
        if (this.role !== 'leader' || this.disk.term !== term) return;
        // Any answer in our term means that host still recognises this main.
        this.acked.set(node.id, this.now()); this.lastContact.set(node.id, Date.now());
        const reached = message.kind === 'snapshot' ? message.index : prev + message.entries.length;
        if (response.ok) {
          this.match.set(node.id, reached); this.next.set(node.id, reached + 1);
        } else if (response.ahead) this.next.set(node.id, response.length + 1);
        else this.next.set(node.id, Math.max(1, Math.min(next - 1, (response.length ?? prev) + 1)));
        await this.advance(term);
      });
    } catch { /* Retry catch-up on the next heartbeat. */ }
  }
  async advance(term) {
    if (this.role !== 'leader' || term !== this.disk.term) return;
    this.match.set(this.self.id, this.length());
    for (let i = this.length(); i > this.disk.commit; i--) {
      if (this.termAt(i) !== term) continue;
      if (this.enough(new Set([...this.match].filter(([, at]) => at >= i).map(([id]) => id)))) {
        this.disk.commit = i; await this.persist(); this.apply(); await this.compact(); break;
      }
    }
  }
  propose(command) {
    const task = this.proposals.catch(() => {}).then(async () => {
      if (!this.writable()) throw new Error('No coordinator quorum. Wait for the machines to reconnect.');
      const term = this.disk.term;
      const id = crypto.randomUUID();
      await this.exclusive(async () => {
        this.disk.log.push({ term, id, command: copy(command) }); await this.persist();
      });
      const deadline = this.now() + 10000;
      do {
        await this.replicate();
        const at = this.disk.log.findIndex((e) => e.id === id);
        // Missing from the log means compacted, which only happens once committed;
        // a main never truncates its own log, so it cannot have been discarded.
        if (at >= 0 ? this.disk.base + at + 1 <= this.disk.commit : this.role === 'leader' && this.disk.term === term) return;
        if (this.role !== 'leader' || this.disk.term !== term) throw new Error('Coordinator changed; the result is uncertain. Refresh before retrying.');
        await new Promise((r) => setTimeout(r, 50));
      } while (this.now() < deadline);
      throw new Error('Replication timed out; the result is uncertain. Refresh before retrying.');
    });
    this.proposals = task; return task;
  }
  /** A leader completes a joint membership change once its first half commits. */
  finishJoin() {
    const c = this.configuration();
    if (!c.old || this.finishing || !this.writable()) return;
    const at = this.disk.log.findLastIndex((e) => e.command.type === 'configuration');
    if (at >= 0 && this.disk.base + at + 1 > this.disk.commit) return;
    this.finishing = this.propose({ type: 'configuration', members: c.members })
      .catch(() => {}).finally(() => { this.finishing = null; });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.role === 'leader') {
        await this.replicate();
        if (!this.writable()) this.stepDown(this.disk.term); else this.finishJoin();
      } else if (this.now() > this.deadline) {
        this.resetElection();
        if (await this.preVote()) await this.campaign();
      }
    } finally { this.busy = false; }
  }
  start() { clearInterval(this.timer); this.timer = setInterval(() => this.tick().catch(() => {}), 700); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
}
