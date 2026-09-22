// site/src/worker.ts
//
// Runs entirely off the main thread: Argon2id key derivation is deliberately
// about a second of memory-hard work, and chunk-by-chunk decryption of a
// 40 MB original needs to report byte-accurate progress without freezing
// the page. This file is a thin message-dispatch shim; the actual
// fetch-and-decrypt loop lives in ./worker-decrypt.ts, where it can be
// tested with an injected fetch instead of a real Worker global.
import { deriveMasterKey, type KdfParams } from "@photos/core";
import { runDecrypt, type DecryptRequest } from "./worker-decrypt.js";

type Request =
  | { type: "derive"; password: string; kdf: KdfParams }
  | ({ type: "decrypt" } & DecryptRequest);

self.addEventListener("message", async (event: MessageEvent<Request>) => {
  const msg = event.data;

  if (msg.type === "derive") {
    try {
      const key = await deriveMasterKey(msg.password, msg.kdf);
      self.postMessage({ type: "derived", key }, { transfer: [key.buffer] });
    } catch (err) {
      self.postMessage({ type: "error", message: (err as Error).message });
    }
    return;
  }

  await runDecrypt(msg, fetch, (out) => {
    self.postMessage(out, { transfer: out.type === "decrypted" ? [out.bytes.buffer] : [] });
  });
});
