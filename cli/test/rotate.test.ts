import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { rotatePassword } from "../src/commands/keys.js";
import { KEYS, readKeys } from "../src/manifest.js";
import {
  SCHEMA_VERSION, checkVerifier, deriveMasterKey, makeVerifier, newDataKey,
  newKdfParams, unwrapDataKey, wrapDataKey,
} from "@photos/core";

const FAST = { m: 512, t: 1 };

async function seedKeys(store: ReturnType<typeof createMemoryStore>, password: string, ids: string[]) {
  const kdf = newKdfParams(FAST);
  const master = await deriveMasterKey(password, kdf);
  const keys: Record<string, { iv: string; ct: string }> = {};
  const plain: Record<string, Uint8Array> = {};
  for (const id of ids) {
    const dk = newDataKey();
    plain[id] = dk;
    keys[id] = await wrapDataKey(master, dk, id);
  }
  const file = { schemaVersion: SCHEMA_VERSION, kdf, verifier: await makeVerifier(master), keys };
  await store.put(KEYS.keys, new TextEncoder().encode(JSON.stringify(file)), "application/json", "x");
  await store.put("orig/a.enc", new Uint8Array([1, 2, 3]), "application/octet-stream", "x");
  return plain;
}

describe("rotatePassword", () => {
  it("re-wraps every key so all photos open under the new password", async () => {
    const store = createMemoryStore();
    const plain = await seedKeys(store, "old passphrase", ["a", "b"]);

    const result = await rotatePassword(store, "old passphrase", "new passphrase");
    expect(result.rewrapped).toBe(2);

    const keys = (await readKeys(store))!;
    const master = await deriveMasterKey("new passphrase", keys.kdf);
    expect(await checkVerifier(master, keys.verifier)).toBe(true);
    for (const id of ["a", "b"]) {
      expect(await unwrapDataKey(master, keys.keys[id]!, id)).toEqual(plain[id]);
    }
  });

  it("makes the old password stop working", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    await rotatePassword(store, "old passphrase", "new passphrase");
    const keys = (await readKeys(store))!;
    const oldMaster = await deriveMasterKey("old passphrase", keys.kdf);
    expect(await checkVerifier(oldMaster, keys.verifier)).toBe(false);
  });

  it("uses a fresh salt", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    const before = (await readKeys(store))!.kdf.salt;
    await rotatePassword(store, "old passphrase", "new passphrase");
    expect((await readKeys(store))!.kdf.salt).not.toBe(before);
  });

  it("rejects a wrong old password before writing anything", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    const before = (await readKeys(store))!;
    await expect(rotatePassword(store, "wrong", "new passphrase")).rejects.toThrow(/password/i);
    expect(await readKeys(store)).toEqual(before);
  });

  it("restores a month shard, not just the index", async () => {
    const store = createMemoryStore();
    const { restoreFile } = await import("../src/commands/keys.js");
    const shard = (title: string) => new TextEncoder().encode(JSON.stringify({
      schemaVersion: SCHEMA_VERSION, month: "2026-03",
      photos: [{
        id: "a", title, caption: "", location: "", takenAt: "2026-03-14T10:00:00-06:00", featured: false,
        web: { path: "web/a-2048.aaaaaaaa.jpg", w: 2048, h: 1365, bytes: 100 },
        thumb: { path: "web/a-640.bbbbbbbb.jpg", w: 640, h: 427, bytes: 10 },
        lqip: "data:image/jpeg;base64,aa",
        exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
        original: { path: "orig/a.enc", bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
      }],
    }));

    await store.put("data/months/2026-03.json", shard("the good title"), "application/json", "x");
    await store.put("data/months/2026-03.json", shard("an accidental edit"), "application/json", "x");

    await restoreFile(store, "data/months/2026-03.json");
    const back = JSON.parse(new TextDecoder().decode((await store.get("data/months/2026-03.json"))!));
    expect(back.photos[0].title).toBe("the good title");
  });

  it("refuses to restore something outside data/", async () => {
    const store = createMemoryStore();
    const { restoreFile } = await import("../src/commands/keys.js");
    await expect(restoreFile(store, "orig/a.enc")).rejects.toThrow(/only restore/);
  });

  it("never rewrites an encrypted original", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    const before = await store.get("orig/a.enc");
    await rotatePassword(store, "old passphrase", "new passphrase");
    expect(await store.get("orig/a.enc")).toEqual(before);
    expect((await store.listVersions("orig/a.enc")).length).toBe(1);
  });
});
