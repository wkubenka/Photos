// site/src/unlock.ts
import { KeysFileSchema, checkVerifier, type KdfParams, type KeysFile } from "@photos/core";

const STORAGE_KEY = "photos.masterKey.v1";

export type UnlockState =
  | { kind: "locked" }
  | { kind: "deriving" }
  | { kind: "wrong-password" }
  | { kind: "unlocked" }
  | { kind: "unsupported"; reason: string };

export interface UnlockDeps {
  derive: (password: string, kdf: KdfParams) => Promise<Uint8Array>;
  loadKeys: () => Promise<KeysFile>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  supported: () => { ok: true } | { ok: false; reason: string };
}

export interface UnlockController {
  state(): UnlockState;
  subscribe(fn: (s: UnlockState) => void): void;
  submit(password: string): Promise<void>;
  restore(): Promise<void>;
  lock(): void;
  masterKey(): Uint8Array | null;
}

export function defaultSupported(): { ok: true } | { ok: false; reason: string } {
  if (!globalThis.crypto?.subtle) {
    return { ok: false, reason: "This browser does not provide WebCrypto, which is needed to decrypt originals." };
  }
  if (typeof WebAssembly === "undefined") {
    return { ok: false, reason: "This browser does not support WebAssembly, which is needed to check the password." };
  }
  return { ok: true };
}

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createUnlock(deps: UnlockDeps): UnlockController {
  const support = deps.supported();
  let state: UnlockState = support.ok ? { kind: "locked" } : { kind: "unsupported", reason: support.reason };
  let key: Uint8Array | null = null;
  const listeners: ((s: UnlockState) => void)[] = [];

  function set(next: UnlockState): void {
    state = next;
    for (const fn of listeners) fn(next);
  }

  return {
    state: () => state,
    subscribe(fn) { listeners.push(fn); },
    masterKey: () => key,

    async submit(password) {
      if (!support.ok) return;
      set({ kind: "deriving" });
      let keysFile: KeysFile;
      try {
        keysFile = KeysFileSchema.parse(await deps.loadKeys());
      } catch (err) {
        // A network failure is not a wrong password, and must not be reported as one.
        set({ kind: "locked" });
        throw err;
      }

      const candidate = await deps.derive(password, keysFile.kdf);
      if (!(await checkVerifier(candidate, keysFile.verifier))) {
        set({ kind: "wrong-password" });
        return;
      }

      key = candidate;
      deps.storage.setItem(STORAGE_KEY, toBase64(candidate));
      set({ kind: "unlocked" });
    },

    async restore() {
      if (!support.ok) return;
      const stored = deps.storage.getItem(STORAGE_KEY);
      if (!stored) return;
      try {
        const candidate = fromBase64(stored);
        const keysFile = KeysFileSchema.parse(await deps.loadKeys());
        // After a password rotation the stored key no longer verifies, so it is
        // discarded rather than left to fail later on a 40 MB download.
        if (await checkVerifier(candidate, keysFile.verifier)) {
          key = candidate;
          set({ kind: "unlocked" });
        } else {
          deps.storage.removeItem(STORAGE_KEY);
          set({ kind: "locked" });
        }
      } catch {
        deps.storage.removeItem(STORAGE_KEY);
        set({ kind: "locked" });
      }
    },

    lock() {
      key = null;
      deps.storage.removeItem(STORAGE_KEY);
      set({ kind: "locked" });
    },
  };
}
