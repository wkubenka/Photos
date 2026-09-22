import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  CHUNK_SIZE, chunkCountFor, deriveMasterKey, encryptOriginal, checkVerifier,
  makePhotoId, makeVerifier, monthOf, newDataKey, newKdfParams, wrapDataKey,
  SCHEMA_VERSION, type KeysFile, type Photo,
} from "@photos/core";
import type { Config } from "../config.js";
import type { Store } from "../store.js";
import { buildDerivatives, derivativePath } from "../images.js";
import { readExif, type ExtractedExif } from "../exif.js";
import { writeRights } from "../rights.js";
import {
  commit, rebuildFeatured, rebuildIndex, readAllMonths, readIndex, readKeys, readMonth,
} from "../manifest.js";

export interface AddDeps {
  store: Store;
  config: Config;
  prompt: (
    file: string,
    exif: ExtractedExif,
    askLocation: boolean,
  ) => Promise<{ title: string; caption: string; location?: string }>;
  password: () => Promise<string>;
}

export interface AddOptions {
  keepGps?: boolean;
  offset?: string;
  /** One location for the whole batch; when set, the prompt does not ask for it. */
  location?: string;
}

export async function addPhotos(
  deps: AddDeps,
  files: string[],
  opts: AddOptions = {},
): Promise<Photo[]> {
  const { store, config } = deps;

  const existingKeys = await readKeys(store);
  const password = await deps.password();

  let keysFile: KeysFile;
  let master: Uint8Array;
  if (existingKeys) {
    master = await deriveMasterKey(password, existingKeys.kdf);
    if (!(await checkVerifier(master, existingKeys.verifier))) {
      throw new Error("that password does not match the one this library was created with");
    }
    keysFile = existingKeys;
  } else {
    const kdf = newKdfParams();
    master = await deriveMasterKey(password, kdf);
    keysFile = {
      schemaVersion: SCHEMA_VERSION,
      kdf,
      verifier: await makeVerifier(master),
      keys: {},
    };
  }

  const index = await readIndex(store);
  const months = new Map((await readAllMonths(store, index)).map((m) => [m.month, m]));
  const objects: { key: string; body: Uint8Array; contentType: string }[] = [];
  const added: Photo[] = [];

  for (const file of files) {
    const source = await readFile(file);
    const extracted = await readExif(file, opts.offset);
    const askLocation = opts.location === undefined;
    const answers = await deps.prompt(file, extracted, askLocation);
    const location = opts.location ?? answers.location ?? "";

    const id = makePhotoId(extracted.takenAt, answers.title, extracted.frame);
    const month = monthOf(extracted.takenAt);

    const { display, thumb, lqip } = await buildDerivatives(source, config.sizes);
    const rightsInput = {
      title: answers.title,
      caption: answers.caption,
      takenAt: extracted.takenAt,
      exif: extracted.exif,
    };
    // GPS is stripped by default (Global Constraint); it only survives into
    // the published derivatives when the caller passed --keep-gps AND the
    // source actually had coordinates to keep.
    const rightsOpts = opts.keepGps && extracted.gps ? { gps: extracted.gps } : {};
    const displayJpeg = await writeRights(display.buffer, rightsInput, config, rightsOpts);
    const thumbJpeg = await writeRights(thumb.buffer, rightsInput, config, rightsOpts);

    const dataKey = newDataKey();
    const container = await encryptOriginal(source, dataKey, id);
    keysFile.keys[id] = await wrapDataKey(master, dataKey, id);

    const webPath = derivativePath(id, config.sizes.display, display.hash);
    const thumbPath = derivativePath(id, config.sizes.thumb, thumb.hash);
    const origPath = `orig/${id}.enc`;

    objects.push(
      { key: webPath, body: displayJpeg, contentType: "image/jpeg" },
      { key: thumbPath, body: thumbJpeg, contentType: "image/jpeg" },
      { key: origPath, body: container, contentType: "application/octet-stream" },
    );

    const photo: Photo = {
      id,
      title: answers.title,
      caption: answers.caption,
      location,
      takenAt: extracted.takenAt,
      featured: false,
      web: { path: webPath, w: display.w, h: display.h, bytes: displayJpeg.length },
      thumb: { path: thumbPath, w: thumb.w, h: thumb.h, bytes: thumbJpeg.length },
      lqip,
      exif: extracted.exif,
      original: {
        path: origPath,
        bytes: container.length,
        mime: "image/jpeg",
        sha256: createHash("sha256").update(source).digest("hex"),
        chunkSize: CHUNK_SIZE,
        chunkCount: chunkCountFor(source.length, CHUNK_SIZE),
      },
    };

    const shard = months.get(month) ?? (await readMonth(store, month));
    months.set(month, { ...shard, photos: [...shard.photos, photo] });
    added.push(photo);
  }

  const allMonths = [...months.values()];
  await commit(store, {
    objects,
    keys: keysFile,
    months: allMonths,
    featured: rebuildFeatured(allMonths),
    index: rebuildIndex(allMonths, index.lastBackupAt),
  });

  return added;
}
