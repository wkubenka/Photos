import { ExifTool, DefaultExiftoolArgs } from "exiftool-vendored";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { Photo } from "@photos/core";

const DIGITAL_CAPTURE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";

// Resolves cli/exiftool.config relative to this module (not the process cwd),
// so the CLI works no matter where it's invoked from. fileURLToPath is used
// instead of the URL's .pathname because .pathname is not reliably decoded
// on all platforms (e.g. Windows drive letters, percent-encoded spaces).
const CONFIG_PATH = fileURLToPath(new URL("../exiftool.config", import.meta.url));

// XMP-xmp:Robots and XMP-tdm:Reservation are user-defined tags (see
// exiftool.config). exiftool requires "-config FILE" to be the very first
// argument it sees. exiftool-vendored's default `exiftool` singleton is a
// long-running "-stay_open" process that has already started without it, and
// passing -config later as part of a per-write `writeArgs` batch is silently
// rejected ("Ignored -config option (not first on command line)") because,
// from exiftool's point of view, that's not the start of the command line
// any more. So this module runs its own dedicated exiftool process, started
// with -config baked into its launch arguments.
const writer = new ExifTool({
  exiftoolArgs: ["-config", CONFIG_PATH, ...DefaultExiftoolArgs],
});

/** Shuts down the dedicated exiftool process this module starts for writes. */
export async function closeRightsWriter(): Promise<void> {
  await writer.end();
}

export interface RightsInput {
  title: string;
  caption: string;
  takenAt: string;
  exif: Photo["exif"];
}

/**
 * Re-injects the whitelist onto a metadata-free derivative.
 *
 * sharp has already discarded everything, so whatever is written here is
 * exactly what ships. GPS is absent unless a caller passes it explicitly.
 */
export async function writeRights(
  jpeg: Buffer,
  photo: RightsInput,
  config: Config,
  opts: { gps?: { lat: number; lon: number } } = {},
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "photos-rights-"));
  const path = join(dir, "image.jpg");
  try {
    await writeFile(path, jpeg);

    const tags: Record<string, unknown> = {
      // Rights
      "XMP-dc:Creator": config.creator,
      "XMP-dc:Rights": config.copyright,
      "IPTC:CopyrightNotice": config.copyright,
      "XMP-xmpRights:UsageTerms": config.usageTerms,
      "XMP-xmpRights:WebStatement": config.siteUrl,
      "XMP-xmpRights:Marked": "True",
      "XMP-photoshop:Credit": config.creator,
      "EXIF:Copyright": config.copyright,
      "EXIF:Artist": config.creator,

      // Opt-out signals
      "XMP-xmp:Robots": "noai, noimageai",
      "XMP-iptcExt:DigitalSourceType": DIGITAL_CAPTURE,
      "XMP-tdm:Reservation": 1,

      // Description
      "XMP-dc:Title": photo.title,
      "XMP-dc:Description": photo.caption,
      "IPTC:Caption-Abstract": photo.caption,

      // Whitelisted camera fields
      "EXIF:Model": photo.exif.camera,
      "EXIF:LensModel": photo.exif.lens,
      "EXIF:ISO": photo.exif.iso,
      "EXIF:DateTimeOriginal": photo.takenAt,
    };

    if (opts.gps) {
      tags["EXIF:GPSLatitude"] = opts.gps.lat;
      tags["EXIF:GPSLongitude"] = opts.gps.lon;
      tags["EXIF:GPSLatitudeRef"] = opts.gps.lat >= 0 ? "N" : "S";
      tags["EXIF:GPSLongitudeRef"] = opts.gps.lon >= 0 ? "E" : "W";
    }

    await writer.write(path, tags, {
      writeArgs: ["-overwrite_original"],
    });
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
