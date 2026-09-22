import { createLibrary } from "./library.js";
import { navigate, onNavigate, parseView } from "./urlstate.js";
import { createApp } from "./app.js";
import { createUnlock, defaultSupported } from "./unlock.js";
import { renderOriginals, DecryptFailure, shouldRefillOriginalsSlot } from "./originals.js";
import { KeysFileSchema, unwrapDataKey, type KdfParams, type KeysFile, type Photo } from "@photos/core";
import type { LightboxHandle } from "./lightbox.js";

const library = createLibrary();
const app = document.querySelector("#app") as HTMLElement;
const nav = document.querySelector("#nav") as HTMLElement;

// --- the crypto worker ----------------------------------------------------
//
// One Worker for the whole page. Argon2id derivation (on unlock) and
// chunk-by-chunk original decryption (on view/download) both run there, off
// the main thread. Requests are queued onto the same worker so a decrypt
// already in flight can never have its progress/result messages crossed
// with a second request — e.g. a quick "View" click followed by "Download".
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

type WorkerEvent =
  | { type: "derived"; key: Uint8Array }
  | { type: "progress"; done: number; total: number }
  | { type: "decrypted"; bytes: Uint8Array }
  // `kind` is only ever present on an error from a "decrypt" request — the
  // worker's own "derive" errors have no download/decrypt split to make —
  // so it's optional here rather than carried on a second error shape.
  | { type: "error"; kind?: "download" | "decrypt"; message: string };

let workerQueue: Promise<unknown> = Promise.resolve();
function onWorker<T>(run: () => Promise<T>): Promise<T> {
  const result = workerQueue.then(run, run);
  workerQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function deriveViaWorker(password: string, kdf: KdfParams): Promise<Uint8Array> {
  return onWorker(
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        function onMessage(event: MessageEvent<WorkerEvent>): void {
          const msg = event.data;
          if (msg.type === "derived") {
            worker.removeEventListener("message", onMessage);
            resolve(msg.key);
          } else if (msg.type === "error") {
            worker.removeEventListener("message", onMessage);
            reject(new Error(msg.message));
          }
        }
        worker.addEventListener("message", onMessage);
        worker.postMessage({ type: "derive", password, kdf });
      }),
  );
}

function decryptViaWorker(
  photo: Photo,
  dataKey: Uint8Array,
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  return onWorker(
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        function onMessage(event: MessageEvent<WorkerEvent>): void {
          const msg = event.data;
          if (msg.type === "progress") {
            onProgress(msg.done, msg.total);
          } else if (msg.type === "decrypted") {
            worker.removeEventListener("message", onMessage);
            resolve(msg.bytes);
          } else if (msg.type === "error") {
            worker.removeEventListener("message", onMessage);
            // Every "decrypt" request's error carries a `kind`; fall back to
            // "decrypt" only as a defensive default, never as a guess drawn
            // from the message text.
            reject(new DecryptFailure(msg.kind ?? "decrypt", msg.message));
          }
        }
        worker.addEventListener("message", onMessage);
        worker.postMessage(
          {
            type: "decrypt",
            url: `/${photo.original.path}`,
            dataKey,
            photoId: photo.id,
            containerLength: photo.original.bytes,
          },
          { transfer: [dataKey.buffer as ArrayBuffer] },
        );
      }),
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- unlock state ----------------------------------------------------------

async function loadKeysFile(): Promise<KeysFile> {
  const res = await fetch("/data/keys.json");
  if (!res.ok) throw new Error(`could not load the key file (${res.status})`);
  return KeysFileSchema.parse(await res.json());
}

const unlock = createUnlock({
  derive: deriveViaWorker,
  loadKeys: loadKeysFile,
  storage: sessionStorage,
  supported: defaultSupported,
});

