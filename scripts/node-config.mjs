// This computer's private settings, shared by every way of starting DO.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultDataDir } from '../src/core/platform.js';

/** Create the settings once, never overwriting them, and return the port they name. */
export async function loadNodeConfig(root) {
  const config = path.join(root, '.orchestrator-node.env');
  if (!await fs.stat(config).catch(() => null)) {
    const values = { HARNESS_PORT: process.env.HARNESS_PORT || '8787', HARNESS_DATA_DIR: process.env.HARNESS_DATA_DIR || defaultDataDir(),
      ORCHESTRATOR_NODE_NAME: os.hostname() };
    await fs.writeFile(config, Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v.replaceAll('\\', '/'))}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  process.loadEnvFile(config);
  // Preserve explicit authentication. Empty-token mode is local-socket only.
  const port = Number(process.env.HARNESS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HARNESS_PORT must be a port from 1 to 65535.');
  return port;
}
