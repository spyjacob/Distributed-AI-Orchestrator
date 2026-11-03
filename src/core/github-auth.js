/** Browser onboarding, isolated from the user's existing gh configuration. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loginPath } from './tools.js';
import { loadSecrets, setSecret } from './secrets.js';

const execute = promisify(execFile);
let dataDir;
export function configureGithub(dir) { dataDir = dir; }
export async function githubEnv() {
  const token = dataDir && (await loadSecrets(dataDir)).__github;
  const env = { ...process.env, PATH: await loginPath() };
  if (token) {
    env.GH_TOKEN = token;
    // Command-local helper: do not rewrite the user's global Git configuration.
    const n = Number(env.GIT_CONFIG_COUNT || 0);
    env.GIT_CONFIG_COUNT = String(n + 3);
    env[`GIT_CONFIG_KEY_${n}`] = 'credential.https://github.com.helper';
    env[`GIT_CONFIG_VALUE_${n}`] = '';
    env[`GIT_CONFIG_KEY_${n + 1}`] = 'credential.https://github.com.helper';
    env[`GIT_CONFIG_VALUE_${n + 1}`] = '!gh auth git-credential';
    env[`GIT_CONFIG_KEY_${n + 2}`] = 'url.https://github.com/.insteadOf';
    env[`GIT_CONFIG_VALUE_${n + 2}`] = 'git@github.com:';
  }
  return env;
}
export function createGithubAuth(dir, { run = execute, launch = spawn } = {}) {
  let job;
  const options = async () => ({ env: await githubEnv(), timeout: 20000 });
  async function status() {
    if (!(await loadSecrets(dir)).__github) return { authenticated: false };
    try {
      const { stdout } = await run('gh', ['api', 'user', '--jq', '.login'], await options());
      return { authenticated: true, login: stdout.trim() };
    } catch (e) {
      return { authenticated: false, missingCli: e.code === 'ENOENT' };
    }
  }
  function progress() {
    return job ? { state: job.state, code: job.code, url: 'https://github.com/login/device', error: job.error } : { state: 'idle' };
  }
  async function start() {
    if ((await status()).authenticated) return { state: 'connected', ...(await status()) };
    if (job && ['starting', 'waiting', 'ready'].includes(job.state)) return progress();
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-github-'));
    const env = { ...process.env, PATH: await loginPath(), GH_CONFIG_DIR: folder,
      GH_BROWSER: process.platform === 'win32' ? 'cmd /c exit 0' : 'true', GH_NO_UPDATE_NOTIFIER: '1' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_DEBUG', 'DEBUG', 'GH_PROMPT_DISABLED']) delete env[key];
    const current = job = { state: 'starting' };
    const child = launch('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk).slice(-8000);
      const match = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
      if (match) { current.code = match[0]; current.state = 'waiting'; }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.stdin.on('error', () => {}); child.stdin.end('\n');
    const timer = setTimeout(() => child.kill(), 10 * 60_000); timer.unref();
    child.once('error', () => { current.state = 'failed'; current.error = 'Install GitHub CLI on the host, then try again.'; });
    child.once('close', async (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error('GitHub authorization expired or was declined. Try again.');
        const { stdout } = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { env, timeout: 20000 });
        if (!stdout.trim()) throw new Error('GitHub did not return a connection.');
        current.token = stdout.trim(); current.state = 'ready';
        const expiry = setTimeout(() => {
          if (current.state === 'ready') { delete current.token; current.state = 'failed'; current.error = 'Login expired. Try again.'; }
        }, 10 * 60_000);
        expiry.unref();
      } catch (e) { current.state = 'failed'; current.error = 'GitHub authorization did not finish. Try again.'; }
      finally { await fs.rm(folder, { recursive: true, force: true }); }
    });
    return progress();
  }
  async function finish() {
    if (job?.state !== 'ready') throw new Error('Complete GitHub authorization first.');
    await setSecret(dir, '__github', job.token);
    delete job.token; job.state = 'connected';
    return status();
  }
  return { status, start, progress, finish };
}
