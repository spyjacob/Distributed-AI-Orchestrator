// Canonicalize existing ancestors as well as new write targets. This closes
// static symlink escapes; it is not an OS sandbox against concurrent link swaps.
import fs from 'node:fs';
import path from 'node:path';
export function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling symlink must not be treated as an ordinary missing filename.
    try { if (fs.lstatSync(absolute).isSymbolicLink()) throw Error('Dangling symbolic link refused.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}
export function insidePath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
