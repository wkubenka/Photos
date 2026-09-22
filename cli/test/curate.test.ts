import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { setFeatured, editPhoto, removePhoto } from "../src/commands/curate.js";
import { commit, rebuildFeatured, rebuildIndex, readFeatured, readIndex, readMonth, KEYS } from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

function photo(id: string, takenAt: string): Photo {
  return {
    id, title: `title ${id}`, caption: "caption", location: "somewhere", takenAt, featured: false,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

let store: ReturnType<typeof createMemoryStore>;

beforeEach(async () => {
  store = createMemoryStore();
  const months: MonthFile[] = [
    { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] },
    { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-02T10:00:00-06:00")] },
  ];
  for (const m of months) {
    for (const p of m.photos) {
      await store.put(p.web.path, new Uint8Array([1]), "image/jpeg", "x");
      await store.put(p.thumb.path, new Uint8Array([1]), "image/jpeg", "x");
      await store.put(p.original.path, new Uint8Array([1]), "application/octet-stream", "x");
    }
  }
  await store.put(KEYS.keys, new TextEncoder().encode(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kdf: { alg: "argon2id", salt: "c2FsdA==", m: 65536, t: 3, p: 1, keyLen: 32 },
    verifier: { iv: "aXY=", ct: "Y3Q=" },
    keys: { a: { iv: "aXY=", ct: "Y3Q=" }, b: { iv: "aXY=", ct: "Y3Q=" } },
  })), "application/json", "x");
  await commit(store, { months, featured: rebuildFeatured(months), index: rebuildIndex(months, null) });
});

/** The month shards a change actually wrote. */
async function shardWrites(run: () => Promise<unknown>): Promise<string[]> {
  const written: string[] = [];
  const put = store.put.bind(store);
  store.put = async (key, ...rest) => {
    if (key.startsWith("data/months/")) written.push(key);
    return put(key, ...rest);
  };
  try {
    await run();
  } finally {
    store.put = put;
  }
  return written;
}

// The library is seeded with two months, so a command that rewrites both
// fails these. At the spec's stated volume the real cost is ~120 shard PUTs
// per curation after a decade, each leaving a noncurrent version to linger
// for 90 days under the lifecycle rule.
describe("touching only the changed month shard", () => {
  it("feature writes only the shard holding the photo", async () => {
    expect(await shardWrites(() => setFeatured(store, ["a"], true)))
      .toEqual(["data/months/2026-03.json"]);
    // The untouched month is still counted correctly in the rebuilt index.
    expect((await readIndex(store)).months.map((m) => m.month).sort())
      .toEqual(["2026-03", "2026-08"]);
    expect((await readMonth(store, "2026-08")).photos).toHaveLength(1);
  });

  it("unfeature writes only the shard holding the photo", async () => {
    await setFeatured(store, ["b"], true);
    expect(await shardWrites(() => setFeatured(store, ["b"], false)))
      .toEqual(["data/months/2026-08.json"]);
    expect((await readFeatured(store)).photos).toEqual([]);
  });

  it("feature across two months writes both, and only those", async () => {
    expect((await shardWrites(() => setFeatured(store, ["a", "b"], true))).sort())
      .toEqual(["data/months/2026-03.json", "data/months/2026-08.json"]);
  });

  it("edit writes only the shard holding the photo", async () => {
    expect(await shardWrites(() => editPhoto(store, "b", { caption: "new" })))
      .toEqual(["data/months/2026-08.json"]);
    expect((await readMonth(store, "2026-08")).photos[0]!.caption).toBe("new");
  });

  it("rm writes only the shard holding the photo", async () => {
    expect(await shardWrites(() => removePhoto(store, "a")))
      .toEqual(["data/months/2026-03.json"]);
    expect((await readMonth(store, "2026-03")).photos).toEqual([]);
    expect((await readIndex(store)).months.map((m) => m.month)).toEqual(["2026-08"]);
  });
});

