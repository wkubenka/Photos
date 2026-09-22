// site/test/unlock.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUnlock } from "../src/unlock.js";
import {
  SCHEMA_VERSION, deriveMasterKey, makeVerifier, newKdfParams, type KeysFile,
} from "@photos/core";

const FAST = { m: 512, t: 1 };
let keysFile: KeysFile;
let master: Uint8Array;

beforeEach(async () => {
  const kdf = newKdfParams(FAST);
  master = await deriveMasterKey("the right password", kdf);
  keysFile = { schemaVersion: SCHEMA_VERSION, kdf, verifier: await makeVerifier(master), keys: {} };
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    map,
  };
}

function deps(overrides: Partial<Parameters<typeof createUnlock>[0]> = {}) {
  return {
    derive: (password: string, kdf: typeof keysFile.kdf) => deriveMasterKey(password, kdf),
    loadKeys: async () => keysFile,
    storage: memoryStorage(),
    supported: () => ({ ok: true as const }),
    ...overrides,
  };
}

describe("unlock state machine", () => {
  it("starts locked", () => {
    expect(createUnlock(deps()).state()).toEqual({ kind: "locked" });
  });

  it("reports unsupported browsers without offering a password field", () => {
    const u = createUnlock(deps({ supported: () => ({ ok: false, reason: "WebCrypto is unavailable" }) }));
    expect(u.state()).toEqual({ kind: "unsupported", reason: "WebCrypto is unavailable" });
  });

  it("passes through deriving and reaches unlocked on the right password", async () => {
    const seen: string[] = [];
    const u = createUnlock(deps());
    u.subscribe((s) => seen.push(s.kind));
    await u.submit("the right password");
    expect(seen).toEqual(["deriving", "unlocked"]);
    expect(u.masterKey()).toEqual(master);
  });

  it("reports a wrong password and holds no key", async () => {
    const u = createUnlock(deps());
    await u.submit("not the password");
    expect(u.state()).toEqual({ kind: "wrong-password" });
    expect(u.masterKey()).toBeNull();
  });

  it("stores the derived key in session storage so a refresh does not re-prompt", async () => {
    const storage = memoryStorage();
    const u = createUnlock(deps({ storage }));
    await u.submit("the right password");
    expect(storage.map.size).toBe(1);

    const revived = createUnlock(deps({ storage }));
    await revived.restore();
    expect(revived.state()).toEqual({ kind: "unlocked" });
    expect(revived.masterKey()).toEqual(master);
  });

  it("ignores a stored key that no longer matches the verifier after rotation", async () => {
    const storage = memoryStorage();
    const u = createUnlock(deps({ storage }));
    await u.submit("the right password");

    const rotatedKdf = newKdfParams(FAST);
    const rotatedMaster = await deriveMasterKey("a new password", rotatedKdf);
    keysFile = { schemaVersion: SCHEMA_VERSION, kdf: rotatedKdf, verifier: await makeVerifier(rotatedMaster), keys: {} };

    const revived = createUnlock(deps({ storage }));
    await revived.restore();
    expect(revived.state()).toEqual({ kind: "locked" });
    expect(storage.map.size).toBe(0);
  });

  it("clears the key and storage on lock", async () => {
    const storage = memoryStorage();
    const u = createUnlock(deps({ storage }));
    await u.submit("the right password");
    u.lock();
    expect(u.state()).toEqual({ kind: "locked" });
    expect(u.masterKey()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("surfaces a keys.json load failure as locked, not as a wrong password", async () => {
    const u = createUnlock(deps({ loadKeys: async () => { throw new Error("network down"); } }));
    await expect(u.submit("the right password")).rejects.toThrow(/network down/);
    expect(u.state()).toEqual({ kind: "locked" });
  });
});
