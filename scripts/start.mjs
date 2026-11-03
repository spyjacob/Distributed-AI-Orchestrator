// Shared first-run path. No shell-specific setup, WSL, or Python dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dependencyHash } from './dependency-state.mjs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from '../src/core/platform.js';
import { stopServer } from './stop-server.mjs';
import { startupUpdate } from './startup-update.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
const run = (bin, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${bin} exited with ${code}`)));
});
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then run this launcher again.');
  await run('git', ['--version']);
  const config = '.orchestrator-node.env';
  if (!await fs.stat(config).catch(() => null)) {
    const values = { HARNESS_PORT: process.env.HARNESS_PORT || '8787', HARNESS_DATA_DIR: process.env.HARNESS_DATA_DIR || defaultDataDir(),
      ORCHESTRATOR_NODE_NAME: os.hostname() };
    await fs.writeFile(config, Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v.replaceAll('\\', '/'))}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  process.loadEnvFile(config);
  // Preserve explicit authentication. Empty-token mode is local-socket only.
  const port = Number(process.env.HARNESS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HARNESS_PORT must be a port from 1 to 65535.');
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing server or choose another HARNESS_PORT in ${config}.`))); probe.listen(port, '0.0.0.0', resolve); });
  await new Promise((resolve) => probe.close(resolve));
  await startupUpdate(root);
  const lockHash = await dependencyHash(root);
  const stamp = '.launcher/dependencies.sha256';
  if (await fs.readFile(stamp, 'utf8').catch(() => '') !== lockHash || !await fs.stat('node_modules/cross-spawn/package.json').catch(() => null)) {
    if (process.platform === 'win32') await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci']);
    else await run('npm', ['ci']);
    await fs.mkdir('.launcher', { recursive: true });
    await fs.writeFile(stamp, lockHash);
  }
  const server = spawn(process.execPath, [path.join(root, 'server/boot.js')], { stdio: 'inherit', env: process.env });
  server.once('error', (e) => { console.error(e.message); process.exitCode = 1; });
  // An in-app restart hands the port to a detached server this window no longer owns.
  // Stay open while it serves, and stop it when the window closes (as the Mac app does on quit).
  const serving = () => fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  server.once('exit', async (code) => {
    process.exitCode = code || 0;
    if (code) return;
    for (let i = 0; i < 60 && !await serving(); i++) await new Promise((resolve) => setTimeout(resolve, 500));
    if (!await serving()) return;
    console.log('Server restarted. Keep this window open while this host runs.');
    while (await serving()) await new Promise((resolve) => setTimeout(resolve, 5000));
  });
  // Closing a Windows console window arrives as SIGHUP, with a few seconds to finish.
  for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.once(sig, () => { stopServer(root, port).catch((e) => console.error(e.message)).finally(() => process.exit(0)); });
  }
  let opened = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const url = new URL(`http://localhost:${port}/`);
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) continue;
      const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]] : ['open', [url.href]];
      if (!process.argv.includes('--no-browser')) {
        const browser = spawn(command[0], command[1], { stdio: 'ignore' });
        browser.on('error', () => console.error('Open the local URL printed by the server in your browser.'));
      }
      opened = true;
      break;
    } catch { /* wait for startup */ }
  }
  console.log(opened ? 'Use Settings → Phone access, then Machines → Join an existing system. Keep this window open while this host runs.' : 'Browser startup timed out; check the server output above.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
