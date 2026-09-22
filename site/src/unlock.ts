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
  if (typeof Worker === "undefined") {
    return { ok: false, reason: "This browser does not support Web Workers, which are needed to unlock without freezing the page." };
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

      let candidate: Uint8Array;
      try {
        candidate = fromBase64(stored);
      } catch {
        // The stored value itself is unusable (corrupt base64) — nothing to keep.
        deps.storage.removeItem(STORAGE_KEY);
        set({ kind: "locked" });
        return;
      }

      let keysFile: KeysFile;
      try {
        keysFile = KeysFileSchema.parse(await deps.loadKeys());
      } catch {
        // We could not verify the stored key — that is not evidence it is
        // wrong. Leave it in storage so a later attempt can still restore
        // it, and stay locked without surfacing the error (this runs on
        // page load; an unhandled rejection there is worse than staying
        // locked quietly).
        set({ kind: "locked" });
        return;
      }

      // After a password rotation the stored key no longer verifies, so it is
      // discarded rather than left to fail later on a 40 MB download.
      if (await checkVerifier(candidate, keysFile.verifier)) {
        key = candidate;
        set({ kind: "unlocked" });
      } else {
        // Zeroed before the reference is dropped: this is still a real
        // Argon2id output derived from the user's password, and dropping the
        // reference only makes it garbage — it does not make it unreadable.
        candidate.fill(0);
        deps.storage.removeItem(STORAGE_KEY);
        set({ kind: "locked" });
      }
    },

    lock() {
      // Same reasoning as the rotation-discard path above: clear the bytes,
      // then drop the reference. Locking is the one action a viewer has to
      // take back the key short of closing the tab, so it has to actually
      // destroy it.
      key?.fill(0);
      key = null;
      deps.storage.removeItem(STORAGE_KEY);
      set({ kind: "locked" });
    },
  };
}
