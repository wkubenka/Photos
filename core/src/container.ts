import { concat, equal, u32be, u64be, utf8 } from "./bytes.js";

export const MAGIC = utf8("PHOTOENC");
export const HEADER_BYTES = 22;
export const FORMAT_VERSION = 1;
export const CIPHER_AES_256_GCM = 1;
export const CHUNK_SIZE = 4194304;
export const TAG_BYTES = 16;

export interface Header {
  version: number;
  cipherId: number;
  chunkSize: number;
  chunkCount: number;
  noncePrefix: Uint8Array;
}

export function encodeHeader(h: Header): Uint8Array {
  if (h.noncePrefix.length !== 4) throw new Error(`invalid nonce prefix: expected 4 bytes, got ${h.noncePrefix.length}`);
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out[8] = h.version;
  out[9] = h.cipherId;
  out.set(u32be(h.chunkSize), 10);
  out.set(u32be(h.chunkCount), 14);
  out.set(h.noncePrefix, 18);
  return out;
}

export function decodeHeader(buf: Uint8Array): Header {
  if (buf.length < HEADER_BYTES) throw new Error("container too short for a header");
  if (!equal(buf.slice(0, 8), MAGIC)) throw new Error("bad magic: not a PHOTOENC container");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = buf[8]!;
  const cipherId = buf[9]!;
  if (version !== FORMAT_VERSION) throw new Error(`unsupported format version ${version}`);
  if (cipherId !== CIPHER_AES_256_GCM) throw new Error(`unsupported cipher id ${cipherId}`);
  const chunkSize = view.getUint32(10, false);
  const chunkCount = view.getUint32(14, false);
  if (chunkSize === 0) throw new Error("invalid chunk size of zero");
  if (chunkCount === 0) throw new Error("invalid chunk count of zero");
  return { version, cipherId, chunkSize, chunkCount, noncePrefix: buf.slice(18, 22) };
}

export function chunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array {
  return concat(noncePrefix, u64be(index));
}

export function chunkAad(
  headerBytes: Uint8Array,
  photoId: string,
  index: number,
  isFinal: boolean,
): Uint8Array {
  return concat(headerBytes, utf8(photoId), u32be(index), new Uint8Array([isFinal ? 1 : 0]));
}

export function chunkCountFor(byteLength: number, chunkSize: number): number {
  return Math.ceil(byteLength / chunkSize);
}

async function gcmKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, usages);
}

export async function encryptOriginal(
  plaintext: Uint8Array,
  dataKey: Uint8Array,
  photoId: string,
  opts: { chunkSize?: number } = {},
): Promise<Uint8Array> {
  if (plaintext.length === 0) throw new Error("refusing to encrypt an empty file");
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const chunkCount = chunkCountFor(plaintext.length, chunkSize);
  const noncePrefix = new Uint8Array(4);
  globalThis.crypto.getRandomValues(noncePrefix);

  const headerBytes = encodeHeader({
    version: FORMAT_VERSION,
    cipherId: CIPHER_AES_256_GCM,
    chunkSize,
    chunkCount,
    noncePrefix,
  });

  const key = await gcmKey(dataKey, ["encrypt"]);
  const parts: Uint8Array[] = [headerBytes];

  for (let i = 0; i < chunkCount; i++) {
    const slice = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length));
    const isFinal = i === chunkCount - 1;
    const ct = await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(noncePrefix, i) as BufferSource,
        additionalData: chunkAad(headerBytes, photoId, i, isFinal) as BufferSource,
        tagLength: 128,
      },
      key,
      slice as BufferSource,
    );
    parts.push(new Uint8Array(ct));
  }

  return concat(...parts);
}

export async function decryptOriginal(
  container: Uint8Array,
  dataKey: Uint8Array,
  photoId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const headerBytes = container.slice(0, HEADER_BYTES);
  const h = decodeHeader(headerBytes);

  const body = container.length - HEADER_BYTES;
  const tagOverhead = h.chunkCount * TAG_BYTES;
  const plainTotal = body - tagOverhead;
  if (plainTotal <= 0) throw new Error("container body length is impossible for its chunk count");
  if (chunkCountFor(plainTotal, h.chunkSize) !== h.chunkCount) {
    throw new Error("container body length disagrees with the header chunk count");
  }

  const key = await gcmKey(dataKey, ["decrypt"]);
  const out = new Uint8Array(plainTotal);
  let readAt = HEADER_BYTES;
  let wroteAt = 0;

  for (let i = 0; i < h.chunkCount; i++) {
    const isFinal = i === h.chunkCount - 1;
    const plainLen = isFinal ? plainTotal - wroteAt : h.chunkSize;
    const slice = container.subarray(readAt, readAt + plainLen + TAG_BYTES);
    try {
      const plain = await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(h.noncePrefix, i) as BufferSource,
          additionalData: chunkAad(headerBytes, photoId, i, isFinal) as BufferSource,
          tagLength: 128,
        },
        key,
        slice as BufferSource,
      );
      out.set(new Uint8Array(plain), wroteAt);
    } catch {
      throw new Error(`chunk ${i} failed authentication`);
    }
    readAt += plainLen + TAG_BYTES;
    wroteAt += plainLen;
    onProgress?.(wroteAt, plainTotal);
  }

  return out;
}
