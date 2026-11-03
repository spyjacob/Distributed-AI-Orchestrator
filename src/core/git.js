/**
 * Git integration: the file changes a turn produced, committed and pushed.
 *
 * What is deliberately NOT recorded: anything the user typed. Commit messages
 * describe the files that changed, without model-attribution trailers.
 * The transcript is the harness's business; the repository's history should
 * read as a record of the work, not of the conversation.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { githubEnv } from './github-auth.js';

export const run = async (args, cwd, opts = {}) => {
  const env = await githubEnv();
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, timeout: 120_000, maxBuffer: 8e6, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout ?? '').trim(), err: (stderr ?? '').trim() || err?.message || '' }));
  });
};

export async function status(dir) {
  if (!dir) return { repo: false };
  const top = await run(['rev-parse', '--show-toplevel'], dir);
  if (!top.ok) return { repo: false };

  const root = top.out;
  const [branch, remote, dirty, head] = await Promise.all([
    run(['branch', '--show-current'], root),
    run(['remote', 'get-url', 'origin'], root),
    run(['status', '--porcelain'], root),
    run(['log', '-1', '--format=%h %s'], root),
  ]);

  const changed = dirty.out ? dirty.out.split('\n').length : 0;
  return {
    repo: true,
    root,
    branch: branch.out || null,
    remote: remote.ok ? remote.out : null,
    changed,
    lastCommit: head.ok ? head.out : null,
  };
}

/** Turn `git status --porcelain` into a plain list of paths. */
function pathsFrom(porcelain) {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
}

/**
 * Commit whatever changed and push if there is a remote.
 */
export async function commitAndPush(dir, { push = true, autoCreatePrivate = false, appName } = {}) {
  if (!dir || !await fs.stat(dir).then((s) => s.isDirectory(), () => false)) {
    return { ok: false, error: `Project folder is missing: ${dir || '(unset)'}. Update Settings → Project folder; restart after moving the orchestrator.` };
  }
  let st = await status(dir);
  if (!st.repo) {
    // With auto-create on, a brand-new project becomes a repo rather than being
    // skipped — the whole point of "push every turn by default".
    if (!autoCreatePrivate) return { ok: false, skipped: 'not a git repository' };
    const init = await run(['init', '-b', 'main'], dir);
    if (!init.ok) return { ok: false, error: init.err || 'git init failed' };
    st = await status(dir);
    if (!st.repo) return { ok: false, error: 'could not initialise a git repository' };
  }

  const before = await run(['status', '--porcelain'], st.root);
  const files = pathsFrom(before.out);
  if (!files.length) return { ok: true, skipped: 'no changes' };

  const add = await run(['add', '-A'], st.root);
  if (!add.ok) return { ok: false, error: add.err || 'git add failed' };

  // Nothing about the prompt or the model goes in here — only what changed. The
  // commits are the user's own; they carry no AI-authorship bookkeeping.
  const subject = `harness: ${files.length} file${files.length === 1 ? '' : 's'} changed`;
  const body = files.slice(0, 40).map((f) => `- ${f}`).join('\n')
    + (files.length > 40 ? `\n…and ${files.length - 40} more` : '');

  const message = `${subject}\n\n${body}`;
  const identity = [];
  for (const [key, fallback] of [['user.name', 'Distributed Orchestrator'], ['user.email', 'orchestrator@localhost']]) {
    if (!(await run(['config', '--get', key], st.root)).out) identity.push('-c', `${key}=${fallback}`);
  }
  const commit = await run([...identity, 'commit', '-m', message], st.root);
  if (!commit.ok) {
    return { ok: false, error: commit.err || commit.out || 'git commit failed', files };
  }

  const sha = (await run(['rev-parse', '--short', 'HEAD'], st.root)).out;
  if (!push) return { ok: true, committed: true, sha, files, pushed: false, reason: 'push disabled' };
  const branch = st.branch || 'main';

  if (!st.remote) {
    if (!autoCreatePrivate) {
      return { ok: true, committed: true, sha, files, pushed: false, reason: 'no remote configured' };
    }
    // No GitHub repo yet: create one, private by default, and push this commit.
    // Uses the gh login (found via the real PATH, since the server runs with a
    // minimal one). A failure leaves the commit safely on disk.
    const created = await createPrivateRepo(st.root, branch, appName);
    return {
      ok: true, committed: true, sha, files,
      pushed: created.ok,
      created: created.ok ? created.repo : undefined,
      reason: created.ok ? null : created.reason,
    };
  }

  const pushed = await run(['push', '-u', 'origin', branch], st.root, { timeout: 180_000 });
  return {
    ok: true,
    committed: true,
    sha,
    files,
    pushed: pushed.ok,
    reason: pushed.ok ? null : (pushed.err || 'push failed'),
  };
}

/**
 * Create a private GitHub repo for a folder and push its current branch.
 *
 * Named after the app, preserving case. Private is deliberate here: a new
 * project should never become public by accident — making it public is a
 * separate, explicit step in the app's settings.
 */
