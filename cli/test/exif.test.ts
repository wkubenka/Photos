import { describe, it, expect } from "vitest";
import { assembleTakenAt, gpsFrom, exifDateString, readExif, closeExif } from "../src/exif.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exiftool } from "exiftool-vendored";

describe("assembleTakenAt", () => {
  it("combines an EXIF datetime with its offset tag", () => {
    expect(assembleTakenAt("2026:03:14 18:22:05", "-06:00")).toBe("2026-03-14T18:22:05-06:00");
  });

  it("accepts a positive offset", () => {
    expect(assembleTakenAt("2026:04:01 01:00:00", "+03:00")).toBe("2026-04-01T01:00:00+03:00");
  });

  it("throws when the offset tag is missing, rather than assuming a zone", () => {
    expect(() => assembleTakenAt("2026:03:14 18:22:05", undefined))
      .toThrow(/offset/i);
  });

  it("rejects a malformed datetime", () => {
    expect(() => assembleTakenAt("not a date", "-06:00")).toThrow(/DateTimeOriginal/);
  });
});

describe("gpsFrom", () => {
  it("returns both latitude and longitude when both are present as numbers", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128, GPSLongitude: -74.0060 });
    expect(result).toEqual({ lat: 40.7128, lon: -74.0060 });
  });

  it("returns null when latitude is missing", () => {
    const result = gpsFrom({ GPSLongitude: -74.0060 });
    expect(result).toBeNull();
  });

  it("returns null when longitude is missing", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128 });
    expect(result).toBeNull();
  });

  it("returns null when both are missing", () => {
    const result = gpsFrom({});
    expect(result).toBeNull();
  });

  it("returns null when latitude is a non-numeric value", () => {
    const result = gpsFrom({ GPSLatitude: "not a number", GPSLongitude: -74.0060 });
    expect(result).toBeNull();
  });

  it("returns null when longitude is a non-numeric value", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128, GPSLongitude: "not a number" });
    expect(result).toBeNull();
  });

  it("returns null when latitude is NaN", () => {
    const result = gpsFrom({ GPSLatitude: NaN, GPSLongitude: -74.0060 });
    expect(result).toBeNull();
  });

  it("returns null when longitude is NaN", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128, GPSLongitude: NaN });
    expect(result).toBeNull();
  });

  it("handles negative values (south/west) correctly", () => {
    const result = gpsFrom({ GPSLatitude: -33.8688, GPSLongitude: 151.2093 });
    expect(result).toEqual({ lat: -33.8688, lon: 151.2093 });
  });

  it("returns null when latitude is Infinity", () => {
    const result = gpsFrom({ GPSLatitude: Infinity, GPSLongitude: -74.0060 });
    expect(result).toBeNull();
  });

  it("returns null when longitude is Infinity", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128, GPSLongitude: Infinity });
    expect(result).toBeNull();
  });

  it("returns null when latitude is null", () => {
    const result = gpsFrom({ GPSLatitude: null, GPSLongitude: -74.0060 });
    expect(result).toBeNull();
  });

  it("returns null when longitude is null", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128, GPSLongitude: null });
    expect(result).toBeNull();
  });

  it("returns null when latitude is undefined", () => {
    const result = gpsFrom({ GPSLatitude: undefined, GPSLongitude: -74.0060 });
    expect(result).toBeNull();
  });

  it("returns null when longitude is undefined", () => {
    const result = gpsFrom({ GPSLatitude: 40.7128, GPSLongitude: undefined });
    expect(result).toBeNull();
  });
});

describe("exifDateString", () => {
  it("returns a plain wire-format string as-is", () => {
    expect(exifDateString("2026:03:14 18:22:05")).toBe("2026:03:14 18:22:05");
  });

  it("extracts rawValue from an ExifDateTime-like object", () => {
    const exifDateTime = {
      rawValue: "2026:03:14 18:22:05",
      toExifString: () => "2026:03:14 18:22:05",
    };
    expect(exifDateString(exifDateTime)).toBe("2026:03:14 18:22:05");
  });

  it("calls toExifString() when rawValue is not a string", () => {
    const exifDateTime = {
      rawValue: undefined,
      toExifString: () => "2026:03:14 18:22:05",
    };
    expect(exifDateString(exifDateTime)).toBe("2026:03:14 18:22:05");
  });

  it("returns empty string for null", () => {
    expect(exifDateString(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(exifDateString(undefined)).toBe("");
  });
});

describe("readExif integration", () => {
  it("reads and extracts EXIF data from a real JPEG with correct timestamp and GPS", async () => {
    // Minimal 1x1 JPEG as base64
    const minimalJpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8VAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=",
      "base64",
    );

    const tempDir = mkdtempSync(join(tmpdir(), "photos-exif-test-"));
    const testImagePath = join(tempDir, "test.jpg");

    // Write the minimal JPEG
    writeFileSync(testImagePath, minimalJpeg);

    // Stamp it with EXIF data
    await exiftool.write(testImagePath, {
      DateTimeOriginal: "2026:03:14 18:22:05",
      OffsetTimeOriginal: "-06:00",
      GPSLatitude: -33.8688,
      GPSLongitude: 151.2093,
    });

    // Read it back using our function
    const result = await readExif(testImagePath);

    // Verify the results
    expect(result.takenAt).toBe("2026-03-14T18:22:05-06:00");
    expect(result.hasGps).toBe(true);
    expect(result.gps).toEqual({ lat: -33.8688, lon: 151.2093 });
    expect(result.frame).toBe("test");

    // Verify exactly 6 whitelisted fields in exif object
    const exifKeys = Object.keys(result.exif).sort();
    expect(exifKeys).toEqual(["aperture", "camera", "focalLength", "iso", "lens", "shutter"]);
  }, { timeout: 10000 });
});
