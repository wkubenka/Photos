import sharp from "sharp";
import { createHash } from "node:crypto";

export interface Derivative {
  buffer: Buffer;
  w: number;
  h: number;
  bytes: number;
  hash: string;
}

export function contentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 8);
}

export function derivativePath(id: string, width: number, hash: string): string {
  return `web/${id}-${width}.${hash}.jpg`;
}

async function resize(input: Buffer, longEdge: number): Promise<Derivative> {
  const buffer = await sharp(input)
    .rotate() // applies EXIF orientation before metadata is discarded
    .resize({
      width: longEdge,
      height: longEdge,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .toColorspace("srgb")
    .jpeg({ quality: 82, progressive: true, chromaSubsampling: "4:2:0", mozjpeg: true })
    .toBuffer();

  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    w: meta.width ?? 0,
    h: meta.height ?? 0,
    bytes: buffer.length,
    hash: contentHash(buffer),
  };
}

export async function buildDerivatives(
  input: Buffer,
  sizes: { display: number; thumb: number },
): Promise<{ display: Derivative; thumb: Derivative; lqip: string }> {
  const display = await resize(input, sizes.display);
  const thumb = await resize(input, sizes.thumb);

  const lqipBuffer = await sharp(input)
    .rotate()
    .resize({ width: 16, fit: "inside" })
    .blur(1.5)
    .jpeg({ quality: 30 })
    .toBuffer();

  return {
    display,
    thumb,
    lqip: `data:image/jpeg;base64,${lqipBuffer.toString("base64")}`,
  };
}
