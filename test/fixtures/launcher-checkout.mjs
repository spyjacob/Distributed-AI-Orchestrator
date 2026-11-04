// A real checkout and remote for the launcher workflows. Tests play the window: they
// read what the page reads and say what the page says, so everything but drawing the
// window is the real thing.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { dependencyHash } from '../../scripts/dependency-state.mjs';
import { stopServer } from '../../scripts/stop-server.mjs';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const until = async (what, read, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; error = null; } catch (e) { error = e; }
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${what}${error ? `: ${error.message}` : ''}`);
};

/** What an open window does: one live connection, and telling the launcher what it shows. */
export function openWindow(url) {
  const controller = new AbortController();
  const views = [];
  const done = (async () => {
    const response = await fetch(`${url}events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith('data: ')) views.push(JSON.parse(block.slice(6)));
      }
    }
  })().catch(() => {});
  const say = body => fetch(`${url}action`, { method: 'POST', body: JSON.stringify(body) });
  return { views, say, close: () => { controller.abort(); return done; },
    until: (what, check) => until(what, () => views.findLast(view => !view.focus && check(view))),
    latest: () => views.findLast(view => !view.focus) };
}

export const exited = async (child) => {
  if (child.exitCode !== null) return child.exitCode;
  const result = await Promise.race([once(child, 'exit'), pause(30000).then(() => null)]);
  assert.ok(result, 'the launcher ends once DO has stopped');
  return result[0];
};

export async function launcherCheckout(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const checkout = path.join(root, 'checkout'), remote = path.join(root, 'remote.git'), data = path.join(root, 'data');
  await fs.mkdir(checkout); await fs.mkdir(data);
  for (const entry of ['server', 'src', 'scripts']) await fs.cp(entry, path.join(checkout, entry), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', '.gitignore']) await fs.copyFile(file, path.join(checkout, file));
  await fs.writeFile(path.join(checkout, 'VERSION'), '1.0\n');
  await fs.symlink(path.resolve('node_modules'), path.join(checkout, 'node_modules'), 'junction');
  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'published');
  git(checkout, 'remote', 'add', 'origin', remote); git(checkout, 'push', '-qu', 'origin', 'main');
  await fs.mkdir(path.join(checkout, '.launcher'));
  await fs.writeFile(path.join(checkout, '.launcher/dependencies.sha256'), await dependencyHash(checkout));

  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(checkout, '.orchestrator-node.env'), `HARNESS_PORT=${port}\nHARNESS_DATA_DIR=${JSON.stringify(data)}\nORCHESTRATOR_NODE_NAME="Laptop"\n`);

  const env = { ...process.env, ORCHESTRATOR_LAUNCHER_WINDOW: 'none' };
  // Started from a double-click, it has none of the server's settings. A test run inherits them.
  for (const setting of ['HARNESS_PORT', 'HARNESS_DATA_DIR', 'HARNESS_TOKEN', 'ORCHESTRATOR_NODE_NAME', 'ORCHESTRATOR_RESTART_ID']) delete env[setting];
  const children = new Set();
  const track = (child) => { children.add(child); child.once('exit', () => children.delete(child)); return child; };
  const status = async () => (await fetch(`${origin}/api/cluster/status`, { signal: AbortSignal.timeout(2000) })).json();
  const serving = () => status().then(() => true, () => false);
  return {
    root, checkout, remote, data, port, origin, env, git, track, status, serving,
    launch: async (extra = {}) => {
      const child = track(spawn(process.execPath, ['scripts/launcher.mjs'], { cwd: checkout, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] }));
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      const url = await until('the status window address', () => output.match(/Status window: (\S+)/)?.[1]);
      return { child, url };
    },
    startDirectly: async (extra = {}) => {
      track(spawn(process.execPath, ['server/boot.js'], { cwd: checkout, stdio: 'ignore',
        env: { ...env, HARNESS_PORT: String(port), HARNESS_DATA_DIR: data, ORCHESTRATOR_NODE_NAME: 'Laptop', ...extra } }));
      await until('the running server', serving);
    },
    events: async () => (await fs.readFile(path.join(checkout, '.launcher/trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    cleanUp: async () => {
      for (const child of children) child.kill();
      await stopServer(checkout, port).catch(() => {});
      await pause(300);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
