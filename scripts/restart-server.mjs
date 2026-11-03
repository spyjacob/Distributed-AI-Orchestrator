// Wait for the old listener to close without requiring lsof or a Unix shell.
import net from 'node:net';
import { verifyDependencies } from './dependency-state.mjs';
import path from 'node:path';
import { startupUpdate } from './startup-update.mjs';
import { spawn } from 'node:child_process';
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
// Keep the old process serving until its checkout passes the pull check. Loading
// this computer's own test changes needs nothing from GitHub, and a test build
// that failed to start is already gone: get DO back with no checks at all.
const mode = process.argv[4];
try {
  if (mode !== '--fallback') {
    const root = path.resolve(path.dirname(process.argv[3]), '..');
    const revision = mode === '--local' ? undefined : await startupUpdate(root);
    await verifyDependencies(root);
    process.send?.({ ready: true, revision });
  }
} catch (error) {
  process.send?.({ error: error.message });
  console.error(error.message);
  process.exit(1);
}
let available = false;
for (let i = 0; i < 150; i++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  available = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
  if (available) break;
}
if (!available) throw new Error('Restart timed out: the port is still in use.');
const child = spawn(process.execPath, [process.argv[3]], { stdio: 'inherit', env: process.env });
child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
