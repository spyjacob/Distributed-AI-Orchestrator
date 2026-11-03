// A single replicated operation keeps project IDs and their tabs together.
// Existing records win; retries use deterministic IDs and never replace work.
export function importProjects(state, { apps = [], sessions = [], values = {}, host }) {
  const registry = JSON.parse(state.values['settings:apps.json'] || '{"apps":[]}');
  const ids = new Map();
  for (const source of apps) {
    if (source.id === '__harness' || source.builtin) continue;
    const ownerNode = source.ownerNode || host;
    let id = source.id;
    const existing = registry.apps.find(a => a.id === id);
    if (existing && (existing.ownerNode !== ownerNode || existing.dir !== source.dir)) id += `-${host}`;
    ids.set(source.id, id);
    if (!registry.apps.some(a => a.id === id)) registry.apps.push({ ...source, id, ownerNode,
      hosts: source.hosts?.length ? source.hosts : [ownerNode], pid: null });
  }
  state.values['settings:apps.json'] = JSON.stringify(registry);
  for (const source of sessions) {
    let id = source.id;
    const existing = state.sessions[id];
    if (existing && (existing.ownerNode !== (source.ownerNode || host) || existing.projectDir !== source.projectDir)) id += `-${host}`;
    if (state.sessions[id]) continue;
    state.sessions[id] = { ...source, id, appId: ids.get(source.appId) || source.appId,
      ownerNode: source.ownerNode || host, turnHost: null, turnStartedAt: null };
  }
  for (const [id, value] of Object.entries(values))
    if (id.startsWith('asset:') && !state.values[id]) state.values[id] = value;
}
