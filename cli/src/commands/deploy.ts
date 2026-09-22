import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CACHE_IMMUTABLE, CACHE_SHORT } from "../config.js";
import type { Cdn, Store } from "../store.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot)] ?? "application/octet-stream";
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

export async function uploadSite(store: Store, cdn: Cdn, dir: string): Promise<string[]> {
  const files = await walk(dir);
  for (const key of files) {
    const body = await readFile(join(dir, ...key.split("/")));
    // Vite hashes everything under assets/, so only those are safe to pin for a year.
    const cacheControl = key.startsWith("assets/") ? CACHE_IMMUTABLE : CACHE_SHORT;
    await store.put(key, new Uint8Array(body), contentTypeFor(key), cacheControl);
  }
  await cdn.invalidate(["/index.html", "/robots.txt"]);
  return files;
}
