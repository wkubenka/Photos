import { describe, it, expect, afterAll, vi } from "vitest";
import sharp from "sharp";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exiftool } from "exiftool-vendored";
import { createMemoryStore } from "../src/memory-store.js";
import { addPhotos } from "../src/commands/add.js";
import { readIndex, readKeys, readMonth, readFeatured } from "../src/manifest.js";
import { closeExif } from "../src/exif.js";
import { closeRightsWriter } from "../src/rights.js";
import { decryptOriginal, deriveMasterKey, unwrapDataKey } from "@photos/core";

afterAll(async () => {
  await closeExif();
  await closeRightsWriter();
});

const config = {
  bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
  siteUrl: "https://photos.example.com", creator: "W K",
  copyright: "© 2026 W K", usageTerms: "No AI training.",
  sizes: { display: 2048, thumb: 640 },
};

// The brief's original fixture only stamped Make/Model via sharp's
// withMetadata(), which never produces a DateTimeOriginal tag. readExif
// throws when it cannot determine a capture time, so every test using that
// fixture would fail before reaching its assertions. Task 11's own
// integration test (cli/test/exif.test.ts) stamps EXIF with exiftool after
// writing the JPEG; this fixture follows that pattern.
async function sourceFile(
  name = "DSCF0031.jpg",
  tags: Record<string, unknown> = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "photos-add-"));
  const path = join(dir, name);
  const buf = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#5a6b7c" },
  })
    .jpeg()
    .toBuffer();
  writeFileSync(path, buf);
  await exiftool.write(path, {
    DateTimeOriginal: "2026:03:14 18:22:05",
    OffsetTimeOriginal: "-06:00",
    Make: "Fujifilm",
    Model: "X-T5",
    LensModel: "XF 16-55mm F2.8 R LM WR",
    FNumber: 8,
    ExposureTime: "1/60",
    FocalLength: "23",
    ISO: 400,
    ...tags,
  });
  return path;
}

async function readTags(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "photos-add-check-"));
  const outPath = join(dir, "out.jpg");
  writeFileSync(outPath, bytes);
  return (await exiftool.read(outPath)) as Record<string, unknown>;
}

function deps(store = createMemoryStore()) {
  return {
    store,
    config,
    prompt: async () => ({ title: "Santa Elena at dusk", caption: "Dusk.", location: "Big Bend NP" }),
    password: async () => "a long shared passphrase",
  };
}

