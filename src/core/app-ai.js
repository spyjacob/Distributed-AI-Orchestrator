// Public documentation contains requirements, never account credentials or host IDs.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function documentAI(dir, dependencies) {
  const file = path.join(dir, 'README.md');
  const old = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const start = '<!-- harness-ai:start -->', end = '<!-- harness-ai:end -->';
  const clean = value => String(value).replace(/[\r\n<>]/g, ' ').replace(/[\x60*_[\]]/g, '');
  const block = dependencies.length ? [
    start, '## AI requirements', '',
    ...dependencies.map(d => '- **' + clean(d.label || d.alias) + '** — ' + clean(d.purpose) + '.'),
    '', 'These are the models selected for this project. Supply your own provider access, subscription login, or local model runtime; no credentials are included.',
    'Machine-local subscriptions and GPU models require the configured source computer to be running. The app must run on that computer unless its own integration explicitly supports remote access.',
    'Harness supplies HARNESS_APP_AI as JSON at launch (purpose, provider, model, alias, host). Apps must read this setting to support model switching. Alternative models require a compatible provider adapter and may produce different results. Restart the app after changing its selection.',
    end,
  ].join('\n') : '';
  const first = old.indexOf(start), last = old.indexOf(end);
  if ((first >= 0) !== (last >= 0) || (first >= 0 && last < first)) throw Error('README AI section markers are incomplete; repair them before pushing.');
  if (!block && first < 0) return;
  const next = first >= 0 ? old.slice(0, first) + block + old.slice(last + end.length) : old + (old ? '\n\n' : '') + block + (block ? '\n' : '');
  if (next !== old) await fs.writeFile(file, next);
}

export function runtimeAI(dependencies, host, models) {
  return dependencies.map(d => {
    if (d.host !== host) throw Error((d.label || d.alias) + ' requires its source computer. Launch there or select a source on this computer in project settings.');
    const spec = models[d.alias];
    if (!spec || spec.available === false || spec.hasKey === false) throw Error((d.label || d.alias) + ' is unavailable. Check AI sources or choose a replacement.');
    return { ...d, provider: spec.provider, model: spec.model };
  });
}
