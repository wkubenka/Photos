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
    const manifestWrites = operations.filter(
      (op) => op.op === "put" && (op.key.startsWith("2026-") || op.key === KEYS.index || op.key === KEYS.featured),
    );
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
