import { concat } from "./bytes.js";
import {
  HEADER_BYTES, TAG_BYTES, chunkAad, chunkCountFor, chunkNonce, decodeHeader,
  type Header,
} from "./container.js";

export interface StreamDecryptor {
  push(bytes: Uint8Array): Promise<Uint8Array[]>;
  finish(): Promise<Uint8Array[]>;
  readonly plainTotal: number | null;
}

export function createStreamDecryptor(
  dataKey: Uint8Array,
  photoId: string,
  containerLength: number,
): StreamDecryptor {
  let buffer: Uint8Array = new Uint8Array(0);
  let headerBytes: Uint8Array | null = null;
  let header: Header | null = null;
  let plainTotal: number | null = null;
  let nextChunk = 0;
  let key: CryptoKey | null = null;

  async function ensureKey(): Promise<CryptoKey> {
    key ??= await globalThis.crypto.subtle.importKey("raw", dataKey as BufferSource, "AES-GCM", false, ["decrypt"]);
    return key;
  }

  async function drain(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];

    if (!header) {
      if (buffer.length < HEADER_BYTES) return out;
      headerBytes = buffer.slice(0, HEADER_BYTES);
      header = decodeHeader(headerBytes);
      buffer = concat(buffer.subarray(HEADER_BYTES));
      plainTotal = containerLength - HEADER_BYTES - header.chunkCount * TAG_BYTES;
      if (plainTotal <= 0) throw new Error("container length is impossible for its chunk count");
      if (chunkCountFor(plainTotal, header.chunkSize) !== header.chunkCount) {
        throw new Error("container length disagrees with the header chunk count");
      }
    }

    const h = header;
    const total = plainTotal!;

    while (nextChunk < h.chunkCount) {
      const isFinal = nextChunk === h.chunkCount - 1;
      const plainLen = isFinal ? total - nextChunk * h.chunkSize : h.chunkSize;
      const need = plainLen + TAG_BYTES;
      if (buffer.length < need) break;

      const plain = await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(h.noncePrefix, nextChunk) as BufferSource,
          additionalData: chunkAad(headerBytes!, photoId, nextChunk, isFinal) as BufferSource,
          tagLength: 128,
        },
        await ensureKey(),
        buffer.subarray(0, need) as BufferSource,
      );
      out.push(new Uint8Array(plain as ArrayBuffer));
      buffer = concat(buffer.subarray(need));
      nextChunk++;
    }

    return out;
  }

  return {
    get plainTotal() {
      return plainTotal;
    },
    async push(bytes: Uint8Array) {
      buffer = concat(buffer, bytes);
      return drain();
    },
    async finish() {
      const out = await drain();
      if (!header) throw new Error("incomplete container: the header never arrived");
      if (nextChunk !== header.chunkCount) throw new Error("incomplete container: missing chunks");
      if (buffer.length !== 0) throw new Error("trailing bytes after the final chunk");
      return out;
    },
  };
}
