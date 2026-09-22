import { exiftool } from "exiftool-vendored";
import { basename } from "node:path";
import type { Photo } from "@photos/core";

export interface ExtractedExif {
  exif: Photo["exif"];
  takenAt: string;
  hasGps: boolean;
  gps: { lat: number; lon: number } | null;
  frame: string;
}

const EXIF_DATETIME = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/;

export function exifDateString(value: unknown): string {
  // Handle plain strings - return as-is (already in wire format)
  if (typeof value === "string") {
    return value;
  }

  // Handle ExifDateTime-like objects
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Prefer rawValue if it's a string (the original EXIF input)
    if (typeof obj.rawValue === "string") {
      return obj.rawValue;
    }

    // Fall back to toExifString() if it exists and is callable
    if (typeof obj.toExifString === "function") {
      const result = obj.toExifString();
      if (typeof result === "string") {
        return result;
      }
    }
  }

  // For null, undefined, or other values, return empty string
  // This allows the "unrecognised DateTimeOriginal" error to fire with useful context
  return "";
}

export function assembleTakenAt(dateTimeOriginal: string, offset: string | undefined): string {
  const m = EXIF_DATETIME.exec(dateTimeOriginal.trim());
  if (!m) throw new Error(`unrecognised DateTimeOriginal: ${dateTimeOriginal}`);
  if (!offset) {
    throw new Error(
      "this photo has no OffsetTimeOriginal tag, so its time zone is unknown. " +
        "Pass --offset ±HH:MM to supply it. Guessing would file evening photos " +
        "into the wrong month.",
    );
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}${offset}`;
}

export function gpsFrom(tags: { GPSLatitude?: unknown; GPSLongitude?: unknown }): { lat: number; lon: number } | null {
  const lat = tags.GPSLatitude;
  const lon = tags.GPSLongitude;

  // Check if both are present and are finite numbers
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !isFinite(lat) ||
    !isFinite(lon)
  ) {
    return null;
  }

  return { lat, lon };
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

export async function readExif(
  path: string,
  offsetOverride?: string,
): Promise<ExtractedExif> {
  const tags = await exiftool.read(path);
  const takenAt = assembleTakenAt(
    exifDateString(tags.DateTimeOriginal ?? tags.CreateDate),
    offsetOverride ?? (tags.OffsetTimeOriginal as string | undefined),
  );

  const focal = tags.FocalLength ? str(tags.FocalLength).replace(/\s+/g, "") : "";
  const aperture = tags.FNumber ? `f/${tags.FNumber}` : "";
  const shutter = str(tags.ExposureTime ?? tags.ShutterSpeed);

  return {
    takenAt,
    hasGps: tags.GPSLatitude !== undefined || tags.GPSLongitude !== undefined,
    gps: gpsFrom(tags),
    frame: basename(path).replace(/\.[^.]+$/, ""),
    exif: {
      camera: [str(tags.Make), str(tags.Model)].filter(Boolean).join(" ").trim(),
      lens: str(tags.LensModel ?? tags.LensID),
      focalLength: focal,
      aperture,
      shutter,
      iso: Number(tags.ISO ?? 0),
    },
  };
}

export async function closeExif(): Promise<void> {
  await exiftool.end();
}
