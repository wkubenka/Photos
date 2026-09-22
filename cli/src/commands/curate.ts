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
  let next = months;
  for (const id of ids) next = replacePhoto(next, id, (p) => ({ ...p, featured }));
  await commit(store, {
    months: next,
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

  let updated: Photo | null = null;
  const next = replacePhoto(months, id, (p) => {
    updated = { ...p, ...patch };
    return updated;
  });

  await commit(store, {
    months: next,
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });
  return updated!;
}

export async function removePhoto(store: Store, id: string): Promise<void> {
  const { months, lastBackupAt } = await loadMonths(store);
  const found = findPhoto(months, id);
  if (!found) throw new Error(`no photo with id ${id}`);

  const next = replacePhoto(months, id, () => null);

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

  await commit(store, {
    months: next,
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });

  // Objects are deleted last: an orphaned object is harmless, a manifest
  // pointing at a deleted object is not.
  for (const key of [found.photo.web.path, found.photo.thumb.path, found.photo.original.path]) {
    await store.delete(key);
  }
}
