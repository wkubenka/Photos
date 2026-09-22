import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import {
  publish, listPhotos, formatList, collectGarbage, deleteGarbage, repair,
} from "../src/commands/maintain.js";
import { commit, rebuildFeatured, rebuildIndex, readIndex, readMonth } from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

function photo(id: string, takenAt: string, featured = false): Photo {
  return {
    id, title: `Title ${id}`, caption: "", location: "", takenAt, featured,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

let store: ReturnType<typeof createMemoryStore>;

async function seed(months: MonthFile[], withObjects = true) {
  if (withObjects) {
    for (const m of months) {
      for (const p of m.photos) {
        for (const k of [p.web.path, p.thumb.path, p.original.path]) {
          await store.put(k, new Uint8Array([1]), "image/jpeg", "x");
        }
      }
    }
  }
  await commit(store, { months, featured: rebuildFeatured(months), index: rebuildIndex(months, null) });
}

beforeEach(() => { store = createMemoryStore(); });

describe("publish", () => {
  it("reports nothing missing for a healthy library and invalidates", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    const invalidated: string[][] = [];
    const result = await publish(store, { invalidate: async (p) => { invalidated.push(p); } });
    expect(result.missing).toEqual([]);
    expect(invalidated[0]).toContain("/data/*");
    expect(invalidated[0]).toContain("/index.html");
  });

  it("reports an object the manifest references but S3 lacks", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }], false);
    const result = await publish(store, { invalidate: async () => {} });
    expect(result.missing).toContain("orig/a.enc");
  });
});

describe("listPhotos", () => {
  const seeded = () => seed([
    { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00", true)] },
    { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [
      photo("b", "2026-08-01T10:00:00-06:00"), photo("c", "2026-08-02T10:00:00-06:00")] },
  ]);

  it("lists the whole library newest first", async () => {
    await seeded();
    expect((await listPhotos(store)).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("carries the local date, title, and featured state", async () => {
    await seeded();
    const row = (await listPhotos(store)).find((r) => r.id === "a")!;
    expect(row).toEqual({ id: "a", date: "2026-03-14", title: "Title a", featured: true, month: "2026-03" });
  });

  it("narrows to one month", async () => {
    await seeded();
    expect((await listPhotos(store, { month: "2026-08" })).map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("narrows to the featured set", async () => {
    await seeded();
    expect((await listPhotos(store, { featuredOnly: true })).map((r) => r.id)).toEqual(["a"]);
  });

  it("returns nothing for a month with no photos", async () => {
    await seeded();
    expect(await listPhotos(store, { month: "2030-01" })).toEqual([]);
  });

  it("formats a copyable line per photo, marking featured ones", async () => {
    await seeded();
    const text = formatList(await listPhotos(store));
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("a");
    expect(text).toMatch(/★.*Title a/);
  });
});

describe("garbage collection", () => {
  it("finds unreferenced objects and leaves referenced ones alone", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    await store.put("orig/orphan.enc", new Uint8Array([9]), "application/octet-stream", "x");
    await store.put("web/orphan-640.cccccccc.jpg", new Uint8Array([9]), "image/jpeg", "x");

    const junk = (await collectGarbage(store)).sort();
    expect(junk).toEqual(["orig/orphan.enc", "web/orphan-640.cccccccc.jpg"]);

    await deleteGarbage(store, junk);
    expect(await store.get("orig/orphan.enc")).toBeNull();
    expect(await store.get("orig/a.enc")).not.toBeNull();
  });

  it("never proposes deleting a data file, a live shard, or a site asset", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    await store.put("index.html", new Uint8Array([1]), "text/html", "x");
    await store.put("assets/main.abc.js", new Uint8Array([1]), "text/javascript", "x");
    expect(await collectGarbage(store)).toEqual([]);
  });

  it("collects a month shard that dropped out of the index", async () => {
    // 2026-03 is emptied, so rebuildIndex drops it while the object remains.
    await seed([
      { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [] },
      { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-01T10:00:00-06:00")] },
    ]);
    expect(await collectGarbage(store)).toContain("data/months/2026-03.json");
  });

  it("refuses to collect an unindexed shard that still holds photo records", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-01T10:00:00-06:00")] }]);
    // A shard the index has lost track of, but which still contains a photo.
    await store.put(
      "data/months/2026-03.json",
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: SCHEMA_VERSION, month: "2026-03",
        photos: [photo("a", "2026-03-14T10:00:00-06:00")],
      })),
      "application/json", "x",
    );
    expect(await collectGarbage(store)).not.toContain("data/months/2026-03.json");
  });

  it("refuses to collect an unindexed shard with invalid JSON", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-01T10:00:00-06:00")] }]);
    // An unindexed shard that will not parse — could be truncated, corrupted, or mid-migration.
    await store.put(
      "data/months/2026-03.json",
      new TextEncoder().encode("{ not json"),
      "application/json", "x",
    );
    expect(await collectGarbage(store)).not.toContain("data/months/2026-03.json");
  });

  it("refuses to collect an unindexed shard that fails schema validation", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-01T10:00:00-06:00")] }]);
    // An unindexed shard with valid JSON but missing the photos array — fails schema validation.
    await store.put(
      "data/months/2026-03.json",
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: SCHEMA_VERSION, month: "2026-03",
        // Missing photos array
      })),
      "application/json", "x",
    );
    expect(await collectGarbage(store)).not.toContain("data/months/2026-03.json");
  });

  it("refuses to delete outside the prefixes it owns", async () => {
    await expect(deleteGarbage(store, ["data/index.json"])).rejects.toThrow(/refusing/);
  });
});

describe("repair", () => {
  it("is idempotent", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    const first = await repair(store);
    const second = await repair(store);
    expect(second.months).toEqual(first.months);
    expect(second.photoCount).toBe(1);
  });

  it("refiles a photo that is in the wrong month shard", async () => {
    // "a" belongs to 2026-08 by its takenAt but is filed under 2026-03.
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-08-02T10:00:00-06:00")] }]);
    const index = await repair(store);
    expect(index.months.map((m) => m.month)).toEqual(["2026-08"]);
    expect((await readMonth(store, "2026-08")).photos[0]!.id).toBe("a");
    expect((await readMonth(store, "2026-03")).photos).toEqual([]);
  });

  it("matches an index built incrementally", async () => {
    const months = [
      { schemaVersion: SCHEMA_VERSION as 1, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] },
      { schemaVersion: SCHEMA_VERSION as 1, month: "2026-08", photos: [photo("b", "2026-08-02T10:00:00-06:00")] },
    ];
    await seed(months);
    const incremental = await readIndex(store);
    const rebuilt = await repair(store);
    expect(rebuilt.months).toEqual(incremental.months);
  });
});
