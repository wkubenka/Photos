import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStore } from "../src/memory-store.js";
import { uploadSite, contentTypeFor } from "../src/commands/deploy.js";

function builtSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "photos-site-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "robots.txt"), "User-agent: GPTBot\nDisallow: /\n");
  writeFileSync(join(dir, "assets", "main.abc12345.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "main.def67890.css"), "body{}");
  return dir;
}

describe("contentTypeFor", () => {
  it("maps the types the site ships", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("assets/main.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("assets/main.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("robots.txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("assets/argon2.wasm")).toBe("application/wasm");
  });
});

describe("uploadSite", () => {
  it("uploads every file with the right key", async () => {
    const store = createMemoryStore();
    const keys = await uploadSite(store, { invalidate: async () => {} }, builtSite());
    expect(keys.sort()).toEqual([
      "assets/main.abc12345.js",
      "assets/main.def67890.css",
      "index.html",
      "robots.txt",
    ]);
  });

  it("marks hashed assets immutable and index.html short-lived", async () => {
    const store = createMemoryStore();
    await uploadSite(store, { invalidate: async () => {} }, builtSite());
    expect(store.objects.get("assets/main.abc12345.js")!.cacheControl)
      .toBe("max-age=31536000, immutable");
    expect(store.objects.get("index.html")!.cacheControl).toBe("max-age=60, must-revalidate");
    expect(store.objects.get("robots.txt")!.cacheControl).toBe("max-age=60, must-revalidate");
  });

  it("invalidates index.html so a deploy is visible immediately", async () => {
    const seen: string[][] = [];
    await uploadSite(createMemoryStore(), { invalidate: async (p) => { seen.push(p); } }, builtSite());
    expect(seen[0]).toContain("/index.html");
  });
});
