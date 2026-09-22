import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";

const body = new Uint8Array([1, 2, 3]);

describe("memory store", () => {
  it("round-trips an object with its headers", async () => {
    const s = createMemoryStore();
    await s.put("data/index.json", body, "application/json", "max-age=60");
    expect(await s.get("data/index.json")).toEqual(body);
    expect(s.objects.get("data/index.json")!.contentType).toBe("application/json");
  });

  it("returns null for a missing key", async () => {
    expect(await createMemoryStore().get("nope")).toBeNull();
  });

  it("lists by prefix", async () => {
    const s = createMemoryStore();
    await s.put("web/a.jpg", body, "image/jpeg", "x");
    await s.put("web/b.jpg", body, "image/jpeg", "x");
    await s.put("orig/c.enc", body, "application/octet-stream", "x");
    expect((await s.list("web/")).sort()).toEqual(["web/a.jpg", "web/b.jpg"]);
  });

  it("keeps versions and can read an older one", async () => {
    const s = createMemoryStore();
    await s.put("data/index.json", new Uint8Array([1]), "application/json", "x");
    await s.put("data/index.json", new Uint8Array([2]), "application/json", "x");
    const versions = await s.listVersions("data/index.json");
    expect(versions).toHaveLength(2);
    expect(await s.getVersion("data/index.json", versions[1]!.versionId)).toEqual(new Uint8Array([1]));
  });

  it("throws on the nth put when failAfter is set", async () => {
    const s = createMemoryStore();
    s.failAfter(2);
    await s.put("a", body, "x", "x");
    await s.put("b", body, "x", "x");
    await expect(s.put("c", body, "x", "x")).rejects.toThrow(/simulated/i);
    expect(await s.get("c")).toBeNull();
  });

  it("head returns the stored object's size for a key that exists", async () => {
    const s = createMemoryStore();
    await s.put("data/test.bin", body, "application/octet-stream", "x");
    expect(await s.head("data/test.bin")).toEqual({ size: body.length });
  });

  it("head returns null for a missing key", async () => {
    expect(await createMemoryStore().head("nope")).toBeNull();
  });

  it("delete removes a key so subsequent get returns null", async () => {
    const s = createMemoryStore();
    await s.put("data/test.json", body, "application/json", "x");
    await s.delete("data/test.json");
    expect(await s.get("data/test.json")).toBeNull();
  });

  it("delete on a missing key does not throw", async () => {
    const s = createMemoryStore();
    await expect(s.delete("nope")).resolves.toBeUndefined();
  });
});