describe("addPhotos", () => {
  it("publishes a photo end to end", async () => {
    const d = deps();
    const [photo] = await addPhotos(d, [await sourceFile()], {});

    expect(photo!.id).toMatch(/^\d{4}-\d{2}-\d{2}-santa-elena-at-dusk-/);
    expect(photo!.featured).toBe(false);

    const index = await readIndex(d.store);
    expect(index.photoCount).toBe(1);
    expect(index.months).toHaveLength(1);

    const shard = await readMonth(d.store, index.months[0]!.month);
    expect(shard.photos[0]!.id).toBe(photo!.id);

    expect(await d.store.get(photo!.web.path)).not.toBeNull();
    expect(await d.store.get(photo!.thumb.path)).not.toBeNull();
    expect(await d.store.get(photo!.original.path)).not.toBeNull();
  }, 60_000);

  it("stores an original that decrypts back to the source bytes", async () => {
    const d = deps();
    const file = await sourceFile();
    const [photo] = await addPhotos(d, [file], {});

    const keys = (await readKeys(d.store))!;
    const master = await deriveMasterKey("a long shared passphrase", keys.kdf);
    const dataKey = await unwrapDataKey(master, keys.keys[photo!.id]!, photo!.id);
    const container = (await d.store.get(photo!.original.path))!;
    const plain = await decryptOriginal(container, dataKey, photo!.id);

    expect(Buffer.from(plain)).toEqual(readFileSync(file));
  }, 60_000);

  it("creates the kdf params and verifier on the first add only", async () => {
    const d = deps();
    await addPhotos(d, [await sourceFile("a.jpg")], {});
    const first = (await readKeys(d.store))!;
    await addPhotos(d, [await sourceFile("b.jpg")], {});
    const second = (await readKeys(d.store))!;
    expect(second.kdf.salt).toBe(first.kdf.salt);
    expect(second.verifier).toEqual(first.verifier);
    expect(Object.keys(second.keys)).toHaveLength(2);
  }, 90_000);

  it("rejects a second add under a different password, writing nothing", async () => {
    const store = createMemoryStore();
    await addPhotos(deps(store), [await sourceFile("a.jpg")], {});

    const indexBefore = await readIndex(store);
    const keysBefore = [...store.objects.keys()].sort();

    const wrong = { ...deps(store), password: async () => "a different passphrase" };
    await expect(addPhotos(wrong, [await sourceFile("b.jpg")], {}))
      .rejects.toThrow(/password/i);

    const indexAfter = await readIndex(store);
    expect(indexAfter.photoCount).toBe(1);
    expect(indexAfter).toEqual(indexBefore);
    expect([...store.objects.keys()].sort()).toEqual(keysBefore);
  }, 90_000);

  it("applies a batch location without prompting for one", async () => {
    const prompt = vi.fn(async () => ({ title: "Santa Elena at dusk", caption: "Dusk." }));
    const d = { ...deps(), prompt };
    const [photo] = await addPhotos(d, [await sourceFile()], {
      location: "Big Bend NP, Texas",
    });
    expect(photo!.location).toBe("Big Bend NP, Texas");
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.anything(), false);
  }, 60_000);

  it("applies the batch location to every file in the batch", async () => {
    const d = { ...deps(), prompt: async () => ({ title: "T", caption: "C" }) };
    const added = await addPhotos(d, [await sourceFile("a.jpg"), await sourceFile("b.jpg")], {
      location: "Guadalupe Mountains",
    });
    expect(added.map((p) => p.location)).toEqual(["Guadalupe Mountains", "Guadalupe Mountains"]);
  }, 90_000);

  it("asks for a location when no batch location is given", async () => {
    const prompt = vi.fn(async () => ({ title: "T", caption: "C", location: "Typed in" }));
    const d = { ...deps(), prompt };
    const [photo] = await addPhotos(d, [await sourceFile()], {});
    expect(photo!.location).toBe("Typed in");
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.anything(), true);
  }, 60_000);

  it("writes an empty featured file when nothing is featured", async () => {
    const d = deps();
    await addPhotos(d, [await sourceFile()], {});
    expect((await readFeatured(d.store)).photos).toEqual([]);
  }, 60_000);

  // The GPS pair: proves --keep-gps is actually wired end to end, not just
  // that Task 13's writeRights accepts an opts.gps object. Tags are read
  // back from the published derivative bytes, never from the source file.
  it("keeps GPS in both published derivatives when --keep-gps is passed", async () => {
    const d = deps();
    const file = await sourceFile("gps-kept.jpg", {
      GPSLatitude: 29.2, GPSLongitude: -103.6,
    });
    const [photo] = await addPhotos(d, [file], { keepGps: true });

    const webTags = await readTags((await d.store.get(photo!.web.path))!);
    expect(webTags.GPSLatitude).toBeCloseTo(29.2, 3);
    expect(webTags.GPSLongitude).toBeCloseTo(-103.6, 3);

    const thumbTags = await readTags((await d.store.get(photo!.thumb.path))!);
    expect(thumbTags.GPSLatitude).toBeCloseTo(29.2, 3);
    expect(thumbTags.GPSLongitude).toBeCloseTo(-103.6, 3);
  }, 60_000);

  it("strips GPS from both published derivatives by default", async () => {
    const d = deps();
    const file = await sourceFile("gps-stripped.jpg", {
      GPSLatitude: 29.2, GPSLongitude: -103.6,
    });
    const [photo] = await addPhotos(d, [file], {});

    const webTags = await readTags((await d.store.get(photo!.web.path))!);
    expect(webTags.GPSLatitude).toBeUndefined();
    expect(webTags.GPSLongitude).toBeUndefined();
    expect(webTags.GPSPosition).toBeUndefined();

    const thumbTags = await readTags((await d.store.get(photo!.thumb.path))!);
    expect(thumbTags.GPSLatitude).toBeUndefined();
    expect(thumbTags.GPSLongitude).toBeUndefined();
    expect(thumbTags.GPSPosition).toBeUndefined();
  }, 60_000);
});
