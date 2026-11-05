import { KINDS, isValidKey } from './images.js';

/**
 * Pure: which stored objects are safe to delete?
 * Only keys that look like ours, are not referenced by Firestore, and are older than minAgeMs
 * (so an image uploaded a moment ago, whose Firestore write has not landed yet, is never removed).
 */
export function findOrphans(objects, referenced, { now = Date.now(), minAgeMs = 24 * 3600 * 1000 } = {}) {
  return objects.filter((o) =>
    isValidKey(o.key) && !referenced.has(o.key) && now - new Date(o.lastModified).getTime() >= minAgeMs);
}

export async function sweepImages({ imageStore, referenced, apply = false, minAgeMs, now }) {
  const objects = (await Promise.all(KINDS.map((k) => imageStore.list(`${k}/`)))).flat();
  const orphans = findOrphans(objects, referenced, { now, minAgeMs });
  if (apply) for (const o of orphans) await imageStore.delete(o.key);
  return { scanned: objects.length, orphans: orphans.map((o) => o.key), deleted: apply ? orphans.length : 0 };
}
