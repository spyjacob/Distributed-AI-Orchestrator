// Loaded only by the E2E runner and its child processes. Node works on Windows
// too, where execFile cannot execute a shebang script as a client substitute.
import fs from 'node:fs';
import path from 'node:path';

const command = path.basename(process.argv[1] || '');
if (command === 'status' || command === 'serve') {
  const state = process.env.HARNESS_TEST_TAILSCALE_STATE;
  const value = command === 'status'
    ? { BackendState: state ? fs.readFileSync(state, 'utf8').trim() : 'Running' }
    : {};
  fs.writeSync(1, JSON.stringify(value));
  process.exit(0);
}

// Simulate only the external Ollama service for the network workflow.
if (process.env.HARNESS_TEST_LOCAL_MODELS === '1') {
  const originalFetch = globalThis.fetch;
  let loaded = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('http://127.0.0.1:11434/')) return originalFetch(url, options);
    const route = new URL(url).pathname;
    if (route === '/api/generate') {
      await new Promise(resolve => setTimeout(resolve, 500));
      loaded = JSON.parse(options.body).keep_alive !== 0;
    }
    return Response.json(route === '/api/ps' ? { models: loaded ? [{ name: 'test:local' }] : [] } : {});
  };
}