describe("setFeatured", () => {
  it("flags the photo in its month shard and in featured.json", async () => {
    await setFeatured(store, ["a"], true);
    expect((await readMonth(store, "2026-03")).photos[0]!.featured).toBe(true);
    expect((await readFeatured(store)).photos.map((p) => p.id)).toEqual(["a"]);
    expect((await readIndex(store)).featuredCount).toBe(1);
  });

  it("unfeatures", async () => {
    await setFeatured(store, ["a", "b"], true);
    await setFeatured(store, ["a"], false);
    expect((await readFeatured(store)).photos.map((p) => p.id)).toEqual(["b"]);
  });

  it("throws on an unknown id and changes nothing", async () => {
    await expect(setFeatured(store, ["nope"], true)).rejects.toThrow(/nope/);
    expect((await readFeatured(store)).photos).toEqual([]);
  });

  it("all-or-nothing: mixed valid and invalid ids leaves valid ones unchanged", async () => {
    await setFeatured(store, ["a"], true);
    const beforeAttempt = (await readMonth(store, "2026-03")).photos[0]!.featured;
    expect(beforeAttempt).toBe(true);

    await expect(setFeatured(store, ["a", "nope"], false)).rejects.toThrow(/nope/);

    const afterFailedAttempt = (await readMonth(store, "2026-03")).photos[0]!.featured;
    expect(afterFailedAttempt).toBe(true);
    expect((await readFeatured(store)).photos.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("editPhoto", () => {
  it("amends fields in the month shard", async () => {
    await editPhoto(store, "a", { caption: "a better caption" });
    expect((await readMonth(store, "2026-03")).photos[0]!.caption).toBe("a better caption");
  });

  it("regenerates featured.json so the home page never shows stale text", async () => {
    await setFeatured(store, ["a"], true);
    await editPhoto(store, "a", { title: "a better title" });
    expect((await readFeatured(store)).photos[0]!.title).toBe("a better title");
  });

  it("leaves untouched fields alone", async () => {
    const updated = await editPhoto(store, "a", { location: "elsewhere" });
    expect(updated.title).toBe("title a");
    expect(updated.location).toBe("elsewhere");
  });
});

describe("removePhoto", () => {
  it("removes the record, its key entry, and its objects", async () => {
    await removePhoto(store, "a");
    expect((await readMonth(store, "2026-03")).photos).toEqual([]);
    expect(await store.get("orig/a.enc")).toBeNull();
    expect(await store.get("web/a-2048.aaaaaaaa.jpg")).toBeNull();
    const keys = JSON.parse(new TextDecoder().decode((await store.get(KEYS.keys))!));
    expect(keys.keys.a).toBeUndefined();
    expect(keys.keys.b).toBeDefined();
  });

  it("drops the month from the index once it is empty", async () => {
    await removePhoto(store, "a");
    expect((await readIndex(store)).months.map((m) => m.month)).toEqual(["2026-08"]);
  });

  it("regenerates featured.json when a featured photo is removed", async () => {
    await setFeatured(store, ["a"], true);
    await removePhoto(store, "a");
    expect((await readFeatured(store)).photos).toEqual([]);
  });

  it("writes in the correct order: manifest, then keys, then objects", async () => {
    const operations: Array<{ op: "put" | "delete"; key: string }> = [];
    const originalPut = store.put.bind(store);
    const originalDelete = store.delete.bind(store);

    store.put = async (key, ...rest) => {
      operations.push({ op: "put", key });
      return originalPut(key, ...rest);
    };

    store.delete = async (key) => {
      operations.push({ op: "delete", key });
      return originalDelete(key);
    };

    await removePhoto(store, "a");

    // Find positions of key milestones
    // Shard keys are "data/months/2026-03.json", so the old "2026-" prefix
    // test matched nothing and this assertion was weaker than it read.
    const manifestWrites = operations.filter(
      (op) => op.op === "put"
        && (op.key.startsWith("data/months/") || op.key === KEYS.index || op.key === KEYS.featured),
    );
    expect(manifestWrites.some((w) => w.key.startsWith("data/months/"))).toBe(true);
    const keysWrite = operations.find((op) => op.op === "put" && op.key === KEYS.keys);
    const objectDeletes = operations.filter((op) => op.op === "delete" && !op.key.startsWith("data/"));

    // All manifest writes must precede keys.json write
    expect(manifestWrites.length).toBeGreaterThan(0);
    expect(keysWrite).toBeDefined();
    expect(objectDeletes.length).toBeGreaterThan(0);

    const lastManifestIndex = Math.max(...manifestWrites.map((w) => operations.indexOf(w)));
    const keysIndex = operations.indexOf(keysWrite!);
    const firstObjectDeleteIndex = Math.min(...objectDeletes.map((d) => operations.indexOf(d)));

    expect(lastManifestIndex).toBeLessThan(keysIndex);
    expect(keysIndex).toBeLessThan(firstObjectDeleteIndex);
  });
});
