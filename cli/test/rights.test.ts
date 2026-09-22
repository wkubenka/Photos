import { describe, it, expect, afterAll } from "vitest";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRights, closeRightsWriter } from "../src/rights.js";
import { closeExif } from "../src/exif.js";

afterAll(async () => {
  await closeExif();
  await closeRightsWriter();
});

const config = {
  bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
  siteUrl: "https://photos.example.com",
  creator: "William Kubenka",
  copyright: "© 2026 William Kubenka. All rights reserved.",
  usageTerms: "No reproduction, redistribution, or use as AI training data without written permission.",
  sizes: { display: 2048, thumb: 640 },
};

const photo = {
  title: "Santa Elena at dusk",
  caption: "The canyon mouth from the river trail.",
  takenAt: "2026-03-14T18:22:05-06:00",
  exif: {
    camera: "Fujifilm X-T5", lens: "XF 16-55mm F2.8 R LM WR",
    focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400,
  },
};

async function tagsOf(buffer: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "photos-rights-"));
  const path = join(dir, "out.jpg");
  writeFileSync(path, buffer);
  return exiftool.read(path);
}

async function blank(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "#777" } })
    .jpeg().toBuffer();
}

describe("writeRights", () => {
  it("writes the rights fields", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config)) as Record<string, unknown>;
    expect(tags.Creator).toContain("William Kubenka");
    expect(String(tags.Rights ?? tags.CopyrightNotice)).toContain("2026 William Kubenka");
    expect(String(tags.UsageTerms)).toContain("AI training data");
    expect(tags.Marked).toBe(true);
  }, 30_000);

  it("writes the machine-readable opt-out tags", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config)) as Record<string, unknown>;
    expect(String(tags.Robots)).toBe("noai, noimageai");
    expect(String(tags.DigitalSourceType)).toContain("digitalCapture");
    expect(String(tags.Reservation)).toBe("1");
  }, 30_000);

  it("writes the whitelisted camera fields and the description", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config)) as Record<string, unknown>;
    expect(String(tags.Model)).toContain("X-T5");
    expect(String(tags.LensModel)).toContain("16-55mm");
    expect(Number(tags.ISO)).toBe(400);
    expect(String(tags.FocalLength)).toContain("23");
    expect(Number(tags.FNumber)).toBe(8);
    expect(String(tags.ExposureTime)).toContain("60");
    expect(String(tags.Description ?? tags.ImageDescription)).toContain("canyon mouth");
  }, 30_000);

  it("writes no GPS tags by default", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config)) as Record<string, unknown>;
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.GPSLongitude).toBeUndefined();
    expect(tags.GPSPosition).toBeUndefined();
  }, 30_000);

  it("writes GPS only when explicitly asked", async () => {
    const out = await writeRights(await blank(), photo, config, { gps: { lat: 29.2, lon: -103.6 } });
    const tags = await tagsOf(out) as Record<string, unknown>;
    expect(tags.GPSLatitude).toBeDefined();
    expect(tags.GPSLongitude).toBeDefined();
    expect(Number(tags.GPSLatitude)).toBeCloseTo(29.2, 3);
    expect(Number(tags.GPSLongitude)).toBeCloseTo(-103.6, 3);
  }, 30_000);
});

describe("writeRights with incomplete camera EXIF", () => {
  // readExif (Task 11) emits "" for aperture/focalLength/shutter whenever the
  // source camera didn't report them (manual/adapted lens, incomplete EXIF),
  // and the schema allows it. An absent value must not become a fabricated
  // zero, and must not fail the whole photo.
  it("omits FNumber entirely when aperture is blank, rather than publishing without it", async () => {
    const incomplete = { ...photo, exif: { ...photo.exif, aperture: "" } };
    const tags = await tagsOf(await writeRights(await blank(), incomplete, config)) as Record<string, unknown>;
    expect(tags.FNumber).toBeUndefined();
  }, 30_000);

  it("omits FocalLength entirely when focalLength is blank", async () => {
    const incomplete = { ...photo, exif: { ...photo.exif, focalLength: "" } };
    const tags = await tagsOf(await writeRights(await blank(), incomplete, config)) as Record<string, unknown>;
    expect(tags.FocalLength).toBeUndefined();
  }, 30_000);

  it("omits ExposureTime entirely when shutter is blank, never writing a zero", async () => {
    const incomplete = { ...photo, exif: { ...photo.exif, shutter: "" } };
    const tags = await tagsOf(await writeRights(await blank(), incomplete, config)) as Record<string, unknown>;
    expect(tags.ExposureTime).toBeUndefined();
    expect(tags.ExposureTime).not.toBe(0);
  }, 30_000);

  it("still writes rights fields and all three opt-out signals when all three camera values are blank", async () => {
    const bare = { ...photo, exif: { ...photo.exif, aperture: "", focalLength: "", shutter: "" } };
    const tags = await tagsOf(await writeRights(await blank(), bare, config)) as Record<string, unknown>;
    expect(tags.FNumber).toBeUndefined();
    expect(tags.FocalLength).toBeUndefined();
    expect(tags.ExposureTime).toBeUndefined();
    expect(String(tags.Rights ?? tags.CopyrightNotice)).toContain("2026 William Kubenka");
    expect(String(tags.Robots)).toBe("noai, noimageai");
    expect(String(tags.DigitalSourceType)).toContain("digitalCapture");
    expect(String(tags.Reservation)).toBe("1");
  }, 30_000);

  it("still throws on a non-empty but unparseable aperture", async () => {
    const bad = { ...photo, exif: { ...photo.exif, aperture: "wide open" } };
    await expect(writeRights(await blank(), bad, config)).rejects.toThrow(/aperture/i);
  }, 30_000);
});
