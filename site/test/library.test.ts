import { describe, it, expect, vi } from "vitest";
import { createLibrary } from "../src/library.js";
import { SCHEMA_VERSION } from "@photos/core";

const photo = (id: string, takenAt: string, featured = false) => ({
  id, title: id, caption: "", location: "", takenAt, featured,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

const index = {
  schemaVersion: SCHEMA_VERSION, generatedAt: "t", lastBackupAt: null,
  photoCount: 2, featuredCount: 1, sort: "takenAt:desc",
  months: [
    { month: "2026-08", count: 1, path: "data/months/2026-08.json" },
    { month: "2026-03", count: 1, path: "data/months/2026-03.json" },
  ],
};

const files: Record<string, unknown> = {
  "/data/index.json": index,
  "/data/months/2026-08.json": { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("a", "2026-08-02T10:00:00-06:00"), photo("b", "2026-08-01T10:00:00-06:00", true)] },
  "/data/months/2026-03.json": { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("c", "2026-03-14T10:00:00-06:00")] },
  "/data/featured.json": { schemaVersion: SCHEMA_VERSION, generatedAt: "t", photos: [photo("b", "2026-08-01T10:00:00-06:00", true)] },
};

function fakeFetch() {
  return vi.fn(async (url: string) => {
    const body = files[url];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("library", () => {
  it("lists months newest first", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect((await lib.months()).map((m) => m.month)).toEqual(["2026-08", "2026-03"]);
  });

  it("fetches the index only once across many calls", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    await lib.months();
    await lib.months();
    await lib.month("2026-03");
    expect(f.mock.calls.filter(([u]) => u === "/data/index.json")).toHaveLength(1);
  });

  it("caches a month shard", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    await lib.month("2026-03");
    await lib.month("2026-03");
    expect(f.mock.calls.filter(([u]) => u === "/data/months/2026-03.json")).toHaveLength(1);
  });

  it("returns featured photos", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect((await lib.featured()).map((p) => p.id)).toEqual(["b"]);
  });

  it("finds a photo in a known month without scanning others", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    expect((await lib.photo("c", "2026-03"))!.id).toBe("c");
    expect(f.mock.calls.some(([u]) => u === "/data/months/2026-08.json")).toBe(false);
  });

  it("finds a photo with no month hint by searching newest first", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    expect((await lib.photo("a", null))!.id).toBe("a");
    expect(f.mock.calls.some(([u]) => u === "/data/months/2026-03.json")).toBe(false);
  });

  it("returns null for an unknown photo", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect(await lib.photo("ghost", null)).toBeNull();
  });

  it("throws a useful error for a month that is not in the index", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    await expect(lib.month("2030-01")).rejects.toThrow(/2030-01/);
  });

  it("throws when the index itself cannot be loaded", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 500 }));
    const lib = createLibrary(f as unknown as typeof fetch);
    await expect(lib.months()).rejects.toThrow(/index/i);
  });

  it("two concurrent month calls for the same month result in exactly one fetch", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    const results = await Promise.all([lib.month("2026-03"), lib.month("2026-03")]);
    expect(results[0]).toEqual(results[1]);
    expect(f.mock.calls.filter(([u]) => u === "/data/months/2026-03.json")).toHaveLength(1);
  });

  it("index can be retried after failure", async () => {
    let callCount = 0;
    const f = vi.fn(async (url: string) => {
      if (url === "/data/index.json") {
        callCount++;
        if (callCount === 1) return new Response("error", { status: 500 });
      }
      const body = files[url];
      if (!body) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const lib = createLibrary(f as unknown as typeof fetch);

    await expect(lib.months()).rejects.toThrow(/index/i);
    const result = await lib.months();
    expect(result.map((m) => m.month)).toEqual(["2026-08", "2026-03"]);
    expect(f.mock.calls.filter(([u]) => u === "/data/index.json")).toHaveLength(2);
  });

  it("month can be retried after failure", async () => {
    let callCount = 0;
    const f = vi.fn(async (url: string) => {
      if (url === "/data/months/2026-03.json") {
        callCount++;
        if (callCount === 1) return new Response("error", { status: 500 });
      }
      const body = files[url];
      if (!body) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const lib = createLibrary(f as unknown as typeof fetch);

    await expect(lib.month("2026-03")).rejects.toThrow(/photos for 2026-03/i);
    const result = await lib.month("2026-03");
    expect(result.month).toBe("2026-03");
    expect(f.mock.calls.filter(([u]) => u === "/data/months/2026-03.json")).toHaveLength(2);
  });

  it("featured can be retried after failure", async () => {
    let callCount = 0;
    const f = vi.fn(async (url: string) => {
      if (url === "/data/featured.json") {
        callCount++;
        if (callCount === 1) return new Response("error", { status: 500 });
      }
      const body = files[url];
      if (!body) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const lib = createLibrary(f as unknown as typeof fetch);

    await expect(lib.featured()).rejects.toThrow(/featured/i);
    const result = await lib.featured();
    expect(result.map((p) => p.id)).toEqual(["b"]);
    expect(f.mock.calls.filter(([u]) => u === "/data/featured.json")).toHaveLength(2);
  });
});
