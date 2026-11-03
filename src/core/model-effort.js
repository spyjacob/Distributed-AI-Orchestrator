// Capability data belongs to a model and adapter, never to its display label.
export function effortCapability(spec = {}) {
  const native = ['claude-cli', 'codex-cli'].includes(spec.provider);
  let levels = spec.supportedEffortLevels;
  let source = spec.effortSource || 'model configuration';
  if (spec.supportsEffort === false) levels = [];
  // Explicit, documented fallback only for the official API, not lookalike gateways.
  if (!Array.isArray(levels) && !native && ['openai', 'openai-responses'].includes(spec.provider)
      && (!spec.baseUrl || /^https:\/\/api\.openai\.com(?:\/|$)/.test(spec.baseUrl)) && spec.model === 'gpt-6-astra') {
    levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    source = 'OpenAI model documentation';
  }
  const configured = ['anthropic','claude-cli'].includes(spec.provider) ? spec.effort : spec.reasoningEffort;
  const extra = spec.provider === 'openai' ? spec.extraBody?.reasoning_effort
    : spec.provider === 'openai-responses' ? spec.extraBody?.reasoning?.effort : null;
  return { levels: Array.isArray(levels) ? [...new Set(levels.filter(v => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v)))] : null,
    source: Array.isArray(levels) ? source : 'unknown', configured: configured || extra || null,
    default: spec.defaultEffort || null };
}

export function validateEffort(spec, effort) {
  if (!effort) return;
  const capability = effortCapability(spec);
  if (capability.levels && !capability.levels.includes(effort))
    throw Error(`Effort ${effort} is not supported by ${spec.model}. Supported: ${capability.levels.join(', ') || 'no effort override'}.`);
}
