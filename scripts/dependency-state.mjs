import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export async function dependencyHash(root) {
  try { return crypto.createHash('sha256').update(await fs.readFile(path.join(root,'package-lock.json'))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function verifyDependencies(root) {
  const hash = await dependencyHash(root);
  if (hash === null) return; // Unlocked source/test distributions have no install receipt.
  const saved = await fs.readFile(path.join(root,'.launcher/dependencies.sha256'),'utf8').catch(()=>null);
  if (hash !== saved || !await fs.stat(path.join(root,'node_modules/cross-spawn/package.json')).catch(()=>null))
    throw Error('Updated dependencies are not prepared. The current server will keep running. After active work finishes, stop it and use the desktop launcher to install dependencies and start again.');
}
