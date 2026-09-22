import { fromBase64, toBase64, utf8 } from "./bytes.js";

export const VERIFIER_PLAINTEXT = "photo-gallery-verifier-v1";

export interface Wrapped {
  iv: string;
  ct: string;
}

async function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, usages);
}

function newIv(): Uint8Array {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  return iv;
}

export function newDataKey(): Uint8Array {
  const k = new Uint8Array(32);
  globalThis.crypto.getRandomValues(k);
  return k;
}

async function seal(master: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Wrapped> {
  const iv = newIv();
  const key = await aesKey(master, ["encrypt"]);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, key, plaintext as BufferSource,
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

async function open(master: Uint8Array, wrapped: Wrapped, aad: Uint8Array): Promise<Uint8Array> {
  const key = await aesKey(master, ["decrypt"]);
  const out = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapped.iv) as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    key, fromBase64(wrapped.ct) as BufferSource,
  );
  return new Uint8Array(out);
}

export function wrapDataKey(master: Uint8Array, dataKey: Uint8Array, photoId: string) {
  return seal(master, dataKey, utf8(photoId));
}

export function unwrapDataKey(master: Uint8Array, wrapped: Wrapped, photoId: string) {
  return open(master, wrapped, utf8(photoId));
}

export function makeVerifier(master: Uint8Array): Promise<Wrapped> {
  return seal(master, utf8(VERIFIER_PLAINTEXT), new Uint8Array(0));
}

export async function checkVerifier(master: Uint8Array, v: Wrapped): Promise<boolean> {
  try {
    const out = await open(master, v, new Uint8Array(0));
    return new TextDecoder().decode(out) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}
