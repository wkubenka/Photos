import type { KeysFile, Photo } from "@photos/core";
import type { UnlockController, UnlockState } from "./unlock.js";

// Raised by the `decrypt` function this module is given, to say *which*
// stage of the download-then-decrypt pipeline failed. This is deliberately
// structural rather than a string match against `err.message`: a network
// blip and a corrupt/tampered chunk both throw, but only one of them is
// evidence of tampering, and a message is not a reliable place to carry
// that distinction across a platform boundary (Node's own error text for
// this class of failure is famously empty in the browser). The `decrypt`
// implementation this module is handed — main.ts's worker-backed one, or a
// test double — is expected to throw this (not a bare `Error`) when it
// wants that distinction honoured; a plain `Error` is still treated as a
// decrypt failure, which is also what a chunk failing its GCM tag raises.
export class DecryptFailure extends Error {
  constructor(
    public readonly kind: "download" | "decrypt",
    message: string,
  ) {
    super(message);
    this.name = "DecryptFailure";
  }
}

// Whether the "originals" slot should be re-rendered for this unlock state
// transition. Only "unlocked" is re-rendered: that's the one transition
// that needs a different tree (the password prompt becomes the view/
// download controls). Every other transition — "deriving" in particular —
// is already reflected on the currently-rendered node by its own form
// handler (see the `status.textContent` writes below), and re-rendering
// out from under it would tear out an in-flight submit.
export function shouldRefillOriginalsSlot(state: UnlockState): boolean {
  return state.kind === "unlocked";
}

export interface OriginalsOptions {
  photo: Photo;
  unlock: UnlockController;
  keysFile: KeysFile | null;
  unwrap: (master: Uint8Array, wrapped: { iv: string; ct: string }, id: string) => Promise<Uint8Array>;
  decrypt: (
    photo: Photo,
    dataKey: Uint8Array,
    onProgress: (done: number, total: number) => void,
  ) => Promise<Uint8Array>;
  sha256: (bytes: Uint8Array) => Promise<string>;
  onImage: (url: string) => void;
  // Invoked exactly once per decrypted original, the moment its object URL
  // is created — whichever of "view" or "download" happens to trigger that
  // first. Optional so existing tests that don't care about URL lifetime
  // don't need to supply it; main.ts uses it to revoke the URL once it's no
  // longer the one behind the lightbox's image, so a photo that's only ever
  // downloaded (never viewed) doesn't leak its blob for the rest of the tab's
  // life.
  onObjectUrl?: (url: string) => void;
}

export function renderOriginals(opts: OriginalsOptions): HTMLElement {
  const root = document.createElement("div");
  root.className = "originals";

  const state = opts.unlock.state();

  if (state.kind === "unsupported") {
    root.append(message(state.reason));
    return root;
  }

  if (state.kind !== "unlocked") {
    root.innerHTML = `
      <form class="unlock-form">
        <label>Have the password? <input type="password" name="password" autocomplete="current-password" /></label>
        <button type="submit">Unlock originals</button>
      </form>
      <p class="unlock-status" role="status"></p>
    `;
    const form = root.querySelector("form")!;
    const status = root.querySelector(".unlock-status")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.elements.namedItem("password") as HTMLInputElement;
      status.textContent = "Checking…";
      try {
        await opts.unlock.submit(input.value);
        status.textContent =
          opts.unlock.state().kind === "wrong-password" ? "That password is not right." : "";
      } catch {
        status.textContent = "Could not reach the key file. Check your connection and try again.";
      }
    });
    return root;
  }

  const wrappedKey = opts.keysFile?.keys[opts.photo.id];
  if (!wrappedKey) {
    root.append(message("There is no original on file for this photo."));
    return root;
  }

  let blob: Blob | null = null;
  let objectUrl: string | null = null;

  const controls = document.createElement("div");
  controls.innerHTML = `
    <button type="button" data-action="view">View full size</button>
    <button type="button" data-action="download">Download original</button>
    <progress value="0" max="100" hidden></progress>
    <p class="originals-status" role="status"></p>
  `;
  root.append(controls);

  const progress = controls.querySelector("progress") as HTMLProgressElement;
  const status = controls.querySelector(".originals-status") as HTMLElement;

  async function ensureDecrypted(): Promise<Blob | null> {
    if (blob) return blob;

    const master = opts.unlock.masterKey();
    if (!master) return null;

    progress.hidden = false;
    status.textContent = "Downloading and decrypting…";
    try {
      const dataKey = await opts.unwrap(master, wrappedKey!, opts.photo.id);
      const bytes = await opts.decrypt(opts.photo, dataKey, (done, total) => {
        progress.setAttribute("value", String(done));
        progress.setAttribute("max", String(total || 100));
      });

      const digest = await opts.sha256(bytes);
      if (digest !== opts.photo.original.sha256) {
        status.textContent =
          "The decrypted file does not match its recorded checksum, so it was discarded.";
        return null;
      }

      blob = new Blob([bytes as BlobPart], { type: opts.photo.original.mime });
      status.textContent = "";
      return blob;
    } catch (err) {
      status.textContent =
        err instanceof DecryptFailure && err.kind === "download"
          ? "This original could not be downloaded. Check your connection and try again."
          : "This original could not be decrypted. The file may be corrupt or may have been altered.";
      return null;
    } finally {
      progress.hidden = true;
    }
  }

  // Creates the one object URL this blob ever gets, reporting it through
  // `onObjectUrl` at the moment it's created — regardless of whether "view"
  // or "download" is what triggered it — so main.ts can track its lifetime
  // from either path, not just the one that happens to also call `onImage`.
  function ensureObjectUrl(ready: Blob): string {
    if (!objectUrl) {
      objectUrl = URL.createObjectURL(ready);
      opts.onObjectUrl?.(objectUrl);
    }
    return objectUrl;
  }

  controls.querySelector("[data-action='view']")!.addEventListener("click", async () => {
    const ready = await ensureDecrypted();
    if (!ready) return;
    opts.onImage(ensureObjectUrl(ready));
  });

  controls.querySelector("[data-action='download']")!.addEventListener("click", async () => {
    const ready = await ensureDecrypted();
    if (!ready) return;
    const link = document.createElement("a");
    link.href = ensureObjectUrl(ready);
    link.download = `${opts.photo.id}.jpg`;
    link.textContent = "Saving…";
    root.append(link);
    link.click();
  });

  return root;

  function message(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "originals-note";
    p.textContent = text;
    return p;
  }
}
