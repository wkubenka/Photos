import {
  MonthFileSchema, localDateOf, monthOf, SCHEMA_VERSION,
  type IndexFile, type MonthFile,
} from "@photos/core";
import type { Cdn, Store } from "../store.js";
import {
  KEYS, commit, readAllMonths, readIndex, rebuildFeatured, rebuildIndex,
} from "../manifest.js";

const INVALIDATION_PATHS = ["/data/*", "/index.html"];

function referencedKeys(months: MonthFile[]): Set<string> {
  const keys = new Set<string>();
  for (const m of months) {
    for (const p of m.photos) {
      keys.add(p.web.path);
      keys.add(p.thumb.path);
      keys.add(p.original.path);
    }
  }
  return keys;
}

export async function publish(store: Store, cdn: Cdn): Promise<{ missing: string[] }> {
  const index = await readIndex(store);
  const months = await readAllMonths(store, index);
  const missing: string[] = [];
  for (const key of referencedKeys(months)) {
    if ((await store.head(key)) === null) missing.push(key);
  }
  await cdn.invalidate(INVALIDATION_PATHS);
  return { missing: missing.sort() };
}

export interface PhotoSummary {
  id: string;
  date: string;
  title: string;
  featured: boolean;
  month: string;
}

export async function listPhotos(
  store: Store,
  opts: { month?: string; featuredOnly?: boolean } = {},
): Promise<PhotoSummary[]> {
  const index = await readIndex(store);
  const wanted = opts.month
    ? index.months.filter((m) => m.month === opts.month)
    : index.months;
  const months = await readAllMonths(store, { ...index, months: wanted });

  return months
    .flatMap((m) =>
      m.photos
        .filter((p) => !opts.featuredOnly || p.featured)
        .map((p) => ({
          id: p.id,
          date: localDateOf(p.takenAt),
          title: p.title,
          featured: p.featured,
          month: m.month,
        })),
    )
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
}

export function formatList(rows: PhotoSummary[]): string {
  const width = rows.reduce((n, r) => Math.max(n, r.id.length), 0);
  return rows
    .map((r) => `${r.featured ? "★" : " "} ${r.id.padEnd(width)}  ${r.date}  ${r.title}`)
    .join("\n");
}

const COLLECTABLE_PREFIXES = ["web/", "orig/", "data/months/"];

/**
 * Candidates are derivatives, encrypted originals, and month shards the index
 * no longer lists. A shard that still holds photo records is never proposed,
 * so a stale index cannot turn into lost records.
 */
export async function collectGarbage(store: Store): Promise<string[]> {
  const index = await readIndex(store);
  const referenced = referencedKeys(await readAllMonths(store, index));
  const liveShards = new Set(index.months.map((m) => m.path));

  const assets = [...(await store.list("web/")), ...(await store.list("orig/"))]
    .filter((k) => !referenced.has(k));

  const staleShards: string[] = [];
  for (const key of await store.list("data/months/")) {
    if (liveShards.has(key)) continue;
    const body = await store.get(key);
    if (!body) continue;
    try {
      const shard = MonthFileSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      if (shard.photos.length === 0) staleShards.push(key);
    } catch {
      // Shard contents cannot be verified — could be truncated, corrupted, or mid-migration.
      // Never propose deletion of unverifiable data that might contain photo records.
    }
  }

  return [...assets, ...staleShards].sort();
}

export async function deleteGarbage(store: Store, keys: string[]): Promise<void> {
  for (const key of keys) {
    if (!COLLECTABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`refusing to delete outside ${COLLECTABLE_PREFIXES.join(", ")}: ${key}`);
    }
    await store.delete(key);
  }
}

export async function repair(store: Store): Promise<IndexFile> {
  const previous = await readIndex(store);
  const previousMonths = await readAllMonths(store, previous);
  const photos = previousMonths.flatMap((m) => m.photos);

  const grouped = new Map<string, MonthFile>();
  // Start every previously known month as empty, so a shard a photo has moved
  // out of gets rewritten as empty rather than left stale.
  for (const m of previousMonths) {
    grouped.set(m.month, { schemaVersion: SCHEMA_VERSION, month: m.month, photos: [] });
  }
  for (const photo of photos) {
    const month = monthOf(photo.takenAt);
    const shard = grouped.get(month) ?? { schemaVersion: SCHEMA_VERSION, month, photos: [] };
    grouped.set(month, { ...shard, photos: [...shard.photos, photo] });
  }

  const months = [...grouped.values()];
  const index = rebuildIndex(months, previous.lastBackupAt);
  await commit(store, { months, featured: rebuildFeatured(months), index });
  return index;
}
