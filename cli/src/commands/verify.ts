import {
  checkVerifier, decryptOriginal, deriveMasterKey, monthOf, unwrapDataKey,
} from "@photos/core";
import { CACHE_SHORT } from "../config.js";
import { KEYS, commit, readAllMonths, readFeatured, readIndex, readKeys, rebuildFeatured } from "../manifest.js";
import type { Store } from "../store.js";

export interface VerifyReport {
  photoCount: number;
  missingObjects: string[];
  missingKeys: string[];
  orphanKeys: string[];
  featuredDrift: string[];
  monthMismatches: string[];
  backupAgeDays: number | null;
  sampleDecrypted: boolean | null;
  ok: boolean;
}

/** Patches lastBackupAt onto the existing index; never rebuilds it from scratch. */
export async function recordBackup(store: Store, at: string): Promise<void> {
  const index = await readIndex(store);
  await commit(store, { index: { ...index, lastBackupAt: at } });
}

export async function verifyLibrary(
  deps: { store: Store; password?: string },
): Promise<VerifyReport> {
  const { store } = deps;
  const index = await readIndex(store);
  const months = await readAllMonths(store, index);
  const photos = months.flatMap((m) => m.photos);
  const keys = await readKeys(store);
  const featured = await readFeatured(store);

  const missingObjects: string[] = [];
  for (const p of photos) {
    for (const key of [p.web.path, p.thumb.path, p.original.path]) {
      if ((await store.head(key)) === null) missingObjects.push(key);
    }
  }

  const keyIds = new Set(Object.keys(keys?.keys ?? {}));
  const photoIds = new Set(photos.map((p) => p.id));
  const missingKeys = photos.filter((p) => !keyIds.has(p.id)).map((p) => p.id);
  const orphanKeys = [...keyIds].filter((id) => !photoIds.has(id));

  const expected = rebuildFeatured(months);
  const expectedById = new Map(expected.photos.map((p) => [p.id, p]));
  const actualById = new Map(featured.photos.map((p) => [p.id, p]));
  const featuredDrift = [...new Set([...expectedById.keys(), ...actualById.keys()])].filter((id) => {
    const a = expectedById.get(id);
    const b = actualById.get(id);
    return JSON.stringify(a) !== JSON.stringify(b);
  });

  const monthMismatches = months.flatMap((m) =>
    m.photos.filter((p) => monthOf(p.takenAt) !== m.month).map((p) => p.id),
  );

  const backupAgeDays = index.lastBackupAt
    ? (Date.now() - Date.parse(index.lastBackupAt)) / 86_400_000
    : null;

  // With a password, prove the library is still readable rather than merely
  // well-bookkept: unwrap the newest photo's key and decrypt its original.
  let sampleDecrypted: boolean | null = null;
  if (deps.password && keys && photos.length > 0) {
    sampleDecrypted = false;
    const newest = photos.reduce((a, b) => (a.takenAt >= b.takenAt ? a : b));
    const wrapped = keys.keys[newest.id];
    const container = await store.get(newest.original.path);
    if (wrapped && container) {
      try {
        const master = await deriveMasterKey(deps.password, keys.kdf);
        if (await checkVerifier(master, keys.verifier)) {
          const dataKey = await unwrapDataKey(master, wrapped, newest.id);
          const plain = await decryptOriginal(container, dataKey, newest.id);
          const digest = [...new Uint8Array(
            await globalThis.crypto.subtle.digest("SHA-256", plain as BufferSource),
          )]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          sampleDecrypted = digest === newest.original.sha256;
        }
      } catch {
        sampleDecrypted = false;
      }
    }
  }

  return {
    photoCount: photos.length,
    missingObjects: missingObjects.sort(),
    missingKeys: missingKeys.sort(),
    orphanKeys: orphanKeys.sort(),
    featuredDrift: featuredDrift.sort(),
    monthMismatches: monthMismatches.sort(),
    backupAgeDays,
    sampleDecrypted,
    ok:
      missingObjects.length === 0 &&
      missingKeys.length === 0 &&
      orphanKeys.length === 0 &&
      featuredDrift.length === 0 &&
      monthMismatches.length === 0 &&
      sampleDecrypted !== false,
  };
}

export function formatReport(report: VerifyReport): string {
  const lines = [`${report.photoCount} photos`];
  const section = (label: string, items: string[]) => {
    if (items.length) lines.push(`${label}: ${items.join(", ")}`);
  };
  section("missing objects", report.missingObjects);
  section("photos with no key", report.missingKeys);
  section("keys with no photo", report.orphanKeys);
  section("featured.json drift", report.featuredDrift);
  section("photos in the wrong month shard", report.monthMismatches);
  if (report.sampleDecrypted === true) lines.push("sample original decrypted and matched its checksum");
  if (report.sampleDecrypted === false) lines.push("SAMPLE DECRYPTION FAILED");
  if (report.backupAgeDays === null) {
    lines.push("WARNING: no backup has ever been recorded. See infra/README.md.");
  } else if (report.backupAgeDays > 30) {
    lines.push(`WARNING: last backup was ${Math.floor(report.backupAgeDays)} days ago.`);
  }
  lines.push(report.ok ? "OK" : "PROBLEMS FOUND");
  return lines.join("\n");
}
