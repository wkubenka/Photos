import {
  FeaturedFileSchema, IndexFileSchema, KeysFileSchema, MonthFileSchema,
  SCHEMA_VERSION, monthOf,
  type FeaturedFile, type IndexFile, type KeysFile, type MonthFile, type Photo,
} from "@photos/core";
import { CACHE_IMMUTABLE, CACHE_SHORT } from "./config.js";
import type { Store } from "./store.js";

export const KEYS = {
  index: "data/index.json",
  keys: "data/keys.json",
  featured: "data/featured.json",
  month: (m: string) => `data/months/${m}.json`,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value, null, 2));
}

async function readJson(store: Store, key: string): Promise<unknown | null> {
  const bytes = await store.get(key);
  return bytes === null ? null : JSON.parse(dec.decode(bytes));
}

export function emptyIndex(): IndexFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    lastBackupAt: null,
    photoCount: 0,
    featuredCount: 0,
    sort: "takenAt:desc",
    months: [],
  };
}

export async function readIndex(store: Store): Promise<IndexFile> {
  const raw = await readJson(store, KEYS.index);
  return raw === null ? emptyIndex() : IndexFileSchema.parse(raw);
}

export async function readMonth(store: Store, month: string): Promise<MonthFile> {
  const raw = await readJson(store, KEYS.month(month));
  return raw === null
    ? { schemaVersion: SCHEMA_VERSION, month, photos: [] }
    : MonthFileSchema.parse(raw);
}

export async function readFeatured(store: Store): Promise<FeaturedFile> {
  const raw = await readJson(store, KEYS.featured);
  return raw === null
    ? { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), photos: [] }
    : FeaturedFileSchema.parse(raw);
}

export async function readKeys(store: Store): Promise<KeysFile | null> {
  const raw = await readJson(store, KEYS.keys);
  return raw === null ? null : KeysFileSchema.parse(raw);
}

export async function readAllMonths(store: Store, index: IndexFile): Promise<MonthFile[]> {
  return Promise.all(index.months.map((m) => readMonth(store, m.month)));
}

function byTakenAtDesc(a: Photo, b: Photo): number {
  return a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : a.id < b.id ? 1 : -1;
}

export function sortMonth(m: MonthFile): MonthFile {
  return { ...m, photos: [...m.photos].sort(byTakenAtDesc) };
}

export function rebuildIndex(months: MonthFile[], lastBackupAt: string | null): IndexFile {
  const nonEmpty = months.filter((m) => m.photos.length > 0);
  const featuredCount = nonEmpty.reduce(
    (n, m) => n + m.photos.filter((p) => p.featured).length, 0,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    lastBackupAt,
    photoCount: nonEmpty.reduce((n, m) => n + m.photos.length, 0),
    featuredCount,
    sort: "takenAt:desc",
    months: nonEmpty
      .map((m) => ({ month: m.month, count: m.photos.length, path: KEYS.month(m.month) }))
      .sort((a, b) => (a.month < b.month ? 1 : -1)),
  };
}

export function rebuildFeatured(months: MonthFile[]): FeaturedFile {
  const photos = months
    .flatMap((m) => m.photos)
    .filter((p) => p.featured)
    .sort(byTakenAtDesc);
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), photos };
}

export function monthFor(photo: Photo): string {
  return monthOf(photo.takenAt);
}

export interface Change {
  objects?: { key: string; body: Uint8Array; contentType: string }[];
  keys?: KeysFile;
  months?: MonthFile[];
  featured?: FeaturedFile;
  index: IndexFile;
}

/**
 * The single writer of data/. Order is the spec's, and it is the reason an
 * interrupted run leaves the live site consistent: nothing references an
 * asset until its month shard lands, and no month shard is visible until the
 * index lands.
 */
export async function commit(store: Store, change: Change): Promise<void> {
  for (const o of change.objects ?? []) {
    await store.put(o.key, o.body, o.contentType, CACHE_IMMUTABLE);
  }
  if (change.keys) {
    await store.put(KEYS.keys, json(change.keys), "application/json", CACHE_SHORT);
  }
  for (const m of change.months ?? []) {
    await store.put(KEYS.month(m.month), json(sortMonth(m)), "application/json", CACHE_SHORT);
  }
  if (change.featured) {
    await store.put(KEYS.featured, json(change.featured), "application/json", CACHE_SHORT);
  }
  await store.put(KEYS.index, json(change.index), "application/json", CACHE_SHORT);
}
