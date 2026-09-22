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

// The schema stores aperture/shutter/focal length as photographer-facing
// display strings ("f/8", "1/60", "23mm"); EXIF wants them as numbers (an
// f-number, a ratio of seconds, millimeters). These convert one way, from
// display string to the numeric value exiftool expects.
//
// Absent is not the same as unparseable: readExif (Task 11) emits "" for
// aperture/focalLength whenever the source file's camera didn't report them
// (a manual/adapted lens, incomplete EXIF), and the schema allows it (a bare
// z.string(), not .min(1), for exactly these three fields). A blank or
// whitespace-only value returns `undefined` so the caller can omit that tag
// entirely rather than write a fabricated zero or fail the whole photo.
// A *non-empty* value that still doesn't parse is a real bug — that's a
// camera field we have but can't understand — so that throws, with the
// offending value in the message, same as before.
function parseFNumber(aperture: string): number | undefined {
  const trimmed = aperture.trim();
  if (trimmed === "") return undefined;
  const m = /^f\/?\s*([\d.]+)$/i.exec(trimmed);
  if (!m) throw new Error(`cannot parse aperture as an f-number: ${JSON.stringify(aperture)}`);
  return Number(m[1]);
}

function parseFocalLengthMm(focalLength: string): number | undefined {
  const trimmed = focalLength.trim();
  if (trimmed === "") return undefined;
  const m = /^([\d.]+)\s*mm$/i.exec(trimmed);
  if (!m) throw new Error(`cannot parse focal length in mm: ${JSON.stringify(focalLength)}`);
  return Number(m[1]);
}

// exiftool's own PrintExposureTime (Exif.pm) only ever emits a fraction
// ("1/60") for exposures under ~0.25s, or a plain decimal with no unit
// ("2", "2.5", "30") otherwise — never a trailing "s" or other suffix.
// Checked directly against the vendored binary for 2, 2.5, 30, 0.5, 13 and
// 1/1000: all came back exactly as written, no unit. So a fraction or a
// bare decimal are the only two shapes readExif can hand back; no other
// format needs to be handled here.
function parseExposureSeconds(shutter: string): number | undefined {
  const trimmed = shutter.trim();
  if (trimmed === "") return undefined;
  const fraction = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(trimmed);
  if (fraction) {
    const [, num, den] = fraction;
    return Number(num) / Number(den);
  }
  const whole = Number(trimmed);
  if (Number.isFinite(whole)) return whole;
  throw new Error(`cannot parse shutter speed as a fraction or number of seconds: ${JSON.stringify(shutter)}`);
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
      // Legacy-EXIF-reader fallbacks: not part of the design doc's rights
      // list, but IPTC:CopyrightNotice/XMP-dc:Creator aren't visible to
      // tools that only read classic EXIF, so these are deliberately
      // duplicated here rather than left as an oversight.
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

      // Whitelisted camera fields (all six of ExifSchema's fields)
      "EXIF:Model": photo.exif.camera,
      "EXIF:LensModel": photo.exif.lens,
      "EXIF:ISO": photo.exif.iso,
      "EXIF:DateTimeOriginal": photo.takenAt,
    };

    // Omitted entirely (not set to `undefined`) when the source photo never
    // had the value, rather than writing a fabricated zero or an empty tag.
    const focalLength = parseFocalLengthMm(photo.exif.focalLength);
    if (focalLength !== undefined) tags["EXIF:FocalLength"] = focalLength;

    const fNumber = parseFNumber(photo.exif.aperture);
    if (fNumber !== undefined) tags["EXIF:FNumber"] = fNumber;

    const exposureTime = parseExposureSeconds(photo.exif.shutter);
    if (exposureTime !== undefined) tags["EXIF:ExposureTime"] = exposureTime;

    if (opts.gps) {
      tags["EXIF:GPSLatitude"] = opts.gps.lat;
      tags["EXIF:GPSLongitude"] = opts.gps.lon;
      tags["EXIF:GPSLatitudeRef"] = opts.gps.lat >= 0 ? "N" : "S";
      tags["EXIF:GPSLongitudeRef"] = opts.gps.lon >= 0 ? "E" : "W";
    }

    // exiftool-vendored does not throw on a rejected tag (a typo'd group, an
    // unwritable name, a value it won't coerce) — it resolves normally and
    // reports the problem as a string in `result.warnings`. That's exactly
    // the silent-drop failure mode this module exists to prevent, so any
    // warning here is treated as fatal rather than merely logged.
    const result = await writer.write(path, tags, {
      writeArgs: ["-overwrite_original"],
    });
    if (result.warnings && result.warnings.length > 0) {
      throw new Error(`exiftool warned while writing rights metadata: ${result.warnings.join("; ")}`);
    }
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
