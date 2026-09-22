import type { Store } from "./store.js";

interface Stored { body: Uint8Array; contentType: string; cacheControl: string }

export function createMemoryStore(): Store & {
  objects: Map<string, Stored>;
  failAfter(n: number): void;
} {
  const objects = new Map<string, Stored>();
  const versions = new Map<string, { versionId: string; lastModified: string; body: Uint8Array }[]>();
  let puts = 0;
  let limit = Infinity;

  return {
    objects,
    failAfter(n) { limit = n; },
    async get(key) { return objects.get(key)?.body ?? null; },
    async put(key, body, contentType, cacheControl) {
      if (puts >= limit) throw new Error(`simulated store failure at put ${puts + 1}`);
      puts++;
      objects.set(key, { body, contentType, cacheControl });
      const list = versions.get(key) ?? [];
      list.unshift({
        versionId: `v${list.length + 1}`,
        lastModified: new Date(Date.now() + list.length).toISOString(),
        body,
      });
      versions.set(key, list);
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.body.length } : null;
    },
    async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
    async delete(key) { objects.delete(key); },
    async listVersions(key) {
      return (versions.get(key) ?? []).map(({ versionId, lastModified }) => ({ versionId, lastModified }));
    },
    async getVersion(key, versionId) {
      const v = (versions.get(key) ?? []).find((x) => x.versionId === versionId);
      if (!v) throw new Error(`no version ${versionId} of ${key}`);
      return v.body;
    },
  };
}
