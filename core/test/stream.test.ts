import { describe, it, expect } from "vitest";
import { encryptOriginal } from "../src/container.js";
import { createStreamDecryptor } from "../src/stream.js";
import { newDataKey } from "../src/wrap.js";
import { concat } from "../src/bytes.js";

const ID = "photo-stream-test";
const SMALL = 64;

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 11 + 5) & 0xff;
  return b;
}

async function feed(enc: Uint8Array, key: Uint8Array, pieceSize: number): Promise<Uint8Array> {
  const d = createStreamDecryptor(key, ID, enc.length);
  const out: Uint8Array[] = [];
  for (let i = 0; i < enc.length; i += pieceSize) {
    out.push(...(await d.push(enc.subarray(i, i + pieceSize))));
  }
  out.push(...(await d.finish()));
  return concat(...out);
}

describe("stream decryptor", () => {
  it("decrypts when fed one byte at a time", async () => {
    const key = newDataKey();
    const plain = bytes(200);
    const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
    expect(await feed(enc, key, 1)).toEqual(plain);
  });

  it("decrypts when fed in pieces larger than a chunk", async () => {
    const key = newDataKey();
    const plain = bytes(200);
    const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
    expect(await feed(enc, key, 1000)).toEqual(plain);
  });

  it("decrypts when pieces land exactly on chunk boundaries", async () => {
    const key = newDataKey();
    const plain = bytes(192);
    const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
    expect(await feed(enc, key, SMALL + 16)).toEqual(plain);
  });

  it("exposes the plaintext total once the header arrives", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const d = createStreamDecryptor(key, ID, enc.length);
    expect(d.plainTotal).toBeNull();
    await d.push(enc.subarray(0, 22));
    expect(d.plainTotal).toBe(200);
  });

  it("throws on a tampered chunk as soon as that chunk completes", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const byte = enc[30]!;
    enc[30] = byte ^ 0x01;
    await expect(feed(enc, key, 1000)).rejects.toThrow(/failed authentication/);
  });

  it("throws if the stream ends early", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const d = createStreamDecryptor(key, ID, enc.length);
    await d.push(enc.subarray(0, 100));
    await expect(d.finish()).rejects.toThrow(/incomplete/i);
  });

  it("throws on trailing bytes after the final chunk", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const withTrailing = concat(enc, bytes(5));
    const d = createStreamDecryptor(key, ID, enc.length);
    await d.push(withTrailing);
    await expect(d.finish()).rejects.toThrow(/trailing bytes/);
  });
});
