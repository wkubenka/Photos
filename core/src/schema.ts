import { z } from "zod";

export const SCHEMA_VERSION = 1;

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/;
// The lqip is the one manifest string that reaches a CSS context (the site
// inserts it into a `background-image: url(...)` rule), so it is pinned to
// the exact shape the image pipeline produces rather than left as any
// string: nothing that is not a base64 image data URI can get that far.
const LQIP_DATA_URI = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const WrappedSchema = z.object({ iv: z.string(), ct: z.string() });

const DerivativeSchema = z.object({
  path: z.string().min(1),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  bytes: z.number().int().positive(),
});

// strict() is what makes the GPS test meaningful: an unexpected EXIF field is
// a failure, not something quietly carried through to the public JSON.
const ExifSchema = z
  .object({
    camera: z.string(),
    lens: z.string(),
    focalLength: z.string(),
    aperture: z.string(),
    shutter: z.string(),
    iso: z.number().int().nonnegative(),
  })
  .strict();

const OriginalSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().positive(),
  mime: z.string().min(1),
  sha256: z.string().min(1),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
});

export const PhotoSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  caption: z.string(),
  location: z.string(),
  takenAt: z.string().regex(ISO_OFFSET, "takenAt must be ISO 8601 with a UTC offset"),
  featured: z.boolean().default(false),
  web: DerivativeSchema,
  thumb: DerivativeSchema,
  lqip: z.string().regex(LQIP_DATA_URI, "lqip must be a base64 image data URI"),
  exif: ExifSchema,
  original: OriginalSchema,
});

export const MonthEntrySchema = z.object({
  month: z.string().regex(MONTH_KEY),
  count: z.number().int().nonnegative(),
  path: z.string().min(1),
});

export const IndexFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string(),
  lastBackupAt: z.string().nullable(),
  photoCount: z.number().int().nonnegative(),
  featuredCount: z.number().int().nonnegative(),
  sort: z.literal("takenAt:desc"),
  months: z.array(MonthEntrySchema),
});

export const MonthFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  month: z.string().regex(MONTH_KEY),
  photos: z.array(PhotoSchema),
});

export const FeaturedFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string(),
  photos: z.array(PhotoSchema),
});

export const KeysFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kdf: z.object({
    alg: z.literal("argon2id"),
    salt: z.string(),
    m: z.number().int().positive(),
    t: z.number().int().positive(),
    p: z.number().int().positive(),
    keyLen: z.number().int().positive(),
  }),
  verifier: WrappedSchema,
  keys: z.record(z.string(), WrappedSchema),
});

export type Photo = z.infer<typeof PhotoSchema>;
export type MonthEntry = z.infer<typeof MonthEntrySchema>;
export type IndexFile = z.infer<typeof IndexFileSchema>;
export type MonthFile = z.infer<typeof MonthFileSchema>;
export type FeaturedFile = z.infer<typeof FeaturedFileSchema>;
export type KeysFile = z.infer<typeof KeysFileSchema>;
