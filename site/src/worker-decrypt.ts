// The fetch-and-decrypt loop the worker runs, extracted so it can be tested
// with an injected `fetch` and without a real Worker global. `worker.ts`
// wraps this in the postMessage/message-event plumbing; this function knows
// nothing about that transport.
import { createStreamDecryptor } from "@photos/core";

export interface DecryptRequest {
  url: string;
  dataKey: Uint8Array;
  photoId: string;
  containerLength: number;
}

export type DecryptEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "decrypted"; bytes: Uint8Array }
  | { type: "error"; message: string };

export async function runDecrypt(
  req: DecryptRequest,
  fetchFn: typeof fetch,
  emit: (event: DecryptEvent) => void,
): Promise<void> {
  try {
    const res = await fetchFn(req.url);
    if (!res.ok || !res.body) throw new Error(`could not download the original (${res.status})`);

    const decryptor = createStreamDecryptor(req.dataKey, req.photoId, req.containerLength);
    const reader = res.body.getReader();
    const pieces: Uint8Array[] = [];
    let done = 0;

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      for (const out of await decryptor.push(value)) {
        pieces.push(out);
        done += out.length;
        emit({ type: "progress", done, total: decryptor.plainTotal ?? 0 });
      }
    }
    for (const out of await decryptor.finish()) {
      pieces.push(out);
      done += out.length;
      emit({ type: "progress", done, total: decryptor.plainTotal ?? 0 });
    }

    const total = pieces.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of pieces) { bytes.set(p, at); at += p.length; }
    emit({ type: "decrypted", bytes });
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
  }
}
