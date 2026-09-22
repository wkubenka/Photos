import { describe, it, expect } from "vitest";
import {
  PhotoSchema, IndexFileSchema, MonthFileSchema, KeysFileSchema, SCHEMA_VERSION,
} from "../src/schema.js";
import { newKdfParams } from "../src/kdf.js";

const photo = {
  id: "2026-03-14-santa-elena-at-dusk-0031",
  title: "Santa Elena at dusk",
  caption: "The canyon mouth from the river trail.",
  location: "Big Bend National Park, Texas",
  takenAt: "2026-03-14T18:22:05-06:00",
  featured: true,
  web: { path: "web/x-2048.a1b2c3d4.jpg", w: 2048, h: 1365, bytes: 812446 },
  thumb: { path: "web/x-640.e5f6a7b8.jpg", w: 640, h: 427, bytes: 71230 },
  lqip: "data:image/jpeg;base64,abc",
  exif: {
    camera: "Fujifilm X-T5", lens: "XF 16-55mm F2.8 R LM WR",
    focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400,
  },
  original: {
    path: "orig/x.enc", bytes: 41903882, mime: "image/jpeg",
    sha256: "9f2c", chunkSize: 4194304, chunkCount: 10,
  },
};

describe("PhotoSchema", () => {
  it("accepts a full record", () => {
    expect(PhotoSchema.parse(photo).id).toBe(photo.id);
  });

  it("defaults featured to false", () => {
    const { featured, ...rest } = photo;
    expect(PhotoSchema.parse(rest).featured).toBe(false);
  });

  it("rejects a takenAt without an offset", () => {
    expect(() => PhotoSchema.parse({ ...photo, takenAt: "2026-03-14T18:22:05" })).toThrow();
  });

  it("rejects an unknown exif field", () => {
    expect(() =>
      PhotoSchema.parse({ ...photo, exif: { ...photo.exif, gpsLatitude: 29.2 } }),
    ).toThrow();
  });

  it("requires a positive chunk count", () => {
    expect(() =>
      PhotoSchema.parse({ ...photo, original: { ...photo.original, chunkCount: 0 } }),
    ).toThrow();
  });
});

describe("IndexFileSchema", () => {
  it("accepts an index and rejects a bad month key", () => {
    const index = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-09-21T14:02:11Z",
      lastBackupAt: null,
      photoCount: 1,
      featuredCount: 1,
      sort: "takenAt:desc",
      months: [{ month: "2026-03", count: 1, path: "data/months/2026-03.json" }],
    };
    expect(IndexFileSchema.parse(index).months[0]!.month).toBe("2026-03");
    expect(() =>
      IndexFileSchema.parse({ ...index, months: [{ month: "2026-3", count: 1, path: "p" }] }),
    ).toThrow();
  });
});

describe("MonthFileSchema and KeysFileSchema", () => {
  it("accepts a month shard", () => {
    const parsed = MonthFileSchema.parse({
      schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo],
    });
    expect(parsed.photos).toHaveLength(1);
  });

  it("accepts a keys file", () => {
    const parsed = KeysFileSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      kdf: { alg: "argon2id", salt: "c2FsdA==", m: 65536, t: 3, p: 1, keyLen: 32 },
      verifier: { iv: "aXY=", ct: "Y3Q=" },
      keys: { [photo.id]: { iv: "aXY=", ct: "Y3Q=" } },
    });
    expect(parsed.kdf.m).toBe(65536);
  });
});

describe("KeysFileSchema drift-guard", () => {
  it("accepts the kdf params the generator actually produces", () => {
    const kdfParams = newKdfParams();
    const keysFile = {
      schemaVersion: SCHEMA_VERSION,
      kdf: kdfParams,
      verifier: { iv: "aXY=", ct: "Y3Q=" },
      keys: {},
    };
    expect(() => KeysFileSchema.parse(keysFile)).not.toThrow();
  });
});
