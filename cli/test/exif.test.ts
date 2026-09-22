import { describe, it, expect } from "vitest";
import { assembleTakenAt, gpsFrom } from "../src/exif.js";

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
