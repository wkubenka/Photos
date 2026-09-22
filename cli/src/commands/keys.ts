import {
  checkVerifier, deriveMasterKey, makeVerifier, newKdfParams, unwrapDataKey, wrapDataKey,
  FeaturedFileSchema, IndexFileSchema, KeysFileSchema, MonthFileSchema, type KeysFile,
} from "@photos/core";
import { CACHE_SHORT } from "../config.js";
import { KEYS, readKeys } from "../manifest.js";
import type { Store } from "../store.js";

const enc = new TextEncoder();

/**
 * Re-wraps every data key under a new password. No object under orig/ is read,
 * rewritten, or re-uploaded — that is the whole point of the key hierarchy.
 */
export async function rotatePassword(
  store: Store,
  oldPassword: string,
  newPassword: string,
): Promise<{ rewrapped: number }> {
  const current = await readKeys(store);
  if (!current) throw new Error("this library has no keys.json yet; add a photo first");

  const oldMaster = await deriveMasterKey(oldPassword, current.kdf);
  if (!(await checkVerifier(oldMaster, current.verifier))) {
    throw new Error("the old password is incorrect; nothing was changed");
  }

  const kdf = newKdfParams({ m: current.kdf.m, t: current.kdf.t, p: current.kdf.p });
  const newMaster = await deriveMasterKey(newPassword, kdf);

  const rewrapped: KeysFile["keys"] = {};
  for (const [id, wrapped] of Object.entries(current.keys)) {
    const dataKey = await unwrapDataKey(oldMaster, wrapped, id);
    rewrapped[id] = await wrapDataKey(newMaster, dataKey, id);
  }

  const next: KeysFile = {
    schemaVersion: current.schemaVersion,
    kdf,
    verifier: await makeVerifier(newMaster),
    keys: rewrapped,
  };

  await store.put(KEYS.keys, enc.encode(JSON.stringify(next, null, 2)), "application/json", CACHE_SHORT);
  return { rewrapped: Object.keys(rewrapped).length };
}

const RESTORABLE = new Set([KEYS.index, KEYS.keys, KEYS.featured]);

function validatorFor(path: string): (value: unknown) => unknown {
  if (path === KEYS.index) return (v) => IndexFileSchema.parse(v);
  if (path === KEYS.keys) return (v) => KeysFileSchema.parse(v);
  if (path === KEYS.featured) return (v) => FeaturedFileSchema.parse(v);
  return (v) => MonthFileSchema.parse(v);
}

/**
 * Rolls one data/ file back to a previous S3 object version.
 *
 * It names a file rather than assuming the index, because the manifest is four
 * kinds of file and the one worth rolling back is usually a month shard. The
 * restored bytes are validated against that file's schema before being written,
 * so a corrupted old version cannot be promoted back into service.
 */
export async function restoreFile(
  store: Store,
  path: string,
  versionId?: string,
): Promise<void> {
  if (!RESTORABLE.has(path) && !path.startsWith("data/months/")) {
    throw new Error(`can only restore data/ manifest files, not ${path}`);
  }

  const versions = await store.listVersions(path);
  if (versions.length < 2 && !versionId) {
    throw new Error(`no previous version of ${path} to restore`);
  }

  const target = versionId ?? versions[1]!.versionId;
  const body = await store.getVersion(path, target);
  validatorFor(path)(JSON.parse(new TextDecoder().decode(body)));
  await store.put(path, body, "application/json", CACHE_SHORT);
}

export async function listFileVersions(
  store: Store,
  path: string,
): Promise<{ versionId: string; lastModified: string }[]> {
  return store.listVersions(path);
}
