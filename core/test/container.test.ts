import { describe, it, expect } from "vitest";
import {
  encryptOriginal, decryptOriginal, decodeHeader, chunkCountFor,
  HEADER_BYTES, TAG_BYTES,
} from "../src/container.js";
import { newDataKey } from "../src/wrap.js";

const ID = "2026-03-14-santa-elena-0031";
const SMALL = 64; // a tiny chunk size keeps these tests fast

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

describe("chunkCountFor", () => {
  it("counts partial and exact chunks", () => {
    expect(chunkCountFor(1, 64)).toBe(1);
    expect(chunkCountFor(64, 64)).toBe(1);
    expect(chunkCountFor(65, 64)).toBe(2);
    expect(chunkCountFor(128, 64)).toBe(2);
  });
});

describe("round trip", () => {
  for (const size of [1, 63, 64, 65, 200, 4096]) {
    it(`round-trips ${size} bytes`, async () => {
      const key = newDataKey();
      const plain = bytes(size);
      const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
      expect(await decryptOriginal(enc, key, ID)).toEqual(plain);
    });
  }

  it("produces the expected container length", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    // 4 chunks: 64 + 64 + 64 + 8 plaintext, each with a 16-byte tag
    expect(enc.length).toBe(HEADER_BYTES + 200 + 4 * TAG_BYTES);
    expect(decodeHeader(enc).chunkCount).toBe(4);
  });

  it("reports progress once per chunk", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const seen: number[] = [];
    await decryptOriginal(enc, key, ID, (done) => seen.push(done));
    expect(seen).toEqual([64, 128, 192, 200]);
  });

  it("uses a different nonce prefix per file", async () => {
    const key = newDataKey();
    const a = await encryptOriginal(bytes(10), key, ID, { chunkSize: SMALL });
    const b = await encryptOriginal(bytes(10), key, ID, { chunkSize: SMALL });
    expect(a.slice(18, 22)).not.toEqual(b.slice(18, 22));
  });

  it("refuses to encrypt an empty file", async () => {
    await expect(encryptOriginal(new Uint8Array(0), newDataKey(), ID)).rejects.toThrow(/empty/i);
  });
});

describe("fails closed", () => {
  async function container(size = 200) {
    const key = newDataKey();
    return { key, enc: await encryptOriginal(bytes(size), key, ID, { chunkSize: SMALL }) };
  }

  it("rejects a flipped ciphertext byte", async () => {
    const { key, enc: encOrig } = await container();
    const enc: Uint8Array = new Uint8Array(encOrig);
    enc[HEADER_BYTES + 5]! ^= 0x01;
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a flipped authentication tag byte", async () => {
    const { key, enc: encOrig } = await container();
    const enc: Uint8Array = new Uint8Array(encOrig);
    enc[HEADER_BYTES + SMALL + 2]! ^= 0x01;
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a tampered header, because the header is authenticated", async () => {
    const { key, enc: encOrig } = await container();
    const enc: Uint8Array = new Uint8Array(encOrig);
    enc[21]! ^= 0x01; // last byte of the nonce prefix
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects truncation within the final chunk", async () => {
    const { key, enc } = await container();
    const truncated = enc.slice(0, enc.length - 1);
    await expect(decryptOriginal(truncated, key, ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a container missing a whole chunk", async () => {
    const { key, enc } = await container();
    const truncated = enc.slice(0, enc.length - (8 + TAG_BYTES));
    await expect(decryptOriginal(truncated, key, ID)).rejects.toThrow(/disagrees with the header chunk count/);
  });

  it("rejects a wrong photo id", async () => {
    const { key, enc } = await container();
    await expect(decryptOriginal(enc, key, "some-other-photo")).rejects.toThrow(/failed authentication/);
  });

  it("rejects a wrong data key", async () => {
    const { enc } = await container();
    await expect(decryptOriginal(enc, newDataKey(), ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a chunk spliced from another file", async () => {
    const key = newDataKey();
    const a = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const b = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const spliced = new Uint8Array(a);
    spliced.set(b.slice(HEADER_BYTES, HEADER_BYTES + SMALL + TAG_BYTES), HEADER_BYTES);
    await expect(decryptOriginal(spliced, key, ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects two chunks swapped within one file", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const unit = SMALL + TAG_BYTES;
    const first = enc.slice(HEADER_BYTES, HEADER_BYTES + unit);
    const second = enc.slice(HEADER_BYTES + unit, HEADER_BYTES + 2 * unit);
    enc.set(second, HEADER_BYTES);
    enc.set(first, HEADER_BYTES + unit);
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a container with trailing bytes", async () => {
    const { key, enc } = await container();
    const extended = new Uint8Array(enc.length + 5);
    extended.set(enc);
    await expect(decryptOriginal(extended, key, ID)).rejects.toThrow(/failed authentication/);
  });
});

describe("realistic size", () => {
  it("round-trips a 12 MB file across real 4 MiB chunks", async () => {
    const key = newDataKey();
    const plain = bytes(12 * 1024 * 1024);
    const enc = await encryptOriginal(plain, key, ID);
    expect(decodeHeader(enc).chunkCount).toBe(3);
    expect(await decryptOriginal(enc, key, ID)).toEqual(plain);
  }, 30_000);
});
