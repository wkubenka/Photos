import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, CACHE_IMMUTABLE, CACHE_SHORT } from "../src/config.js";

const valid = {
  bucket: "photos.example.com",
  region: "us-east-1",
  profile: "photos",
  distributionId: "E1234567890ABC",
  siteUrl: "https://photos.example.com",
  creator: "William Kubenka",
  copyright: "© 2026 William Kubenka. All rights reserved.",
  usageTerms: "No reproduction without written permission.",
  sizes: { display: 2048, thumb: 640 },
};

function writeConfig(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "photos-config-"));
  const path = join(dir, "photos.config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("loadConfig", () => {
  it("loads a valid config", () => {
    expect(loadConfig(writeConfig(valid)).bucket).toBe("photos.example.com");
  });

  it("names the missing field when one is absent", () => {
    const { bucket, ...rest } = valid;
    expect(() => loadConfig(writeConfig(rest))).toThrow(/bucket/);
  });

  it("rejects a siteUrl that is not https", () => {
    expect(() => loadConfig(writeConfig({ ...valid, siteUrl: "http://example.com" })))
      .toThrow(/https/);
  });

  it("rejects a thumb larger than the display size", () => {
    expect(() => loadConfig(writeConfig({ ...valid, sizes: { display: 640, thumb: 2048 } })))
      .toThrow(/thumb/);
  });

  it("reports a clear error when the file is missing", () => {
    expect(() => loadConfig("/nope/photos.config.json")).toThrow(/not found/i);
  });

  it("exposes the spec cache headers", () => {
    expect(CACHE_IMMUTABLE).toBe("max-age=31536000, immutable");
    expect(CACHE_SHORT).toBe("max-age=60, must-revalidate");
  });
});
