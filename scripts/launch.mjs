import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Preserve the existing Mac desktop launcher; fresh clones can use start_mac.command.
if (process.platform === 'darwin') {
  const child = spawn('sh', [fileURLToPath(new URL('launch.sh', import.meta.url))], { stdio: 'inherit' });
  child.once('error', (e) => { console.error(e.message); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code || 0; });
} else await import('./start.mjs');
