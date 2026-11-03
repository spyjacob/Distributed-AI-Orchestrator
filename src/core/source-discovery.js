import spawn from 'cross-spawn';
import { childEnv } from './providers/claude-cli.js';
import { loginPath } from './tools.js';

export async function sourceEnv() {
  return childEnv({ ...process.env, PATH: await loginPath() });
}

export async function runSourceCommand(bin, args, { timeout = 15000, env } = {}) {
  env ||= await sourceEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${bin} timed out. Check it on this computer.`)); }, timeout);
    child.stdout.on('data', c => { output = (output + c).slice(-100000); });
    // Auth command stderr can contain account details; never return it to callers.
    child.stderr.resume();
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Could not run ${bin}: ${e.code || 'launch failed'}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${bin} needs installation or sign-in on this computer.`)); });
  });
}

export async function codexModels({ spawnProcess = spawn, env, timeout = 20000 } = {}) {
  env ||= await sourceEnv();
  const child = spawnProcess('codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let counter = 0, buffer = '';
  const fail = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  const timer = setTimeout(() => { fail(new Error('Codex discovery timed out. Update Codex and retry.')); child.kill(); }, timeout);
  child.on('error', () => fail(new Error('Codex is not installed or cannot start.')));
  child.on('close', () => fail(new Error('Codex closed before model discovery finished.')));
  child.stdin.on('error', () => fail(new Error('Codex connection closed.')));
  child.stderr.resume();
  child.stdout.on('data', c => {
    buffer += c;
    if (buffer.length > 2000000) { fail(new Error('Codex response exceeded the discovery limit.')); child.kill(); return; }
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { continue; }
      const handler = pending.get(message.id);
      if (!handler) continue;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message || 'Codex discovery failed.'));
      else handler.resolve(message.result);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await send('initialize', { clientInfo: { name: 'harness', version: '0.1.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    const { account } = await send('account/read', { refreshToken: false });
    if (!account) throw new Error('Sign in with codex login on this computer, then retry.');
    const models = []; let cursor = null;
    for (let page = 0; page < 20; page++) {
      const result = await send('model/list', { limit: 100, includeHidden: false, cursor });
      models.push(...(result.data || []).filter(m => !m.hidden).map(m => ({ model: m.model || m.id, label: m.displayName || m.model || m.id, supportedEffortLevels: m.supportedReasoningEfforts?.map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, effortSource: 'Codex model/list' })));
      cursor = result.nextCursor;
      if (!cursor) return models;
    }
    throw new Error('Codex returned too many model pages.');
  } finally { clearTimeout(timer); child.kill(); }
}

export async function claudeModels({ run = runSourceCommand, load = () => import('@anthropic-ai/claude-agent-sdk'), env } = {}) {
  env ||= await sourceEnv();
  const auth = JSON.parse(await run('claude', ['auth', 'status'], { env }));
  if (!auth.loggedIn) throw new Error('Sign in with claude auth login on this computer, then retry.');
  const { query } = await load();
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  async function* empty() { await hold; }
  const controller = new AbortController();
  const session = query({ prompt: empty(), options: { pathToClaudeCodeExecutable: 'claude', env,
    tools: [], mcpServers: {}, persistSession: false, abortController: controller } });
  let timer;
  try {
    const models = await Promise.race([session.supportedModels(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude model discovery timed out. Update Claude Code and retry.')), 20000);
    })]);
    return models.filter(m => !m.disabled).map(m => ({ model: m.value, label: m.displayName || m.value, supportsEffort: m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels, effortSource: 'Claude supportedModels' }));
  } finally { clearTimeout(timer); finish(); session.close(); controller.abort(); }
}
