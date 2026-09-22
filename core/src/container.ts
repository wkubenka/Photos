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
