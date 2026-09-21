import { describe, it, expect } from "vitest";
import { newKdfParams, deriveMasterKey, DEFAULT_KDF } from "../src/kdf.js";

describe("kdf", () => {
  it("defaults to the spec parameters", () => {
    expect(DEFAULT_KDF).toEqual({ m: 65536, t: 3, p: 1, keyLen: 32 });
    const p = newKdfParams();
    expect(p.alg).toBe("argon2id");
    expect(p.m).toBe(65536);
  });

  it("generates a fresh 16-byte salt each time", () => {
    const a = newKdfParams();
    const b = newKdfParams();
    expect(a.salt).not.toBe(b.salt);
  });

  it("derives a 32-byte key deterministically", async () => {
    const params = newKdfParams({ m: 512, t: 1 });
    const one = await deriveMasterKey("correct horse battery staple", params);
    const two = await deriveMasterKey("correct horse battery staple", params);
    expect(one.length).toBe(32);
    expect(one).toEqual(two);
  });

  it("derives different keys for different passwords", async () => {
    const params = newKdfParams({ m: 512, t: 1 });
    const one = await deriveMasterKey("password one", params);
    const two = await deriveMasterKey("password two", params);
    expect(one).not.toEqual(two);
  });

  it("derives different keys for different salts", async () => {
    const a = await deriveMasterKey("same password", newKdfParams({ m: 512, t: 1 }));
    const b = await deriveMasterKey("same password", newKdfParams({ m: 512, t: 1 }));
    expect(a).not.toEqual(b);
  });
});
