// Runs before loading server code or installing dependencies. No npm imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function startupUpdate(root) {
  const git = async (...args) => (await exec('git', args, { cwd: root, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  // Source archives have no tracked branch to update.
  if (!await fs.stat(path.join(root, '.git')).catch(() => null)) {
    console.log('Startup update unavailable: this is not a Git checkout.');
    return;
  }
  console.log('Checking GitHub for updates before starting…');
  const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const lock = path.join(common, 'harness-integration.lock');
  await fs.mkdir(lock).catch(() => { throw Error('Startup update blocked: another integration is in progress. Retry when it finishes.'); });
  try {
    if (await git('status', '--porcelain')) throw Error('Local changes must be committed or resolved before startup can update.');
    const branch = await git('symbolic-ref', '--short', 'HEAD');
    const remote = await git('config', `branch.${branch}.remote`);
    const ref = await git('config', `branch.${branch}.merge`);
    if (!remote || remote === '.' || !ref.startsWith('refs/heads/')) throw Error('Configure a remote tracking branch before starting.');
    try { await git('fetch', '--no-tags', remote, ref); }
    catch (error) {
      // Only a previously published, clean local revision is an offline fallback.
      // Missing tracking evidence, local divergence and dependency errors remain fatal.
      const head = await git('rev-parse', 'HEAD');
      const known = await git('rev-parse', '@{upstream}');
      if (head !== known) throw error;
      console.warn('Remote update unavailable; starting the clean, previously tracked local revision.');
      return head;
    }
    const latest = await git('rev-parse', 'FETCH_HEAD');
    await git('merge', '--ff-only', latest);
    const head = await git('rev-parse', 'HEAD');
    if (head !== latest) throw Error('Local commits have not been published. Publish them before starting.');
    console.log(`Startup update verified: ${head.slice(0, 12)}`);
    return head;
  } catch (error) {
    throw Error(`Harness was not started: update check failed. ${error.stderr || error.message}`);
  } finally { await fs.rmdir(lock); }
}
