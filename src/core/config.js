import { effortCapability } from './model-effort.js';
import crypto from 'node:crypto';
/**
 * Model registry. Adding a model is a config edit, never a code edit.
 *
 * Lives at <userData>/models.json. First run starts empty; onboarding adds
 * sources explicitly on the selected host.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { atomic } from './cluster/raft.js';
import { loadSecrets } from './secrets.js';

export const DEFAULT_MODELS = { default: null, models: {} };

/** Where each provider looks for a key when models.json does not say. */
const DEFAULT_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function configPath(userDataDir) {
  return path.join(userDataDir, 'models.json');
}

export async function ensureConfig(userDataDir) {
  const file = configPath(userDataDir);
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(DEFAULT_MODELS, null, 2)}\n`, 'utf8');
  }
  return file;
}

/**
 * Returns { models, default, error }. A broken config is reported rather than
 * thrown, so the window still opens and can tell you what to fix.
 */
export async function loadConfig(userDataDir) {
  const file = await ensureConfig(userDataDir);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    return { models: {}, default: null, path: file, error: `models.json is not valid JSON: ${e.message}` };
  }

  const secrets = await loadSecrets(userDataDir);

  const models = {};
  for (const [alias, block] of Object.entries(raw.models ?? {})) {
    // A key set through the UI wins; the env var named by the config is the
    // fallback; failing both, the provider's own conventional variable.
    const envName = block.apiKeyOptional ? '' : block.apiKeyEnv || DEFAULT_KEY_ENV[block.provider] || '';
    const apiKey = secrets[alias] || (envName ? process.env[envName] || '' : '');

    // A local OpenAI-compatible server (Ollama, vLLM, LM Studio) needs no key,
    // so don't flag it as unconfigured.
    const isLocal = block.provider === 'openai' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(block.baseUrl ?? '');

    // The `claude` CLI carries its own credentials; the harness never holds one.
    const selfAuth = block.provider === 'claude-cli' || block.provider === 'codex-cli';

    models[alias] = {
      alias,
      ...block,
      apiKey,
      keyEnv: envName,
      keySource: selfAuth ? 'subscription' : secrets[alias] ? 'stored' : apiKey ? 'env' : null,
      hasKey: Boolean(apiKey) || isLocal || selfAuth || (block.provider === 'openai' && block.apiKeyOptional === true),
    };
  }

  for (const spec of Object.values(models)) spec.effortCapability = effortCapability(spec);
  const aliases = Object.keys(models);
  if (!aliases.length) {
    return { models, default: null, path: file, error: null };
  }

  const def = models[raw.default] ? raw.default : aliases[0];
  // A default effort belongs to the chosen default model; a fallback default gets none.
  const defaultEffort = def === raw.default && typeof raw.defaultEffort === 'string' ? raw.defaultEffort : null;
  return { models, default: def, defaultEffort, path: file, error: null };
}

const writes = new Map();
export async function updateConfig(dir, change) {
  const previous = writes.get(dir) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const file = await ensureConfig(dir);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const result = await change(raw);
    await atomic(file, raw);
    return result;
  });
  writes.set(dir, pending);
  try { return await pending; }
  finally { if (writes.get(dir) === pending) writes.delete(dir); }
}

/**
 * Merge fields into one model's block in models.json and write it back.
 * Used by the web UI, where there is no text editor to hand.
 */
export async function patchModel(userDataDir, alias, patch) {
  return updateConfig(userDataDir, raw => {
    raw.models ??= {};
    if (!raw.models[alias]) throw new Error(`no model "${alias}" in models.json`);

    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') delete raw.models[alias][k];
      else raw.models[alias][k] = v;
    }

    return raw.models[alias];
  });
}

/** Add a source without replacing an existing model or changing the default. */
export async function addModel(userDataDir, { label, provider, model, baseUrl, apiKeyEnv, apiKeyOptional }) {
  const allowed = ['openai', 'openai-responses', 'anthropic', 'claude-cli', 'codex-cli'];
  if (!allowed.includes(provider)) throw new Error('Choose a supported connection type.');
  if (typeof label !== 'string' || !label.trim()) throw new Error('Enter a source name.');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Enter a model ID.');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use an HTTP or HTTPS endpoint without credentials in the URL.');
    }
  }
  return updateConfig(userDataDir, raw => {
    raw.models ??= {};
    const alias = 'source-' + crypto.randomUUID();
    raw.models[alias] = { label: label.trim(), provider, model: model.trim(),
      ...(apiKeyOptional === true && provider === 'openai' ? { apiKeyOptional: true } : {}),
      ...(baseUrl ? { baseUrl } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) };
    if (!raw.default) raw.default = alias;
    return alias;
  });
}
