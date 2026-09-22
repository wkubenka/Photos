// site/src/worker.ts
import {
  createStreamDecryptor, deriveMasterKey, type KdfParams,
} from "@photos/core";

type Request =
  | { type: "derive"; password: string; kdf: KdfParams }
  | { type: "decrypt"; url: string; dataKey: Uint8Array; photoId: string; containerLength: number };

self.addEventListener("message", async (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    if (msg.type === "derive") {
      const key = await deriveMasterKey(msg.password, msg.kdf);
      self.postMessage({ type: "derived", key }, { transfer: [key.buffer] });
      return;
    }

    const res = await fetch(msg.url);
    if (!res.ok || !res.body) throw new Error(`could not download the original (${res.status})`);

    const decryptor = createStreamDecryptor(msg.dataKey, msg.photoId, msg.containerLength);
    const reader = res.body.getReader();
    const pieces: Uint8Array[] = [];
    let done = 0;

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      for (const out of await decryptor.push(value)) {
        pieces.push(out);
        done += out.length;
        self.postMessage({ type: "progress", done, total: decryptor.plainTotal ?? 0 });
      }
    }
    for (const out of await decryptor.finish()) {
      pieces.push(out);
      done += out.length;
      self.postMessage({ type: "progress", done, total: decryptor.plainTotal ?? 0 });
    }

    const total = pieces.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of pieces) { bytes.set(p, at); at += p.length; }
    self.postMessage({ type: "decrypted", bytes }, { transfer: [bytes.buffer] });
  } catch (err) {
    self.postMessage({ type: "error", message: (err as Error).message });
  }
});
