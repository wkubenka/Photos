import type { KeysFile, Photo } from "@photos/core";
import type { UnlockController } from "./unlock.js";

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
    } catch {
      status.textContent =
        "This original could not be decrypted. The file may be corrupt or may have been altered.";
      return null;
    } finally {
      progress.hidden = true;
    }
  }

  controls.querySelector("[data-action='view']")!.addEventListener("click", async () => {
    const ready = await ensureDecrypted();
    if (!ready) return;
    objectUrl ??= URL.createObjectURL(ready);
    opts.onImage(objectUrl);
  });

  controls.querySelector("[data-action='download']")!.addEventListener("click", async () => {
    const ready = await ensureDecrypted();
    if (!ready) return;
    objectUrl ??= URL.createObjectURL(ready);
    const link = document.createElement("a");
    link.href = objectUrl;
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
