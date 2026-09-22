import {
  checkVerifier, decryptOriginal, deriveMasterKey, monthOf, unwrapDataKey,
} from "@photos/core";
import { CACHE_SHORT } from "../config.js";
import { KEYS, commit, readAllMonths, readFeatured, readIndex, readKeys, rebuildFeatured } from "../manifest.js";
import type { Store } from "../store.js";

export interface VerifyReport {
  photoCount: number;
  missingObjects: string[];
  sizeMismatches: string[];
  missingKeys: string[];
  orphanKeys: string[];
  duplicateIds: string[];
  featuredDrift: string[];
  monthMismatches: string[];
  countMismatches: string[];
  backupAgeDays: number | null;
  sampleDecrypted: boolean | null;
  ok: boolean;
}

/**
 * JSON with object keys in a fixed order, so two records that differ only in
 * the order their fields happen to serialize in compare equal. Plain
 * JSON.stringify is key-order sensitive, which made featuredDrift report
 * drift for records that were in fact identical (and, worse, gave the
 * impression drift was being checked structurally when it was not).
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

  // head() already returns the size, so comparing it against the bytes the
  // manifest records costs no extra request — and it is the only check here
  // that catches a truncated upload, which otherwise passes cleanly.
  const missingObjects: string[] = [];
  const sizeMismatches: string[] = [];
  for (const p of photos) {
    for (const [key, bytes] of [
      [p.web.path, p.web.bytes],
      [p.thumb.path, p.thumb.bytes],
      [p.original.path, p.original.bytes],
    ] as [string, number][]) {
      const head = await store.head(key);
      if (head === null) missingObjects.push(key);
      else if (head.size !== bytes) {
        sizeMismatches.push(`${key} (${head.size} bytes in S3, manifest says ${bytes})`);
      }
    }
  }

  const keyIds = new Set(Object.keys(keys?.keys ?? {}));
  const photoIds = new Set(photos.map((p) => p.id));
  const missingKeys = photos.filter((p) => !keyIds.has(p.id)).map((p) => p.id);
  const orphanKeys = [...keyIds].filter((id) => !photoIds.has(id));

  // Counted, not collapsed into a Set: two records sharing an id means one
  // photo's wrapped key and encrypted original were written over the other's,
  // and the set-based comparisons above cannot see it.
  const idCounts = new Map<string, number>();
  for (const p of photos) idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1);
  const duplicateIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id);

  const expected = rebuildFeatured(months);
  const expectedById = new Map(expected.photos.map((p) => [p.id, p]));
  const actualById = new Map(featured.photos.map((p) => [p.id, p]));
  const featuredDrift = [...new Set([...expectedById.keys(), ...actualById.keys()])].filter((id) => {
    const a = expectedById.get(id);
    const b = actualById.get(id);
    return canonical(a) !== canonical(b);
  });

  const monthMismatches = months.flatMap((m) =>
    m.photos.filter((p) => monthOf(p.takenAt) !== m.month).map((p) => p.id),
  );

  // The index is what the site reads before it fetches a single shard, so a
  // count that disagrees with the shards is a visible lie on the rail.
  const countMismatches: string[] = [];
  if (index.photoCount !== photos.length) {
    countMismatches.push(
      `index.photoCount is ${index.photoCount}, shards hold ${photos.length}`,
    );
  }
  const shardSizes = new Map(months.map((m) => [m.month, m.photos.length]));
  for (const entry of index.months) {
    const actual = shardSizes.get(entry.month) ?? 0;
    if (entry.count !== actual) {
      countMismatches.push(`${entry.month}: index says ${entry.count}, shard holds ${actual}`);
    }
  }

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
    sizeMismatches: sizeMismatches.sort(),
    missingKeys: missingKeys.sort(),
    orphanKeys: orphanKeys.sort(),
    duplicateIds: duplicateIds.sort(),
    featuredDrift: featuredDrift.sort(),
    monthMismatches: monthMismatches.sort(),
    countMismatches: countMismatches.sort(),
    backupAgeDays,
    sampleDecrypted,
    ok:
      missingObjects.length === 0 &&
      sizeMismatches.length === 0 &&
      missingKeys.length === 0 &&
      orphanKeys.length === 0 &&
      duplicateIds.length === 0 &&
      featuredDrift.length === 0 &&
      monthMismatches.length === 0 &&
      countMismatches.length === 0 &&
      sampleDecrypted !== false,
  };
}

export function formatReport(report: VerifyReport): string {
  const lines = [`${report.photoCount} photos`];
  const section = (label: string, items: string[]) => {
    if (items.length) lines.push(`${label}: ${items.join(", ")}`);
  };
  section("missing objects", report.missingObjects);
  section("objects whose size does not match the manifest", report.sizeMismatches);
  section("photos with no key", report.missingKeys);
  section("keys with no photo", report.orphanKeys);
  section("ids used by more than one photo record", report.duplicateIds);
  section("featured.json drift", report.featuredDrift);
  section("photos in the wrong month shard", report.monthMismatches);
  section("counts that disagree with the shards", report.countMismatches);
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
