import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import {
  KEYS, readIndex, readMonth, readFeatured, rebuildIndex, rebuildFeatured, commit,
} from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

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

function month(m: string, photos: Photo[]): MonthFile {
  return { schemaVersion: SCHEMA_VERSION, month: m, photos };
}

describe("reads with no data present", () => {
  it("returns an empty index", async () => {
    const index = await readIndex(createMemoryStore());
    expect(index.photoCount).toBe(0);
    expect(index.months).toEqual([]);
  });

  it("returns an empty month shard", async () => {
    expect((await readMonth(createMemoryStore(), "2026-03")).photos).toEqual([]);
  });

  it("returns an empty featured file", async () => {
    expect((await readFeatured(createMemoryStore())).photos).toEqual([]);
  });
});

describe("rebuildIndex", () => {
  it("lists months newest first with counts, skipping empty ones", () => {
    const index = rebuildIndex(
      [month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00")]),
       month("2026-08", [photo("b", "2026-08-01T10:00:00-06:00"), photo("c", "2026-08-02T10:00:00-06:00")]),
       month("2026-05", [])],
      null,
    );
    expect(index.months.map((m) => m.month)).toEqual(["2026-08", "2026-03"]);
    expect(index.months[0]!.count).toBe(2);
    expect(index.months[0]!.path).toBe("data/months/2026-08.json");
    expect(index.photoCount).toBe(3);
  });

  it("carries lastBackupAt through", () => {
    expect(rebuildIndex([], "2026-09-19T08:30:00Z").lastBackupAt).toBe("2026-09-19T08:30:00Z");
  });
});

describe("rebuildFeatured", () => {
  it("collects only featured photos, newest first", () => {
    const f = rebuildFeatured([
      month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00", true)]),
      month("2026-08", [photo("b", "2026-08-01T10:00:00-06:00"), photo("c", "2026-08-02T10:00:00-06:00", true)]),
    ]);
    expect(f.photos.map((p) => p.id)).toEqual(["c", "a"]);
  });
});

describe("commit ordering", () => {
  const change = () => ({
    objects: [{ key: "orig/a.enc", body: new Uint8Array([1]), contentType: "application/octet-stream" }],
    keys: {
      schemaVersion: SCHEMA_VERSION as 1,
      kdf: { alg: "argon2id" as const, salt: "c2FsdA==", m: 65536, t: 3, p: 1, keyLen: 32 },
      verifier: { iv: "aXY=", ct: "Y3Q=" },
      keys: {},
    },
    months: [month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00")])],
    featured: { schemaVersion: SCHEMA_VERSION as 1, generatedAt: "now", photos: [] },
    index: rebuildIndex([month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00")])], null),
  });

  it("writes assets, keys, months, featured, then the index", async () => {
    const store = createMemoryStore();
    const order: string[] = [];
    const put = store.put.bind(store);
    store.put = async (k, b, c, cc) => { order.push(k); return put(k, b, c, cc); };
    await commit(store, change());
    expect(order).toEqual([
      "orig/a.enc",
      KEYS.keys,
      "data/months/2026-03.json",
      KEYS.featured,
      KEYS.index,
    ]);
  });

  it("leaves the index untouched if a month shard write fails", async () => {
    const store = createMemoryStore();
    store.failAfter(2); // asset and keys succeed, the month shard fails
    await expect(commit(store, change())).rejects.toThrow(/simulated/);
    expect(await store.get(KEYS.index)).toBeNull();
  });

  it("gives data files the short cache header and assets the immutable one", async () => {
    const store = createMemoryStore();
    await commit(store, change());
    expect(store.objects.get(KEYS.index)!.cacheControl).toBe("max-age=60, must-revalidate");
    expect(store.objects.get("orig/a.enc")!.cacheControl).toBe("max-age=31536000, immutable");
  });

  it("round-trips through the schemas", async () => {
    const store = createMemoryStore();
    await commit(store, change());
    expect((await readIndex(store)).photoCount).toBe(1);
    expect((await readMonth(store, "2026-03")).photos[0]!.id).toBe("a");
  });
});
