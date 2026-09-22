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
 * Every month shard S3 actually holds, read from the bucket rather than from
 * the index. `repair` exists precisely for the case where `data/index.json`
 * is missing or wrong, so it cannot take its list of months from the file it
 * is supposed to rebuild.
 *
 * A shard that will not parse stops the rebuild instead of being skipped:
 * rebuilding without it would drop every photo it holds out of the index,
 * and `gc` would then see those photos' originals as unreferenced.
 */
async function readShardsFromStore(store: Store): Promise<MonthFile[]> {
  const shards: MonthFile[] = [];
  for (const key of (await store.list("data/months/")).sort()) {
    if (!key.endsWith(".json")) continue;
    const body = await store.get(key);
    if (!body) continue;
    try {
      shards.push(MonthFileSchema.parse(JSON.parse(new TextDecoder().decode(body))));
    } catch (err) {
      throw new Error(
        `cannot rebuild: ${key} is not a readable month shard (${(err as Error).message}). `
        + `Roll it back with \`photos restore ${key} <version>\` first — rebuilding without `
        + "it would drop every photo it holds out of the index.",
      );
    }
  }
  return shards;
}

/**
 * Candidates are derivatives, encrypted originals, and month shards the index
 * no longer lists. A shard that still holds photo records is never proposed,
 * so a stale index cannot turn into lost records.
 */
export async function collectGarbage(store: Store): Promise<string[]> {
  const index = await readIndex(store);
  const months = await readAllMonths(store, index);
  const referenced = referencedKeys(months);
  const liveShards = new Set(index.months.map((m) => m.path));

  const originals = await store.list("orig/");
  // readIndex returns an empty index when data/index.json is absent, so a
  // lost index looks exactly like an empty library — and every encrypted
  // original becomes a deletion candidate. Refuse for the same reason the
  // month-shard guard below refuses: never propose deleting what cannot be
  // verified as unreferenced.
  if (months.every((m) => m.photos.length === 0) && originals.length > 0) {
    throw new Error(
      `the manifest references no photos at all, but orig/ holds ${originals.length} encrypted `
      + "original(s). data/index.json is missing or empty, so nothing here can be shown to be "
      + "garbage. Run `photos repair` to rebuild the index from the month shards in S3, then "
      + "run gc again.",
    );
  }

  const assets = [...(await store.list("web/")), ...originals]
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
  // The index is read only for lastBackupAt; the records themselves come from
  // the shards S3 holds, so repair still works when the index is gone.
  const previous = await readIndex(store);
  const existingMonths = await readShardsFromStore(store);
  const photos = existingMonths.flatMap((m) => m.photos);

  const grouped = new Map<string, MonthFile>();
  // Start every shard that exists as empty, so a shard a photo has moved
  // out of gets rewritten as empty rather than left stale.
  for (const m of existingMonths) {
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
