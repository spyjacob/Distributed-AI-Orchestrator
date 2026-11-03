/**
 * What launchers and restarts start. It decides which code this computer runs:
 * the published checkout (./index.js), or a test build holding this computer's
 * unpushed DO changes; see src/core/test-build.js.
 *
 * Keep this small and free of npm imports. If a test build cannot start, this is
 * what brings DO back on the published code.
 */
import { openSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from '../src/core/platform.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = process.env.HARNESS_DATA_DIR || defaultDataDir();
const port = Number(process.env.HARNESS_PORT ?? 8787);

// Set by the failure path below for one start only: whatever else went wrong, the
// next start is published code, so a build that keeps failing can never loop.
const afterFailure = process.env.ORCHESTRATOR_AFTER_BUILD_FAILURE;
delete process.env.ORCHESTRATOR_AFTER_BUILD_FAILURE;

let builds = null, boot = null;
try {
  builds = await import('../src/core/test-build.js');
  if (!afterFailure) boot = await builds.prepareBoot(root, dataDir);
} catch (error) {
  // Bookkeeping for a test build must never be the reason DO fails to start.
  console.error(`Starting the published version: ${error.message}`);
}

if (!boot) await import('./index.js');
else {
  let finished = false;
  const fail = async (error) => {
    if (finished) return;
    finished = true;
    // Another DO on this port says nothing about the changes being tested.
    if (error?.code === 'EADDRINUSE') { console.error(error.message); process.exit(1); }
    console.error(`Test build failed to start: ${error?.stack || error}`);
    await builds.bootFailed(dataDir, boot, error).catch(() => {});
    // A fresh process: this one may hold the port or half-started state. The
    // helper waits for the port, then starts this file again.
    let log = 'ignore';
    try { log = openSync(path.join(dataDir, 'server.log'), 'a'); } catch { /* still restart */ }
    spawn(process.execPath, [path.join(root, 'scripts/restart-server.mjs'), String(port), path.join(root, 'server/boot.js'), '--fallback'], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, ORCHESTRATOR_AFTER_BUILD_FAILURE: '1' },
    }).unref();
    process.exit(0);
  };
  process.on('uncaughtException', fail);
  (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        // Any answer proves it is serving. A crash in its first moments still counts.
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        setTimeout(() => process.removeListener('uncaughtException', fail), 30_000).unref();
        return;
      } catch { /* not listening yet */ }
    }
    await fail(new Error('It did not start serving within a minute.'));
  })();
  try { await import(boot.entry); }
  catch (error) { await fail(error); }
}
