import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { verifyLibrary, recordBackup, formatReport } from "../src/commands/verify.js";
import { KEYS, commit, rebuildFeatured, rebuildIndex } from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";
import { closeExif } from "../src/exif.js";
import { closeRightsWriter } from "../src/rights.js";

afterAll(async () => {
  await closeExif();
  await closeRightsWriter();
});

function photo(id: string, takenAt: string, featured = false): Photo {
  return {
    id, title: id, caption: "", location: "", takenAt, featured,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

let store: ReturnType<typeof createMemoryStore>;
const enc = new TextEncoder();

// Objects are written at exactly the size their record claims: verify now
// compares head()'s size against the manifest, so a fixture that wrote a
// 1-byte stand-in for a 1000-byte original would report a size mismatch on
// every photo in every test.
async function seed(months: MonthFile[], keyIds: string[], objects = true) {
  if (objects) {
    for (const m of months) for (const p of m.photos) {
      for (const [k, bytes] of [
        [p.web.path, p.web.bytes], [p.thumb.path, p.thumb.bytes],
        [p.original.path, p.original.bytes],
      ] as [string, number][]) {
        await store.put(k, new Uint8Array(bytes), "image/jpeg", "x");
      }
    }
  }
  await store.put(KEYS.keys, enc.encode(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kdf: { alg: "argon2id", salt: "c2FsdA==", m: 512, t: 1, p: 1, keyLen: 32 },
    verifier: { iv: "aXY=", ct: "Y3Q=" },
    keys: Object.fromEntries(keyIds.map((id) => [id, { iv: "aXY=", ct: "Y3Q=" }])),
  })), "application/json", "x");
  await commit(store, { months, featured: rebuildFeatured(months), index: rebuildIndex(months, null) });
}

const march = (photos: Photo[]): MonthFile => ({ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos });

beforeEach(() => { store = createMemoryStore(); });

