import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
// Crash-safe replacement, with unique staging names. Callers serialize whole
// read/modify/write operations, not merely this final write.
export async function atomicFile(file, data) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
    if (process.platform !== 'win32') {
      const dir = await fs.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally { await fs.rm(tmp, {force:true}).catch(() => {}); }
}
const mutations = new Map();
export function serializedFile(file, operation) {
  const key = path.resolve(file);
  const result = (mutations.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  mutations.set(key, result);
  return result.finally(() => { if (mutations.get(key) === result) mutations.delete(key); });
}
