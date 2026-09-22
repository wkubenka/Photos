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

/**
 * How many times a failed download is retried before the error reaches the
 * UI (which then offers a manual retry). A 40 MB transfer on a phone is the
 * failure this exists for: one blip used to mean starting over on the next
 * click.
 *
 * The whole download is retried, not the failed byte range. Resuming
 * mid-stream would mean re-seeding the chunk decryptor at an arbitrary
 * offset, and the container is authenticated chunk by chunk — not worth the
 * complexity here. A decrypt failure is never retried: a chunk that fails
 * its GCM tag will fail again.
 */
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  retries?: number;
  /** Injected so tests do not actually wait out the backoff. */
  delay?: (ms: number) => Promise<void>;
}

export async function runDecrypt(
  req: DecryptRequest,
  fetchFn: typeof fetch,
  emit: (event: DecryptEvent) => void,
  opts: RetryOptions = {},
): Promise<void> {
  const retries = opts.retries ?? MAX_RETRIES;
  const delay = opts.delay ?? sleep;

  for (let attempt = 0; ; attempt++) {
    try {
      await attemptDecrypt(req, fetchFn, emit);
      return;
    } catch (err) {
      if (err instanceof DownloadFailure && attempt < retries) {
        // Each attempt starts the transfer, and the progress bar, over.
        await delay(RETRY_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      const kind = err instanceof DownloadFailure ? "download" : "decrypt";
      emit({ type: "error", kind, message: (err as Error).message });
      return;
    }
  }
}

async function attemptDecrypt(
  req: DecryptRequest,
  fetchFn: typeof fetch,
  emit: (event: DecryptEvent) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(req.url);
  } catch (err) {
    throw new DownloadFailure((err as Error).message);
  }
  if (!res.ok || !res.body) throw new DownloadFailure(`could not download the original (${res.status})`);

  const decryptor = createStreamDecryptor(req.dataKey, req.photoId, req.containerLength);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = res.body.getReader();
  } catch (err) {
    // e.g. a retry handed back a body that is already locked or consumed.
    throw new DownloadFailure((err as Error).message);
  }
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
}
