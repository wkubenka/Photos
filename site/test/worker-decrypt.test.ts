// site/test/worker-decrypt.test.ts
//
// worker.ts itself has no test — it's a thin message-dispatch shim around a
// real Worker global, which vitest doesn't provide. This tests the
// fetch-and-decrypt loop it wraps (runDecrypt) directly, with an injected
// fetch and no Worker involved, so the worker's actual behaviour — a
// 40 MB download turning into incremental progress and a correct plaintext,
// or a corrupt chunk turning into an error message instead of a throw — has
// real coverage instead of resting on a read-through.
import { describe, it, expect } from "vitest";
import { encryptOriginal, newDataKey } from "@photos/core";
import { runDecrypt, type DecryptEvent } from "../src/worker-decrypt.js";

type ErrorEvent = Extract<DecryptEvent, { type: "error" }>;

function streamOf(bytes: Uint8Array, networkChunk: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(at + networkChunk, bytes.length);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  });
}

function fakeFetch(body: ReadableStream<Uint8Array> | null, opts: { ok?: boolean; status?: number } = {}) {
  return (async () => ({ ok: opts.ok ?? true, status: opts.status ?? 200, body })) as unknown as typeof fetch;
}

describe("runDecrypt", () => {
  it("emits progress incrementally as network chunks arrive, then the full plaintext", async () => {
    const dataKey = newDataKey();
    const photoId = "photo-1";
    const plaintext = new TextEncoder().encode("x".repeat(200));
    const container = await encryptOriginal(plaintext, dataKey, photoId, { chunkSize: 32 });

    const events: DecryptEvent[] = [];
    await runDecrypt(
      { url: "https://example.test/original", dataKey, photoId, containerLength: container.length },
      // Network chunks (17 bytes) deliberately don't align with the 32-byte
      // decryption chunk size, so this also proves push/finish handle a
      // buffer that spans decryption-chunk boundaries.
      fakeFetch(streamOf(container, 17)),
      (e) => events.push(e),
    );

    const progress = events.filter((e): e is Extract<DecryptEvent, { type: "progress" }> => e.type === "progress");
    const decrypted = events.filter((e): e is Extract<DecryptEvent, { type: "decrypted" }> => e.type === "decrypted");
    const errors = events.filter((e) => e.type === "error");

    expect(errors).toEqual([]);
    expect(progress.length).toBeGreaterThan(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.done).toBeGreaterThan(progress[i - 1]!.done);
      expect(progress[i]!.total).toBe(plaintext.length);
    }
    expect(progress.at(-1)!.done).toBe(plaintext.length);
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]!.bytes).toEqual(plaintext);
  });

  it("emits an error, not a throw, when a chunk fails authentication", async () => {
    const dataKey = newDataKey();
    const photoId = "photo-1";
    const plaintext = new TextEncoder().encode("y".repeat(200));
    const container = await encryptOriginal(plaintext, dataKey, photoId, { chunkSize: 32 });

    // Flip a bit inside the first ciphertext chunk (past the 22-byte header)
    // to break its GCM tag without touching the header or the length.
    const corrupted = container.slice();
    corrupted[30] = corrupted[30]! ^ 0xff;

    const events: DecryptEvent[] = [];
    await expect(
      runDecrypt(
        { url: "https://example.test/original", dataKey, photoId, containerLength: corrupted.length },
        fakeFetch(streamOf(corrupted, corrupted.length)),
        (e) => events.push(e),
      ),
    ).resolves.toBeUndefined();

    expect(events.some((e) => e.type === "decrypted")).toBe(false);
    const error = events.find((e): e is ErrorEvent => e.type === "error");
    expect(error).toBeDefined();
    expect(error!.kind).toBe("decrypt");
    expect(error!.message).toMatch(/failed authentication/);
  });

  it("emits a download-kind error when the download itself fails", async () => {
    const events: DecryptEvent[] = [];
    await runDecrypt(
      { url: "https://example.test/missing", dataKey: newDataKey(), photoId: "photo-1", containerLength: 100 },
      fakeFetch(null, { ok: false, status: 404 }),
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { type: "error", kind: "download", message: "could not download the original (404)" },
    ]);
  });

  // A chunk failing its GCM tag and the network dropping mid-transfer both
  // surface as an "error" event, but a viewer whose connection blipped
  // should not be told their photograph may have been tampered with — the
  // two need different `kind`s so the UI can tell them apart. This is what
  // distinguishes a stream that errors after already delivering some bytes
  // (download) from one that delivers a corrupted chunk the decryptor itself
  // rejects (decrypt).
  it("emits a download-kind error, not a decrypt-kind one, when the stream fails mid-transfer", async () => {
    const dataKey = newDataKey();
    const photoId = "photo-1";
    const plaintext = new TextEncoder().encode("m".repeat(200));
    const container = await encryptOriginal(plaintext, dataKey, photoId, { chunkSize: 32 });

    let pulls = 0;
    const flakyStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        // Fewer than HEADER_BYTES (22), so the decryptor has buffered
        // nothing decodable yet when the stream fails on the next read.
        if (pulls === 1) {
          controller.enqueue(container.slice(0, 10));
          return;
        }
        throw new Error("network blip");
      },
    });

    const events: DecryptEvent[] = [];
    await runDecrypt(
      { url: "https://example.test/original", dataKey, photoId, containerLength: container.length },
      fakeFetch(flakyStream),
      (e) => events.push(e),
    );

    expect(events.some((e) => e.type === "decrypted")).toBe(false);
    const error = events.find((e): e is ErrorEvent => e.type === "error");
    expect(error).toBeDefined();
    expect(error!.kind).toBe("download");
    expect(error!.message).toMatch(/network blip/);
  });
});