export function defaultRepoName(root, appName) {
  return String(appName || path.basename(root)).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/** Rename the linked GitHub repository before changing the app's display name. */
export async function renameAppRepo(app, name, execute = promisify(execFile)) {
  const options = { cwd: app.dir, timeout: 30_000, env: await githubEnv() };
  let remote = '';
  try { remote = (await execute('git', ['remote', 'get-url', 'origin'], options)).stdout.trim(); }
  catch { /* A workspace may not have a local Git repository. */ }
  const linked = app.repo || remote;
  if (!linked) return null;
  const parse = (url) => url.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  const match = parse(linked);
  if (!match) throw new Error('Automatic repository renaming requires a GitHub repository URL.');
  const [, owner, oldName] = match;
  const next = defaultRepoName(app.dir, name);
  if (next !== oldName) {
    await execute('gh', ['api', '--method', 'PATCH', `repos/${owner}/${oldName}`, '-f', `name=${next}`], options);
  }
  const url = `https://github.com/${owner}/${next}.git`;
  const origin = parse(remote);
  if (origin && `${origin[1]}/${origin[2]}`.toLowerCase() === `${owner}/${oldName}`.toLowerCase()) {
    // GitHub redirects the old URL if a local configuration write fails.
    await execute('git', ['remote', 'set-url', 'origin', remote.startsWith('git@')
      ? `git@github.com:${owner}/${next}.git` : url], options);
  }
  return linked.startsWith('git@') ? `git@github.com:${owner}/${next}.git` : url;
}

export function githubRepoIdentity(url) {
  const match = String(url || '').match(/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match ? match[1] + '/' + match[2] : null;
}

export function githubCommitUrl(remote, sha) {
  const repo = githubRepoIdentity(remote);
  return repo && /^[a-f0-9]{7,40}$/i.test(sha || '') ? `https://github.com/${repo}/commit/${sha}` : null;
}

/** Only delete the explicitly linked repository after an exact-name confirmation. */
export async function deleteAppRepo(app, confirmation, execute = promisify(execFile)) {
  if (app.builtin) throw new Error('The built-in project cannot be deleted.');
  const repo = githubRepoIdentity(app.repo);
  if (!repo || confirmation !== repo) throw new Error('Confirm the exact linked GitHub owner/repository.');
  await execute('gh', ['repo', 'delete', repo, '--yes'], {
    cwd: app.dir, timeout: 30_000, env: await githubEnv(),
  });
  return repo;
}

export async function createPrivateRepo(root, branch, appName, visibility = 'private') {
  if (!['private', 'public'].includes(visibility)) throw new Error('Invalid repository visibility');
  const name = defaultRepoName(root, appName);
  const env = await githubEnv();
  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'create', name, '--' + visibility, '--source', root, '--remote', 'origin', '--push'],
      { cwd: root, timeout: 120_000, env },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message) ?? '' }));
  });
  if (res.ok) return { ok: true, repo: name };
  // Most likely: gh not signed in, or a repo of that name already exists.
  return { ok: false, reason: (res.err.trim() || 'gh could not create the repo').split('\n')[0].slice(0, 160) };
}

/** Point a repo at a remote, creating the repo locally if needed. *//** Point a repo at a remote, creating the repo locally if needed. */
export async function connect(dir, remoteUrl) {
  const top = await run(['rev-parse', '--show-toplevel'], dir);
  const root = top.ok ? top.out : dir;
  if (!top.ok) {
    const init = await run(['init', '-b', 'main'], root);
    if (!init.ok) return { ok: false, error: init.err };
  }
  const existing = await run(['remote', 'get-url', 'origin'], root);
  const args = existing.ok ? ['remote', 'set-url', 'origin', remoteUrl] : ['remote', 'add', 'origin', remoteUrl];
  const res = await run(args, root);
  return res.ok ? { ok: true, root, remote: remoteUrl } : { ok: false, error: res.err };
}

/**
 * Repository visibility, via the GitHub CLI.
 *
 * Kept behind `gh` rather than raw API calls so it uses whatever login the user
 * already has, and returns a plain reason when it cannot rather than throwing.
 */
export async function visibility(dir) {
  const st = await status(dir);
  if (!st.repo || !st.remote) return { ok: false, reason: 'no remote' };

  const env = await githubEnv();
  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility,url'],
      { cwd: st.root, timeout: 20_000, env },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message) ?? '' }));
  });
  if (!res.ok) return { ok: false, reason: res.err.trim() || 'gh not available' };

  try {
    const j = JSON.parse(res.out);
    return { ok: true, repo: j.nameWithOwner, visibility: (j.visibility ?? '').toLowerCase(), url: j.url };
  } catch {
    return { ok: false, reason: 'could not read repository info' };
  }
}

export async function setVisibility(dir, want) {
  const st = await status(dir);
  if (!st.repo) return { ok: false, reason: 'not a git repository' };
  if (!['public', 'private'].includes(want)) return { ok: false, reason: 'bad visibility' };

  const env = await githubEnv();
  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'edit', `--visibility=${want}`, '--accept-visibility-change-consequences'],
      { cwd: st.root, timeout: 30_000, env },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message) ?? '' }));
  });
  return res.ok ? { ok: true, visibility: want } : { ok: false, reason: res.err.trim() || 'gh failed' };
}
