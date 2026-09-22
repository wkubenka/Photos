import { describe, it, expect, beforeAll } from "vitest";
import { deriveMasterKey, newKdfParams } from "../src/kdf.js";
import {
  newDataKey, wrapDataKey, unwrapDataKey,
  makeVerifier, checkVerifier, VERIFIER_PLAINTEXT,
} from "../src/wrap.js";

let master: Uint8Array;
let other: Uint8Array;

beforeAll(async () => {
  const fast = newKdfParams({ m: 512, t: 1 });
  master = await deriveMasterKey("the right password", fast);
  other = await deriveMasterKey("the wrong password", fast);
});

describe("data keys", () => {
  it("generates 32 random bytes", () => {
    const a = newDataKey();
    expect(a.length).toBe(32);
    expect(newDataKey()).not.toEqual(a);
  });

  it("round-trips a wrapped key", async () => {
    const dk = newDataKey();
    const wrapped = await wrapDataKey(master, dk, "2026-03-14-photo-0031");
    expect(await unwrapDataKey(master, wrapped, "2026-03-14-photo-0031")).toEqual(dk);
  });

  it("refuses to unwrap under a different photo id", async () => {
    const wrapped = await wrapDataKey(master, newDataKey(), "photo-a");
    await expect(unwrapDataKey(master, wrapped, "photo-b")).rejects.toThrow();
  });

  it("refuses to unwrap under a different master key", async () => {
    const wrapped = await wrapDataKey(master, newDataKey(), "photo-a");
    await expect(unwrapDataKey(other, wrapped, "photo-a")).rejects.toThrow();
  });

  it("uses a fresh iv per wrap", async () => {
    const dk = newDataKey();
    const a = await wrapDataKey(master, dk, "photo-a");
    const b = await wrapDataKey(master, dk, "photo-a");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("verifier", () => {
  it("uses the exact spec plaintext", () => {
    expect(VERIFIER_PLAINTEXT).toBe("photo-gallery-verifier-v1");
  });

  it("accepts the correct master key", async () => {
    expect(await checkVerifier(master, await makeVerifier(master))).toBe(true);
  });

  it("rejects the wrong master key without throwing", async () => {
    expect(await checkVerifier(other, await makeVerifier(master))).toBe(false);
  });
});