// keys.json is resolved once per unlock, not once per photo: the same
// cached promise backs every "originals" slot filled while unlocked, and is
// dropped the moment the state leaves "unlocked" (a lock, or a load
// failure) so a later attempt fetches fresh rather than replaying a stale
// failure or a stale password's keys.
let keysFileCache: Promise<KeysFile> | null = null;
function currentKeysFile(): Promise<KeysFile | null> {
  if (unlock.state().kind !== "unlocked") return Promise.resolve(null);
  if (!keysFileCache) {
    keysFileCache = loadKeysFile();
    keysFileCache.catch(() => {
      keysFileCache = null;
    });
  }
  return keysFileCache.catch(() => null);
}
unlock.subscribe((state) => {
  if (state.kind !== "unlocked") keysFileCache = null;
});

void unlock.restore();

// --- filling the lightbox's "originals" slot --------------------------------
//
// At most one decrypted object URL is ever alive: `onObjectUrl` fires the
// moment `originals.ts` creates one, from *either* the "view" or the
// "download" path (whichever gets there first) — not only the one that
// also happens to call `onImage`. It is revoked the moment it stops being
// current — either a new one replaces it, or the lightbox goes away. A
// 40 MB blob per photo, viewed or merely downloaded and never released, is
// a real leak on a long browsing session.
let currentObjectUrl: string | null = null;
function revokeCurrentObjectUrl(): void {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

let openLightboxState: { handle: LightboxHandle; photo: Photo } | null = null;

function fillOriginals(handle: LightboxHandle, photo: Photo): void {
  void currentKeysFile().then((keysFile) => {
    // A slower-to-resolve fill from an earlier open (or an earlier unlock
    // state change) must not clobber a newer lightbox's slot.
    if (openLightboxState?.handle !== handle) return;
    handle.setSlot(
      "originals",
      renderOriginals({
        photo,
        unlock,
        keysFile,
        unwrap: unwrapDataKey,
        decrypt: decryptViaWorker,
        sha256,
        onObjectUrl(url) {
          revokeCurrentObjectUrl();
          currentObjectUrl = url;
        },
        onImage(url) {
          const img = handle.element.querySelector("img");
          if (img) img.src = url;
        },
      }),
    );
  });
}

// Unlocking happens from the form `renderOriginals` itself renders (inside
// the currently open slot), and `restore()` above resolves on its own
// schedule after page load — neither is something this module drives
// directly. Re-filling the moment the state actually reaches "unlocked" is
// what turns either one into the slot upgrading from the password prompt to
// the view/download controls, instead of leaving a submitted form with no
// visible result. Only that one transition is re-filled from here: the
// form's own submit handler already manages its status text through
// "deriving" and "wrong-password" on the very node the user is looking at,
// and replacing that node out from under an in-flight submit (as every
// state change would, including "deriving" the instant submit() starts)
// would drop the "Checking…" status and the password the user just typed.
unlock.subscribe((state) => {
  if (shouldRefillOriginalsSlot(state) && openLightboxState) {
    fillOriginals(openLightboxState.handle, openLightboxState.photo);
  }
});

const instance = createApp(library, {
  app,
  nav,
  onLightboxOpen(handle, photo) {
    openLightboxState = { handle, photo };
    fillOriginals(handle, photo);
  },
  onLightboxClose() {
    openLightboxState = null;
    revokeCurrentObjectUrl();
  },
});

// Intercept in-app links (thumbnails, rail entries, "Browse all") so navigation
// goes through history.pushState instead of a full page load. Modifier-clicks
// and non-primary buttons are left alone so "open in new tab" keeps working.
document.body.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;

  if (anchor.hasAttribute("data-browse-all")) {
    event.preventDefault();
    void instance.browseAll();
    return;
  }

  if (!nav.contains(anchor) && !app.contains(anchor)) return;
  const href = anchor.getAttribute("href");
  if (!href || !href.startsWith("?")) return;

  event.preventDefault();
  navigate(parseView(href));
});

onNavigate(() => void instance.render());
void instance.render();
