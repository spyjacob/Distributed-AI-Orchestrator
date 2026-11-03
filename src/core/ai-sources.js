import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';
import { updateConfig, loadConfig } from './config.js';
import { codexModels, claudeModels, sourceEnv } from './source-discovery.js';
import { validateEffort } from './model-effort.js';

const OLLAMA = 'http://127.0.0.1:11434';
const kinds = ['claude-cli', 'codex-cli', 'ollama'];
const validModel = model => typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model);

// A source belongs to this machine. No model weights, endpoint, or login is replicated.
export function createAISources(dir, { request = fetch, discoverClaude = claudeModels, discoverCodex = codexModels, spawnProcess = spawn } = {}) {
  let daemon, startPending;
  const jobs = new Map(), discoveries = new Map(), localBusy = new Set();
  const mutate = fn => updateConfig(dir, fn);
  async function ollama(route, body, timeout = 15000) {
    const response = await request(OLLAMA + route, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Ollama returned ${response.status}`);
    return result;
  }
  async function start() {
    try { await ollama('/api/tags'); return; } catch { /* explicit start */ }
    if (startPending) return startPending;
    startPending = (async () => {
      await fs.mkdir(dir, { recursive: true });
      const log = await fs.open(path.join(dir, 'ollama-runtime.log'), 'a');
      try {
        daemon = spawnProcess('ollama', ['serve'], { env: { ...await sourceEnv(), OLLAMA_HOST: '127.0.0.1:11434' },
          stdio: ['ignore', log.fd, log.fd] });
        let error;
        daemon.on('error', () => { error = new Error('Install Ollama on this computer first, then retry.'); });
        for (let i = 0; i < 30; i++) {
          if (error) throw error;
          try { await ollama('/api/tags', null, 1000); return; } catch { /* booting */ }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('Ollama did not start. Check ollama-runtime.log on this computer.');
      } finally { await log.close(); }
    })().finally(() => { startPending = null; });
    return startPending;
  }
  const service = {
    ensureRunning: start,
    async prepare(model) {
      await start();
      if ((await ollama('/api/ps')).models?.some(m => m.name === model || m.model === model)) return;
      let job = [...jobs.values()].find(j => j.model === model && j.action === 'load' && j.state === 'running');
      job ||= await service.localAction('load', model);
      while (job.state === 'running') await new Promise(resolve => setTimeout(resolve, 200));
      if (job.state === 'failed') throw new Error(job.error);
    },
    async catalog() {
      const cfg = await loadConfig(dir);
      const runtime = Object.values(cfg.models).some(m => m.sourceKind === 'ollama')
        ? await ollama('/api/ps', null, 2000).catch(() => ({ models: [], unavailable: true })) : null;
      return { runtime, models: Object.fromEntries(Object.entries(cfg.models).map(([id, m]) => [id, { ...m, apiKey: undefined,
          ...(m.sourceKind === 'ollama' ? { runtimeStatus: (() => {
            const job = [...jobs.values()].find(j => j.model === m.model && j.state === 'running');
            if (job) return { load: 'loading', unload: 'unloading', pull: 'downloading' }[job.action];
            if (runtime?.unavailable) return 'runtime unavailable';
            return runtime?.models?.some(r => r.name === m.model || r.model === m.model) ? 'loaded' : 'not loaded';
          })() } : {}) }])),
        default: cfg.default, defaultEffort: cfg.defaultEffort, error: cfg.error, jobs: [...jobs.values()] };
    },
    async discover(kind) {
      if (!kinds.includes(kind)) throw new Error('Choose Claude Code, Codex, or Ollama.');
      let models;
      if (kind === 'claude-cli') models = await discoverClaude();
      if (kind === 'codex-cli') models = await discoverCodex();
      if (kind === 'ollama') {
        const { models: installed = [] } = await ollama('/api/tags');
        models = [];
        for (const model of installed.slice(0, 200)) {
          const info = await ollama('/api/show', { model: model.name });
          if (!info.capabilities?.includes('completion') || info.remote_model || info.remote_host || /(?:^|[-:])cloud(?:$|[-:])/i.test(model.name)) continue;
          models.push({ model: model.name, label: model.name, tools: info.capabilities.includes('tools'), size: model.size });
        }
      }
      models = [...new Map(models.filter(m => typeof m.model === 'string' && m.model).map(m => [m.model, m])).values()];
      // Refresh capabilities of already installed rows too; never change their chosen effort.
      await mutate(raw => {
        for (const spec of Object.values(raw.models || {})) {
          if ((spec.sourceKind || spec.provider) !== kind) continue;
          const model = models.find(m => m.model === spec.model);
          if (!model) continue;
          for (const key of ['supportsEffort','supportedEffortLevels','defaultEffort','effortSource']) {
            if (model[key] === undefined) delete spec[key]; else spec[key] = model[key];
          }
        }
      });
      discoveries.set(kind, { models, at: Date.now() });
      return { kind, models, message: models.length ? 'Models reported by this source. Add the ones you want; account limits still apply.' : 'No text models found. Install or download a model, then refresh.' };
    },
    async add({ kind, models, allowDelegate = false }) {
      const found = discoveries.get(kind);
      if (!found || Date.now() - found.at > 600000) throw new Error('Refresh the source model list before adding models.');
      if (!Array.isArray(models) || !models.length || models.length > 200) throw new Error('Select at least one discovered model.');
      const chosen = [...new Set(models)].map(id => {
        const model = found.models.find(m => m.model === id);
        if (!model) throw new Error('A selected model was not reported by this source. Refresh and retry.');
        return model;
      });
      return mutate(raw => {
        raw.models ||= {};
        const aliases = [];
        for (const m of chosen) {
          const alias = Object.keys(raw.models).find(id => (raw.models[id].sourceKind || raw.models[id].provider) === kind && raw.models[id].model === m.model)
            || 'source-' + crypto.randomUUID();
          raw.models[alias] = { ...raw.models[alias], sourceKind: kind, provider: kind === 'ollama' ? 'openai' : kind,
            model: m.model, label: m.label, supportsEffort:m.supportsEffort, supportedEffortLevels:m.supportedEffortLevels, defaultEffort:m.defaultEffort, effortSource:m.effortSource, ...(kind === 'ollama' ? { baseUrl: OLLAMA + '/v1', apiKeyOptional: true,
              supportsTools: m.tools, allowDelegate: allowDelegate === true, priceIn: 0, priceOut: 0 } : {}) };
          aliases.push(alias);
        }
        if (!raw.models[raw.default]) raw.default = aliases[0];
        return { aliases };
      });
    },
    // The model and effort new sessions on this computer start with.
    async setDefault({ alias, effort = '' }) {
      if (typeof effort !== 'string' || (effort && !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))) throw new Error('Invalid effort level.');
      return mutate(raw => {
        const spec = raw.models?.[alias];
        if (!spec) throw new Error('Unknown source.');
        validateEffort(spec, effort);
        raw.default = alias;
        if (effort) raw.defaultEffort = effort; else delete raw.defaultEffort;
        return { default: alias, defaultEffort: effort || null };
      });
    },
    async remove(alias) {
      return mutate(raw => {
        if (!raw.models?.[alias]) throw new Error('Unknown source.');
        delete raw.models[alias];
        if (raw.default === alias) { raw.default = Object.keys(raw.models)[0] || null; delete raw.defaultEffort; }
        return { ok: true };
      });
    },
    async delegateSetting(alias, enabled) {
      return mutate(raw => {
        if (raw.models?.[alias]?.sourceKind !== 'ollama') throw new Error('Only local Ollama models can be helpers.');
        raw.models[alias].allowDelegate = enabled === true;
        return { ok: true };
      });
    },
    async localAction(action, model) {
      if (!['start', 'pull', 'load', 'unload'].includes(action)) throw new Error('Unknown local model action.');
      if (action !== 'start' && !validModel(model)) throw new Error('Enter a valid Ollama model name.');
      if (model && /(?:^|[-:])cloud(?:$|[-:])/i.test(model)) throw new Error('Choose local model weights, not an Ollama cloud model.');
      const key = model || 'runtime';
      if (localBusy.size) throw new Error('The local model runtime is busy. Retry after the current operation.');
      if (localBusy.has(key)) throw new Error('This model already has an operation in progress.');
      localBusy.add(key);
      const job = { id: crypto.randomUUID(), action, model, state: 'running', startedAt: Date.now() };
      for (const [id, old] of jobs) if (old.state !== 'running') jobs.delete(id);
      jobs.set(job.id, job);
      (async () => {
        try {
          if (action !== 'unload') await start();
          if (action === 'pull') await ollama('/api/pull', { model, stream: false }, 3600000);
          if (action === 'load' || action === 'unload') await ollama('/api/generate', { model, stream: false, keep_alive: action === 'load' ? '10m' : 0 }, 180000);
          job.state = 'done';
        } catch (e) { job.state = 'failed'; job.error = e.message; }
        finally { localBusy.delete(key); }
      })();
      return job;
    },
    async helper({ alias, prompt }) {
      const spec = (await loadConfig(dir)).models[alias];
      if (spec?.sourceKind !== 'ollama' || !spec.allowDelegate) throw new Error('This local model has not been enabled as an agent helper.');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24000) throw new Error('Use a task of 1–24,000 characters.');
      if (localBusy.size) throw new Error('The local model runtime is busy. Retry after the current operation.');
      localBusy.add(spec.model);
      try {
        await start();
        const info = await ollama('/api/show', { model: spec.model });
        if (info.remote_model || info.remote_host) throw new Error('This model is hosted remotely; local helper use is disabled.');
        const result = await ollama('/api/chat', { model: spec.model, stream: false, keep_alive: '10m',
          messages: [{ role: 'system', content: 'Complete only the supplied task. You have no tools, filesystem access, or delegation ability.' }, { role: 'user', content: prompt }],
          options: { num_predict: 2048, num_ctx: 8192 } }, 180000);
        return { model: spec.model, text: (result.message?.content || '').slice(0, 30000),
          usage: { input: result.prompt_eval_count || 0, output: result.eval_count || 0 } };
      } finally { localBusy.delete(spec.model); }
    },
    async running() { return ollama('/api/ps'); },
    close() { daemon?.kill(); },
  };
  return service;
}
