import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export function replicatedAssets(cluster, dir) {
  const root = path.join(dir, 'attachments');
  const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
  const api = {
    async capture(attachment) {
      if (attachment.clusterAsset && cluster.replica.state.values['asset:' + attachment.clusterAsset]) return;
      const relative = path.relative(root, attachment.path || '');
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Attachment is outside the attachment store');
      const data = await fs.readFile(attachment.path);
      if (data.length > 25 * 1024 * 1024) throw new Error('Attachment exceeds 25 MB');
      const id = hash(data);
      await cluster.command({ type: 'value', id: 'asset:' + id,
        value: { data: data.toString('base64'), hash: id, originalPath: attachment.path, extension: path.extname(attachment.path).replace(/[^.a-zA-Z0-9]/g, '') } });
      attachment.clusterAsset = id;
    },
    async restore(attachment) {
      const value = cluster.replica.state.values['asset:' + attachment.clusterAsset];
      if (!value) return;
      const data = Buffer.from(value.data, 'base64');
      if (hash(data) !== value.hash) throw new Error('Attachment checksum mismatch');
      const directory = path.join(root, 'cluster'); await fs.mkdir(directory, { recursive: true });
      const target = path.join(directory, value.hash + value.extension);
      await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      attachment.path = target;
    },
    async session(session, capture = false) {
      for (const event of session.events || []) for (const attachment of event.attachments || []) {
        if (capture) await api.capture(attachment); else await api.restore(attachment);
      }
    },
    async resolve(file) {
      const entry = Object.entries(cluster.replica.state.values).find(([key, value]) => key.startsWith('asset:') && value.originalPath === file);
      if (!entry) return file;
      const attachment = { clusterAsset: entry[0].slice(6) }; await api.restore(attachment); return attachment.path;
    },
  };
  return api;
}
