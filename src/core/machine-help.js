import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { childEnv, complete, makeClient } from './providers/claude-cli.js';
import { loginPath } from './tools.js';
import { userEvent } from './transcript.js';

export async function executableAvailable(bin, env = process.env) {
  const dirs = bin.includes('/') || bin.includes('\\') ? [''] : (env.PATH || '').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of dirs) for (const ext of extensions) {
    try {
      const file = path.resolve(dir, bin + ext);
      if (!(await fs.stat(file)).isFile()) continue;
      await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { /* try the next PATH entry */ }
  }
  return false;
}

/** Installation is checked on the executor; credentials and service health are not inferred. */
export async function modelInventory(config, probe = executableAvailable) {
  const models = {};
  const env = childEnv({ ...process.env, PATH: await loginPath() });
  for (const [id, spec] of Object.entries(config.models)) {
    const bin = spec.provider === 'codex-cli' ? 'codex' : spec.provider === 'claude-cli' ? 'claude' : null;
    const installed = bin ? await probe(spec.bin || bin, env) : null;
    const available = installed === false ? false : Boolean(spec.hasKey);
    models[id] = { ...spec, apiKey: undefined, available,
      availability: installed === false ? `${bin} is not installed on this computer`
        : !spec.hasKey ? 'No API key configured' : 'Configured; sign-in and service access are unverified' };
  }
  const def = models[config.default]?.available ? config.default
    : Object.keys(models).find(id => models[id].available) || null;
  return { models, default: def, defaultEffort: def === config.default ? config.defaultEffort || null : null };
}

/** Claude interprets a bounded diagnostic snapshot, with no filesystem or shell tools. */
export async function machineHelp(config, machine, { question = '', useClaude = false } = {}, dependencies = {}) {
  if (typeof question !== 'string' || question.length > 4000 || typeof useClaude !== 'boolean')
    throw new Error('Use a question of at most 4000 characters and a boolean useClaude.');
  const inventory = await modelInventory(config, dependencies.probe);
  const report = { machine: { id: machine.id, name: machine.name, platform: process.platform },
    models: Object.entries(inventory.models).map(([alias, m]) => ({ alias, provider: m.provider,
      model: m.model, available: m.available, availability: m.availability })) };
  if (useClaude) {
    const spec = Object.values(inventory.models).find(m => m.provider === 'claude-cli' && m.available);
    if (!spec) throw new Error('No installed, configured Claude CLI on this computer. Request diagnostics without useClaude.');
    const result = await (dependencies.complete || complete)({ client: makeClient(spec), spec: { ...spec, maxTurns: 1 },
      events: [userEvent(`${question}\n\nMachine diagnostic snapshot:\n${JSON.stringify(report)}`)],
      system: 'Answer the diagnostic question using only the supplied snapshot. Distinguish installation from sign-in and service access. Do not claim to have checked anything beyond this snapshot.',
      useTools: false, cwd: os.tmpdir(), signal: AbortSignal.timeout(45000) });
    report.answer = result.text;
  }
  return report;
}
