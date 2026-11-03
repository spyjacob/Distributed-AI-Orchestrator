import { defaultDataDir } from '../src/core/platform.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const name = (await rl.question(`Machine name [${os.hostname()}]: `)).trim() || os.hostname();
  const port = Number((await rl.question('HTTP port [8788]: ')).trim() || 8788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8787) throw new Error('Choose an unused port from 1024–65535, excluding 8787.');
  const check = net.createServer();
  await new Promise((resolve, reject) => { check.once('error', reject); check.listen(port, '0.0.0.0', resolve); });
  await new Promise((resolve) => check.close(resolve));
  const fallback = defaultDataDir();
  const dir = (await rl.question(`Data directory [${fallback}]: `)).trim() || fallback;
  if (!path.isAbsolute(dir) || /[\r\n"`]/.test(dir + name)) throw new Error('Use an absolute directory and a single-line machine name without quotes.');
  const values = { HARNESS_PORT: port, HARNESS_DATA_DIR: dir, ORCHESTRATOR_NODE_NAME: name };
  const body = Object.entries(values).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n';
  await fs.writeFile('.orchestrator-node.env', body, { flag: 'wx', mode: 0o600 });
  console.log('Created .orchestrator-node.env. Existing files and data were not overwritten.');
  console.log('Start with npm run node:serve. See docs/machines.md for pairing and startup-on-boot.');
  console.log(`Local address: http://127.0.0.1:${port}`);
  console.log('Open Settings → Phone access · Tailscale to connect your phone, then Settings → Machines to pair hosts.');
} catch (e) {
  console.error(e.code === 'EEXIST' ? 'Node config already exists; edit it explicitly instead of replacing it.' : e.message);
  process.exitCode = 1;
} finally { rl.close(); }
