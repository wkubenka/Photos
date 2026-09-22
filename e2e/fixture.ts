import { mkdir, writeFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { createMemoryStore } from "../cli/src/memory-store.js";
import { addPhotos } from "../cli/src/commands/add.js";
import { setFeatured } from "../cli/src/commands/curate.js";
import { closeExif } from "../cli/src/exif.js";
import { closeRightsWriter } from "../cli/src/rights.js";

export const PASSWORD = "a long shared family passphrase";

const config = {
  bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
  siteUrl: "https://photos.example.test", creator: "Test Photographer",
  copyright: "© 2026 Test Photographer", usageTerms: "No AI training.",
  sizes: { display: 2048, thumb: 640 },
};

// The plan's original fixture created JPEGs with sharp alone, which never
// produces a DateTimeOriginal tag. readExif deliberately throws when it
// cannot determine a capture time, so addPhotos would fail before anything
// got published. cli/test/add.test.ts and cli/test/exif.test.ts both stamp
// EXIF with exiftool after writing the JPEG; this follows that pattern, and
// stamps dates in March 2026 because gallery.spec.ts navigates to
// `?m=2026-03`.
async function sourceFile(outDir: string, name: string, colour: string, takenAt: string): Promise<string> {
  const path = join(outDir, "sources", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: colour },
  }).jpeg().toBuffer());
  await exiftool.write(path, {
    DateTimeOriginal: takenAt,
    OffsetTimeOriginal: "-06:00",
    Make: "Fujifilm",
    Model: "X-T5",
    LensModel: "XF 16-55mm F2.8 R LM WR",
    FNumber: 8,
    ExposureTime: "1/60",
    FocalLength: "23",
    ISO: 400,
  });
  return path;
}

/** Builds a two-photo library on disk, and returns the plaintext source paths. */
export async function buildFixture(outDir: string): Promise<{ sources: string[] }> {
  const store = createMemoryStore();
  const sources: string[] = [];

  for (const [i, colour, takenAt] of [
    ["0001", "#3a5f7d", "2026:03:14 18:22:05"],
    ["0002", "#7d5f3a", "2026:03:20 09:10:00"],
  ] as const) {
    sources.push(await sourceFile(outDir, `DSCF${i}.jpg`, colour, takenAt));
  }

  const added = await addPhotos(
    {
      store, config,
      prompt: async (file) => ({
        title: file.includes("0001") ? "First light" : "Second light",
        caption: "A test photograph.",
        location: "Somewhere, Texas",
      }),
      password: async () => PASSWORD,
    },
    sources,
    { offset: "-06:00" },
  );

  await setFeatured(store, [added[0]!.id], true);
  await closeExif();
  await closeRightsWriter();

  for (const [key, value] of store.objects) {
    const dest = join(outDir, "site", key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, value.body);
  }
  await cp("site/dist", join(outDir, "site"), { recursive: true });

  return { sources };
}
