import { KeysFileSchema, type MonthFile, type Photo } from "@photos/core";
import type { Store } from "../store.js";
import {
  KEYS, commit, readAllMonths, readIndex, rebuildFeatured, rebuildIndex,
} from "../manifest.js";
import { CACHE_SHORT } from "../config.js";

export function findPhoto(
  months: MonthFile[],
  id: string,
): { month: MonthFile; photo: Photo } | null {
  for (const month of months) {
    const photo = month.photos.find((p) => p.id === id);
    if (photo) return { month, photo };
  }
  return null;
}

async function loadMonths(store: Store): Promise<{ months: MonthFile[]; lastBackupAt: string | null }> {
  const index = await readIndex(store);
  return { months: await readAllMonths(store, index), lastBackupAt: index.lastBackupAt };
}

/**
 * The shards a change actually touches. rebuildIndex and rebuildFeatured are
 * still given every month — they have to see the whole library to compute
 * counts and the featured set — but commit only writes these, so curating one
 * photograph does not rewrite (and version) every month shard in the bucket.
 */
function changedMonths(months: MonthFile[], ids: string[]): Set<string> {
  const changed = new Set<string>();
  for (const id of ids) {
    const found = findPhoto(months, id);
    if (found) changed.add(found.month.month);
  }
  return changed;
}

function onlyChanged(months: MonthFile[], changed: Set<string>): MonthFile[] {
  return months.filter((m) => changed.has(m.month));
}

function replacePhoto(months: MonthFile[], id: string, update: (p: Photo) => Photo | null): MonthFile[] {
  return months.map((m) => ({
    ...m,
    photos: m.photos.flatMap((p) => {
      if (p.id !== id) return [p];
      const next = update(p);
      return next ? [next] : [];
    }),
  }));
}

export async function setFeatured(store: Store, ids: string[], featured: boolean): Promise<void> {
  const { months, lastBackupAt } = await loadMonths(store);
  for (const id of ids) {
    if (!findPhoto(months, id)) throw new Error(`no photo with id ${id}`);
  }
  const changed = changedMonths(months, ids);
  let next = months;
  for (const id of ids) next = replacePhoto(next, id, (p) => ({ ...p, featured }));
  await commit(store, {
    months: onlyChanged(next, changed),
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });
}

export async function editPhoto(
  store: Store,
  id: string,
  patch: { title?: string; caption?: string; location?: string },
): Promise<Photo> {
  const { months, lastBackupAt } = await loadMonths(store);
  if (!findPhoto(months, id)) throw new Error(`no photo with id ${id}`);

  const changed = changedMonths(months, [id]);
  let updated: Photo | null = null;
  const next = replacePhoto(months, id, (p) => {
    updated = { ...p, ...patch };
    return updated;
  });

  await commit(store, {
    months: onlyChanged(next, changed),
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });
  return updated!;
}

export async function removePhoto(store: Store, id: string): Promise<void> {
  const { months, lastBackupAt } = await loadMonths(store);
  const found = findPhoto(months, id);
  if (!found) throw new Error(`no photo with id ${id}`);

  const changed = changedMonths(months, [id]);
  const next = replacePhoto(months, id, () => null);

  // Commit the manifest first: removes the photo reference from months/index.
  // An orphaned key or object is harmless; a manifest pointing at missing
  // objects is broken.
  await commit(store, {
    months: onlyChanged(next, changed),
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });

  // Then drop the key entry so the photo cannot be decrypted if its objects
  // happen to be restored.
  const keysBytes = await store.get(KEYS.keys);
  if (keysBytes) {
    const keysFile = KeysFileSchema.parse(JSON.parse(new TextDecoder().decode(keysBytes)));
    delete keysFile.keys[id];
    await store.put(
      KEYS.keys,
      new TextEncoder().encode(JSON.stringify(keysFile, null, 2)),
      "application/json",
      CACHE_SHORT,
    );
  }

  // Objects are deleted last: an orphaned object is harmless, a manifest
  // pointing at a deleted object is not.
  for (const key of [found.photo.web.path, found.photo.thumb.path, found.photo.original.path]) {
    await store.delete(key);
  }
}
