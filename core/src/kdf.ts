import { argon2id } from "hash-wasm";
import { fromBase64, toBase64 } from "./bytes.js";

export const DEFAULT_KDF = { m: 65536, t: 3, p: 1, keyLen: 32 } as const;

export interface KdfParams {
  alg: "argon2id";
  salt: string;
  m: number;
  t: number;
  p: number;
  keyLen: number;
}

export function newKdfParams(
  overrides: Partial<Omit<KdfParams, "alg" | "salt">> = {},
): KdfParams {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  return { alg: "argon2id", salt: toBase64(salt), ...DEFAULT_KDF, ...overrides };
}

export async function deriveMasterKey(
  password: string,
  params: KdfParams,
): Promise<Uint8Array> {
  if (params.alg !== "argon2id") throw new Error(`unsupported kdf: ${params.alg}`);
  return argon2id({
    password,
    salt: fromBase64(params.salt),
    memorySize: params.m,
    iterations: params.t,
    parallelism: params.p,
    hashLength: params.keyLen,
    outputType: "binary",
  });
}
