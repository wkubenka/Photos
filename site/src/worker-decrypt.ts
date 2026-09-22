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
  | { type: "error"; kind: "download" | "decrypt"; message: string };

// Marks an error as belonging to the fetch/stream side of this loop (the
// initial request, a non-OK response, or the stream failing mid-transfer)
// rather than the decryptor (a chunk failing its GCM tag). This is
// structural, not a match on `err.message`: the site's own worker raises
// it at the exact point a failure is known to be one or the other, so the
// distinction never depends on what a particular platform's error text
// happens to say.
class DownloadFailure extends Error {}

export async function runDecrypt(
  req: DecryptRequest,
  fetchFn: typeof fetch,
  emit: (event: DecryptEvent) => void,
): Promise<void> {
  try {
    let res: Response;
    try {
      res = await fetchFn(req.url);
    } catch (err) {
      throw new DownloadFailure((err as Error).message);
    }
    if (!res.ok || !res.body) throw new DownloadFailure(`could not download the original (${res.status})`);

    const decryptor = createStreamDecryptor(req.dataKey, req.photoId, req.containerLength);
    const reader = res.body.getReader();
    const pieces: Uint8Array[] = [];
    let done = 0;

    for (;;) {
      let value: Uint8Array | undefined;
      let finished: boolean;
      try {
        ({ value, done: finished } = await reader.read());
      } catch (err) {
        throw new DownloadFailure((err as Error).message);
      }
      if (finished) break;
      for (const out of await decryptor.push(value!)) {
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
    const kind = err instanceof DownloadFailure ? "download" : "decrypt";
    emit({ type: "error", kind, message: (err as Error).message });
  }
}
