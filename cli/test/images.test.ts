// cli/test/images.test.ts
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { buildDerivatives, contentHash, derivativePath } from "../src/images.js";

const sizes = { display: 2048, thumb: 640 };

async function source(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } },
  }).jpeg().toBuffer();
}

describe("buildDerivatives", () => {
  it("resizes the long edge and preserves aspect ratio", async () => {
    const { display, thumb } = await buildDerivatives(await source(6000, 4000), sizes);
    expect(display.w).toBe(2048);
    expect(display.h).toBe(1365);
    expect(thumb.w).toBe(640);
    expect(thumb.h).toBe(427);
  });

  it("handles a portrait orientation by the long edge", async () => {
    const { display } = await buildDerivatives(await source(4000, 6000), sizes);
    expect(display.h).toBe(2048);
    expect(display.w).toBe(1365);
  });

  it("never upscales a small source", async () => {
    const { display } = await buildDerivatives(await source(800, 600), sizes);
    expect(display.w).toBe(800);
    expect(display.h).toBe(600);
  });

  it("strips all metadata from the output", async () => {
    const { display } = await buildDerivatives(await source(3000, 2000), sizes);
    const meta = await sharp(display.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });

  it("produces a small inline lqip data uri", async () => {
    const { lqip } = await buildDerivatives(await source(3000, 2000), sizes);
    expect(lqip.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(lqip.length).toBeLessThan(2000);
  });

  it("produces progressive jpegs", async () => {
    const { display } = await buildDerivatives(await source(3000, 2000), sizes);
    expect((await sharp(display.buffer).metadata()).isProgressive).toBe(true);
  });
});

describe("contentHash and derivativePath", () => {
  it("is stable and 8 hex characters", () => {
    const h = contentHash(Buffer.from("hello"));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash(Buffer.from("hello"))).toBe(h);
  });

  it("differs for different content", () => {
    expect(contentHash(Buffer.from("a"))).not.toBe(contentHash(Buffer.from("b")));
  });

  it("builds the spec path shape", () => {
    expect(derivativePath("2026-03-14-x-0031", 2048, "a1b2c3d4"))
      .toBe("web/2026-03-14-x-0031-2048.a1b2c3d4.jpg");
  });
});