describe("verifyLibrary", () => {
  it("reports a healthy library", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"]);
    const report = await verifyLibrary({ store });
    expect(report.ok).toBe(true);
    expect(report.photoCount).toBe(1);
  });

  it("reports a missing object", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"], false);
    expect((await verifyLibrary({ store })).missingObjects).toContain("orig/a.enc");
  });

  it("reports a photo with no wrapped key", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], []);
    expect((await verifyLibrary({ store })).missingKeys).toEqual(["a"]);
  });

  it("reports a wrapped key for a photo that no longer exists", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a", "ghost"]);
    expect((await verifyLibrary({ store })).orphanKeys).toEqual(["ghost"]);
  });

  it("reports featured.json drifting from its month shard", async () => {
    const months = [march([photo("a", "2026-03-14T10:00:00-06:00", true)])];
    await seed(months, ["a"]);
    const stale = { schemaVersion: SCHEMA_VERSION, generatedAt: "x",
      photos: [{ ...photo("a", "2026-03-14T10:00:00-06:00", true), title: "an old title" }] };
    await store.put(KEYS.featured, enc.encode(JSON.stringify(stale)), "application/json", "x");
    expect((await verifyLibrary({ store })).featuredDrift).toEqual(["a"]);
  });

  it("reports a photo filed in the wrong month shard", async () => {
    await seed([march([photo("a", "2026-08-02T10:00:00-06:00")])], ["a"]);
    expect((await verifyLibrary({ store })).monthMismatches).toEqual(["a"]);
  });

  it("decrypts a sample when given the password", async () => {
    // Build a real library so the sample has something genuine to decrypt.
    //
    // readExif throws when it cannot determine a capture time, so a fixture
    // made only with sharp(...) fails before this test can assert anything.
    // Following the pattern in cli/test/add.test.ts and cli/test/exif.test.ts:
    // make pixels with sharp, write the file, then stamp DateTimeOriginal and
    // OffsetTimeOriginal with exiftool.
    const { addPhotos } = await import("../src/commands/add.js");
    const sharp = (await import("sharp")).default;
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { exiftool } = await import("exiftool-vendored");

    const dir = mkdtempSync(join(tmpdir(), "photos-verify-"));
    const file = join(dir, "DSCF0001.jpg");
    writeFileSync(file, await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#456" },
    }).jpeg().toBuffer());
    await exiftool.write(file, {
      DateTimeOriginal: "2026:03:14 18:22:05",
      OffsetTimeOriginal: "-06:00",
    });

    const real = createMemoryStore();
    await addPhotos(
      {
        store: real,
        config: {
          bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
          siteUrl: "https://x.test", creator: "W", copyright: "c", usageTerms: "u",
          sizes: { display: 2048, thumb: 640 },
        },
        prompt: async () => ({ title: "Sample", caption: "", location: "" }),
        password: async () => "a long passphrase",
      },
      [file],
      { offset: "-06:00" },
    );

    expect((await verifyLibrary({ store: real })).sampleDecrypted).toBeNull();
    const report = await verifyLibrary({ store: real, password: "a long passphrase" });
    expect(report.sampleDecrypted).toBe(true);
    expect(report.ok).toBe(true);

    const wrong = await verifyLibrary({ store: real, password: "not the passphrase" });
    expect(wrong.sampleDecrypted).toBe(false);
    expect(wrong.ok).toBe(false);
  }, 90_000);

  it("reports an object truncated to a different size than the manifest records", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"]);
    // A half-finished upload: the object is there, so head() succeeds and
    // every other check passes cleanly.
    await store.put("orig/a.enc", new Uint8Array(400), "application/octet-stream", "x");

    const report = await verifyLibrary({ store });
    expect(report.missingObjects).toEqual([]);
    expect(report.sizeMismatches).toHaveLength(1);
    expect(report.sizeMismatches[0]).toContain("orig/a.enc");
    expect(report.sizeMismatches[0]).toContain("400");
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toContain("orig/a.enc");
  });

  // Two records sharing an id means one photo's wrapped key and encrypted
  // original were written over the other's. The set-based key comparisons
  // collapse a duplicate to one entry and cannot see it.
  it("reports an id used by more than one photo record", async () => {
    const duplicated = photo("a", "2026-03-14T10:00:00-06:00");
    await seed([march([duplicated, { ...duplicated, title: "the one that was overwritten" }])], ["a"]);

    const report = await verifyLibrary({ store });
    expect(report.duplicateIds).toEqual(["a"]);
    expect(report.missingKeys).toEqual([]);
    expect(report.orphanKeys).toEqual([]);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toMatch(/more than one photo record: a/);
  });

  it("reports an index whose counts disagree with the shards", async () => {
    const months = [march([photo("a", "2026-03-14T10:00:00-06:00")])];
    await seed(months, ["a"]);
    const index = JSON.parse(new TextDecoder().decode((await store.get(KEYS.index))!));
    index.photoCount = 7;
    index.months[0].count = 4;
    await store.put(KEYS.index, enc.encode(JSON.stringify(index)), "application/json", "x");

    const report = await verifyLibrary({ store });
    expect(report.countMismatches).toHaveLength(2);
    expect(report.countMismatches.join(" ")).toContain("2026-03");
    expect(report.ok).toBe(false);
  });

  // featuredDrift is compared structurally (key-order insensitive) rather
  // than by JSON.stringify. The comparison has to recurse: most of what the
  // home page renders from a featured record sits in nested objects.
  it("reports drift in a nested field of a featured record", async () => {
    const p = photo("a", "2026-03-14T10:00:00-06:00", true);
    await seed([march([p])], ["a"]);
    const stale = {
      schemaVersion: SCHEMA_VERSION, generatedAt: "x",
      photos: [{ ...p, web: { ...p.web, path: "web/a-2048.stale.jpg" } }],
    };
    await store.put(KEYS.featured, enc.encode(JSON.stringify(stale)), "application/json", "x");

    const report = await verifyLibrary({ store });
    expect(report.featuredDrift).toEqual(["a"]);
    expect(report.ok).toBe(false);
  });

  it("warns when the backup is stale and not when it is fresh", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"]);
    expect((await verifyLibrary({ store })).backupAgeDays).toBeNull();

    await recordBackup(store, new Date(Date.now() - 40 * 86_400_000).toISOString());
    expect((await verifyLibrary({ store })).backupAgeDays).toBeGreaterThan(30);

    await recordBackup(store, new Date().toISOString());
    expect((await verifyLibrary({ store })).backupAgeDays).toBeLessThan(1);
  });
});
