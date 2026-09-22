# Photo Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static photography site on S3 and CloudFront where web-sized photos are public, full-resolution originals are stored as client-side-encrypted ciphertext unlocked by a shared password, and a Node CLI ingests, resizes, stamps, encrypts, and publishes everything.

**Architecture:** Three npm workspaces. `core/` holds the encryption container format, key wrapping, and schema validation, written against the WebCrypto API so the identical source runs in Node and the browser — this is what prevents the writer and reader from ever disagreeing about the format. `cli/` composes `core/` with sharp, exiftool, and the S3 SDK; S3 is the only source of truth and there is no persistent local state. `site/` is a Vite-built vanilla TypeScript app that reads a month-sharded JSON manifest and decrypts originals in a Web Worker.

**Tech Stack:** Node 20+, TypeScript 5, vitest, sharp, exiftool-vendored, hash-wasm (Argon2id), zod, @aws-sdk/client-s3, @aws-sdk/client-cloudfront, Vite 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-photo-gallery-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Node 20 or later.** `core/` must import only from the WebCrypto API at `globalThis.crypto.subtle`. It must never import `node:crypto`, `node:fs`, `node:buffer`, or any other Node built-in. This is what makes a Node round-trip test a real test of the browser path.
- **Cipher:** AES-256-GCM, 16-byte authentication tags, 12-byte nonces.
- **KDF:** Argon2id, `m=65536` (KiB, i.e. 64 MiB), `t=3`, `p=1`, `keyLen=32`, 16-byte random salt.
- **Container:** magic `PHOTOENC` (8 ASCII bytes), format version `1`, cipher id `1` (AES-256-GCM), chunk size `4194304`, 22-byte header, 4-byte random per-file nonce prefix.
- **Nonce:** 4-byte file nonce prefix followed by the chunk index as uint64 big-endian.
- **AAD:** the 22 header bytes, then the photo id as UTF-8, then the chunk index as uint32 big-endian, then one byte: `1` for the final chunk, `0` otherwise.
- **`chunkCount` of 0 is invalid** and must be rejected on read.
- **Verifier plaintext:** the exact ASCII string `photo-gallery-verifier-v1`.
- **Key wrapping AAD:** the photo id as UTF-8, so a wrapped key cannot be moved between entries.
- **A photo's month is its local capture date**, taken from the offset in `takenAt`, never from UTC.
- **Derivative sizes:** 2048px and 640px on the long edge, mozjpeg quality 82, progressive, 4:2:0, sRGB, no upscaling.
- **Metadata is stripped entirely, then re-injected deliberately.** Never selectively removed.
- **GPS is removed** unless `--keep-gps` is passed for that file.
- **No view framework** in `site/`. Vanilla TypeScript only.
- **Immutable cache headers** (`max-age=31536000, immutable`) for `assets/*`, `web/*`, `orig/*`. Short headers (`max-age=60, must-revalidate`) for `data/*.json` and `index.html`.
- **No local persistent state in the CLI.** Scratch work goes under `os.tmpdir()` and is removed on exit.

---

## File Structure

```
package.json                    npm workspaces root, shared scripts
tsconfig.base.json              strict TypeScript settings shared by all workspaces
photos.config.json              deployment + rights configuration (committed)
.gitignore

core/src/bytes.ts               base64/utf8/concat/compare helpers, no I/O
core/src/months.ts              local-month derivation, slugs, photo ids
core/src/kdf.ts                 Argon2id parameters and master-key derivation
core/src/wrap.ts                data-key generation, wrapping, verifier
core/src/container.ts           header codec, nonce/AAD construction, encrypt/decrypt
core/src/stream.ts              incremental decryptor for the browser worker
core/src/schema.ts              zod schemas and types for all four JSON files
core/src/index.ts               public re-exports

cli/src/config.ts               load and validate photos.config.json
cli/src/store.ts                Store interface, S3 implementation, CDN invalidation
cli/src/memory-store.ts         in-memory Store used by tests
cli/src/exif.ts                 EXIF extraction, takenAt assembly, GPS detection
cli/src/images.ts               sharp derivatives and LQIP, content hashing
cli/src/rights.ts               exiftool metadata re-injection
cli/src/manifest.ts             read/modify/write the four JSON files in commit order
cli/src/commands/*.ts           one file per command
cli/src/bin.ts                  argument parsing and command dispatch

site/index.html                 single page, CSP meta, noscript
site/src/urlstate.ts            read/write ?m= and ?photo= without reloads
site/src/library.ts             index/month/featured fetching and caching
site/src/gallery.ts             grid, month rail, home page
site/src/lightbox.ts            detail view, keyboard and swipe, focus management
site/src/unlock.ts              unlock state machine and unlocked UI
site/src/worker.ts              Argon2id derivation and chunk decryption
site/src/styles.css

infra/README.md                 one-time AWS setup runbook
infra/bootstrap.sh              scripted bucket/CloudFront/IAM creation
e2e/gallery.spec.ts             Playwright end-to-end pass
```

---

## Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `core/package.json`, `core/tsconfig.json`, `core/src/index.ts`
- Test: `core/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an `npm test` script that runs vitest across workspaces; the `@photos/core` package name that `cli/` and `site/` import.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/smoke.test.ts
import { describe, it, expect } from "vitest";
import { CHUNK_SIZE } from "../src/index.js";

describe("core", () => {
  it("exposes the spec chunk size", () => {
    expect(CHUNK_SIZE).toBe(4194304);
  });

  it("has WebCrypto available", () => {
    expect(globalThis.crypto.subtle).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the script does not exist yet, then once created, `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Create the workspace files**

```json
// package.json
{
  "name": "photos",
  "private": true,
  "type": "module",
  "workspaces": ["core", "cli", "site"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "composite": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

```json
// core/package.json
{
  "name": "@photos/core",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

```json
// core/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"]
}
```

```ts
// core/src/index.ts
export const CHUNK_SIZE = 4194304;
```

```
# .gitignore
node_modules/
dist/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 4: Install and run the tests**

Run: `npm install && npm test`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .gitignore core/
git commit -m "chore: scaffold npm workspaces with core package and vitest"
```

---

## Task 2: Byte helpers and month derivation

**Files:**
- Create: `core/src/bytes.ts`, `core/src/months.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/bytes.test.ts`, `core/test/months.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toBase64(b: Uint8Array): string`, `fromBase64(s: string): Uint8Array`
  - `utf8(s: string): Uint8Array`, `concat(...parts: Uint8Array[]): Uint8Array`
  - `u32be(n: number): Uint8Array`, `u64be(n: number): Uint8Array`
  - `monthOf(takenAt: string): string` returning `"YYYY-MM"`
  - `localDateOf(takenAt: string): string` returning `"YYYY-MM-DD"`
  - `slugify(s: string): string`
  - `makePhotoId(takenAt: string, title: string, frame: string): string`

- [ ] **Step 1: Write the failing tests**

The month cases are the reason this task exists. A photo shot in the evening at a negative UTC offset must not file into the following month.

```ts
// core/test/months.test.ts
import { describe, it, expect } from "vitest";
import { monthOf, slugify, makePhotoId } from "../src/months.js";

describe("monthOf", () => {
  it("uses the local date, not UTC, at a negative offset", () => {
    // 2026-04-01T01:22:05Z in UTC, but still March where it was shot.
    expect(monthOf("2026-03-31T19:22:05-06:00")).toBe("2026-03");
  });

  it("uses the local date, not UTC, at a positive offset", () => {
    // 2026-03-31T22:00:00Z in UTC, but already April where it was shot.
    expect(monthOf("2026-04-01T01:00:00+03:00")).toBe("2026-04");
  });

  it("accepts a Z offset", () => {
    expect(monthOf("2026-07-04T12:00:00Z")).toBe("2026-07");
  });

  it("rejects a timestamp with no offset", () => {
    expect(() => monthOf("2026-03-14T18:22:05")).toThrow(/offset/);
  });
});

describe("slugify", () => {
  it("lowercases, strips punctuation, and joins with hyphens", () => {
    expect(slugify("Santa Elena at Dusk!")).toBe("santa-elena-at-dusk");
  });

  it("collapses runs and trims hyphens", () => {
    expect(slugify("  --A   B--  ")).toBe("a-b");
  });
});

describe("makePhotoId", () => {
  it("combines local date, title slug, and frame number", () => {
    expect(makePhotoId("2026-03-14T18:22:05-06:00", "Santa Elena at dusk", "0031"))
      .toBe("2026-03-14-santa-elena-at-dusk-0031");
  });

  it("truncates a very long title to keep ids manageable", () => {
    const id = makePhotoId("2026-03-14T18:22:05-06:00", "x".repeat(200), "1");
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id.endsWith("-1")).toBe(true);
  });
});
```

```ts
// core/test/bytes.test.ts
import { describe, it, expect } from "vitest";
import { toBase64, fromBase64, utf8, concat, u32be, u64be } from "../src/bytes.js";

describe("bytes", () => {
  it("round-trips base64", () => {
    const b = new Uint8Array([0, 1, 250, 255, 128]);
    expect(fromBase64(toBase64(b))).toEqual(b);
  });

  it("encodes utf8", () => {
    expect(utf8("hi")).toEqual(new Uint8Array([104, 105]));
  });

  it("concatenates", () => {
    expect(concat(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("writes big-endian integers", () => {
    expect(u32be(4194304)).toEqual(new Uint8Array([0, 64, 0, 0]));
    expect(u64be(1)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/bytes.js'`.

- [ ] **Step 3: Write the implementations**

`monthOf` deliberately reads the literal date prefix rather than constructing a `Date`. An ISO timestamp with an offset already expresses local time, so its first seven characters *are* the local month. Parsing it into a `Date` would normalize to UTC and reintroduce the bug.

```ts
// core/src/bytes.ts
const B64 = typeof globalThis.btoa === "function";

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  if (B64) return globalThis.btoa(s);
  throw new Error("no base64 encoder available");
}

export function fromBase64(s: string): Uint8Array {
  const bin = globalThis.atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
```

```ts
// core/src/months.ts
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The month a photo belongs to, from its LOCAL capture date.
 *
 * An ISO timestamp carrying an offset already expresses local time, so the
 * literal date prefix is the local date. Constructing a Date here would
 * normalize to UTC and file evening photos into the following month.
 */
export function monthOf(takenAt: string): string {
  const m = ISO_WITH_OFFSET.exec(takenAt);
  if (!m) throw new Error(`takenAt must be ISO 8601 with a UTC offset: ${takenAt}`);
  return `${m[1]}-${m[2]}`;
}

export function localDateOf(takenAt: string): string {
  const m = ISO_WITH_OFFSET.exec(takenAt);
  if (!m) throw new Error(`takenAt must be ISO 8601 with a UTC offset: ${takenAt}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const MAX_TITLE_SLUG = 60;

export function makePhotoId(takenAt: string, title: string, frame: string): string {
  const date = localDateOf(takenAt);
  const slug = slugify(title).slice(0, MAX_TITLE_SLUG).replace(/-+$/, "");
  const frameSlug = slugify(frame);
  return [date, slug, frameSlug].filter(Boolean).join("-");
}
```

```ts
// core/src/index.ts
export const CHUNK_SIZE = 4194304;
export * from "./bytes.js";
export * from "./months.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all bytes and months tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/bytes.ts core/src/months.ts core/src/index.ts core/test/
git commit -m "feat(core): add byte helpers and local-date month derivation"
```

---

## Task 3: Argon2id key derivation

**Files:**
- Create: `core/src/kdf.ts`
- Modify: `core/package.json`, `core/src/index.ts`
- Test: `core/test/kdf.test.ts`

**Interfaces:**
- Consumes: `toBase64`, `fromBase64` from Task 2.
- Produces:
  - `type KdfParams = { alg: "argon2id"; salt: string; m: number; t: number; p: number; keyLen: number }`
  - `newKdfParams(overrides?: Partial<Omit<KdfParams, "alg" | "salt">>): KdfParams`
  - `deriveMasterKey(password: string, params: KdfParams): Promise<Uint8Array>`
  - `DEFAULT_KDF: { m: 65536; t: 3; p: 1; keyLen: 32 }`

Later tasks that need a master key in a test must call `newKdfParams({ m: 512, t: 1 })` so the suite stays fast. Only the defaults test asserts the production parameters.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/kdf.test.ts
import { describe, it, expect } from "vitest";
import { newKdfParams, deriveMasterKey, DEFAULT_KDF } from "../src/kdf.js";

describe("kdf", () => {
  it("defaults to the spec parameters", () => {
    expect(DEFAULT_KDF).toEqual({ m: 65536, t: 3, p: 1, keyLen: 32 });
    const p = newKdfParams();
    expect(p.alg).toBe("argon2id");
    expect(p.m).toBe(65536);
  });

  it("generates a fresh 16-byte salt each time", () => {
    const a = newKdfParams();
    const b = newKdfParams();
    expect(a.salt).not.toBe(b.salt);
  });

  it("derives a 32-byte key deterministically", async () => {
    const params = newKdfParams({ m: 512, t: 1 });
    const one = await deriveMasterKey("correct horse battery staple", params);
    const two = await deriveMasterKey("correct horse battery staple", params);
    expect(one.length).toBe(32);
    expect(one).toEqual(two);
  });

  it("derives different keys for different passwords", async () => {
    const params = newKdfParams({ m: 512, t: 1 });
    const one = await deriveMasterKey("password one", params);
    const two = await deriveMasterKey("password two", params);
    expect(one).not.toEqual(two);
  });

  it("derives different keys for different salts", async () => {
    const a = await deriveMasterKey("same password", newKdfParams({ m: 512, t: 1 }));
    const b = await deriveMasterKey("same password", newKdfParams({ m: 512, t: 1 }));
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test core/test/kdf.test.ts`
Expected: FAIL — `Cannot find module '../src/kdf.js'`.

- [ ] **Step 3: Add hash-wasm and implement**

Run: `npm install hash-wasm@^4.11.0 --workspace core`

```ts
// core/src/kdf.ts
import { argon2id } from "hash-wasm";
import { fromBase64, toBase64 } from "./bytes.js";

export const DEFAULT_KDF = { m: 65536, t: 3, p: 1, keyLen: 32 } as const;

export interface KdfParams {
  alg: "argon2id";
  salt: string;
  m: number;
  t: number;
  p: number;
  keyLen: number;
}

export function newKdfParams(
  overrides: Partial<Omit<KdfParams, "alg" | "salt">> = {},
): KdfParams {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  return { alg: "argon2id", salt: toBase64(salt), ...DEFAULT_KDF, ...overrides };
}

export async function deriveMasterKey(
  password: string,
  params: KdfParams,
): Promise<Uint8Array> {
  if (params.alg !== "argon2id") throw new Error(`unsupported kdf: ${params.alg}`);
  return argon2id({
    password,
    salt: fromBase64(params.salt),
    memorySize: params.m,
    iterations: params.t,
    parallelism: params.p,
    hashLength: params.keyLen,
    outputType: "binary",
  });
}
```

```ts
// core/src/index.ts — append
export * from "./kdf.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test core/test/kdf.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add core/src/kdf.ts core/src/index.ts core/test/kdf.test.ts core/package.json package-lock.json
git commit -m "feat(core): derive master keys with Argon2id"
```

---

## Task 4: Data-key wrapping and the verifier

**Files:**
- Create: `core/src/wrap.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/wrap.test.ts`

**Interfaces:**
- Consumes: `toBase64`, `fromBase64`, `utf8` (Task 2); `deriveMasterKey`, `newKdfParams` (Task 3).
- Produces:
  - `type Wrapped = { iv: string; ct: string }`
  - `newDataKey(): Uint8Array` — 32 random bytes
  - `wrapDataKey(master: Uint8Array, dataKey: Uint8Array, photoId: string): Promise<Wrapped>`
  - `unwrapDataKey(master: Uint8Array, wrapped: Wrapped, photoId: string): Promise<Uint8Array>`
  - `makeVerifier(master: Uint8Array): Promise<Wrapped>`
  - `checkVerifier(master: Uint8Array, v: Wrapped): Promise<boolean>`
  - `VERIFIER_PLAINTEXT = "photo-gallery-verifier-v1"`

- [ ] **Step 1: Write the failing test**

The binding test is the important one: a wrapped key must be unusable under a different photo id, or keys could be shuffled between entries.

```ts
// core/test/wrap.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { deriveMasterKey, newKdfParams } from "../src/kdf.js";
import {
  newDataKey, wrapDataKey, unwrapDataKey,
  makeVerifier, checkVerifier, VERIFIER_PLAINTEXT,
} from "../src/wrap.js";

let master: Uint8Array;
let other: Uint8Array;

beforeAll(async () => {
  const fast = newKdfParams({ m: 512, t: 1 });
  master = await deriveMasterKey("the right password", fast);
  other = await deriveMasterKey("the wrong password", fast);
});

describe("data keys", () => {
  it("generates 32 random bytes", () => {
    const a = newDataKey();
    expect(a.length).toBe(32);
    expect(newDataKey()).not.toEqual(a);
  });

  it("round-trips a wrapped key", async () => {
    const dk = newDataKey();
    const wrapped = await wrapDataKey(master, dk, "2026-03-14-photo-0031");
    expect(await unwrapDataKey(master, wrapped, "2026-03-14-photo-0031")).toEqual(dk);
  });

  it("refuses to unwrap under a different photo id", async () => {
    const wrapped = await wrapDataKey(master, newDataKey(), "photo-a");
    await expect(unwrapDataKey(master, wrapped, "photo-b")).rejects.toThrow();
  });

  it("refuses to unwrap under a different master key", async () => {
    const wrapped = await wrapDataKey(master, newDataKey(), "photo-a");
    await expect(unwrapDataKey(other, wrapped, "photo-a")).rejects.toThrow();
  });

  it("uses a fresh iv per wrap", async () => {
    const dk = newDataKey();
    const a = await wrapDataKey(master, dk, "photo-a");
    const b = await wrapDataKey(master, dk, "photo-a");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("verifier", () => {
  it("uses the exact spec plaintext", () => {
    expect(VERIFIER_PLAINTEXT).toBe("photo-gallery-verifier-v1");
  });

  it("accepts the correct master key", async () => {
    expect(await checkVerifier(master, await makeVerifier(master))).toBe(true);
  });

  it("rejects the wrong master key without throwing", async () => {
    expect(await checkVerifier(other, await makeVerifier(master))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test core/test/wrap.test.ts`
Expected: FAIL — `Cannot find module '../src/wrap.js'`.

- [ ] **Step 3: Implement**

```ts
// core/src/wrap.ts
import { fromBase64, toBase64, utf8 } from "./bytes.js";

export const VERIFIER_PLAINTEXT = "photo-gallery-verifier-v1";

export interface Wrapped {
  iv: string;
  ct: string;
}

async function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
}

function newIv(): Uint8Array {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  return iv;
}

export function newDataKey(): Uint8Array {
  const k = new Uint8Array(32);
  globalThis.crypto.getRandomValues(k);
  return k;
}

async function seal(master: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Wrapped> {
  const iv = newIv();
  const key = await aesKey(master, ["encrypt"]);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plaintext,
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

async function open(master: Uint8Array, wrapped: Wrapped, aad: Uint8Array): Promise<Uint8Array> {
  const key = await aesKey(master, ["decrypt"]);
  const out = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapped.iv), additionalData: aad, tagLength: 128 },
    key, fromBase64(wrapped.ct),
  );
  return new Uint8Array(out);
}

export function wrapDataKey(master: Uint8Array, dataKey: Uint8Array, photoId: string) {
  return seal(master, dataKey, utf8(photoId));
}

export function unwrapDataKey(master: Uint8Array, wrapped: Wrapped, photoId: string) {
  return open(master, wrapped, utf8(photoId));
}

export function makeVerifier(master: Uint8Array): Promise<Wrapped> {
  return seal(master, utf8(VERIFIER_PLAINTEXT), new Uint8Array(0));
}

export async function checkVerifier(master: Uint8Array, v: Wrapped): Promise<boolean> {
  try {
    const out = await open(master, v, new Uint8Array(0));
    return new TextDecoder().decode(out) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}
```

```ts
// core/src/index.ts — append
export * from "./wrap.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test core/test/wrap.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add core/src/wrap.ts core/src/index.ts core/test/wrap.test.ts
git commit -m "feat(core): wrap per-photo data keys and add a password verifier"
```

---

## Task 5: Container header codec

**Files:**
- Create: `core/src/container.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/header.test.ts`

**Interfaces:**
- Consumes: `concat`, `u32be`, `u64be`, `utf8`, `equal` (Task 2).
- Produces:
  - `HEADER_BYTES = 22`, `MAGIC = "PHOTOENC"`, `FORMAT_VERSION = 1`, `CIPHER_AES_256_GCM = 1`
  - `type Header = { version: number; cipherId: number; chunkSize: number; chunkCount: number; noncePrefix: Uint8Array }`
  - `encodeHeader(h: Header): Uint8Array`
  - `decodeHeader(buf: Uint8Array): Header`
  - `chunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array`
  - `chunkAad(headerBytes: Uint8Array, photoId: string, index: number, isFinal: boolean): Uint8Array`

- [ ] **Step 1: Write the failing test**

```ts
// core/test/header.test.ts
import { describe, it, expect } from "vitest";
import {
  HEADER_BYTES, encodeHeader, decodeHeader, chunkNonce, chunkAad,
} from "../src/container.js";
import { utf8, concat, u32be } from "../src/bytes.js";

const header = {
  version: 1,
  cipherId: 1,
  chunkSize: 4194304,
  chunkCount: 10,
  noncePrefix: new Uint8Array([9, 8, 7, 6]),
};

describe("header codec", () => {
  it("is exactly 22 bytes", () => {
    expect(HEADER_BYTES).toBe(22);
    expect(encodeHeader(header).length).toBe(22);
  });

  it("starts with the PHOTOENC magic", () => {
    expect(encodeHeader(header).slice(0, 8)).toEqual(utf8("PHOTOENC"));
  });

  it("round-trips", () => {
    expect(decodeHeader(encodeHeader(header))).toEqual(header);
  });

  it("rejects a bad magic", () => {
    const bad = encodeHeader(header);
    bad[0] = 0x58;
    expect(() => decodeHeader(bad)).toThrow(/magic/i);
  });

  it("rejects an unknown version", () => {
    const bad = encodeHeader({ ...header, version: 2 });
    expect(() => decodeHeader(bad)).toThrow(/version/i);
  });

  it("rejects a chunk count of zero", () => {
    const bad = encodeHeader({ ...header, chunkCount: 0 });
    expect(() => decodeHeader(bad)).toThrow(/chunk count/i);
  });

  it("rejects a truncated buffer", () => {
    expect(() => decodeHeader(encodeHeader(header).slice(0, 21))).toThrow(/too short/i);
  });
});

describe("nonce and aad", () => {
  it("builds a 12-byte nonce from prefix and big-endian index", () => {
    const n = chunkNonce(new Uint8Array([1, 2, 3, 4]), 1);
    expect(n.length).toBe(12);
    expect(n).toEqual(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 1]));
  });

  it("binds header, photo id, index, and the final flag", () => {
    const h = encodeHeader(header);
    expect(chunkAad(h, "photo-a", 3, true))
      .toEqual(concat(h, utf8("photo-a"), u32be(3), new Uint8Array([1])));
    expect(chunkAad(h, "photo-a", 3, false))
      .toEqual(concat(h, utf8("photo-a"), u32be(3), new Uint8Array([0])));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test core/test/header.test.ts`
Expected: FAIL — `Cannot find module '../src/container.js'`.

- [ ] **Step 3: Implement the codec**

```ts
// core/src/container.ts
import { concat, equal, u32be, u64be, utf8 } from "./bytes.js";

export const MAGIC = utf8("PHOTOENC");
export const HEADER_BYTES = 22;
export const FORMAT_VERSION = 1;
export const CIPHER_AES_256_GCM = 1;
export const CHUNK_SIZE = 4194304;
export const TAG_BYTES = 16;

export interface Header {
  version: number;
  cipherId: number;
  chunkSize: number;
  chunkCount: number;
  noncePrefix: Uint8Array;
}

export function encodeHeader(h: Header): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out[8] = h.version;
  out[9] = h.cipherId;
  out.set(u32be(h.chunkSize), 10);
  out.set(u32be(h.chunkCount), 14);
  out.set(h.noncePrefix, 18);
  return out;
}

export function decodeHeader(buf: Uint8Array): Header {
  if (buf.length < HEADER_BYTES) throw new Error("container too short for a header");
  if (!equal(buf.slice(0, 8), MAGIC)) throw new Error("bad magic: not a PHOTOENC container");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = buf[8]!;
  const cipherId = buf[9]!;
  if (version !== FORMAT_VERSION) throw new Error(`unsupported format version ${version}`);
  if (cipherId !== CIPHER_AES_256_GCM) throw new Error(`unsupported cipher id ${cipherId}`);
  const chunkSize = view.getUint32(10, false);
  const chunkCount = view.getUint32(14, false);
  if (chunkSize === 0) throw new Error("invalid chunk size of zero");
  if (chunkCount === 0) throw new Error("invalid chunk count of zero");
  return { version, cipherId, chunkSize, chunkCount, noncePrefix: buf.slice(18, 22) };
}

export function chunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array {
  return concat(noncePrefix, u64be(index));
}

export function chunkAad(
  headerBytes: Uint8Array,
  photoId: string,
  index: number,
  isFinal: boolean,
): Uint8Array {
  return concat(headerBytes, utf8(photoId), u32be(index), new Uint8Array([isFinal ? 1 : 0]));
}
```

```ts
// core/src/index.ts — replace the CHUNK_SIZE line with the re-export
export * from "./container.js";
```

Remove the standalone `export const CHUNK_SIZE = 4194304;` from `core/src/index.ts`; it now comes from `container.ts`. The Task 1 smoke test still passes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, including the Task 1 smoke test.

- [ ] **Step 5: Commit**

```bash
git add core/src/container.ts core/src/index.ts core/test/header.test.ts
git commit -m "feat(core): encode and decode the PHOTOENC container header"
```

---

## Task 6: Encrypt and decrypt originals

**Files:**
- Modify: `core/src/container.ts`
- Test: `core/test/container.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces:
  - `encryptOriginal(plaintext: Uint8Array, dataKey: Uint8Array, photoId: string, opts?: { chunkSize?: number }): Promise<Uint8Array>`
  - `decryptOriginal(container: Uint8Array, dataKey: Uint8Array, photoId: string, onProgress?: (done: number, total: number) => void): Promise<Uint8Array>`
  - `chunkCountFor(byteLength: number, chunkSize: number): number`

This is the highest-value test file in the project. Every negative case below is a real attack or a real corruption mode, and each must fail closed rather than return plausible data.

- [ ] **Step 1: Write the failing tests**

```ts
// core/test/container.test.ts
import { describe, it, expect } from "vitest";
import {
  encryptOriginal, decryptOriginal, decodeHeader, chunkCountFor,
  HEADER_BYTES, TAG_BYTES,
} from "../src/container.js";
import { newDataKey } from "../src/wrap.js";

const ID = "2026-03-14-santa-elena-0031";
const SMALL = 64; // a tiny chunk size keeps these tests fast

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

describe("chunkCountFor", () => {
  it("counts partial and exact chunks", () => {
    expect(chunkCountFor(1, 64)).toBe(1);
    expect(chunkCountFor(64, 64)).toBe(1);
    expect(chunkCountFor(65, 64)).toBe(2);
    expect(chunkCountFor(128, 64)).toBe(2);
  });
});

describe("round trip", () => {
  for (const size of [1, 63, 64, 65, 200, 4096]) {
    it(`round-trips ${size} bytes`, async () => {
      const key = newDataKey();
      const plain = bytes(size);
      const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
      expect(await decryptOriginal(enc, key, ID)).toEqual(plain);
    });
  }

  it("produces the expected container length", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    // 4 chunks: 64 + 64 + 64 + 8 plaintext, each with a 16-byte tag
    expect(enc.length).toBe(HEADER_BYTES + 200 + 4 * TAG_BYTES);
    expect(decodeHeader(enc).chunkCount).toBe(4);
  });

  it("reports progress once per chunk", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const seen: number[] = [];
    await decryptOriginal(enc, key, ID, (done) => seen.push(done));
    expect(seen).toEqual([64, 128, 192, 200]);
  });

  it("uses a different nonce prefix per file", async () => {
    const key = newDataKey();
    const a = await encryptOriginal(bytes(10), key, ID, { chunkSize: SMALL });
    const b = await encryptOriginal(bytes(10), key, ID, { chunkSize: SMALL });
    expect(a.slice(18, 22)).not.toEqual(b.slice(18, 22));
  });

  it("refuses to encrypt an empty file", async () => {
    await expect(encryptOriginal(new Uint8Array(0), newDataKey(), ID)).rejects.toThrow(/empty/i);
  });
});

describe("fails closed", () => {
  async function container(size = 200) {
    const key = newDataKey();
    return { key, enc: await encryptOriginal(bytes(size), key, ID, { chunkSize: SMALL }) };
  }

  it("rejects a flipped ciphertext byte", async () => {
    const { key, enc } = await container();
    enc[HEADER_BYTES + 5] ^= 0x01;
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow();
  });

  it("rejects a flipped authentication tag byte", async () => {
    const { key, enc } = await container();
    enc[HEADER_BYTES + SMALL + 2] ^= 0x01;
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow();
  });

  it("rejects a tampered header, because the header is authenticated", async () => {
    const { key, enc } = await container();
    enc[21] ^= 0x01; // last byte of the nonce prefix
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow();
  });

  it("rejects truncation of the final chunk", async () => {
    const { key, enc } = await container();
    const truncated = enc.slice(0, enc.length - (8 + TAG_BYTES));
    await expect(decryptOriginal(truncated, key, ID)).rejects.toThrow();
  });

  it("rejects a wrong photo id", async () => {
    const { key, enc } = await container();
    await expect(decryptOriginal(enc, key, "some-other-photo")).rejects.toThrow();
  });

  it("rejects a wrong data key", async () => {
    const { enc } = await container();
    await expect(decryptOriginal(enc, newDataKey(), ID)).rejects.toThrow();
  });

  it("rejects a chunk spliced from another file", async () => {
    const key = newDataKey();
    const a = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const b = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const spliced = new Uint8Array(a);
    spliced.set(b.slice(HEADER_BYTES, HEADER_BYTES + SMALL + TAG_BYTES), HEADER_BYTES);
    await expect(decryptOriginal(spliced, key, ID)).rejects.toThrow();
  });

  it("rejects two chunks swapped within one file", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const unit = SMALL + TAG_BYTES;
    const first = enc.slice(HEADER_BYTES, HEADER_BYTES + unit);
    const second = enc.slice(HEADER_BYTES + unit, HEADER_BYTES + 2 * unit);
    enc.set(second, HEADER_BYTES);
    enc.set(first, HEADER_BYTES + unit);
    await expect(decryptOriginal(enc, key, ID)).rejects.toThrow();
  });

  it("rejects a container whose body length disagrees with the header", async () => {
    const { key, enc } = await container();
    const extended = new Uint8Array(enc.length + 5);
    extended.set(enc);
    await expect(decryptOriginal(extended, key, ID)).rejects.toThrow(/length/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test core/test/container.test.ts`
Expected: FAIL — `encryptOriginal is not a function`.

- [ ] **Step 3: Implement encryption and decryption**

```ts
// core/src/container.ts — append

export function chunkCountFor(byteLength: number, chunkSize: number): number {
  return Math.ceil(byteLength / chunkSize);
}

function expectedBodyLength(h: Header, total: number): number {
  return total + h.chunkCount * TAG_BYTES;
}

async function gcmKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

export async function encryptOriginal(
  plaintext: Uint8Array,
  dataKey: Uint8Array,
  photoId: string,
  opts: { chunkSize?: number } = {},
): Promise<Uint8Array> {
  if (plaintext.length === 0) throw new Error("refusing to encrypt an empty file");
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const chunkCount = chunkCountFor(plaintext.length, chunkSize);
  const noncePrefix = new Uint8Array(4);
  globalThis.crypto.getRandomValues(noncePrefix);

  const headerBytes = encodeHeader({
    version: FORMAT_VERSION,
    cipherId: CIPHER_AES_256_GCM,
    chunkSize,
    chunkCount,
    noncePrefix,
  });

  const key = await gcmKey(dataKey, "encrypt");
  const parts: Uint8Array[] = [headerBytes];

  for (let i = 0; i < chunkCount; i++) {
    const slice = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length));
    const isFinal = i === chunkCount - 1;
    const ct = await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(noncePrefix, i),
        additionalData: chunkAad(headerBytes, photoId, i, isFinal),
        tagLength: 128,
      },
      key,
      slice,
    );
    parts.push(new Uint8Array(ct));
  }

  return concat(...parts);
}

export async function decryptOriginal(
  container: Uint8Array,
  dataKey: Uint8Array,
  photoId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const headerBytes = container.slice(0, HEADER_BYTES);
  const h = decodeHeader(headerBytes);

  const body = container.length - HEADER_BYTES;
  const tagOverhead = h.chunkCount * TAG_BYTES;
  const plainTotal = body - tagOverhead;
  if (plainTotal <= 0) throw new Error("container body length is impossible for its chunk count");
  if (chunkCountFor(plainTotal, h.chunkSize) !== h.chunkCount) {
    throw new Error("container body length disagrees with the header chunk count");
  }

  const key = await gcmKey(dataKey, "decrypt");
  const out = new Uint8Array(plainTotal);
  let readAt = HEADER_BYTES;
  let wroteAt = 0;

  for (let i = 0; i < h.chunkCount; i++) {
    const isFinal = i === h.chunkCount - 1;
    const plainLen = isFinal ? plainTotal - wroteAt : h.chunkSize;
    const slice = container.subarray(readAt, readAt + plainLen + TAG_BYTES);
    const plain = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(h.noncePrefix, i),
        additionalData: chunkAad(headerBytes, photoId, i, isFinal),
        tagLength: 128,
      },
      key,
      slice,
    );
    out.set(new Uint8Array(plain), wroteAt);
    readAt += plainLen + TAG_BYTES;
    wroteAt += plainLen;
    onProgress?.(wroteAt, plainTotal);
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test core/test/container.test.ts`
Expected: PASS, 20 tests, including every "fails closed" case.

- [ ] **Step 5: Add a realistic-size guard test and commit**

```ts
// core/test/container.test.ts — append
describe("realistic size", () => {
  it("round-trips a 12 MB file across real 4 MiB chunks", async () => {
    const key = newDataKey();
    const plain = bytes(12 * 1024 * 1024);
    const enc = await encryptOriginal(plain, key, ID);
    expect(decodeHeader(enc).chunkCount).toBe(3);
    expect(await decryptOriginal(enc, key, ID)).toEqual(plain);
  }, 30_000);
});
```

Run: `npm test core/test/container.test.ts`, expect PASS.

```bash
git add core/src/container.ts core/test/container.test.ts
git commit -m "feat(core): chunked AES-GCM encryption for originals"
```

---

## Task 7: Streaming decryptor for the browser

**Files:**
- Create: `core/src/stream.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/stream.test.ts`

**Interfaces:**
- Consumes: Task 5 and Task 6 exports.
- Produces:
  - `createStreamDecryptor(dataKey: Uint8Array, photoId: string, containerLength: number): StreamDecryptor`
  - `interface StreamDecryptor { push(bytes: Uint8Array): Promise<Uint8Array[]>; finish(): Promise<Uint8Array[]>; readonly plainTotal: number | null }`

`containerLength` is required because the final chunk's plaintext length is not derivable from the header alone. The site always knows it, from `original.bytes` in the manifest and from `Content-Length`.

The site fetches a `.enc` file as a stream and feeds arbitrary-sized pieces in. The decryptor buffers to chunk boundaries and emits decrypted plaintext as soon as each chunk authenticates, so the progress bar is byte-accurate and memory stays bounded.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/stream.test.ts
import { describe, it, expect } from "vitest";
import { encryptOriginal } from "../src/container.js";
import { createStreamDecryptor } from "../src/stream.js";
import { newDataKey } from "../src/wrap.js";
import { concat } from "../src/bytes.js";

const ID = "photo-stream-test";
const SMALL = 64;

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 11 + 5) & 0xff;
  return b;
}

async function feed(enc: Uint8Array, key: Uint8Array, pieceSize: number): Promise<Uint8Array> {
  const d = createStreamDecryptor(key, ID, enc.length);
  const out: Uint8Array[] = [];
  for (let i = 0; i < enc.length; i += pieceSize) {
    out.push(...(await d.push(enc.subarray(i, i + pieceSize))));
  }
  out.push(...(await d.finish()));
  return concat(...out);
}

describe("stream decryptor", () => {
  it("decrypts when fed one byte at a time", async () => {
    const key = newDataKey();
    const plain = bytes(200);
    const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
    expect(await feed(enc, key, 1)).toEqual(plain);
  });

  it("decrypts when fed in pieces larger than a chunk", async () => {
    const key = newDataKey();
    const plain = bytes(200);
    const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
    expect(await feed(enc, key, 1000)).toEqual(plain);
  });

  it("decrypts when pieces land exactly on chunk boundaries", async () => {
    const key = newDataKey();
    const plain = bytes(192);
    const enc = await encryptOriginal(plain, key, ID, { chunkSize: SMALL });
    expect(await feed(enc, key, SMALL + 16)).toEqual(plain);
  });

  it("exposes the plaintext total once the header arrives", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const d = createStreamDecryptor(key, ID, enc.length);
    expect(d.plainTotal).toBeNull();
    await d.push(enc.subarray(0, 22));
    expect(d.plainTotal).toBe(200);
  });

  it("throws on a tampered chunk as soon as that chunk completes", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    enc[30] ^= 0x01;
    await expect(feed(enc, key, 1000)).rejects.toThrow();
  });

  it("throws if the stream ends early", async () => {
    const key = newDataKey();
    const enc = await encryptOriginal(bytes(200), key, ID, { chunkSize: SMALL });
    const d = createStreamDecryptor(key, ID, enc.length);
    await d.push(enc.subarray(0, 100));
    await expect(d.finish()).rejects.toThrow(/incomplete/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test core/test/stream.test.ts`
Expected: FAIL — `Cannot find module '../src/stream.js'`.

- [ ] **Step 3: Implement**

```ts
// core/src/stream.ts
import { concat } from "./bytes.js";
import {
  HEADER_BYTES, TAG_BYTES, chunkAad, chunkCountFor, chunkNonce, decodeHeader,
  type Header,
} from "./container.js";

export interface StreamDecryptor {
  push(bytes: Uint8Array): Promise<Uint8Array[]>;
  finish(): Promise<Uint8Array[]>;
  readonly plainTotal: number | null;
}

export function createStreamDecryptor(
  dataKey: Uint8Array,
  photoId: string,
  containerLength: number,
): StreamDecryptor {
  let buffer = new Uint8Array(0);
  let headerBytes: Uint8Array | null = null;
  let header: Header | null = null;
  let plainTotal: number | null = null;
  let nextChunk = 0;
  let key: CryptoKey | null = null;

  async function ensureKey(): Promise<CryptoKey> {
    key ??= await globalThis.crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["decrypt"]);
    return key;
  }

  async function drain(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];

    if (!header) {
      if (buffer.length < HEADER_BYTES) return out;
      headerBytes = buffer.slice(0, HEADER_BYTES);
      header = decodeHeader(headerBytes);
      buffer = buffer.subarray(HEADER_BYTES);
      plainTotal = containerLength - HEADER_BYTES - header.chunkCount * TAG_BYTES;
      if (plainTotal <= 0) throw new Error("container length is impossible for its chunk count");
      if (chunkCountFor(plainTotal, header.chunkSize) !== header.chunkCount) {
        throw new Error("container length disagrees with the header chunk count");
      }
    }

    const h = header;
    const total = plainTotal!;

    while (nextChunk < h.chunkCount) {
      const isFinal = nextChunk === h.chunkCount - 1;
      const plainLen = isFinal ? total - nextChunk * h.chunkSize : h.chunkSize;
      const need = plainLen + TAG_BYTES;
      if (buffer.length < need) break;

      const plain = await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(h.noncePrefix, nextChunk),
          additionalData: chunkAad(headerBytes!, photoId, nextChunk, isFinal),
          tagLength: 128,
        },
        await ensureKey(),
        buffer.subarray(0, need),
      );
      out.push(new Uint8Array(plain));
      buffer = buffer.subarray(need);
      nextChunk++;
    }

    return out;
  }

  return {
    get plainTotal() {
      return plainTotal;
    },
    async push(bytes: Uint8Array) {
      buffer = concat(buffer, bytes);
      return drain();
    },
    async finish() {
      const out = await drain();
      if (!header) throw new Error("incomplete container: the header never arrived");
      if (nextChunk !== header.chunkCount) throw new Error("incomplete container: missing chunks");
      if (buffer.length !== 0) throw new Error("trailing bytes after the final chunk");
      return out;
    },
  };
}
```

Because `plainTotal` is known the moment the header is decoded, every chunk's
plaintext length — including the final one — follows arithmetically, and the
decryptor never has to guess where the file ends.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test core/test/stream.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add core/src/stream.ts core/src/index.ts core/test/stream.test.ts
git commit -m "feat(core): incremental decryptor for streamed containers"
```

---

## Task 8: JSON schemas

**Files:**
- Create: `core/src/schema.ts`
- Modify: `core/package.json`, `core/src/index.ts`
- Test: `core/test/schema.test.ts`

**Interfaces:**
- Consumes: `Wrapped` (Task 4), `KdfParams` (Task 3).
- Produces zod schemas and inferred types:
  - `PhotoSchema` / `Photo`
  - `IndexFileSchema` / `IndexFile`
  - `MonthFileSchema` / `MonthFile`
  - `FeaturedFileSchema` / `FeaturedFile`
  - `KeysFileSchema` / `KeysFile`
  - `SCHEMA_VERSION = 1`

- [ ] **Step 1: Write the failing test**

```ts
// core/test/schema.test.ts
import { describe, it, expect } from "vitest";
import {
  PhotoSchema, IndexFileSchema, MonthFileSchema, KeysFileSchema, SCHEMA_VERSION,
} from "../src/schema.js";

const photo = {
  id: "2026-03-14-santa-elena-at-dusk-0031",
  title: "Santa Elena at dusk",
  caption: "The canyon mouth from the river trail.",
  location: "Big Bend National Park, Texas",
  takenAt: "2026-03-14T18:22:05-06:00",
  featured: true,
  web: { path: "web/x-2048.a1b2c3d4.jpg", w: 2048, h: 1365, bytes: 812446 },
  thumb: { path: "web/x-640.e5f6a7b8.jpg", w: 640, h: 427, bytes: 71230 },
  lqip: "data:image/jpeg;base64,abc",
  exif: {
    camera: "Fujifilm X-T5", lens: "XF 16-55mm F2.8 R LM WR",
    focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400,
  },
  original: {
    path: "orig/x.enc", bytes: 41903882, mime: "image/jpeg",
    sha256: "9f2c", chunkSize: 4194304, chunkCount: 10,
  },
};

describe("PhotoSchema", () => {
  it("accepts a full record", () => {
    expect(PhotoSchema.parse(photo).id).toBe(photo.id);
  });

  it("defaults featured to false", () => {
    const { featured, ...rest } = photo;
    expect(PhotoSchema.parse(rest).featured).toBe(false);
  });

  it("rejects a takenAt without an offset", () => {
    expect(() => PhotoSchema.parse({ ...photo, takenAt: "2026-03-14T18:22:05" })).toThrow();
  });

  it("rejects an unknown exif field", () => {
    expect(() =>
      PhotoSchema.parse({ ...photo, exif: { ...photo.exif, gpsLatitude: 29.2 } }),
    ).toThrow();
  });

  it("requires a positive chunk count", () => {
    expect(() =>
      PhotoSchema.parse({ ...photo, original: { ...photo.original, chunkCount: 0 } }),
    ).toThrow();
  });
});

describe("IndexFileSchema", () => {
  it("accepts an index and rejects a bad month key", () => {
    const index = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-09-21T14:02:11Z",
      lastBackupAt: null,
      photoCount: 1,
      featuredCount: 1,
      sort: "takenAt:desc",
      months: [{ month: "2026-03", count: 1, path: "data/months/2026-03.json" }],
    };
    expect(IndexFileSchema.parse(index).months[0]!.month).toBe("2026-03");
    expect(() =>
      IndexFileSchema.parse({ ...index, months: [{ month: "2026-3", count: 1, path: "p" }] }),
    ).toThrow();
  });
});

describe("MonthFileSchema and KeysFileSchema", () => {
  it("accepts a month shard", () => {
    const parsed = MonthFileSchema.parse({
      schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo],
    });
    expect(parsed.photos).toHaveLength(1);
  });

  it("accepts a keys file", () => {
    const parsed = KeysFileSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      kdf: { alg: "argon2id", salt: "c2FsdA==", m: 65536, t: 3, p: 1, keyLen: 32 },
      verifier: { iv: "aXY=", ct: "Y3Q=" },
      keys: { [photo.id]: { iv: "aXY=", ct: "Y3Q=" } },
    });
    expect(parsed.kdf.m).toBe(65536);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test core/test/schema.test.ts`
Expected: FAIL — `Cannot find module '../src/schema.js'`.

- [ ] **Step 3: Add zod and implement**

Run: `npm install zod@^3.23.0 --workspace core`

```ts
// core/src/schema.ts
import { z } from "zod";

export const SCHEMA_VERSION = 1;

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const WrappedSchema = z.object({ iv: z.string(), ct: z.string() });

const DerivativeSchema = z.object({
  path: z.string().min(1),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  bytes: z.number().int().positive(),
});

// strict() is what makes the GPS test meaningful: an unexpected EXIF field is
// a failure, not something quietly carried through to the public JSON.
const ExifSchema = z
  .object({
    camera: z.string(),
    lens: z.string(),
    focalLength: z.string(),
    aperture: z.string(),
    shutter: z.string(),
    iso: z.number().int().nonnegative(),
  })
  .strict();

const OriginalSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().positive(),
  mime: z.string().min(1),
  sha256: z.string().min(1),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
});

export const PhotoSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  caption: z.string(),
  location: z.string(),
  takenAt: z.string().regex(ISO_OFFSET, "takenAt must be ISO 8601 with a UTC offset"),
  featured: z.boolean().default(false),
  web: DerivativeSchema,
  thumb: DerivativeSchema,
  lqip: z.string(),
  exif: ExifSchema,
  original: OriginalSchema,
});

export const MonthEntrySchema = z.object({
  month: z.string().regex(MONTH_KEY),
  count: z.number().int().nonnegative(),
  path: z.string().min(1),
});

export const IndexFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string(),
  lastBackupAt: z.string().nullable(),
  photoCount: z.number().int().nonnegative(),
  featuredCount: z.number().int().nonnegative(),
  sort: z.literal("takenAt:desc"),
  months: z.array(MonthEntrySchema),
});

export const MonthFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  month: z.string().regex(MONTH_KEY),
  photos: z.array(PhotoSchema),
});

export const FeaturedFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string(),
  photos: z.array(PhotoSchema),
});

export const KeysFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kdf: z.object({
    alg: z.literal("argon2id"),
    salt: z.string(),
    m: z.number().int().positive(),
    t: z.number().int().positive(),
    p: z.number().int().positive(),
    keyLen: z.number().int().positive(),
  }),
  verifier: WrappedSchema,
  keys: z.record(z.string(), WrappedSchema),
});

export type Photo = z.infer<typeof PhotoSchema>;
export type MonthEntry = z.infer<typeof MonthEntrySchema>;
export type IndexFile = z.infer<typeof IndexFileSchema>;
export type MonthFile = z.infer<typeof MonthFileSchema>;
export type FeaturedFile = z.infer<typeof FeaturedFileSchema>;
export type KeysFile = z.infer<typeof KeysFileSchema>;
```

```ts
// core/src/index.ts — append
export * from "./schema.js";
export * from "./stream.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, whole core suite green.

- [ ] **Step 5: Commit**

```bash
git add core/src/schema.ts core/src/index.ts core/test/schema.test.ts core/package.json package-lock.json
git commit -m "feat(core): validate the four manifest files with zod"
```

---

## Task 9: AWS infrastructure and CLI configuration

**Files:**
- Create: `infra/README.md`, `infra/bootstrap.sh`, `photos.config.json`
- Create: `cli/package.json`, `cli/tsconfig.json`, `cli/src/config.ts`
- Test: `cli/test/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Config = { bucket: string; region: string; profile: string; distributionId: string; siteUrl: string; creator: string; copyright: string; usageTerms: string; sizes: { display: number; thumb: number } }`
  - `loadConfig(path?: string): Config`
  - `CACHE_IMMUTABLE = "max-age=31536000, immutable"`, `CACHE_SHORT = "max-age=60, must-revalidate"`

The AWS resources are created once, by hand, from the runbook. `photos verify` (Task 18) is what checks they were created correctly, so nothing here is asserted by automated tests except the config loader.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/config.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/config.test.ts`
Expected: FAIL — the `cli` workspace does not exist.

- [ ] **Step 3: Create the cli workspace and the config loader**

```json
// cli/package.json
{
  "name": "@photos/cli",
  "version": "1.0.0",
  "type": "module",
  "bin": { "photos": "./dist/bin.js" },
  "dependencies": {
    "@photos/core": "*",
    "zod": "^3.23.0"
  }
}
```

```json
// cli/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"],
  "references": [{ "path": "../core" }]
}
```

```ts
// cli/src/config.ts
import { readFileSync } from "node:fs";
import { z } from "zod";

export const CACHE_IMMUTABLE = "max-age=31536000, immutable";
export const CACHE_SHORT = "max-age=60, must-revalidate";

const ConfigSchema = z
  .object({
    bucket: z.string().min(1),
    region: z.string().min(1),
    profile: z.string().min(1),
    distributionId: z.string().min(1),
    siteUrl: z.string().url().startsWith("https://", "siteUrl must be https"),
    creator: z.string().min(1),
    copyright: z.string().min(1),
    usageTerms: z.string().min(1),
    sizes: z.object({
      display: z.number().int().positive(),
      thumb: z.number().int().positive(),
    }),
  })
  .refine((c) => c.sizes.thumb < c.sizes.display, {
    message: "sizes.thumb must be smaller than sizes.display",
    path: ["sizes", "thumb"],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = "photos.config.json"): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config not found at ${path}`);
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid ${path}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
```

```json
// photos.config.json — edit the values for your account before first use
{
  "bucket": "photos.example.com",
  "region": "us-east-1",
  "profile": "photos",
  "distributionId": "REPLACE_AFTER_BOOTSTRAP",
  "siteUrl": "https://photos.example.com",
  "creator": "William Kubenka",
  "copyright": "© 2026 William Kubenka. All rights reserved.",
  "usageTerms": "No reproduction, redistribution, or use as AI training data without written permission.",
  "sizes": { "display": 2048, "thumb": 640 }
}
```

- [ ] **Step 4: Write the infrastructure runbook and bootstrap script**

`infra/bootstrap.sh` creates the bucket with versioning and a lifecycle rule, the OAC, the distribution, and the CLI's IAM policy. Versioning and the lifecycle rule are the two settings the spec calls non-negotiable, so they are created before anything is ever uploaded.

```bash
#!/usr/bin/env bash
# infra/bootstrap.sh — one-time AWS setup. Run once, then record the
# distribution id in photos.config.json.
set -euo pipefail

BUCKET="${1:?usage: bootstrap.sh <bucket> <domain> <profile>}"
DOMAIN="${2:?usage: bootstrap.sh <bucket> <domain> <profile>}"
PROFILE="${3:-photos}"
REGION="us-east-1"
AWS="aws --profile ${PROFILE} --region ${REGION}"

echo "==> Creating bucket ${BUCKET}"
$AWS s3api create-bucket --bucket "${BUCKET}"

echo "==> Blocking all public access"
$AWS s3api put-public-access-block --bucket "${BUCKET}" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "==> Enabling versioning (non-negotiable: S3 holds the only copy of originals)"
$AWS s3api put-bucket-versioning --bucket "${BUCKET}" \
  --versioning-configuration Status=Enabled

echo "==> Expiring noncurrent versions after 90 days"
$AWS s3api put-bucket-lifecycle-configuration --bucket "${BUCKET}" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-noncurrent",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 90}
    }]
  }'

echo "==> Requesting an ACM certificate for ${DOMAIN}"
CERT_ARN=$($AWS acm request-certificate --domain-name "${DOMAIN}" \
  --validation-method DNS --query CertificateArn --output text)
echo "    ${CERT_ARN}"
echo "    Add the DNS validation record shown by:"
echo "    aws acm describe-certificate --certificate-arn ${CERT_ARN} --profile ${PROFILE} --region ${REGION}"
echo "    Wait for status ISSUED before continuing."

echo "==> Creating the Origin Access Control"
OAC_ID=$($AWS cloudfront create-origin-access-control \
  --origin-access-control-config "Name=${BUCKET}-oac,OriginAccessControlOriginType=s3,SigningBehavior=always,SigningProtocol=sigv4" \
  --query OriginAccessControl.Id --output text)
echo "    ${OAC_ID}"

cat <<NOTE

==> Remaining manual steps, documented in infra/README.md:
    1. Wait for the certificate to reach ISSUED.
    2. Create the distribution with origin ${BUCKET}.s3.${REGION}.amazonaws.com,
       OAC ${OAC_ID}, certificate ${CERT_ARN}, default root object index.html.
    3. Attach the two cache policies and the response headers policy.
    4. Put the bucket policy allowing only that distribution to read.
    5. Create the IAM policy for the CLI.
    6. Record the distribution id in photos.config.json.
NOTE
```

`infra/README.md` documents, with the exact AWS CLI command for each: the two cache policies (`max-age=31536000, immutable` for `assets/*`, `web/*`, `orig/*`; `max-age=60, must-revalidate` for `data/*.json` and `index.html`), the response headers policy adding `X-Robots-Tag: noai, noimageai` to every response and the spec's Content Security Policy to HTML, the bucket policy scoped to the distribution ARN, the CLI IAM policy (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:ListBucketVersions`, `s3:GetObjectVersion` on this bucket plus `cloudfront:CreateInvalidation` on this distribution), and the backup routine — an `aws s3 sync` of `orig/` and `data/` to an external target, with the reminder that versioning protects against your own mistakes while a backup protects against losing the account.

- [ ] **Step 5: Run tests and commit**

Run: `npm test cli/test/config.test.ts` — expect PASS, 6 tests.
Run: `bash -n infra/bootstrap.sh` — expect no output.

```bash
chmod +x infra/bootstrap.sh
git add cli/ infra/ photos.config.json package-lock.json
git commit -m "feat(cli): add config loader and AWS bootstrap runbook"
```

---

## Task 10: Object store abstraction

**Files:**
- Create: `cli/src/store.ts`, `cli/src/memory-store.ts`
- Test: `cli/test/memory-store.test.ts`

**Interfaces:**
- Consumes: `Config`, `CACHE_IMMUTABLE`, `CACHE_SHORT` (Task 9).
- Produces:
  - `interface Store { get(key: string): Promise<Uint8Array | null>; put(key: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>; head(key: string): Promise<{ size: number } | null>; list(prefix: string): Promise<string[]>; delete(key: string): Promise<void>; listVersions(key: string): Promise<{ versionId: string; lastModified: string }[]>; getVersion(key: string, versionId: string): Promise<Uint8Array>; }`
  - `interface Cdn { invalidate(paths: string[]): Promise<void>; }`
  - `createS3Store(config: Config): Store`
  - `createCloudFrontCdn(config: Config): Cdn`
  - `createMemoryStore(): Store & { objects: Map<string, { body: Uint8Array; contentType: string; cacheControl: string }>; failAfter(n: number): void }`

`failAfter(n)` makes the write-ordering tests in Task 14 possible: it lets a test simulate a crash at an exact step.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/memory-store.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";

const body = new Uint8Array([1, 2, 3]);

describe("memory store", () => {
  it("round-trips an object with its headers", async () => {
    const s = createMemoryStore();
    await s.put("data/index.json", body, "application/json", "max-age=60");
    expect(await s.get("data/index.json")).toEqual(body);
    expect(s.objects.get("data/index.json")!.contentType).toBe("application/json");
  });

  it("returns null for a missing key", async () => {
    expect(await createMemoryStore().get("nope")).toBeNull();
  });

  it("lists by prefix", async () => {
    const s = createMemoryStore();
    await s.put("web/a.jpg", body, "image/jpeg", "x");
    await s.put("web/b.jpg", body, "image/jpeg", "x");
    await s.put("orig/c.enc", body, "application/octet-stream", "x");
    expect((await s.list("web/")).sort()).toEqual(["web/a.jpg", "web/b.jpg"]);
  });

  it("keeps versions and can read an older one", async () => {
    const s = createMemoryStore();
    await s.put("data/index.json", new Uint8Array([1]), "application/json", "x");
    await s.put("data/index.json", new Uint8Array([2]), "application/json", "x");
    const versions = await s.listVersions("data/index.json");
    expect(versions).toHaveLength(2);
    expect(await s.getVersion("data/index.json", versions[1]!.versionId)).toEqual(new Uint8Array([1]));
  });

  it("throws on the nth put when failAfter is set", async () => {
    const s = createMemoryStore();
    s.failAfter(2);
    await s.put("a", body, "x", "x");
    await s.put("b", body, "x", "x");
    await expect(s.put("c", body, "x", "x")).rejects.toThrow(/simulated/i);
    expect(await s.get("c")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/memory-store.test.ts`
Expected: FAIL — `Cannot find module '../src/memory-store.js'`.

- [ ] **Step 3: Implement the interface, the fake, and the S3 client**

```ts
// cli/src/store.ts
import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, DeleteObjectCommand, ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Config } from "./config.js";

export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  listVersions(key: string): Promise<{ versionId: string; lastModified: string }[]>;
  getVersion(key: string, versionId: string): Promise<Uint8Array>;
}

export interface Cdn {
  invalidate(paths: string[]): Promise<void>;
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export function createS3Store(config: Config): Store {
  const client = new S3Client({
    region: config.region,
    credentials: fromIni({ profile: config.profile }),
  });
  const Bucket = config.bucket;

  return {
    async get(Key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key }));
        return await toBytes(r.Body);
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },
    async put(Key, body, ContentType, CacheControl) {
      await client.send(new PutObjectCommand({
        Bucket, Key, Body: body, ContentType, CacheControl,
      }));
    },
    async head(Key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return { size: r.ContentLength ?? 0 };
      } catch (e) {
        if ((e as { name?: string }).name === "NotFound") return null;
        throw e;
      }
    },
    async list(Prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
        ContinuationToken = r.NextContinuationToken;
      } while (ContinuationToken);
      return keys;
    },
    async delete(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    async listVersions(Key) {
      const r = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key }));
      return (r.Versions ?? [])
        .filter((v) => v.Key === Key && v.VersionId)
        .map((v) => ({ versionId: v.VersionId!, lastModified: v.LastModified?.toISOString() ?? "" }));
    },
    async getVersion(Key, VersionId) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key, VersionId }));
      return toBytes(r.Body);
    },
  };
}

export function createCloudFrontCdn(config: Config): Cdn {
  const client = new CloudFrontClient({
    region: "us-east-1",
    credentials: fromIni({ profile: config.profile }),
  });
  return {
    async invalidate(paths) {
      await client.send(new CreateInvalidationCommand({
        DistributionId: config.distributionId,
        InvalidationBatch: {
          CallerReference: `photos-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }));
    },
  };
}
```

```ts
// cli/src/memory-store.ts
import type { Store } from "./store.js";

interface Stored { body: Uint8Array; contentType: string; cacheControl: string }

export function createMemoryStore(): Store & {
  objects: Map<string, Stored>;
  failAfter(n: number): void;
} {
  const objects = new Map<string, Stored>();
  const versions = new Map<string, { versionId: string; lastModified: string; body: Uint8Array }[]>();
  let puts = 0;
  let limit = Infinity;

  return {
    objects,
    failAfter(n) { limit = n; },
    async get(key) { return objects.get(key)?.body ?? null; },
    async put(key, body, contentType, cacheControl) {
      if (puts >= limit) throw new Error(`simulated store failure at put ${puts + 1}`);
      puts++;
      objects.set(key, { body, contentType, cacheControl });
      const list = versions.get(key) ?? [];
      list.unshift({
        versionId: `v${list.length + 1}`,
        lastModified: new Date(Date.now() + list.length).toISOString(),
        body,
      });
      versions.set(key, list);
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.body.length } : null;
    },
    async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
    async delete(key) { objects.delete(key); },
    async listVersions(key) {
      return (versions.get(key) ?? []).map(({ versionId, lastModified }) => ({ versionId, lastModified }));
    },
    async getVersion(key, versionId) {
      const v = (versions.get(key) ?? []).find((x) => x.versionId === versionId);
      if (!v) throw new Error(`no version ${versionId} of ${key}`);
      return v.body;
    },
  };
}
```

- [ ] **Step 4: Install dependencies and run the tests**

Run: `npm install @aws-sdk/client-s3@^3.665.0 @aws-sdk/client-cloudfront@^3.665.0 @aws-sdk/credential-providers@^3.665.0 --workspace cli`
Run: `npm test cli/test/memory-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/store.ts cli/src/memory-store.ts cli/test/memory-store.test.ts cli/package.json package-lock.json
git commit -m "feat(cli): add Store interface with S3 and in-memory implementations"
```

---

## Task 11: EXIF extraction

**Files:**
- Create: `cli/src/exif.ts`
- Test: `cli/test/exif.test.ts`, `cli/test/fixtures/make-fixtures.ts`

**Interfaces:**
- Consumes: `monthOf` (Task 2), `Photo["exif"]` (Task 8).
- Produces:
  - `type ExtractedExif = { exif: Photo["exif"]; takenAt: string; hasGps: boolean; frame: string }`
  - `readExif(path: string): Promise<ExtractedExif>`
  - `assembleTakenAt(dateTimeOriginal: string, offset: string | undefined): string`

`assembleTakenAt` is the piece that must not guess. EXIF stores `DateTimeOriginal` as local wall-clock time with no zone, and `OffsetTimeOriginal` separately. If the offset tag is missing, the CLI must ask rather than assume, because assuming UTC would misfile evening photos — the exact bug the spec calls out.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/exif.test.ts
import { describe, it, expect } from "vitest";
import { assembleTakenAt } from "../src/exif.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/exif.test.ts`
Expected: FAIL — `Cannot find module '../src/exif.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/exif.ts
import { exiftool } from "exiftool-vendored";
import { basename } from "node:path";
import type { Photo } from "@photos/core";

export interface ExtractedExif {
  exif: Photo["exif"];
  takenAt: string;
  hasGps: boolean;
  frame: string;
}

const EXIF_DATETIME = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/;

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

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

export async function readExif(
  path: string,
  offsetOverride?: string,
): Promise<ExtractedExif> {
  const tags = await exiftool.read(path);
  const takenAt = assembleTakenAt(
    str(tags.DateTimeOriginal ?? tags.CreateDate),
    offsetOverride ?? (tags.OffsetTimeOriginal as string | undefined),
  );

  const focal = tags.FocalLength ? str(tags.FocalLength).replace(/\s+/g, "") : "";
  const aperture = tags.FNumber ? `f/${tags.FNumber}` : "";
  const shutter = str(tags.ExposureTime ?? tags.ShutterSpeed);

  return {
    takenAt,
    hasGps: tags.GPSLatitude !== undefined || tags.GPSLongitude !== undefined,
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
```

- [ ] **Step 4: Install exiftool-vendored and run the tests**

Run: `npm install exiftool-vendored@^28.3.0 --workspace cli`
Run: `npm test cli/test/exif.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/exif.ts cli/test/exif.test.ts cli/package.json package-lock.json
git commit -m "feat(cli): extract whitelisted EXIF and require an explicit UTC offset"
```

---

## Task 12: Image derivatives

**Files:**
- Create: `cli/src/images.ts`
- Test: `cli/test/images.test.ts`

**Interfaces:**
- Consumes: `Config["sizes"]` (Task 9).
- Produces:
  - `type Derivative = { buffer: Buffer; w: number; h: number; bytes: number; hash: string }`
  - `buildDerivatives(input: Buffer, sizes: { display: number; thumb: number }): Promise<{ display: Derivative; thumb: Derivative; lqip: string }>`
  - `contentHash(buffer: Buffer): string` — first 8 hex characters of SHA-256
  - `derivativePath(id: string, width: number, hash: string): string`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/images.test.ts`
Expected: FAIL — `Cannot find module '../src/images.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/images.ts
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
```

sharp discards all input metadata unless `.withMetadata()` is called, which is why steps 4 of the spec's pipeline needs no explicit strip call. Task 13 re-injects the whitelist deliberately.

- [ ] **Step 4: Install sharp and run the tests**

Run: `npm install sharp@^0.33.5 --workspace cli`
Run: `npm test cli/test/images.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/images.ts cli/test/images.test.ts cli/package.json package-lock.json
git commit -m "feat(cli): build web derivatives and inline lqip placeholders"
```

---

## Task 13: Rights and opt-out metadata

**Files:**
- Create: `cli/src/rights.ts`
- Test: `cli/test/rights.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 9), `Photo` (Task 8), `closeExif` (Task 11).
- Produces:
  - `writeRights(jpeg: Buffer, photo: { title: string; caption: string; exif: Photo["exif"]; takenAt: string }, config: Config, opts?: { gps?: { lat: number; lon: number } }): Promise<Buffer>`

The GPS test is the one that matters most: the spec's guarantee is that GPS never leaks by accident, and this asserts it on a real file rather than by reading the code.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/rights.test.ts
import { describe, it, expect, afterAll } from "vitest";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRights } from "../src/rights.js";
import { closeExif } from "../src/exif.js";

afterAll(async () => { await closeExif(); });

const config = {
  bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
  siteUrl: "https://photos.example.com",
  creator: "William Kubenka",
  copyright: "© 2026 William Kubenka. All rights reserved.",
  usageTerms: "No reproduction, redistribution, or use as AI training data without written permission.",
  sizes: { display: 2048, thumb: 640 },
};

const photo = {
  title: "Santa Elena at dusk",
  caption: "The canyon mouth from the river trail.",
  takenAt: "2026-03-14T18:22:05-06:00",
  exif: {
    camera: "Fujifilm X-T5", lens: "XF 16-55mm F2.8 R LM WR",
    focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400,
  },
};

async function tagsOf(buffer: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "photos-rights-"));
  const path = join(dir, "out.jpg");
  writeFileSync(path, buffer);
  return exiftool.read(path);
}

async function blank(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "#777" } })
    .jpeg().toBuffer();
}

describe("writeRights", () => {
  it("writes the rights fields", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config));
    expect(tags.Creator).toContain("William Kubenka");
    expect(String(tags.Rights ?? tags.CopyrightNotice)).toContain("2026 William Kubenka");
    expect(String(tags.UsageTerms)).toContain("AI training data");
    expect(tags.Marked).toBe(true);
  }, 30_000);

  it("writes the machine-readable opt-out tags", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config)) as Record<string, unknown>;
    expect(String(tags.Robots)).toBe("noai, noimageai");
    expect(String(tags.DigitalSourceType)).toContain("digitalCapture");
  }, 30_000);

  it("writes the whitelisted camera fields and the description", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config));
    expect(String(tags.Model)).toContain("X-T5");
    expect(String(tags.Description ?? tags.ImageDescription)).toContain("canyon mouth");
  }, 30_000);

  it("writes no GPS tags by default", async () => {
    const tags = await tagsOf(await writeRights(await blank(), photo, config)) as Record<string, unknown>;
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.GPSLongitude).toBeUndefined();
    expect(tags.GPSPosition).toBeUndefined();
  }, 30_000);

  it("writes GPS only when explicitly asked", async () => {
    const out = await writeRights(await blank(), photo, config, { gps: { lat: 29.2, lon: -103.6 } });
    const tags = await tagsOf(out) as Record<string, unknown>;
    expect(tags.GPSLatitude).toBeDefined();
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/rights.test.ts`
Expected: FAIL — `Cannot find module '../src/rights.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/rights.ts
import { exiftool } from "exiftool-vendored";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Photo } from "@photos/core";

const DIGITAL_CAPTURE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";

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
      "XMP-xmpRights:Marked": true,
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

    await exiftool.write(path, tags, { writeArgs: ["-overwrite_original"] });
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

`XMP-tdm:Reservation` and `XMP-xmp:Robots` are not in exiftool's default
writable set, so they need a config file declaring them. Create
`cli/exiftool.config`:

```perl
# cli/exiftool.config — declares the opt-out tags exiftool does not ship with.
%Image::ExifTool::UserDefined::tdm = (
    GROUPS    => { 0 => 'XMP', 1 => 'XMP-tdm', 2 => 'Author' },
    NAMESPACE => { 'tdm' => 'http://www.w3.org/ns/tdmrep#' },
    WRITABLE  => 'string',
    Reservation => { Writable => 'integer' },
    Policy      => { },
);

%Image::ExifTool::UserDefined = (
    'Image::ExifTool::XMP::Main' => {
        tdm => {
            SubDirectory => { TagTable => 'Image::ExifTool::UserDefined::tdm' },
        },
    },
    'Image::ExifTool::XMP::xmp' => {
        Robots => { Writable => 'string' },
    },
);

1;  # end
```

Pass it on every write:

```ts
await exiftool.write(path, tags, {
  writeArgs: ["-overwrite_original", "-config", CONFIG_PATH],
});
```

where `CONFIG_PATH` resolves `cli/exiftool.config` relative to the module
(`new URL("../exiftool.config", import.meta.url).pathname`) so the CLI works
from any working directory. If a tag still refuses to write, the test fails
loudly rather than skipping it silently — fix the config rather than dropping
the tag.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/rights.test.ts`
Expected: PASS, 5 tests. The GPS test is the guarantee the spec depends on.

- [ ] **Step 5: Commit**

```bash
git add cli/src/rights.ts cli/exiftool.config cli/test/rights.test.ts
git commit -m "feat(cli): stamp rights and no-AI opt-out metadata, never GPS by default"
```

---

## Task 14: Manifest read, write, and commit ordering

**Files:**
- Create: `cli/src/manifest.ts`
- Test: `cli/test/manifest.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 10); all schemas (Task 8); `monthOf` (Task 2); cache constants (Task 9).
- Produces:
  - `KEYS = { index: "data/index.json", keys: "data/keys.json", featured: "data/featured.json", month: (m: string) => \`data/months/${m}.json\` }`
  - `readIndex(store): Promise<IndexFile>` — returns an empty index if absent
  - `readMonth(store, month): Promise<MonthFile>` — returns an empty shard if absent
  - `readFeatured(store): Promise<FeaturedFile>`, `readKeys(store): Promise<KeysFile | null>`
  - `rebuildFeatured(months: MonthFile[]): FeaturedFile`
  - `rebuildIndex(months: MonthFile[], lastBackupAt: string | null): IndexFile`
  - `commit(store, change: Change): Promise<void>`
  - `interface Change { objects?: { key: string; body: Uint8Array; contentType: string }[]; keys?: KeysFile; months?: MonthFile[]; featured?: FeaturedFile; index: IndexFile }`

`commit` is the only function permitted to write `data/`, and it writes in exactly the spec's order: assets, then keys, then month shards, then featured, then index. Centralising it is what makes the ordering testable rather than a convention.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/manifest.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import {
  KEYS, readIndex, readMonth, readFeatured, rebuildIndex, rebuildFeatured, commit,
} from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

function photo(id: string, takenAt: string, featured = false): Photo {
  return {
    id, title: id, caption: "", location: "", takenAt, featured,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

function month(m: string, photos: Photo[]): MonthFile {
  return { schemaVersion: SCHEMA_VERSION, month: m, photos };
}

describe("reads with no data present", () => {
  it("returns an empty index", async () => {
    const index = await readIndex(createMemoryStore());
    expect(index.photoCount).toBe(0);
    expect(index.months).toEqual([]);
  });

  it("returns an empty month shard", async () => {
    expect((await readMonth(createMemoryStore(), "2026-03")).photos).toEqual([]);
  });

  it("returns an empty featured file", async () => {
    expect((await readFeatured(createMemoryStore())).photos).toEqual([]);
  });
});

describe("rebuildIndex", () => {
  it("lists months newest first with counts, skipping empty ones", () => {
    const index = rebuildIndex(
      [month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00")]),
       month("2026-08", [photo("b", "2026-08-01T10:00:00-06:00"), photo("c", "2026-08-02T10:00:00-06:00")]),
       month("2026-05", [])],
      null,
    );
    expect(index.months.map((m) => m.month)).toEqual(["2026-08", "2026-03"]);
    expect(index.months[0]!.count).toBe(2);
    expect(index.months[0]!.path).toBe("data/months/2026-08.json");
    expect(index.photoCount).toBe(3);
  });

  it("carries lastBackupAt through", () => {
    expect(rebuildIndex([], "2026-09-19T08:30:00Z").lastBackupAt).toBe("2026-09-19T08:30:00Z");
  });
});

describe("rebuildFeatured", () => {
  it("collects only featured photos, newest first", () => {
    const f = rebuildFeatured([
      month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00", true)]),
      month("2026-08", [photo("b", "2026-08-01T10:00:00-06:00"), photo("c", "2026-08-02T10:00:00-06:00", true)]),
    ]);
    expect(f.photos.map((p) => p.id)).toEqual(["c", "a"]);
  });
});

describe("commit ordering", () => {
  const change = () => ({
    objects: [{ key: "orig/a.enc", body: new Uint8Array([1]), contentType: "application/octet-stream" }],
    keys: {
      schemaVersion: SCHEMA_VERSION as 1,
      kdf: { alg: "argon2id" as const, salt: "c2FsdA==", m: 65536, t: 3, p: 1, keyLen: 32 },
      verifier: { iv: "aXY=", ct: "Y3Q=" },
      keys: {},
    },
    months: [month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00")])],
    featured: { schemaVersion: SCHEMA_VERSION as 1, generatedAt: "now", photos: [] },
    index: rebuildIndex([month("2026-03", [photo("a", "2026-03-14T10:00:00-06:00")])], null),
  });

  it("writes assets, keys, months, featured, then the index", async () => {
    const store = createMemoryStore();
    const order: string[] = [];
    const put = store.put.bind(store);
    store.put = async (k, b, c, cc) => { order.push(k); return put(k, b, c, cc); };
    await commit(store, change());
    expect(order).toEqual([
      "orig/a.enc",
      KEYS.keys,
      "data/months/2026-03.json",
      KEYS.featured,
      KEYS.index,
    ]);
  });

  it("leaves the index untouched if a month shard write fails", async () => {
    const store = createMemoryStore();
    store.failAfter(2); // asset and keys succeed, the month shard fails
    await expect(commit(store, change())).rejects.toThrow(/simulated/);
    expect(await store.get(KEYS.index)).toBeNull();
  });

  it("gives data files the short cache header and assets the immutable one", async () => {
    const store = createMemoryStore();
    await commit(store, change());
    expect(store.objects.get(KEYS.index)!.cacheControl).toBe("max-age=60, must-revalidate");
    expect(store.objects.get("orig/a.enc")!.cacheControl).toBe("max-age=31536000, immutable");
  });

  it("round-trips through the schemas", async () => {
    const store = createMemoryStore();
    await commit(store, change());
    expect((await readIndex(store)).photoCount).toBe(1);
    expect((await readMonth(store, "2026-03")).photos[0]!.id).toBe("a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/manifest.test.ts`
Expected: FAIL — `Cannot find module '../src/manifest.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/manifest.ts
import {
  FeaturedFileSchema, IndexFileSchema, KeysFileSchema, MonthFileSchema,
  SCHEMA_VERSION, monthOf,
  type FeaturedFile, type IndexFile, type KeysFile, type MonthFile, type Photo,
} from "@photos/core";
import { CACHE_IMMUTABLE, CACHE_SHORT } from "./config.js";
import type { Store } from "./store.js";

export const KEYS = {
  index: "data/index.json",
  keys: "data/keys.json",
  featured: "data/featured.json",
  month: (m: string) => `data/months/${m}.json`,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value, null, 2));
}

async function readJson(store: Store, key: string): Promise<unknown | null> {
  const bytes = await store.get(key);
  return bytes === null ? null : JSON.parse(dec.decode(bytes));
}

export function emptyIndex(): IndexFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    lastBackupAt: null,
    photoCount: 0,
    featuredCount: 0,
    sort: "takenAt:desc",
    months: [],
  };
}

export async function readIndex(store: Store): Promise<IndexFile> {
  const raw = await readJson(store, KEYS.index);
  return raw === null ? emptyIndex() : IndexFileSchema.parse(raw);
}

export async function readMonth(store: Store, month: string): Promise<MonthFile> {
  const raw = await readJson(store, KEYS.month(month));
  return raw === null
    ? { schemaVersion: SCHEMA_VERSION, month, photos: [] }
    : MonthFileSchema.parse(raw);
}

export async function readFeatured(store: Store): Promise<FeaturedFile> {
  const raw = await readJson(store, KEYS.featured);
  return raw === null
    ? { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), photos: [] }
    : FeaturedFileSchema.parse(raw);
}

export async function readKeys(store: Store): Promise<KeysFile | null> {
  const raw = await readJson(store, KEYS.keys);
  return raw === null ? null : KeysFileSchema.parse(raw);
}

export async function readAllMonths(store: Store, index: IndexFile): Promise<MonthFile[]> {
  return Promise.all(index.months.map((m) => readMonth(store, m.month)));
}

function byTakenAtDesc(a: Photo, b: Photo): number {
  return a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : a.id < b.id ? 1 : -1;
}

export function sortMonth(m: MonthFile): MonthFile {
  return { ...m, photos: [...m.photos].sort(byTakenAtDesc) };
}

export function rebuildIndex(months: MonthFile[], lastBackupAt: string | null): IndexFile {
  const nonEmpty = months.filter((m) => m.photos.length > 0);
  const featuredCount = nonEmpty.reduce(
    (n, m) => n + m.photos.filter((p) => p.featured).length, 0,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    lastBackupAt,
    photoCount: nonEmpty.reduce((n, m) => n + m.photos.length, 0),
    featuredCount,
    sort: "takenAt:desc",
    months: nonEmpty
      .map((m) => ({ month: m.month, count: m.photos.length, path: KEYS.month(m.month) }))
      .sort((a, b) => (a.month < b.month ? 1 : -1)),
  };
}

export function rebuildFeatured(months: MonthFile[]): FeaturedFile {
  const photos = months
    .flatMap((m) => m.photos)
    .filter((p) => p.featured)
    .sort(byTakenAtDesc);
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), photos };
}

export function monthFor(photo: Photo): string {
  return monthOf(photo.takenAt);
}

export interface Change {
  objects?: { key: string; body: Uint8Array; contentType: string }[];
  keys?: KeysFile;
  months?: MonthFile[];
  featured?: FeaturedFile;
  index: IndexFile;
}

/**
 * The single writer of data/. Order is the spec's, and it is the reason an
 * interrupted run leaves the live site consistent: nothing references an
 * asset until its month shard lands, and no month shard is visible until the
 * index lands.
 */
export async function commit(store: Store, change: Change): Promise<void> {
  for (const o of change.objects ?? []) {
    await store.put(o.key, o.body, o.contentType, CACHE_IMMUTABLE);
  }
  if (change.keys) {
    await store.put(KEYS.keys, json(change.keys), "application/json", CACHE_SHORT);
  }
  for (const m of change.months ?? []) {
    await store.put(KEYS.month(m.month), json(sortMonth(m)), "application/json", CACHE_SHORT);
  }
  if (change.featured) {
    await store.put(KEYS.featured, json(change.featured), "application/json", CACHE_SHORT);
  }
  await store.put(KEYS.index, json(change.index), "application/json", CACHE_SHORT);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/manifest.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/manifest.ts cli/test/manifest.test.ts
git commit -m "feat(cli): centralise manifest reads and ordered commits"
```

---

## Task 15: The `add` command

**Files:**
- Create: `cli/src/commands/add.ts`, `cli/src/password.ts`
- Test: `cli/test/add.test.ts`

**Interfaces:**
- Consumes: Tasks 10–14, plus `encryptOriginal`, `newDataKey`, `wrapDataKey`, `makeVerifier`, `deriveMasterKey`, `newKdfParams`, `makePhotoId`, `monthOf` from core.
- Produces:
  - `addPhotos(deps: AddDeps, files: string[], opts: AddOptions): Promise<Photo[]>`
  - `interface AddDeps { store: Store; config: Config; prompt: (file: string, exif: ExtractedExif, askLocation: boolean) => Promise<{ title: string; caption: string; location?: string }>; password: () => Promise<string> }`
  - `interface AddOptions { keepGps?: boolean; offset?: string; location?: string }`

`--location` supplies one location for the whole batch, which is the common case: a day's shoot happens in one place, and typing it five times is friction for no information. When it is supplied the prompt is not asked for it at all.

Dependency injection on `prompt` and `password` is what makes this testable without a TTY.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/add.test.ts
import { describe, it, expect, afterAll, vi } from "vitest";
import sharp from "sharp";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStore } from "../src/memory-store.js";
import { addPhotos } from "../src/commands/add.js";
import { readIndex, readKeys, readMonth, readFeatured } from "../src/manifest.js";
import { closeExif } from "../src/exif.js";
import { decryptOriginal, deriveMasterKey, unwrapDataKey } from "@photos/core";

afterAll(async () => { await closeExif(); });

const config = {
  bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
  siteUrl: "https://photos.example.com", creator: "W K",
  copyright: "© 2026 W K", usageTerms: "No AI training.",
  sizes: { display: 2048, thumb: 640 },
};

async function sourceFile(name = "DSCF0031.jpg"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "photos-add-"));
  const path = join(dir, name);
  const buf = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#5a6b7c" },
  })
    .withMetadata({ exif: { IFD0: { Model: "X-T5", Make: "Fujifilm" } } })
    .jpeg().toBuffer();
  writeFileSync(path, buf);
  return path;
}

function deps(store = createMemoryStore()) {
  return {
    store,
    config,
    prompt: async () => ({ title: "Santa Elena at dusk", caption: "Dusk.", location: "Big Bend NP" }),
    password: async () => "a long shared passphrase",
  };
}

describe("addPhotos", () => {
  it("publishes a photo end to end", async () => {
    const d = deps();
    const [photo] = await addPhotos(d, [await sourceFile()], { offset: "-06:00" });

    expect(photo!.id).toMatch(/^\d{4}-\d{2}-\d{2}-santa-elena-at-dusk-/);
    expect(photo!.featured).toBe(false);

    const index = await readIndex(d.store);
    expect(index.photoCount).toBe(1);
    expect(index.months).toHaveLength(1);

    const shard = await readMonth(d.store, index.months[0]!.month);
    expect(shard.photos[0]!.id).toBe(photo!.id);

    expect(await d.store.get(photo!.web.path)).not.toBeNull();
    expect(await d.store.get(photo!.thumb.path)).not.toBeNull();
    expect(await d.store.get(photo!.original.path)).not.toBeNull();
  }, 60_000);

  it("stores an original that decrypts back to the source bytes", async () => {
    const d = deps();
    const file = await sourceFile();
    const [photo] = await addPhotos(d, [file], { offset: "-06:00" });

    const keys = (await readKeys(d.store))!;
    const master = await deriveMasterKey("a long shared passphrase", keys.kdf);
    const dataKey = await unwrapDataKey(master, keys.keys[photo!.id]!, photo!.id);
    const container = (await d.store.get(photo!.original.path))!;
    const plain = await decryptOriginal(container, dataKey, photo!.id);

    const { readFileSync } = await import("node:fs");
    expect(Buffer.from(plain)).toEqual(readFileSync(file));
  }, 60_000);

  it("creates the kdf params and verifier on the first add only", async () => {
    const d = deps();
    await addPhotos(d, [await sourceFile("a.jpg")], { offset: "-06:00" });
    const first = (await readKeys(d.store))!;
    await addPhotos(d, [await sourceFile("b.jpg")], { offset: "-06:00" });
    const second = (await readKeys(d.store))!;
    expect(second.kdf.salt).toBe(first.kdf.salt);
    expect(second.verifier).toEqual(first.verifier);
    expect(Object.keys(second.keys)).toHaveLength(2);
  }, 90_000);

  it("rejects a second add under a different password", async () => {
    const store = createMemoryStore();
    await addPhotos(deps(store), [await sourceFile("a.jpg")], { offset: "-06:00" });
    const wrong = { ...deps(store), password: async () => "a different passphrase" };
    await expect(addPhotos(wrong, [await sourceFile("b.jpg")], { offset: "-06:00" }))
      .rejects.toThrow(/password/i);
  }, 90_000);

  it("applies a batch location without prompting for one", async () => {
    const prompt = vi.fn(async () => ({ title: "Santa Elena at dusk", caption: "Dusk." }));
    const d = { ...deps(), prompt };
    const [photo] = await addPhotos(d, [await sourceFile()], {
      offset: "-06:00", location: "Big Bend NP, Texas",
    });
    expect(photo!.location).toBe("Big Bend NP, Texas");
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.anything(), false);
  }, 60_000);

  it("applies the batch location to every file in the batch", async () => {
    const d = { ...deps(), prompt: async () => ({ title: "T", caption: "C" }) };
    const added = await addPhotos(d, [await sourceFile("a.jpg"), await sourceFile("b.jpg")], {
      offset: "-06:00", location: "Guadalupe Mountains",
    });
    expect(added.map((p) => p.location)).toEqual(["Guadalupe Mountains", "Guadalupe Mountains"]);
  }, 90_000);

  it("asks for a location when no batch location is given", async () => {
    const prompt = vi.fn(async () => ({ title: "T", caption: "C", location: "Typed in" }));
    const d = { ...deps(), prompt };
    const [photo] = await addPhotos(d, [await sourceFile()], { offset: "-06:00" });
    expect(photo!.location).toBe("Typed in");
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.anything(), true);
  }, 60_000);

  it("writes an empty featured file when nothing is featured", async () => {
    const d = deps();
    await addPhotos(d, [await sourceFile()], { offset: "-06:00" });
    expect((await readFeatured(d.store)).photos).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/add.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/add.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/password.ts
import { createInterface } from "node:readline/promises";

export async function promptPassword(label = "Password: "): Promise<string> {
  const fromEnv = process.env.PHOTOS_PASSWORD;
  if (fromEnv) return fromEnv;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const output = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const write = output.write.bind(output);
  output.write = ((chunk: string, ...rest: unknown[]) =>
    output.muted ? true : write(chunk, ...(rest as []))) as typeof output.write;
  try {
    const answer = rl.question(label);
    output.muted = true;
    const value = await answer;
    return value;
  } finally {
    output.muted = false;
    output.write = write;
    rl.close();
    process.stdout.write("\n");
  }
}
```

```ts
// cli/src/commands/add.ts
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  CHUNK_SIZE, chunkCountFor, deriveMasterKey, encryptOriginal, checkVerifier,
  makePhotoId, makeVerifier, monthOf, newDataKey, newKdfParams, wrapDataKey,
  SCHEMA_VERSION, type KeysFile, type Photo,
} from "@photos/core";
import type { Config } from "../config.js";
import type { Store } from "../store.js";
import { buildDerivatives, derivativePath } from "../images.js";
import { readExif, type ExtractedExif } from "../exif.js";
import { writeRights } from "../rights.js";
import {
  commit, rebuildFeatured, rebuildIndex, readAllMonths, readIndex, readKeys, readMonth,
} from "../manifest.js";

export interface AddDeps {
  store: Store;
  config: Config;
  prompt: (
    file: string,
    exif: ExtractedExif,
    askLocation: boolean,
  ) => Promise<{ title: string; caption: string; location?: string }>;
  password: () => Promise<string>;
}

export interface AddOptions {
  keepGps?: boolean;
  offset?: string;
  /** One location for the whole batch; when set, the prompt does not ask for it. */
  location?: string;
}

export async function addPhotos(
  deps: AddDeps,
  files: string[],
  opts: AddOptions = {},
): Promise<Photo[]> {
  const { store, config } = deps;

  const existingKeys = await readKeys(store);
  const password = await deps.password();

  let keysFile: KeysFile;
  let master: Uint8Array;
  if (existingKeys) {
    master = await deriveMasterKey(password, existingKeys.kdf);
    if (!(await checkVerifier(master, existingKeys.verifier))) {
      throw new Error("that password does not match the one this library was created with");
    }
    keysFile = existingKeys;
  } else {
    const kdf = newKdfParams();
    master = await deriveMasterKey(password, kdf);
    keysFile = {
      schemaVersion: SCHEMA_VERSION,
      kdf,
      verifier: await makeVerifier(master),
      keys: {},
    };
  }

  const index = await readIndex(store);
  const months = new Map((await readAllMonths(store, index)).map((m) => [m.month, m]));
  const objects: { key: string; body: Uint8Array; contentType: string }[] = [];
  const added: Photo[] = [];

  for (const file of files) {
    const source = await readFile(file);
    const extracted = await readExif(file, opts.offset);
    const answers = await deps.prompt(file, extracted, opts.location === undefined);
    const location = opts.location ?? answers.location ?? "";

    const id = makePhotoId(extracted.takenAt, answers.title, extracted.frame);
    const month = monthOf(extracted.takenAt);

    const { display, thumb, lqip } = await buildDerivatives(source, config.sizes);
    const rightsInput = {
      title: answers.title,
      caption: answers.caption,
      takenAt: extracted.takenAt,
      exif: extracted.exif,
    };
    const displayJpeg = await writeRights(display.buffer, rightsInput, config);
    const thumbJpeg = await writeRights(thumb.buffer, rightsInput, config);

    const dataKey = newDataKey();
    const container = await encryptOriginal(source, dataKey, id);
    keysFile.keys[id] = await wrapDataKey(master, dataKey, id);

    const webPath = derivativePath(id, config.sizes.display, display.hash);
    const thumbPath = derivativePath(id, config.sizes.thumb, thumb.hash);
    const origPath = `orig/${id}.enc`;

    objects.push(
      { key: webPath, body: displayJpeg, contentType: "image/jpeg" },
      { key: thumbPath, body: thumbJpeg, contentType: "image/jpeg" },
      { key: origPath, body: container, contentType: "application/octet-stream" },
    );

    const photo: Photo = {
      id,
      title: answers.title,
      caption: answers.caption,
      location,
      takenAt: extracted.takenAt,
      featured: false,
      web: { path: webPath, w: display.w, h: display.h, bytes: displayJpeg.length },
      thumb: { path: thumbPath, w: thumb.w, h: thumb.h, bytes: thumbJpeg.length },
      lqip,
      exif: extracted.exif,
      original: {
        path: origPath,
        bytes: container.length,
        mime: "image/jpeg",
        sha256: createHash("sha256").update(source).digest("hex"),
        chunkSize: CHUNK_SIZE,
        chunkCount: chunkCountFor(source.length, CHUNK_SIZE),
      },
    };

    const shard = months.get(month) ?? (await readMonth(store, month));
    months.set(month, { ...shard, photos: [...shard.photos, photo] });
    added.push(photo);
  }

  const allMonths = [...months.values()];
  await commit(store, {
    objects,
    keys: keysFile,
    months: allMonths,
    featured: rebuildFeatured(allMonths),
    index: rebuildIndex(allMonths, index.lastBackupAt),
  });

  return added;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/add.test.ts`
Expected: PASS, 8 tests. The decrypt-back-to-source test is the one that proves writer and reader agree.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/add.ts cli/src/password.ts cli/test/add.test.ts
git commit -m "feat(cli): add ingests, encrypts, and publishes a photo in one run"
```

---

## Task 16: `feature`, `unfeature`, `edit`, and `rm`

**Files:**
- Create: `cli/src/commands/curate.ts`
- Test: `cli/test/curate.test.ts`

**Interfaces:**
- Consumes: Task 14 manifest functions.
- Produces:
  - `setFeatured(store, ids: string[], featured: boolean): Promise<void>`
  - `editPhoto(store, id: string, patch: { title?: string; caption?: string; location?: string }): Promise<Photo>`
  - `removePhoto(store, id: string): Promise<void>`
  - `findPhoto(months: MonthFile[], id: string): { month: MonthFile; photo: Photo } | null`

The spec calls the `featured.json` duplication a sharp edge: an edit to a featured photo must regenerate it or the home page shows stale text. Every function here goes through `rebuildFeatured`, and the tests assert it.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/curate.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { setFeatured, editPhoto, removePhoto } from "../src/commands/curate.js";
import { commit, rebuildFeatured, rebuildIndex, readFeatured, readIndex, readMonth, KEYS } from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

function photo(id: string, takenAt: string): Photo {
  return {
    id, title: `title ${id}`, caption: "caption", location: "somewhere", takenAt, featured: false,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

let store: ReturnType<typeof createMemoryStore>;

beforeEach(async () => {
  store = createMemoryStore();
  const months: MonthFile[] = [
    { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] },
    { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-02T10:00:00-06:00")] },
  ];
  for (const m of months) {
    for (const p of m.photos) {
      await store.put(p.web.path, new Uint8Array([1]), "image/jpeg", "x");
      await store.put(p.thumb.path, new Uint8Array([1]), "image/jpeg", "x");
      await store.put(p.original.path, new Uint8Array([1]), "application/octet-stream", "x");
    }
  }
  await store.put(KEYS.keys, new TextEncoder().encode(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kdf: { alg: "argon2id", salt: "c2FsdA==", m: 65536, t: 3, p: 1, keyLen: 32 },
    verifier: { iv: "aXY=", ct: "Y3Q=" },
    keys: { a: { iv: "aXY=", ct: "Y3Q=" }, b: { iv: "aXY=", ct: "Y3Q=" } },
  })), "application/json", "x");
  await commit(store, { months, featured: rebuildFeatured(months), index: rebuildIndex(months, null) });
});

describe("setFeatured", () => {
  it("flags the photo in its month shard and in featured.json", async () => {
    await setFeatured(store, ["a"], true);
    expect((await readMonth(store, "2026-03")).photos[0]!.featured).toBe(true);
    expect((await readFeatured(store)).photos.map((p) => p.id)).toEqual(["a"]);
    expect((await readIndex(store)).featuredCount).toBe(1);
  });

  it("unfeatures", async () => {
    await setFeatured(store, ["a", "b"], true);
    await setFeatured(store, ["a"], false);
    expect((await readFeatured(store)).photos.map((p) => p.id)).toEqual(["b"]);
  });

  it("throws on an unknown id and changes nothing", async () => {
    await expect(setFeatured(store, ["nope"], true)).rejects.toThrow(/nope/);
    expect((await readFeatured(store)).photos).toEqual([]);
  });
});

describe("editPhoto", () => {
  it("amends fields in the month shard", async () => {
    await editPhoto(store, "a", { caption: "a better caption" });
    expect((await readMonth(store, "2026-03")).photos[0]!.caption).toBe("a better caption");
  });

  it("regenerates featured.json so the home page never shows stale text", async () => {
    await setFeatured(store, ["a"], true);
    await editPhoto(store, "a", { title: "a better title" });
    expect((await readFeatured(store)).photos[0]!.title).toBe("a better title");
  });

  it("leaves untouched fields alone", async () => {
    const updated = await editPhoto(store, "a", { location: "elsewhere" });
    expect(updated.title).toBe("title a");
    expect(updated.location).toBe("elsewhere");
  });
});

describe("removePhoto", () => {
  it("removes the record, its key entry, and its objects", async () => {
    await removePhoto(store, "a");
    expect((await readMonth(store, "2026-03")).photos).toEqual([]);
    expect(await store.get("orig/a.enc")).toBeNull();
    expect(await store.get("web/a-2048.aaaaaaaa.jpg")).toBeNull();
    const keys = JSON.parse(new TextDecoder().decode((await store.get(KEYS.keys))!));
    expect(keys.keys.a).toBeUndefined();
    expect(keys.keys.b).toBeDefined();
  });

  it("drops the month from the index once it is empty", async () => {
    await removePhoto(store, "a");
    expect((await readIndex(store)).months.map((m) => m.month)).toEqual(["2026-08"]);
  });

  it("regenerates featured.json when a featured photo is removed", async () => {
    await setFeatured(store, ["a"], true);
    await removePhoto(store, "a");
    expect((await readFeatured(store)).photos).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/curate.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/curate.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/commands/curate.ts
import { KeysFileSchema, type MonthFile, type Photo } from "@photos/core";
import type { Store } from "../store.js";
import {
  KEYS, commit, readAllMonths, readIndex, rebuildFeatured, rebuildIndex,
} from "../manifest.js";
import { CACHE_SHORT } from "../config.js";

export function findPhoto(
  months: MonthFile[],
  id: string,
): { month: MonthFile; photo: Photo } | null {
  for (const month of months) {
    const photo = month.photos.find((p) => p.id === id);
    if (photo) return { month, photo };
  }
  return null;
}

async function loadMonths(store: Store): Promise<{ months: MonthFile[]; lastBackupAt: string | null }> {
  const index = await readIndex(store);
  return { months: await readAllMonths(store, index), lastBackupAt: index.lastBackupAt };
}

function replacePhoto(months: MonthFile[], id: string, update: (p: Photo) => Photo | null): MonthFile[] {
  return months.map((m) => ({
    ...m,
    photos: m.photos.flatMap((p) => {
      if (p.id !== id) return [p];
      const next = update(p);
      return next ? [next] : [];
    }),
  }));
}

export async function setFeatured(store: Store, ids: string[], featured: boolean): Promise<void> {
  const { months, lastBackupAt } = await loadMonths(store);
  for (const id of ids) {
    if (!findPhoto(months, id)) throw new Error(`no photo with id ${id}`);
  }
  let next = months;
  for (const id of ids) next = replacePhoto(next, id, (p) => ({ ...p, featured }));
  await commit(store, {
    months: next,
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });
}

export async function editPhoto(
  store: Store,
  id: string,
  patch: { title?: string; caption?: string; location?: string },
): Promise<Photo> {
  const { months, lastBackupAt } = await loadMonths(store);
  if (!findPhoto(months, id)) throw new Error(`no photo with id ${id}`);

  let updated: Photo | null = null;
  const next = replacePhoto(months, id, (p) => {
    updated = { ...p, ...patch };
    return updated;
  });

  await commit(store, {
    months: next,
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });
  return updated!;
}

export async function removePhoto(store: Store, id: string): Promise<void> {
  const { months, lastBackupAt } = await loadMonths(store);
  const found = findPhoto(months, id);
  if (!found) throw new Error(`no photo with id ${id}`);

  const next = replacePhoto(months, id, () => null);

  const keysBytes = await store.get(KEYS.keys);
  if (keysBytes) {
    const keysFile = KeysFileSchema.parse(JSON.parse(new TextDecoder().decode(keysBytes)));
    delete keysFile.keys[id];
    await store.put(
      KEYS.keys,
      new TextEncoder().encode(JSON.stringify(keysFile, null, 2)),
      "application/json",
      CACHE_SHORT,
    );
  }

  await commit(store, {
    months: next,
    featured: rebuildFeatured(next),
    index: rebuildIndex(next, lastBackupAt),
  });

  // Objects are deleted last: an orphaned object is harmless, a manifest
  // pointing at a deleted object is not.
  for (const key of [found.photo.web.path, found.photo.thumb.path, found.photo.original.path]) {
    await store.delete(key);
  }
}
```

Note that `commit` writes every month shard it is handed, including ones that became empty. An empty shard drops out of the index via `rebuildIndex` but its object remains in S3; `photos gc` (Task 17) reclaims it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/curate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/curate.ts cli/test/curate.test.ts
git commit -m "feat(cli): curate photos with feature, edit, and remove"
```

---

## Task 17: `publish`, `ls`, `gc`, and `repair`

**Files:**
- Create: `cli/src/commands/maintain.ts`
- Test: `cli/test/maintain.test.ts`

**Interfaces:**
- Consumes: Tasks 10, 14, 16.
- Produces:
  - `publish(store, cdn: Cdn): Promise<{ missing: string[] }>` — reports manifest-referenced objects S3 does not have, then invalidates
  - `listPhotos(store, opts?: { month?: string; featuredOnly?: boolean }): Promise<PhotoSummary[]>`
  - `interface PhotoSummary { id: string; date: string; title: string; featured: boolean; month: string }`
  - `formatList(rows: PhotoSummary[]): string`
  - `collectGarbage(store): Promise<string[]>` — returns unreferenced object keys without deleting
  - `deleteGarbage(store, keys: string[]): Promise<void>`
  - `repair(store): Promise<IndexFile>` — rebuilds every shard, the index, and featured from the photos S3 already holds

`repair` reads the month shards named by the index, then re-derives each photo's month from its own `takenAt`, which is what lets it refile a photo that landed in the wrong shard. It is named for what it does: there is no page-size setting to re-apply, because the calendar decides shard boundaries.

`listPhotos` exists because every curation command takes an id, and ids are printed exactly once — when the photo is added. Without it, featuring something from three weeks ago means reading a shard by hand.

`collectGarbage` also sweeps `data/months/` for shards that dropped out of the index, which happens whenever the last photo in a month is removed. It refuses to propose a shard that still contains photo records, so a stale index can never cause records to be deleted.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/maintain.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import {
  publish, listPhotos, formatList, collectGarbage, deleteGarbage, repair,
} from "../src/commands/maintain.js";
import { KEYS, commit, rebuildFeatured, rebuildIndex, readIndex, readMonth } from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

function photo(id: string, takenAt: string, featured = false): Photo {
  return {
    id, title: `Title ${id}`, caption: "", location: "", takenAt, featured,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

let store: ReturnType<typeof createMemoryStore>;

async function seed(months: MonthFile[], withObjects = true) {
  if (withObjects) {
    for (const m of months) {
      for (const p of m.photos) {
        for (const k of [p.web.path, p.thumb.path, p.original.path]) {
          await store.put(k, new Uint8Array([1]), "image/jpeg", "x");
        }
      }
    }
  }
  await commit(store, { months, featured: rebuildFeatured(months), index: rebuildIndex(months, null) });
}

beforeEach(() => { store = createMemoryStore(); });

describe("publish", () => {
  it("reports nothing missing for a healthy library and invalidates", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    const invalidated: string[][] = [];
    const result = await publish(store, { invalidate: async (p) => { invalidated.push(p); } });
    expect(result.missing).toEqual([]);
    expect(invalidated[0]).toContain("/data/*");
    expect(invalidated[0]).toContain("/index.html");
  });

  it("reports an object the manifest references but S3 lacks", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }], false);
    const result = await publish(store, { invalidate: async () => {} });
    expect(result.missing).toContain("orig/a.enc");
  });
});

describe("listPhotos", () => {
  const seeded = () => seed([
    { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00", true)] },
    { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [
      photo("b", "2026-08-01T10:00:00-06:00"), photo("c", "2026-08-02T10:00:00-06:00")] },
  ]);

  it("lists the whole library newest first", async () => {
    await seeded();
    expect((await listPhotos(store)).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("carries the local date, title, and featured state", async () => {
    await seeded();
    const row = (await listPhotos(store)).find((r) => r.id === "a")!;
    expect(row).toEqual({ id: "a", date: "2026-03-14", title: "Title a", featured: true, month: "2026-03" });
  });

  it("narrows to one month", async () => {
    await seeded();
    expect((await listPhotos(store, { month: "2026-08" })).map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("narrows to the featured set", async () => {
    await seeded();
    expect((await listPhotos(store, { featuredOnly: true })).map((r) => r.id)).toEqual(["a"]);
  });

  it("returns nothing for a month with no photos", async () => {
    await seeded();
    expect(await listPhotos(store, { month: "2030-01" })).toEqual([]);
  });

  it("formats a copyable line per photo, marking featured ones", async () => {
    await seeded();
    const text = formatList(await listPhotos(store));
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("a");
    expect(text).toMatch(/★.*Title a/);
  });
});

describe("garbage collection", () => {
  it("finds unreferenced objects and leaves referenced ones alone", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    await store.put("orig/orphan.enc", new Uint8Array([9]), "application/octet-stream", "x");
    await store.put("web/orphan-640.cccccccc.jpg", new Uint8Array([9]), "image/jpeg", "x");

    const junk = (await collectGarbage(store)).sort();
    expect(junk).toEqual(["orig/orphan.enc", "web/orphan-640.cccccccc.jpg"]);

    await deleteGarbage(store, junk);
    expect(await store.get("orig/orphan.enc")).toBeNull();
    expect(await store.get("orig/a.enc")).not.toBeNull();
  });

  it("never proposes deleting a data file, a live shard, or a site asset", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    await store.put("index.html", new Uint8Array([1]), "text/html", "x");
    await store.put("assets/main.abc.js", new Uint8Array([1]), "text/javascript", "x");
    expect(await collectGarbage(store)).toEqual([]);
  });

  it("collects a month shard that dropped out of the index", async () => {
    // 2026-03 is emptied, so rebuildIndex drops it while the object remains.
    await seed([
      { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [] },
      { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-01T10:00:00-06:00")] },
    ]);
    expect(await collectGarbage(store)).toContain("data/months/2026-03.json");
  });

  it("refuses to collect an unindexed shard that still holds photo records", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-01T10:00:00-06:00")] }]);
    // A shard the index has lost track of, but which still contains a photo.
    await store.put(
      "data/months/2026-03.json",
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: SCHEMA_VERSION, month: "2026-03",
        photos: [photo("a", "2026-03-14T10:00:00-06:00")],
      })),
      "application/json", "x",
    );
    expect(await collectGarbage(store)).not.toContain("data/months/2026-03.json");
  });

  it("refuses to delete outside the prefixes it owns", async () => {
    await expect(deleteGarbage(store, ["data/index.json"])).rejects.toThrow(/refusing/);
  });
});

describe("repair", () => {
  it("is idempotent", async () => {
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] }]);
    const first = await repair(store);
    const second = await repair(store);
    expect(second.months).toEqual(first.months);
    expect(second.photoCount).toBe(1);
  });

  it("refiles a photo that is in the wrong month shard", async () => {
    // "a" belongs to 2026-08 by its takenAt but is filed under 2026-03.
    await seed([{ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-08-02T10:00:00-06:00")] }]);
    const index = await repair(store);
    expect(index.months.map((m) => m.month)).toEqual(["2026-08"]);
    expect((await readMonth(store, "2026-08")).photos[0]!.id).toBe("a");
    expect((await readMonth(store, "2026-03")).photos).toEqual([]);
  });

  it("matches an index built incrementally", async () => {
    const months = [
      { schemaVersion: SCHEMA_VERSION as 1, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] },
      { schemaVersion: SCHEMA_VERSION as 1, month: "2026-08", photos: [photo("b", "2026-08-02T10:00:00-06:00")] },
    ];
    await seed(months);
    const incremental = await readIndex(store);
    const rebuilt = await repair(store);
    expect(rebuilt.months).toEqual(incremental.months);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test cli/test/maintain.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/maintain.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/commands/maintain.ts
import {
  MonthFileSchema, localDateOf, monthOf, SCHEMA_VERSION,
  type IndexFile, type MonthFile,
} from "@photos/core";
import type { Cdn, Store } from "../store.js";
import {
  KEYS, commit, readAllMonths, readIndex, rebuildFeatured, rebuildIndex,
} from "../manifest.js";

const INVALIDATION_PATHS = ["/data/*", "/index.html"];

function referencedKeys(months: MonthFile[]): Set<string> {
  const keys = new Set<string>();
  for (const m of months) {
    for (const p of m.photos) {
      keys.add(p.web.path);
      keys.add(p.thumb.path);
      keys.add(p.original.path);
    }
  }
  return keys;
}

export async function publish(store: Store, cdn: Cdn): Promise<{ missing: string[] }> {
  const index = await readIndex(store);
  const months = await readAllMonths(store, index);
  const missing: string[] = [];
  for (const key of referencedKeys(months)) {
    if ((await store.head(key)) === null) missing.push(key);
  }
  await cdn.invalidate(INVALIDATION_PATHS);
  return { missing: missing.sort() };
}

export interface PhotoSummary {
  id: string;
  date: string;
  title: string;
  featured: boolean;
  month: string;
}

export async function listPhotos(
  store: Store,
  opts: { month?: string; featuredOnly?: boolean } = {},
): Promise<PhotoSummary[]> {
  const index = await readIndex(store);
  const wanted = opts.month
    ? index.months.filter((m) => m.month === opts.month)
    : index.months;
  const months = await readAllMonths(store, { ...index, months: wanted });

  return months
    .flatMap((m) =>
      m.photos
        .filter((p) => !opts.featuredOnly || p.featured)
        .map((p) => ({
          id: p.id,
          date: localDateOf(p.takenAt),
          title: p.title,
          featured: p.featured,
          month: m.month,
        })),
    )
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
}

export function formatList(rows: PhotoSummary[]): string {
  const width = rows.reduce((n, r) => Math.max(n, r.id.length), 0);
  return rows
    .map((r) => `${r.featured ? "★" : " "} ${r.id.padEnd(width)}  ${r.date}  ${r.title}`)
    .join("\n");
}

const COLLECTABLE_PREFIXES = ["web/", "orig/", "data/months/"];

/**
 * Candidates are derivatives, encrypted originals, and month shards the index
 * no longer lists. A shard that still holds photo records is never proposed,
 * so a stale index cannot turn into lost records.
 */
export async function collectGarbage(store: Store): Promise<string[]> {
  const index = await readIndex(store);
  const referenced = referencedKeys(await readAllMonths(store, index));
  const liveShards = new Set(index.months.map((m) => m.path));

  const assets = [...(await store.list("web/")), ...(await store.list("orig/"))]
    .filter((k) => !referenced.has(k));

  const staleShards: string[] = [];
  for (const key of await store.list("data/months/")) {
    if (liveShards.has(key)) continue;
    const body = await store.get(key);
    if (!body) continue;
    try {
      const shard = MonthFileSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      if (shard.photos.length === 0) staleShards.push(key);
    } catch {
      // Unparseable and unreferenced: safe to reclaim.
      staleShards.push(key);
    }
  }

  return [...assets, ...staleShards].sort();
}

export async function deleteGarbage(store: Store, keys: string[]): Promise<void> {
  for (const key of keys) {
    if (!COLLECTABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`refusing to delete outside ${COLLECTABLE_PREFIXES.join(", ")}: ${key}`);
    }
    await store.delete(key);
  }
}

export async function repair(store: Store): Promise<IndexFile> {
  const previous = await readIndex(store);
  const previousMonths = await readAllMonths(store, previous);
  const photos = previousMonths.flatMap((m) => m.photos);

  const grouped = new Map<string, MonthFile>();
  // Start every previously known month as empty, so a shard a photo has moved
  // out of gets rewritten as empty rather than left stale.
  for (const m of previousMonths) {
    grouped.set(m.month, { schemaVersion: SCHEMA_VERSION, month: m.month, photos: [] });
  }
  for (const photo of photos) {
    const month = monthOf(photo.takenAt);
    const shard = grouped.get(month) ?? { schemaVersion: SCHEMA_VERSION, month, photos: [] };
    grouped.set(month, { ...shard, photos: [...shard.photos, photo] });
  }

  const months = [...grouped.values()];
  const index = rebuildIndex(months, previous.lastBackupAt);
  await commit(store, { months, featured: rebuildFeatured(months), index });
  return index;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/maintain.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/maintain.ts cli/test/maintain.test.ts
git commit -m "feat(cli): add publish, ls, garbage collection, and repair"
```

---

## Task 18: `rotate-password`, `verify`, and `restore`

**Files:**
- Create: `cli/src/commands/keys.ts`, `cli/src/commands/verify.ts`
- Test: `cli/test/rotate.test.ts`, `cli/test/verify.test.ts`

**Interfaces:**
- Consumes: Tasks 10, 14; core key functions.
- Produces:
  - `rotatePassword(store, oldPassword: string, newPassword: string): Promise<{ rewrapped: number }>`
  - `restoreFile(store, path: string, versionId?: string): Promise<void>`
  - `verifyLibrary(deps: { store: Store; password?: string }): Promise<VerifyReport>`
  - `interface VerifyReport { photoCount: number; missingObjects: string[]; missingKeys: string[]; orphanKeys: string[]; featuredDrift: string[]; monthMismatches: string[]; backupAgeDays: number | null; sampleDecrypted: boolean | null; ok: boolean }`
  - `formatReport(report: VerifyReport): string`

`sampleDecrypted` is `null` when no password was given, and otherwise records whether the newest photo's original actually round-tripped. That sample is what turns `verify` from a bookkeeping check into proof the library is still readable.
  - `recordBackup(store, at: string): Promise<void>`

`rotatePassword` must never touch `orig/`. The test asserts that by snapshotting every `orig/` object before and after.

- [ ] **Step 1: Write the failing tests**

```ts
// cli/test/rotate.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { rotatePassword } from "../src/commands/keys.js";
import { KEYS, readKeys } from "../src/manifest.js";
import {
  SCHEMA_VERSION, checkVerifier, deriveMasterKey, makeVerifier, newDataKey,
  newKdfParams, unwrapDataKey, wrapDataKey,
} from "@photos/core";

const FAST = { m: 512, t: 1 };

async function seedKeys(store: ReturnType<typeof createMemoryStore>, password: string, ids: string[]) {
  const kdf = newKdfParams(FAST);
  const master = await deriveMasterKey(password, kdf);
  const keys: Record<string, { iv: string; ct: string }> = {};
  const plain: Record<string, Uint8Array> = {};
  for (const id of ids) {
    const dk = newDataKey();
    plain[id] = dk;
    keys[id] = await wrapDataKey(master, dk, id);
  }
  const file = { schemaVersion: SCHEMA_VERSION, kdf, verifier: await makeVerifier(master), keys };
  await store.put(KEYS.keys, new TextEncoder().encode(JSON.stringify(file)), "application/json", "x");
  await store.put("orig/a.enc", new Uint8Array([1, 2, 3]), "application/octet-stream", "x");
  return plain;
}

describe("rotatePassword", () => {
  it("re-wraps every key so all photos open under the new password", async () => {
    const store = createMemoryStore();
    const plain = await seedKeys(store, "old passphrase", ["a", "b"]);

    const result = await rotatePassword(store, "old passphrase", "new passphrase");
    expect(result.rewrapped).toBe(2);

    const keys = (await readKeys(store))!;
    const master = await deriveMasterKey("new passphrase", keys.kdf);
    expect(await checkVerifier(master, keys.verifier)).toBe(true);
    for (const id of ["a", "b"]) {
      expect(await unwrapDataKey(master, keys.keys[id]!, id)).toEqual(plain[id]);
    }
  });

  it("makes the old password stop working", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    await rotatePassword(store, "old passphrase", "new passphrase");
    const keys = (await readKeys(store))!;
    const oldMaster = await deriveMasterKey("old passphrase", keys.kdf);
    expect(await checkVerifier(oldMaster, keys.verifier)).toBe(false);
  });

  it("uses a fresh salt", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    const before = (await readKeys(store))!.kdf.salt;
    await rotatePassword(store, "old passphrase", "new passphrase");
    expect((await readKeys(store))!.kdf.salt).not.toBe(before);
  });

  it("rejects a wrong old password before writing anything", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    const before = (await readKeys(store))!;
    await expect(rotatePassword(store, "wrong", "new passphrase")).rejects.toThrow(/password/i);
    expect(await readKeys(store)).toEqual(before);
  });

  it("restores a month shard, not just the index", async () => {
    const store = createMemoryStore();
    const { restoreFile } = await import("../src/commands/keys.js");
    const shard = (title: string) => new TextEncoder().encode(JSON.stringify({
      schemaVersion: SCHEMA_VERSION, month: "2026-03",
      photos: [{
        id: "a", title, caption: "", location: "", takenAt: "2026-03-14T10:00:00-06:00", featured: false,
        web: { path: "web/a-2048.aaaaaaaa.jpg", w: 2048, h: 1365, bytes: 100 },
        thumb: { path: "web/a-640.bbbbbbbb.jpg", w: 640, h: 427, bytes: 10 },
        lqip: "data:image/jpeg;base64,aa",
        exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
        original: { path: "orig/a.enc", bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
      }],
    }));

    await store.put("data/months/2026-03.json", shard("the good title"), "application/json", "x");
    await store.put("data/months/2026-03.json", shard("an accidental edit"), "application/json", "x");

    await restoreFile(store, "data/months/2026-03.json");
    const back = JSON.parse(new TextDecoder().decode((await store.get("data/months/2026-03.json"))!));
    expect(back.photos[0].title).toBe("the good title");
  });

  it("refuses to restore something outside data/", async () => {
    const store = createMemoryStore();
    const { restoreFile } = await import("../src/commands/keys.js");
    await expect(restoreFile(store, "orig/a.enc")).rejects.toThrow(/only restore/);
  });

  it("never rewrites an encrypted original", async () => {
    const store = createMemoryStore();
    await seedKeys(store, "old passphrase", ["a"]);
    const before = await store.get("orig/a.enc");
    await rotatePassword(store, "old passphrase", "new passphrase");
    expect(await store.get("orig/a.enc")).toEqual(before);
    expect((await store.listVersions("orig/a.enc")).length).toBe(1);
  });
});
```

```ts
// cli/test/verify.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { verifyLibrary, recordBackup } from "../src/commands/verify.js";
import { KEYS, commit, rebuildFeatured, rebuildIndex } from "../src/manifest.js";
import { SCHEMA_VERSION, type MonthFile, type Photo } from "@photos/core";

function photo(id: string, takenAt: string, featured = false): Photo {
  return {
    id, title: id, caption: "", location: "", takenAt, featured,
    web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
    thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
    lqip: "data:image/jpeg;base64,aa",
    exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
    original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
  };
}

let store: ReturnType<typeof createMemoryStore>;
const enc = new TextEncoder();

async function seed(months: MonthFile[], keyIds: string[], objects = true) {
  if (objects) {
    for (const m of months) for (const p of m.photos) {
      for (const k of [p.web.path, p.thumb.path, p.original.path]) {
        await store.put(k, new Uint8Array([1]), "image/jpeg", "x");
      }
    }
  }
  await store.put(KEYS.keys, enc.encode(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kdf: { alg: "argon2id", salt: "c2FsdA==", m: 512, t: 1, p: 1, keyLen: 32 },
    verifier: { iv: "aXY=", ct: "Y3Q=" },
    keys: Object.fromEntries(keyIds.map((id) => [id, { iv: "aXY=", ct: "Y3Q=" }])),
  })), "application/json", "x");
  await commit(store, { months, featured: rebuildFeatured(months), index: rebuildIndex(months, null) });
}

const march = (photos: Photo[]): MonthFile => ({ schemaVersion: SCHEMA_VERSION, month: "2026-03", photos });

beforeEach(() => { store = createMemoryStore(); });

describe("verifyLibrary", () => {
  it("reports a healthy library", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"]);
    const report = await verifyLibrary({ store });
    expect(report.ok).toBe(true);
    expect(report.photoCount).toBe(1);
  });

  it("reports a missing object", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"], false);
    expect((await verifyLibrary({ store })).missingObjects).toContain("orig/a.enc");
  });

  it("reports a photo with no wrapped key", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], []);
    expect((await verifyLibrary({ store })).missingKeys).toEqual(["a"]);
  });

  it("reports a wrapped key for a photo that no longer exists", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a", "ghost"]);
    expect((await verifyLibrary({ store })).orphanKeys).toEqual(["ghost"]);
  });

  it("reports featured.json drifting from its month shard", async () => {
    const months = [march([photo("a", "2026-03-14T10:00:00-06:00", true)])];
    await seed(months, ["a"]);
    const stale = { schemaVersion: SCHEMA_VERSION, generatedAt: "x",
      photos: [{ ...photo("a", "2026-03-14T10:00:00-06:00", true), title: "an old title" }] };
    await store.put(KEYS.featured, enc.encode(JSON.stringify(stale)), "application/json", "x");
    expect((await verifyLibrary({ store })).featuredDrift).toEqual(["a"]);
  });

  it("reports a photo filed in the wrong month shard", async () => {
    await seed([march([photo("a", "2026-08-02T10:00:00-06:00")])], ["a"]);
    expect((await verifyLibrary({ store })).monthMismatches).toEqual(["a"]);
  });

  it("decrypts a sample when given the password", async () => {
    // Build a real library so the sample has something genuine to decrypt.
    const { addPhotos } = await import("../src/commands/add.js");
    const { closeExif } = await import("../src/exif.js");
    const sharp = (await import("sharp")).default;
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "photos-verify-"));
    const file = join(dir, "DSCF0001.jpg");
    writeFileSync(file, await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#456" },
    }).jpeg().toBuffer());

    const real = createMemoryStore();
    await addPhotos(
      {
        store: real,
        config: {
          bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
          siteUrl: "https://x.test", creator: "W", copyright: "c", usageTerms: "u",
          sizes: { display: 2048, thumb: 640 },
        },
        prompt: async () => ({ title: "Sample", caption: "", location: "" }),
        password: async () => "a long passphrase",
      },
      [file],
      { offset: "-06:00" },
    );
    await closeExif();

    expect((await verifyLibrary({ store: real })).sampleDecrypted).toBeNull();
    const report = await verifyLibrary({ store: real, password: "a long passphrase" });
    expect(report.sampleDecrypted).toBe(true);
    expect(report.ok).toBe(true);

    const wrong = await verifyLibrary({ store: real, password: "not the passphrase" });
    expect(wrong.sampleDecrypted).toBe(false);
    expect(wrong.ok).toBe(false);
  }, 90_000);

  it("warns when the backup is stale and not when it is fresh", async () => {
    await seed([march([photo("a", "2026-03-14T10:00:00-06:00")])], ["a"]);
    expect((await verifyLibrary({ store })).backupAgeDays).toBeNull();

    await recordBackup(store, new Date(Date.now() - 40 * 86_400_000).toISOString());
    expect((await verifyLibrary({ store })).backupAgeDays).toBeGreaterThan(30);

    await recordBackup(store, new Date().toISOString());
    expect((await verifyLibrary({ store })).backupAgeDays).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test cli/test/rotate.test.ts cli/test/verify.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// cli/src/commands/keys.ts
import {
  checkVerifier, deriveMasterKey, makeVerifier, newKdfParams, unwrapDataKey, wrapDataKey,
  FeaturedFileSchema, IndexFileSchema, KeysFileSchema, MonthFileSchema, type KeysFile,
} from "@photos/core";
import { CACHE_SHORT } from "../config.js";
import { KEYS, readKeys } from "../manifest.js";
import type { Store } from "../store.js";

const enc = new TextEncoder();

/**
 * Re-wraps every data key under a new password. No object under orig/ is read,
 * rewritten, or re-uploaded — that is the whole point of the key hierarchy.
 */
export async function rotatePassword(
  store: Store,
  oldPassword: string,
  newPassword: string,
): Promise<{ rewrapped: number }> {
  const current = await readKeys(store);
  if (!current) throw new Error("this library has no keys.json yet; add a photo first");

  const oldMaster = await deriveMasterKey(oldPassword, current.kdf);
  if (!(await checkVerifier(oldMaster, current.verifier))) {
    throw new Error("the old password is incorrect; nothing was changed");
  }

  const kdf = newKdfParams({ m: current.kdf.m, t: current.kdf.t, p: current.kdf.p });
  const newMaster = await deriveMasterKey(newPassword, kdf);

  const rewrapped: KeysFile["keys"] = {};
  for (const [id, wrapped] of Object.entries(current.keys)) {
    const dataKey = await unwrapDataKey(oldMaster, wrapped, id);
    rewrapped[id] = await wrapDataKey(newMaster, dataKey, id);
  }

  const next: KeysFile = {
    schemaVersion: current.schemaVersion,
    kdf,
    verifier: await makeVerifier(newMaster),
    keys: rewrapped,
  };

  await store.put(KEYS.keys, enc.encode(JSON.stringify(next, null, 2)), "application/json", CACHE_SHORT);
  return { rewrapped: Object.keys(rewrapped).length };
}

const RESTORABLE = new Set([KEYS.index, KEYS.keys, KEYS.featured]);

function validatorFor(path: string): (value: unknown) => unknown {
  if (path === KEYS.index) return (v) => IndexFileSchema.parse(v);
  if (path === KEYS.keys) return (v) => KeysFileSchema.parse(v);
  if (path === KEYS.featured) return (v) => FeaturedFileSchema.parse(v);
  return (v) => MonthFileSchema.parse(v);
}

/**
 * Rolls one data/ file back to a previous S3 object version.
 *
 * It names a file rather than assuming the index, because the manifest is four
 * kinds of file and the one worth rolling back is usually a month shard. The
 * restored bytes are validated against that file's schema before being written,
 * so a corrupted old version cannot be promoted back into service.
 */
export async function restoreFile(
  store: Store,
  path: string,
  versionId?: string,
): Promise<void> {
  if (!RESTORABLE.has(path) && !path.startsWith("data/months/")) {
    throw new Error(`can only restore data/ manifest files, not ${path}`);
  }

  const versions = await store.listVersions(path);
  if (versions.length < 2 && !versionId) {
    throw new Error(`no previous version of ${path} to restore`);
  }

  const target = versionId ?? versions[1]!.versionId;
  const body = await store.getVersion(path, target);
  validatorFor(path)(JSON.parse(new TextDecoder().decode(body)));
  await store.put(path, body, "application/json", CACHE_SHORT);
}

export async function listFileVersions(
  store: Store,
  path: string,
): Promise<{ versionId: string; lastModified: string }[]> {
  return store.listVersions(path);
}
```

```ts
// cli/src/commands/verify.ts
import {
  checkVerifier, decryptOriginal, deriveMasterKey, monthOf, unwrapDataKey,
} from "@photos/core";
import { CACHE_SHORT } from "../config.js";
import { KEYS, commit, readAllMonths, readFeatured, readIndex, readKeys, rebuildFeatured } from "../manifest.js";
import type { Store } from "../store.js";

export interface VerifyReport {
  photoCount: number;
  missingObjects: string[];
  missingKeys: string[];
  orphanKeys: string[];
  featuredDrift: string[];
  monthMismatches: string[];
  backupAgeDays: number | null;
  sampleDecrypted: boolean | null;
  ok: boolean;
}

/** Patches lastBackupAt onto the existing index; never rebuilds it from scratch. */
export async function recordBackup(store: Store, at: string): Promise<void> {
  const index = await readIndex(store);
  await commit(store, { index: { ...index, lastBackupAt: at } });
}

export async function verifyLibrary(
  deps: { store: Store; password?: string },
): Promise<VerifyReport> {
  const { store } = deps;
  const index = await readIndex(store);
  const months = await readAllMonths(store, index);
  const photos = months.flatMap((m) => m.photos);
  const keys = await readKeys(store);
  const featured = await readFeatured(store);

  const missingObjects: string[] = [];
  for (const p of photos) {
    for (const key of [p.web.path, p.thumb.path, p.original.path]) {
      if ((await store.head(key)) === null) missingObjects.push(key);
    }
  }

  const keyIds = new Set(Object.keys(keys?.keys ?? {}));
  const photoIds = new Set(photos.map((p) => p.id));
  const missingKeys = photos.filter((p) => !keyIds.has(p.id)).map((p) => p.id);
  const orphanKeys = [...keyIds].filter((id) => !photoIds.has(id));

  const expected = rebuildFeatured(months);
  const expectedById = new Map(expected.photos.map((p) => [p.id, p]));
  const actualById = new Map(featured.photos.map((p) => [p.id, p]));
  const featuredDrift = [...new Set([...expectedById.keys(), ...actualById.keys()])].filter((id) => {
    const a = expectedById.get(id);
    const b = actualById.get(id);
    return JSON.stringify(a) !== JSON.stringify(b);
  });

  const monthMismatches = months.flatMap((m) =>
    m.photos.filter((p) => monthOf(p.takenAt) !== m.month).map((p) => p.id),
  );

  const backupAgeDays = index.lastBackupAt
    ? (Date.now() - Date.parse(index.lastBackupAt)) / 86_400_000
    : null;

  // With a password, prove the library is still readable rather than merely
  // well-bookkept: unwrap the newest photo's key and decrypt its original.
  let sampleDecrypted: boolean | null = null;
  if (deps.password && keys && photos.length > 0) {
    sampleDecrypted = false;
    const newest = photos.reduce((a, b) => (a.takenAt >= b.takenAt ? a : b));
    const wrapped = keys.keys[newest.id];
    const container = await store.get(newest.original.path);
    if (wrapped && container) {
      try {
        const master = await deriveMasterKey(deps.password, keys.kdf);
        if (await checkVerifier(master, keys.verifier)) {
          const dataKey = await unwrapDataKey(master, wrapped, newest.id);
          const plain = await decryptOriginal(container, dataKey, newest.id);
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", plain))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          sampleDecrypted = digest === newest.original.sha256;
        }
      } catch {
        sampleDecrypted = false;
      }
    }
  }

  return {
    photoCount: photos.length,
    missingObjects: missingObjects.sort(),
    missingKeys: missingKeys.sort(),
    orphanKeys: orphanKeys.sort(),
    featuredDrift: featuredDrift.sort(),
    monthMismatches: monthMismatches.sort(),
    backupAgeDays,
    sampleDecrypted,
    ok:
      missingObjects.length === 0 &&
      missingKeys.length === 0 &&
      orphanKeys.length === 0 &&
      featuredDrift.length === 0 &&
      monthMismatches.length === 0 &&
      sampleDecrypted !== false,
  };
}

export function formatReport(report: VerifyReport): string {
  const lines = [`${report.photoCount} photos`];
  const section = (label: string, items: string[]) => {
    if (items.length) lines.push(`${label}: ${items.join(", ")}`);
  };
  section("missing objects", report.missingObjects);
  section("photos with no key", report.missingKeys);
  section("keys with no photo", report.orphanKeys);
  section("featured.json drift", report.featuredDrift);
  section("photos in the wrong month shard", report.monthMismatches);
  if (report.sampleDecrypted === true) lines.push("sample original decrypted and matched its checksum");
  if (report.sampleDecrypted === false) lines.push("SAMPLE DECRYPTION FAILED");
  if (report.backupAgeDays === null) {
    lines.push("WARNING: no backup has ever been recorded. See infra/README.md.");
  } else if (report.backupAgeDays > 30) {
    lines.push(`WARNING: last backup was ${Math.floor(report.backupAgeDays)} days ago.`);
  }
  lines.push(report.ok ? "OK" : "PROBLEMS FOUND");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/rotate.test.ts cli/test/verify.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/keys.ts cli/src/commands/verify.ts cli/test/rotate.test.ts cli/test/verify.test.ts
git commit -m "feat(cli): rotate passwords without touching originals, and verify the library"
```

---

## Task 19: `deploy-site` and the command-line entry point

**Files:**
- Create: `cli/src/commands/deploy.ts`, `cli/src/args.ts`, `cli/src/bin.ts`
- Test: `cli/test/deploy.test.ts`, `cli/test/args.test.ts`

**Interfaces:**
- Consumes: Tasks 9, 10, 17.
- Produces:
  - `uploadSite(store, cdn, dir: string): Promise<string[]>` — uploads a built `site/dist`, returns the keys written
  - `contentTypeFor(path: string): string`
  - `parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> }`
  - a `photos` binary dispatching every command from Tasks 15–18

The cache rule is the thing worth testing: hashed files under `assets/` are immutable, while `index.html` and `robots.txt` must not be, or a deploy would be invisible for a year.

- [ ] **Step 1: Write the failing test**

```ts
// cli/test/deploy.test.ts
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
```

```ts
// cli/test/args.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("separates positionals from a flag and its value", () => {
    const { positional, flags } = parseArgs(["a.jpg", "--offset", "-06:00", "b.jpg"]);
    expect(positional).toEqual(["a.jpg", "b.jpg"]);
    expect(flags.offset).toBe("-06:00");
  });

  it("treats a flag with no value as a boolean", () => {
    const { positional, flags } = parseArgs(["a.jpg", "--keep-gps"]);
    expect(positional).toEqual(["a.jpg"]);
    expect(flags["keep-gps"]).toBe(true);
  });

  it("does not swallow a following flag as a value", () => {
    const { flags } = parseArgs(["--keep-gps", "--offset", "+01:00"]);
    expect(flags["keep-gps"]).toBe(true);
    expect(flags.offset).toBe("+01:00");
  });

  it("accepts --flag=value", () => {
    expect(parseArgs(["--title=Santa Elena"]).flags.title).toBe("Santa Elena");
  });

  it("keeps a negative number as a flag value, not a flag", () => {
    expect(parseArgs(["--offset", "-06:00"]).flags.offset).toBe("-06:00");
  });

  it("returns empty results for no arguments", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test cli/test/deploy.test.ts cli/test/args.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/deploy.js'`.

- [ ] **Step 3: Implement**

```ts
// cli/src/commands/deploy.ts
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
```

```ts
// cli/src/args.ts

/**
 * A token starting with "--" is a flag. It takes the next token as its value
 * unless that token is itself a flag, in which case the flag is boolean.
 * "-06:00" is a value, not a flag, because only a double dash starts one.
 */
export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return { positional, flags };
}
```

```ts
// cli/src/bin.ts
#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { createCloudFrontCdn, createS3Store } from "./store.js";
import { promptPassword } from "./password.js";
import { addPhotos } from "./commands/add.js";
import { editPhoto, removePhoto, setFeatured } from "./commands/curate.js";
import {
  collectGarbage, deleteGarbage, formatList, listPhotos, publish, repair,
} from "./commands/maintain.js";
import { listFileVersions, restoreFile, rotatePassword } from "./commands/keys.js";
import { formatReport, recordBackup, verifyLibrary } from "./commands/verify.js";
import { uploadSite } from "./commands/deploy.js";
import { closeExif, type ExtractedExif } from "./exif.js";
import { parseArgs } from "./args.js";

const USAGE = `photos <command>

  add <files...> [--location "Big Bend NP"] [--keep-gps] [--offset ±HH:MM]
                              ingest, encrypt, and publish. --location applies
                              to the whole batch instead of prompting per file
  ls [month] [--featured]     list ids, dates, and titles (★ marks featured)
  edit <id> [--title t] [--caption c] [--location l]
  rm <id>
  feature <ids...>            mark photos for the home page
  unfeature <ids...>
  publish                     re-upload anything missing and invalidate the CDN
  deploy-site [dir]           upload site/dist (default: site/dist)
  repair                      rebuild shards, index, and featured from S3
  verify [--decrypt-sample]   check the library is consistent
  gc [--yes]                  list and optionally delete unreferenced objects
  rotate-password             re-wrap every data key under a new password
  restore <data/path> [ver]   roll one manifest file back a version
  record-backup               stamp today as the last backup date
`;

async function askPhoto(file: string, exif: ExtractedExif, askLocation: boolean) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${file}  (${exif.takenAt}, ${exif.exif.camera})\n`);
    const title = await rl.question("  Title: ");
    const caption = await rl.question("  Caption: ");
    if (!askLocation) return { title, caption };
    return { title, caption, location: await rl.question("  Location: ") };
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help") { process.stdout.write(USAGE); return 0; }

  const { positional, flags } = parseArgs(rest);
  const str = (name: string): string | undefined =>
    typeof flags[name] === "string" ? (flags[name] as string) : undefined;

  const config = loadConfig();
  const store = createS3Store(config);
  const cdn = createCloudFrontCdn(config);

  switch (command) {
    case "add": {
      const added = await addPhotos(
        { store, config, prompt: askPhoto, password: () => promptPassword("Library password: ") },
        positional,
        {
          keepGps: flags["keep-gps"] === true,
          offset: str("offset"),
          location: str("location"),
        },
      );
      for (const p of added) process.stdout.write(`added ${p.id}\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "ls": {
      const rows = await listPhotos(store, {
        month: positional[0],
        featuredOnly: flags.featured === true,
      });
      if (!rows.length) { process.stdout.write("no photos\n"); return 0; }
      process.stdout.write(`${formatList(rows)}\n${rows.length} photos\n`);
      return 0;
    }
    case "edit": {
      const patch = { title: str("title"), caption: str("caption"), location: str("location") };
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const updated = await editPhoto(store, positional[0]!, defined);
      process.stdout.write(`updated ${updated.id}\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "rm":
      await removePhoto(store, positional[0]!);
      await cdn.invalidate(["/data/*"]);
      return 0;
    case "feature":
    case "unfeature":
      await setFeatured(store, positional, command === "feature");
      await cdn.invalidate(["/data/*"]);
      return 0;
    case "publish": {
      const { missing } = await publish(store, cdn);
      if (missing.length) {
        process.stderr.write(`missing objects:\n  ${missing.join("\n  ")}\n`);
        process.stderr.write("re-run `photos add` for these photos, or `photos rm` to drop them\n");
        return 1;
      }
      process.stdout.write("published\n");
      return 0;
    }
    case "deploy-site":
      await uploadSite(store, cdn, positional[0] ?? "site/dist");
      process.stdout.write("site deployed\n");
      return 0;
    case "repair": {
      const index = await repair(store);
      process.stdout.write(`rebuilt ${index.photoCount} photos across ${index.months.length} months\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "verify": {
      const password = flags["decrypt-sample"] === true
        ? await promptPassword("Library password: ")
        : undefined;
      const report = await verifyLibrary({ store, ...(password ? { password } : {}) });
      process.stdout.write(`${formatReport(report)}\n`);
      return report.ok ? 0 : 1;
    }
    case "gc": {
      const junk = await collectGarbage(store);
      if (!junk.length) { process.stdout.write("nothing to collect\n"); return 0; }
      process.stdout.write(`${junk.length} unreferenced objects:\n  ${junk.join("\n  ")}\n`);
      if (flags.yes !== true) { process.stdout.write("re-run with --yes to delete\n"); return 0; }
      await deleteGarbage(store, junk);
      process.stdout.write("deleted\n");
      return 0;
    }
    case "rotate-password": {
      const oldPassword = await promptPassword("Current password: ");
      const newPassword = await promptPassword("New password: ");
      const again = await promptPassword("New password again: ");
      if (newPassword !== again) { process.stderr.write("passwords did not match\n"); return 1; }
      const { rewrapped } = await rotatePassword(store, oldPassword, newPassword);
      process.stdout.write(`re-wrapped ${rewrapped} keys; no originals were touched\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "restore": {
      const path = positional[0];
      if (!path) {
        process.stderr.write("usage: photos restore <data/path> [version]\n");
        return 1;
      }
      if (!positional[1]) {
        const versions = await listFileVersions(store, path);
        process.stdout.write(`${versions.length} versions of ${path}:\n`);
        for (const v of versions) process.stdout.write(`  ${v.versionId}  ${v.lastModified}\n`);
      }
      await restoreFile(store, path, positional[1]);
      process.stdout.write(`restored ${path}\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "record-backup":
      await recordBackup(store, new Date().toISOString());
      await cdn.invalidate(["/data/*"]);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main()
  .then(async (code) => { await closeExif(); process.exit(code); })
  .catch(async (err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    await closeExif();
    process.exit(1);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test cli/test/deploy.test.ts cli/test/args.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/deploy.ts cli/src/bin.ts cli/src/args.ts cli/test/deploy.test.ts cli/test/args.test.ts
git commit -m "feat(cli): deploy the built site and wire up the photos binary"
```

---

## Task 20: Site scaffold and URL state

**Files:**
- Create: `site/package.json`, `site/tsconfig.json`, `site/vite.config.ts`, `site/index.html`, `site/public/robots.txt`, `site/src/styles.css`, `site/src/urlstate.ts`, `site/src/main.ts`
- Test: `site/test/urlstate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type View = { kind: "home" } | { kind: "month"; month: string } | { kind: "photo"; id: string; month: string | null }`
  - `parseView(search: string): View`
  - `viewToSearch(view: View): string`
  - `navigate(view: View): void` — pushes state without reloading
  - `onNavigate(fn: (view: View) => void): void` — fires on popstate

- [ ] **Step 1: Write the failing test**

```ts
// site/test/urlstate.test.ts
import { describe, it, expect } from "vitest";
import { parseView, viewToSearch } from "../src/urlstate.js";

describe("parseView", () => {
  it("defaults to the curated home page", () => {
    expect(parseView("")).toEqual({ kind: "home" });
    expect(parseView("?")).toEqual({ kind: "home" });
  });

  it("reads a month", () => {
    expect(parseView("?m=2026-03")).toEqual({ kind: "month", month: "2026-03" });
  });

  it("reads a photo, carrying its month when present", () => {
    expect(parseView("?m=2026-03&photo=abc")).toEqual({ kind: "photo", id: "abc", month: "2026-03" });
    expect(parseView("?photo=abc")).toEqual({ kind: "photo", id: "abc", month: null });
  });

  it("ignores a malformed month rather than showing an error page", () => {
    expect(parseView("?m=2026-3")).toEqual({ kind: "home" });
    expect(parseView("?m=nonsense")).toEqual({ kind: "home" });
  });
});

describe("viewToSearch", () => {
  it("round-trips every view", () => {
    for (const view of [
      { kind: "home" } as const,
      { kind: "month", month: "2026-03" } as const,
      { kind: "photo", id: "abc", month: "2026-03" } as const,
      { kind: "photo", id: "abc", month: null } as const,
    ]) {
      expect(parseView(viewToSearch(view))).toEqual(view);
    }
  });

  it("produces a clean url for home", () => {
    expect(viewToSearch({ kind: "home" })).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test site/test/urlstate.test.ts`
Expected: FAIL — the `site` workspace does not exist.

- [ ] **Step 3: Create the site workspace**

```json
// site/package.json
{
  "name": "@photos/site",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "build": "vite build", "dev": "vite" },
  "dependencies": { "@photos/core": "*" },
  "devDependencies": { "vite": "^5.4.0", "jsdom": "^25.0.0" }
}
```

```ts
// site/vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    assetsDir: "assets",
    // The worker is a separate entry so Argon2id never runs on the main thread.
    rollupOptions: { output: { entryFileNames: "assets/[name].[hash].js" } },
  },
  worker: { format: "es" },
  test: { environment: "jsdom" },
});
```

```html
<!-- site/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noai, noimageai" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    />
    <title>Photographs</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="site-title" href="/">Photographs</a>
      <nav id="nav"></nav>
    </header>
    <main id="app">
      <noscript>
        <p>
          This gallery builds itself from a photo index in your browser, so it needs
          JavaScript enabled. Nothing is loaded from anywhere but this site.
        </p>
      </noscript>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

The CSP is duplicated here and in the CloudFront response headers policy from Task 9. The meta tag protects local development, where CloudFront is not in the path; the header is authoritative in production.

```
# site/public/robots.txt
User-agent: GPTBot
Disallow: /
User-agent: ChatGPT-User
Disallow: /
User-agent: OAI-SearchBot
Disallow: /
User-agent: CCBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
User-agent: anthropic-ai
Disallow: /
User-agent: Google-Extended
Disallow: /
User-agent: Applebot-Extended
Disallow: /
User-agent: Bytespider
Disallow: /
User-agent: PerplexityBot
Disallow: /
User-agent: Amazonbot
Disallow: /
User-agent: Meta-ExternalAgent
Disallow: /
User-agent: Diffbot
Disallow: /
User-agent: ImagesiftBot
Disallow: /
User-agent: Omgilibot
Disallow: /

User-agent: *
Allow: /
```

```ts
// site/src/urlstate.ts
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export type View =
  | { kind: "home" }
  | { kind: "month"; month: string }
  | { kind: "photo"; id: string; month: string | null };

export function parseView(search: string): View {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawMonth = params.get("m");
  const month = rawMonth && MONTH.test(rawMonth) ? rawMonth : null;
  const photo = params.get("photo");
  if (photo) return { kind: "photo", id: photo, month };
  if (month) return { kind: "month", month };
  return { kind: "home" };
}

export function viewToSearch(view: View): string {
  const params = new URLSearchParams();
  if (view.kind === "month") params.set("m", view.month);
  if (view.kind === "photo") {
    if (view.month) params.set("m", view.month);
    params.set("photo", view.id);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function navigate(view: View): void {
  history.pushState(view, "", `${location.pathname}${viewToSearch(view)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function onNavigate(fn: (view: View) => void): void {
  window.addEventListener("popstate", () => fn(parseView(location.search)));
}

export function currentView(): View {
  return parseView(location.search);
}
```

```ts
// site/src/main.ts
import { currentView, onNavigate } from "./urlstate.js";

async function render(): Promise<void> {
  // Filled in by Task 22.
  document.querySelector("#app")!.textContent = JSON.stringify(currentView());
}

onNavigate(() => void render());
void render();
```

- [ ] **Step 4: Install and run the tests**

Run: `npm install vite@^5.4.0 jsdom@^25.0.0 --workspace site`
Run: `npm test site/test/urlstate.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add site/ package-lock.json
git commit -m "feat(site): scaffold the Vite app with CSP, robots.txt, and URL state"
```

---

## Task 21: Library loader

**Files:**
- Create: `site/src/library.ts`
- Test: `site/test/library.test.ts`

**Interfaces:**
- Consumes: core schemas (Task 8), `View` (Task 20).
- Produces:
  - `createLibrary(fetchFn?: typeof fetch): Library`
  - `interface Library { months(): Promise<MonthEntry[]>; month(m: string): Promise<MonthFile>; featured(): Promise<Photo[]>; photo(id: string, month: string | null): Promise<Photo | null>; index(): Promise<IndexFile> }`

Caching matters here: revisiting a month must not refetch, because the month rail makes back-and-forth navigation the common case.

- [ ] **Step 1: Write the failing test**

```ts
// site/test/library.test.ts
import { describe, it, expect, vi } from "vitest";
import { createLibrary } from "../src/library.js";
import { SCHEMA_VERSION } from "@photos/core";

const photo = (id: string, takenAt: string, featured = false) => ({
  id, title: id, caption: "", location: "", takenAt, featured,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

const index = {
  schemaVersion: SCHEMA_VERSION, generatedAt: "t", lastBackupAt: null,
  photoCount: 2, featuredCount: 1, sort: "takenAt:desc",
  months: [
    { month: "2026-08", count: 1, path: "data/months/2026-08.json" },
    { month: "2026-03", count: 1, path: "data/months/2026-03.json" },
  ],
};

const files: Record<string, unknown> = {
  "/data/index.json": index,
  "/data/months/2026-08.json": { schemaVersion: SCHEMA_VERSION, month: "2026-08", photos: [photo("b", "2026-08-02T10:00:00-06:00", true)] },
  "/data/months/2026-03.json": { schemaVersion: SCHEMA_VERSION, month: "2026-03", photos: [photo("a", "2026-03-14T10:00:00-06:00")] },
  "/data/featured.json": { schemaVersion: SCHEMA_VERSION, generatedAt: "t", photos: [photo("b", "2026-08-02T10:00:00-06:00", true)] },
};

function fakeFetch() {
  return vi.fn(async (url: string) => {
    const body = files[url];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("library", () => {
  it("lists months newest first", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect((await lib.months()).map((m) => m.month)).toEqual(["2026-08", "2026-03"]);
  });

  it("fetches the index only once across many calls", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    await lib.months();
    await lib.months();
    await lib.month("2026-03");
    expect(f.mock.calls.filter(([u]) => u === "/data/index.json")).toHaveLength(1);
  });

  it("caches a month shard", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    await lib.month("2026-03");
    await lib.month("2026-03");
    expect(f.mock.calls.filter(([u]) => u === "/data/months/2026-03.json")).toHaveLength(1);
  });

  it("returns featured photos", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect((await lib.featured()).map((p) => p.id)).toEqual(["b"]);
  });

  it("finds a photo in a known month without scanning others", async () => {
    const f = fakeFetch();
    const lib = createLibrary(f as unknown as typeof fetch);
    expect((await lib.photo("a", "2026-03"))!.id).toBe("a");
    expect(f.mock.calls.some(([u]) => u === "/data/months/2026-08.json")).toBe(false);
  });

  it("finds a photo with no month hint by searching newest first", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect((await lib.photo("a", null))!.id).toBe("a");
  });

  it("returns null for an unknown photo", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    expect(await lib.photo("ghost", null)).toBeNull();
  });

  it("throws a useful error for a month that is not in the index", async () => {
    const lib = createLibrary(fakeFetch() as unknown as typeof fetch);
    await expect(lib.month("2030-01")).rejects.toThrow(/2030-01/);
  });

  it("throws when the index itself cannot be loaded", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 500 }));
    const lib = createLibrary(f as unknown as typeof fetch);
    await expect(lib.months()).rejects.toThrow(/index/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test site/test/library.test.ts`
Expected: FAIL — `Cannot find module '../src/library.js'`.

- [ ] **Step 3: Implement**

```ts
// site/src/library.ts
import {
  FeaturedFileSchema, IndexFileSchema, MonthFileSchema,
  type IndexFile, type MonthEntry, type MonthFile, type Photo,
} from "@photos/core";

export interface Library {
  index(): Promise<IndexFile>;
  months(): Promise<MonthEntry[]>;
  month(m: string): Promise<MonthFile>;
  featured(): Promise<Photo[]>;
  photo(id: string, month: string | null): Promise<Photo | null>;
  prefetch(m: string): void;
}

export function createLibrary(fetchFn: typeof fetch = fetch): Library {
  let indexPromise: Promise<IndexFile> | null = null;
  let featuredPromise: Promise<Photo[]> | null = null;
  const monthCache = new Map<string, Promise<MonthFile>>();

  async function getJson(url: string, what: string): Promise<unknown> {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`could not load ${what} (${res.status})`);
    return res.json();
  }

  function index(): Promise<IndexFile> {
    indexPromise ??= getJson("/data/index.json", "the photo index").then((r) =>
      IndexFileSchema.parse(r),
    );
    return indexPromise;
  }

  async function month(m: string): Promise<MonthFile> {
    const cached = monthCache.get(m);
    if (cached) return cached;

    const entry = (await index()).months.find((x) => x.month === m);
    if (!entry) throw new Error(`no photos for ${m}`);

    const promise = getJson(`/${entry.path}`, `photos for ${m}`).then((r) => MonthFileSchema.parse(r));
    monthCache.set(m, promise);
    return promise;
  }

  return {
    index,
    async months() {
      return (await index()).months;
    },
    month,
    featured() {
      featuredPromise ??= getJson("/data/featured.json", "the featured photos").then(
        (r) => FeaturedFileSchema.parse(r).photos,
      );
      return featuredPromise;
    },
    async photo(id, hint) {
      if (hint) {
        return (await month(hint)).photos.find((p) => p.id === id) ?? null;
      }
      for (const entry of (await index()).months) {
        const found = (await month(entry.month)).photos.find((p) => p.id === id);
        if (found) return found;
      }
      return null;
    },
    prefetch(m) {
      void month(m).catch(() => {});
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test site/test/library.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add site/src/library.ts site/test/library.test.ts
git commit -m "feat(site): load and cache the month-sharded library"
```

---

## Task 22: Home page, month rail, and grid

**Files:**
- Create: `site/src/gallery.ts`
- Modify: `site/src/main.ts`, `site/src/styles.css`
- Test: `site/test/gallery.test.ts`

**Interfaces:**
- Consumes: `Library` (Task 21), `View`/`navigate` (Task 20).
- Produces:
  - `renderHome(root: HTMLElement, photos: Photo[]): void`
  - `renderMonth(root: HTMLElement, month: string, photos: Photo[]): void`
  - `renderRail(nav: HTMLElement, months: MonthEntry[], active: string | null): void`
  - `renderError(root: HTMLElement, message: string, retry: () => void): void`
  - `thumbnail(photo: Photo): HTMLElement`

- [ ] **Step 1: Write the failing test**

```ts
// site/test/gallery.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHome, renderMonth, renderRail, renderError, thumbnail } from "../src/gallery.js";
import type { Photo } from "@photos/core";

const photo = (id: string, takenAt: string): Photo => ({
  id, title: `Title ${id}`, caption: `Caption ${id}`, location: "Big Bend NP", takenAt, featured: false,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "Fujifilm X-T5", lens: "XF 16-55mm", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "<div id='app'></div><nav id='nav'></nav>";
  root = document.querySelector("#app")!;
});

describe("thumbnail", () => {
  it("sets explicit dimensions so the grid does not shift", () => {
    const img = thumbnail(photo("a", "2026-03-14T10:00:00-06:00")).querySelector("img")!;
    expect(img.getAttribute("width")).toBe("640");
    expect(img.getAttribute("height")).toBe("427");
  });

  it("lazy-loads and uses the lqip as a background placeholder", () => {
    const fig = thumbnail(photo("a", "2026-03-14T10:00:00-06:00"));
    const img = fig.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(fig.getAttribute("style")).toContain("data:image/jpeg;base64,aa");
  });

  it("uses the title as alt text and the caption as the description", () => {
    const img = thumbnail(photo("a", "2026-03-14T10:00:00-06:00")).querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Title a");
  });

  it("links to the photo with its month", () => {
    const link = thumbnail(photo("a", "2026-03-14T10:00:00-06:00")).querySelector("a")!;
    expect(link.getAttribute("href")).toBe("?m=2026-03&photo=a");
  });
});

describe("renderHome", () => {
  it("renders the curated set with a browse-all link", () => {
    renderHome(root, [photo("a", "2026-03-14T10:00:00-06:00")]);
    expect(root.querySelectorAll("figure")).toHaveLength(1);
    expect(root.textContent).toContain("Browse all");
  });

  it("explains itself when nothing is featured yet", () => {
    renderHome(root, []);
    expect(root.textContent).toMatch(/no featured photos/i);
    expect(root.textContent).toContain("Browse all");
  });
});

describe("renderMonth", () => {
  it("renders a heading and every photo in one grid", () => {
    renderMonth(root, "2026-03", [
      photo("a", "2026-03-14T10:00:00-06:00"),
      photo("b", "2026-03-15T10:00:00-06:00"),
    ]);
    expect(root.querySelector("h1")!.textContent).toBe("March 2026");
    expect(root.querySelectorAll("figure")).toHaveLength(2);
  });

  it("applies content-visibility so heavy months stay affordable", () => {
    renderMonth(root, "2026-03", [photo("a", "2026-03-14T10:00:00-06:00")]);
    expect(root.querySelector(".grid")!.className).toContain("grid");
  });
});

describe("renderRail", () => {
  it("groups months under years with counts and marks the active one", () => {
    const nav = document.querySelector("#nav") as HTMLElement;
    renderRail(nav, [
      { month: "2026-08", count: 151, path: "p" },
      { month: "2026-03", count: 147, path: "p" },
      { month: "2025-12", count: 20, path: "p" },
    ], "2026-03");

    expect(nav.querySelectorAll(".rail-year")).toHaveLength(2);
    expect(nav.textContent).toContain("August 2026");
    expect(nav.textContent).toContain("151");
    expect(nav.querySelector("[aria-current='page']")!.textContent).toContain("March 2026");
  });
});

describe("renderError", () => {
  it("shows the message and a working retry button", () => {
    let retried = 0;
    renderError(root, "could not load photos for 2026-03", () => { retried++; });
    expect(root.textContent).toContain("could not load photos");
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(retried).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test site/test/gallery.test.ts`
Expected: FAIL — `Cannot find module '../src/gallery.js'`.

- [ ] **Step 3: Implement**

```ts
// site/src/gallery.ts
import type { MonthEntry, Photo } from "@photos/core";
import { viewToSearch } from "./urlstate.js";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function thumbnail(photo: Photo): HTMLElement {
  const month = photo.takenAt.slice(0, 7);
  const href = viewToSearch({ kind: "photo", id: photo.id, month });

  const img = el("img", {
    src: `/${photo.thumb.path}`,
    alt: photo.title,
    width: String(photo.thumb.w),
    height: String(photo.thumb.h),
    loading: "lazy",
    decoding: "async",
  });

  const figure = el("figure", {
    class: "thumb",
    // The lqip sits behind the image so there is no flash of empty space.
    style: `background-image:url(${photo.lqip});background-size:cover;`,
  });
  figure.append(el("a", { href, "data-photo": photo.id }, img));
  return figure;
}

function grid(photos: Photo[]): HTMLElement {
  const g = el("div", { class: "grid" });
  for (const p of photos) g.append(thumbnail(p));
  return g;
}

export function renderHome(root: HTMLElement, photos: Photo[]): void {
  root.replaceChildren();
  root.append(el("h1", {}, "Selected work"));
  if (photos.length === 0) {
    root.append(el("p", { class: "empty" },
      "There are no featured photos yet. Everything published lives in the archive."));
  } else {
    root.append(grid(photos));
  }
  root.append(el("p", { class: "browse-all" },
    el("a", { href: "#", "data-browse-all": "true" }, "Browse all photos →")));
}

export function renderMonth(root: HTMLElement, month: string, photos: Photo[]): void {
  root.replaceChildren();
  root.append(el("h1", {}, monthLabel(month)));
  root.append(el("p", { class: "count" }, `${photos.length} photographs`));
  root.append(grid(photos));
}

export function renderRail(nav: HTMLElement, months: MonthEntry[], active: string | null): void {
  nav.replaceChildren();
  const byYear = new Map<string, MonthEntry[]>();
  for (const m of months) {
    const year = m.month.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), m]);
  }

  for (const [year, entries] of byYear) {
    const section = el("details", { class: "rail-year", ...(entries.some((e) => e.month === active) ? { open: "" } : {}) });
    section.append(el("summary", {}, year));
    const list = el("ul");
    for (const entry of entries) {
      const link = el(
        "a",
        {
          href: viewToSearch({ kind: "month", month: entry.month }),
          ...(entry.month === active ? { "aria-current": "page" } : {}),
        },
        `${monthLabel(entry.month)} (${entry.count})`,
      );
      list.append(el("li", {}, link));
    }
    section.append(list);
    nav.append(section);
  }
}

export function renderError(root: HTMLElement, message: string, retry: () => void): void {
  root.replaceChildren();
  root.append(el("p", { class: "error", role: "alert" }, message));
  const button = el("button", { type: "button" }, "Try again");
  button.addEventListener("click", retry);
  root.append(button);
}
```

Add to `site/src/styles.css` a `.grid` rule using `display:grid`, `grid-template-columns:repeat(auto-fill,minmax(220px,1fr))`, `gap:12px`, and `content-visibility:auto` with `contain-intrinsic-size: 300px` on `.thumb`, which is what keeps a 400-photo month affordable.

- [ ] **Step 4: Wire it into `main.ts`, run the tests**

`main.ts` reads the view, renders the rail from `library.months()`, renders home or a month, prefetches the adjacent months on `requestIdleCallback`, and calls `renderError` with a retry that re-runs the same render.

Run: `npm test site/test/gallery.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add site/src/gallery.ts site/src/main.ts site/src/styles.css site/test/gallery.test.ts
git commit -m "feat(site): render the curated home page, month rail, and grid"
```

---

## Task 23: Lightbox

**Files:**
- Create: `site/src/lightbox.ts`
- Modify: `site/src/main.ts`, `site/src/styles.css`
- Test: `site/test/lightbox.test.ts`

**Interfaces:**
- Consumes: `Photo`, `navigate` (Task 20), `monthLabel` (Task 22).
- Produces:
  - `openLightbox(opts: LightboxOptions): LightboxHandle`
  - `interface LightboxOptions { photo: Photo; neighbours: { prev: Photo | null; next: Photo | null }; onNavigate: (photo: Photo) => void; onClose: () => void; returnFocusTo: HTMLElement | null }`
  - `interface LightboxHandle { close(): void; element: HTMLElement; setSlot(name: "originals", node: Node): void }`
  - `exifLine(photo: Photo): string`

`setSlot` is the seam Task 25 fills with the unlock controls, so the lightbox itself stays ignorant of encryption.

- [ ] **Step 1: Write the failing test**

```ts
// site/test/lightbox.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { openLightbox, exifLine } from "../src/lightbox.js";
import type { Photo } from "@photos/core";

const photo = (id: string): Photo => ({
  id, title: `Title ${id}`, caption: `Caption ${id}`, location: "Big Bend NP",
  takenAt: "2026-03-14T18:22:05-06:00", featured: false,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "Fujifilm X-T5", lens: "XF 16-55mm", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

let opener: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = "<button id='opener'>open</button>";
  opener = document.querySelector("#opener")!;
});

function open(overrides: Partial<Parameters<typeof openLightbox>[0]> = {}) {
  return openLightbox({
    photo: photo("b"),
    neighbours: { prev: photo("a"), next: photo("c") },
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    returnFocusTo: opener,
    ...overrides,
  });
}

describe("exifLine", () => {
  it("joins the whitelisted fields", () => {
    expect(exifLine(photo("a")))
      .toBe("Fujifilm X-T5 · XF 16-55mm · 23mm · f/8 · 1/60 · ISO 400");
  });

  it("omits fields that are empty rather than printing separators", () => {
    const p = photo("a");
    p.exif = { ...p.exif, lens: "", focalLength: "" };
    expect(exifLine(p)).toBe("Fujifilm X-T5 · f/8 · 1/60 · ISO 400");
  });
});

describe("lightbox", () => {
  it("shows the display copy, title, caption, and location", () => {
    const h = open();
    expect(h.element.querySelector("img")!.getAttribute("src")).toBe("/web/b-2048.aaaaaaaa.jpg");
    expect(h.element.textContent).toContain("Title b");
    expect(h.element.textContent).toContain("Caption b");
    expect(h.element.textContent).toContain("Big Bend NP");
  });

  it("is a modal dialog that traps focus", () => {
    const h = open();
    expect(h.element.getAttribute("role")).toBe("dialog");
    expect(h.element.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).not.toBe(opener);
  });

  it("moves to the next photo on ArrowRight and the previous on ArrowLeft", () => {
    const onNavigate = vi.fn();
    open({ onNavigate });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("does nothing at the ends of a month", () => {
    const onNavigate = vi.fn();
    open({ neighbours: { prev: null, next: null }, onNavigate });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("closes on Escape and restores focus to the thumbnail", () => {
    const onClose = vi.fn();
    open({ onClose });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("removes its keydown listener once closed", () => {
    const onNavigate = vi.fn();
    const h = open({ onNavigate });
    h.close();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("exposes an originals slot for the unlock UI to fill", () => {
    const h = open();
    const node = document.createElement("span");
    node.textContent = "unlock goes here";
    h.setSlot("originals", node);
    expect(h.element.querySelector("[data-slot='originals']")!.textContent).toBe("unlock goes here");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test site/test/lightbox.test.ts`
Expected: FAIL — `Cannot find module '../src/lightbox.js'`.

- [ ] **Step 3: Implement**

```ts
// site/src/lightbox.ts
import type { Photo } from "@photos/core";

export interface LightboxOptions {
  photo: Photo;
  neighbours: { prev: Photo | null; next: Photo | null };
  onNavigate: (photo: Photo) => void;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}

export interface LightboxHandle {
  close(): void;
  element: HTMLElement;
  setSlot(name: "originals", node: Node): void;
}

export function exifLine(photo: Photo): string {
  const { camera, lens, focalLength, aperture, shutter, iso } = photo.exif;
  return [camera, lens, focalLength, aperture, shutter, iso ? `ISO ${iso}` : ""]
    .filter((part) => part !== "" && part !== null && part !== undefined)
    .join(" · ");
}

export function openLightbox(opts: LightboxOptions): LightboxHandle {
  const { photo } = opts;

  const element = document.createElement("div");
  element.className = "lightbox";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-label", photo.title);

  // The skeleton is static: nothing is interpolated into innerHTML. Photo fields
  // are free text the photographer typed, and a title containing a double quote
  // would break out of an attribute — so they are set as DOM properties, which
  // never re-parse as HTML.
  element.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close">×</button>
    <figure>
      <img decoding="async" />
      <figcaption>
        <h2></h2>
        <p class="caption"></p>
        <p class="location"></p>
        <p class="exif"></p>
        <div data-slot="originals"></div>
      </figcaption>
    </figure>
  `;
  const img = element.querySelector("img") as HTMLImageElement;
  img.src = `/${photo.web.path}`;
  img.alt = photo.title;
  img.width = photo.web.w;
  img.height = photo.web.h;

  element.querySelector("h2")!.textContent = photo.title;
  element.querySelector(".caption")!.textContent = photo.caption;
  element.querySelector(".location")!.textContent = photo.location;
  element.querySelector(".exif")!.textContent = exifLine(photo);

  const closeButton = element.querySelector(".lightbox-close") as HTMLButtonElement;

  function focusables(): HTMLElement[] {
    return [...element.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    )].filter((n) => !n.hasAttribute("disabled"));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowRight" && opts.neighbours.next) {
      opts.onNavigate(opts.neighbours.next); return;
    }
    if (event.key === "ArrowLeft" && opts.neighbours.prev) {
      opts.onNavigate(opts.neighbours.prev); return;
    }
    if (event.key === "Tab") {
      const nodes = focusables();
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  }

  let startX = 0;
  function onTouchStart(e: TouchEvent) { startX = e.changedTouches[0]!.clientX; }
  function onTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0]!.clientX - startX;
    if (dx < -50 && opts.neighbours.next) opts.onNavigate(opts.neighbours.next);
    if (dx > 50 && opts.neighbours.prev) opts.onNavigate(opts.neighbours.prev);
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchend", onTouchEnd);
    element.remove();
    opts.returnFocusTo?.focus();
    opts.onClose();
  }

  closeButton.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: true });

  document.body.append(element);
  closeButton.focus();

  return {
    element,
    close,
    setSlot(_name, node) {
      element.querySelector("[data-slot='originals']")!.replaceChildren(node);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test site/test/lightbox.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add site/src/lightbox.ts site/src/main.ts site/src/styles.css site/test/lightbox.test.ts
git commit -m "feat(site): add an accessible lightbox with keyboard and swipe navigation"
```

---

## Task 24: Crypto worker and unlock state machine

**Files:**
- Create: `site/src/worker.ts`, `site/src/unlock.ts`
- Test: `site/test/unlock.test.ts`

**Interfaces:**
- Consumes: core `deriveMasterKey`, `checkVerifier`, `unwrapDataKey`, `createStreamDecryptor`, `KeysFileSchema`.
- Produces:
  - `type UnlockState = { kind: "locked" } | { kind: "deriving" } | { kind: "wrong-password" } | { kind: "unlocked" } | { kind: "unsupported"; reason: string }`
  - `createUnlock(deps: UnlockDeps): UnlockController`
  - `interface UnlockController { state(): UnlockState; subscribe(fn: (s: UnlockState) => void): void; submit(password: string): Promise<void>; lock(): void; masterKey(): Uint8Array | null; restore(): Promise<void> }`
  - `interface UnlockDeps { derive: (password: string, kdf: KdfParams) => Promise<Uint8Array>; loadKeys: () => Promise<KeysFile>; storage: Pick<Storage, "getItem" | "setItem" | "removeItem">; supported: () => { ok: true } | { ok: false; reason: string } }`

Worker messages: `{ type: "derive"; password; kdf }` → `{ type: "derived"; key }`; `{ type: "decrypt"; container; dataKey; photoId }` → `{ type: "progress"; done; total }` and `{ type: "decrypted"; bytes }` or `{ type: "error"; message }`.

- [ ] **Step 1: Write the failing test**

```ts
// site/test/unlock.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUnlock } from "../src/unlock.js";
import {
  SCHEMA_VERSION, deriveMasterKey, makeVerifier, newKdfParams, type KeysFile,
} from "@photos/core";

const FAST = { m: 512, t: 1 };
let keysFile: KeysFile;
let master: Uint8Array;

beforeEach(async () => {
  const kdf = newKdfParams(FAST);
  master = await deriveMasterKey("the right password", kdf);
  keysFile = { schemaVersion: SCHEMA_VERSION, kdf, verifier: await makeVerifier(master), keys: {} };
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    map,
  };
}

function deps(overrides: Partial<Parameters<typeof createUnlock>[0]> = {}) {
  return {
    derive: (password: string, kdf: typeof keysFile.kdf) => deriveMasterKey(password, kdf),
    loadKeys: async () => keysFile,
    storage: memoryStorage(),
    supported: () => ({ ok: true as const }),
    ...overrides,
  };
}

describe("unlock state machine", () => {
  it("starts locked", () => {
    expect(createUnlock(deps()).state()).toEqual({ kind: "locked" });
  });

  it("reports unsupported browsers without offering a password field", () => {
    const u = createUnlock(deps({ supported: () => ({ ok: false, reason: "WebCrypto is unavailable" }) }));
    expect(u.state()).toEqual({ kind: "unsupported", reason: "WebCrypto is unavailable" });
  });

  it("passes through deriving and reaches unlocked on the right password", async () => {
    const seen: string[] = [];
    const u = createUnlock(deps());
    u.subscribe((s) => seen.push(s.kind));
    await u.submit("the right password");
    expect(seen).toEqual(["deriving", "unlocked"]);
    expect(u.masterKey()).toEqual(master);
  });

  it("reports a wrong password and holds no key", async () => {
    const u = createUnlock(deps());
    await u.submit("not the password");
    expect(u.state()).toEqual({ kind: "wrong-password" });
    expect(u.masterKey()).toBeNull();
  });

  it("stores the derived key in session storage so a refresh does not re-prompt", async () => {
    const storage = memoryStorage();
    const u = createUnlock(deps({ storage }));
    await u.submit("the right password");
    expect(storage.map.size).toBe(1);

    const revived = createUnlock(deps({ storage }));
    await revived.restore();
    expect(revived.state()).toEqual({ kind: "unlocked" });
    expect(revived.masterKey()).toEqual(master);
  });

  it("ignores a stored key that no longer matches the verifier after rotation", async () => {
    const storage = memoryStorage();
    const u = createUnlock(deps({ storage }));
    await u.submit("the right password");

    const rotatedKdf = newKdfParams(FAST);
    const rotatedMaster = await deriveMasterKey("a new password", rotatedKdf);
    keysFile = { schemaVersion: SCHEMA_VERSION, kdf: rotatedKdf, verifier: await makeVerifier(rotatedMaster), keys: {} };

    const revived = createUnlock(deps({ storage }));
    await revived.restore();
    expect(revived.state()).toEqual({ kind: "locked" });
    expect(storage.map.size).toBe(0);
  });

  it("clears the key and storage on lock", async () => {
    const storage = memoryStorage();
    const u = createUnlock(deps({ storage }));
    await u.submit("the right password");
    u.lock();
    expect(u.state()).toEqual({ kind: "locked" });
    expect(u.masterKey()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("surfaces a keys.json load failure as locked, not as a wrong password", async () => {
    const u = createUnlock(deps({ loadKeys: async () => { throw new Error("network down"); } }));
    await expect(u.submit("the right password")).rejects.toThrow(/network down/);
    expect(u.state()).toEqual({ kind: "locked" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test site/test/unlock.test.ts`
Expected: FAIL — `Cannot find module '../src/unlock.js'`.

- [ ] **Step 3: Implement the worker and the controller**

```ts
// site/src/worker.ts
import {
  createStreamDecryptor, deriveMasterKey, type KdfParams,
} from "@photos/core";

type Request =
  | { type: "derive"; password: string; kdf: KdfParams }
  | { type: "decrypt"; url: string; dataKey: Uint8Array; photoId: string; containerLength: number };

self.addEventListener("message", async (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    if (msg.type === "derive") {
      const key = await deriveMasterKey(msg.password, msg.kdf);
      self.postMessage({ type: "derived", key }, { transfer: [key.buffer] });
      return;
    }

    const res = await fetch(msg.url);
    if (!res.ok || !res.body) throw new Error(`could not download the original (${res.status})`);

    const decryptor = createStreamDecryptor(msg.dataKey, msg.photoId, msg.containerLength);
    const reader = res.body.getReader();
    const pieces: Uint8Array[] = [];
    let done = 0;

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      for (const out of await decryptor.push(value)) {
        pieces.push(out);
        done += out.length;
        self.postMessage({ type: "progress", done, total: decryptor.plainTotal ?? 0 });
      }
    }
    for (const out of await decryptor.finish()) {
      pieces.push(out);
      done += out.length;
      self.postMessage({ type: "progress", done, total: decryptor.plainTotal ?? 0 });
    }

    const total = pieces.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of pieces) { bytes.set(p, at); at += p.length; }
    self.postMessage({ type: "decrypted", bytes }, { transfer: [bytes.buffer] });
  } catch (err) {
    self.postMessage({ type: "error", message: (err as Error).message });
  }
});
```

```ts
// site/src/unlock.ts
import { KeysFileSchema, checkVerifier, type KdfParams, type KeysFile } from "@photos/core";

const STORAGE_KEY = "photos.masterKey.v1";

export type UnlockState =
  | { kind: "locked" }
  | { kind: "deriving" }
  | { kind: "wrong-password" }
  | { kind: "unlocked" }
  | { kind: "unsupported"; reason: string };

export interface UnlockDeps {
  derive: (password: string, kdf: KdfParams) => Promise<Uint8Array>;
  loadKeys: () => Promise<KeysFile>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  supported: () => { ok: true } | { ok: false; reason: string };
}

export interface UnlockController {
  state(): UnlockState;
  subscribe(fn: (s: UnlockState) => void): void;
  submit(password: string): Promise<void>;
  restore(): Promise<void>;
  lock(): void;
  masterKey(): Uint8Array | null;
}

export function defaultSupported(): { ok: true } | { ok: false; reason: string } {
  if (!globalThis.crypto?.subtle) {
    return { ok: false, reason: "This browser does not provide WebCrypto, which is needed to decrypt originals." };
  }
  if (typeof WebAssembly === "undefined") {
    return { ok: false, reason: "This browser does not support WebAssembly, which is needed to check the password." };
  }
  return { ok: true };
}

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createUnlock(deps: UnlockDeps): UnlockController {
  const support = deps.supported();
  let state: UnlockState = support.ok ? { kind: "locked" } : { kind: "unsupported", reason: support.reason };
  let key: Uint8Array | null = null;
  const listeners: ((s: UnlockState) => void)[] = [];

  function set(next: UnlockState): void {
    state = next;
    for (const fn of listeners) fn(next);
  }

  return {
    state: () => state,
    subscribe(fn) { listeners.push(fn); },
    masterKey: () => key,

    async submit(password) {
      if (!support.ok) return;
      set({ kind: "deriving" });
      let keysFile: KeysFile;
      try {
        keysFile = KeysFileSchema.parse(await deps.loadKeys());
      } catch (err) {
        // A network failure is not a wrong password, and must not be reported as one.
        set({ kind: "locked" });
        throw err;
      }

      const candidate = await deps.derive(password, keysFile.kdf);
      if (!(await checkVerifier(candidate, keysFile.verifier))) {
        set({ kind: "wrong-password" });
        return;
      }

      key = candidate;
      deps.storage.setItem(STORAGE_KEY, toBase64(candidate));
      set({ kind: "unlocked" });
    },

    async restore() {
      if (!support.ok) return;
      const stored = deps.storage.getItem(STORAGE_KEY);
      if (!stored) return;
      try {
        const candidate = fromBase64(stored);
        const keysFile = KeysFileSchema.parse(await deps.loadKeys());
        // After a password rotation the stored key no longer verifies, so it is
        // discarded rather than left to fail later on a 40 MB download.
        if (await checkVerifier(candidate, keysFile.verifier)) {
          key = candidate;
          set({ kind: "unlocked" });
        } else {
          deps.storage.removeItem(STORAGE_KEY);
          set({ kind: "locked" });
        }
      } catch {
        deps.storage.removeItem(STORAGE_KEY);
        set({ kind: "locked" });
      }
    },

    lock() {
      key = null;
      deps.storage.removeItem(STORAGE_KEY);
      set({ kind: "locked" });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test site/test/unlock.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add site/src/worker.ts site/src/unlock.ts site/test/unlock.test.ts
git commit -m "feat(site): derive keys in a worker and manage unlock state"
```

---

## Task 25: Unlocked originals UI

**Files:**
- Create: `site/src/originals.ts`
- Modify: `site/src/main.ts`, `site/src/styles.css`
- Test: `site/test/originals.test.ts`

**Interfaces:**
- Consumes: `UnlockController` (Task 24), `LightboxHandle.setSlot` (Task 23), core `unwrapDataKey`.
- Produces:
  - `renderOriginals(opts: OriginalsOptions): HTMLElement`
  - `interface OriginalsOptions { photo: Photo; unlock: UnlockController; keysFile: KeysFile | null; unwrap: (master: Uint8Array, wrapped: Wrapped, id: string) => Promise<Uint8Array>; decrypt: (photo: Photo, dataKey: Uint8Array, onProgress: (done: number, total: number) => void) => Promise<Uint8Array>; sha256: (bytes: Uint8Array) => Promise<string>; onImage: (url: string) => void }`

`keysFile` is resolved once per unlock by `main.ts` and passed in, so this function is synchronous and can decide up front whether the photo even has an original to offer.

Every failure mode from the spec's table gets its own branch and its own test.

- [ ] **Step 1: Write the failing test**

```ts
// site/test/originals.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderOriginals } from "../src/originals.js";
import { SCHEMA_VERSION, type KeysFile, type Photo } from "@photos/core";

const photo = (id = "a"): Photo => ({
  id, title: "T", caption: "C", location: "L",
  takenAt: "2026-03-14T18:22:05-06:00", featured: false,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "c", lens: "l", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "deadbeef", chunkSize: 4194304, chunkCount: 1 },
});

const keysFile: KeysFile = {
  schemaVersion: SCHEMA_VERSION,
  kdf: { alg: "argon2id", salt: "c2FsdA==", m: 512, t: 1, p: 1, keyLen: 32 },
  verifier: { iv: "aXY=", ct: "Y3Q=" },
  keys: { a: { iv: "aXY=", ct: "Y3Q=" } },
};

function unlocked(kind: "locked" | "unlocked" | "unsupported" = "unlocked") {
  return {
    state: () => (kind === "unsupported"
      ? { kind, reason: "no webcrypto" } as const
      : { kind } as const),
    subscribe: vi.fn(),
    submit: vi.fn(),
    restore: vi.fn(),
    lock: vi.fn(),
    masterKey: () => (kind === "unlocked" ? new Uint8Array(32) : null),
  };
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    photo: photo(),
    unlock: unlocked(),
    keysFile,
    decrypt: vi.fn(async () => new Uint8Array([1, 2, 3])),
    sha256: vi.fn(async () => "deadbeef"),
    onImage: vi.fn(),
    unwrap: vi.fn(async () => new Uint8Array(32)),
    ...overrides,
  } as Parameters<typeof renderOriginals>[0];
}

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.URL.createObjectURL = vi.fn(() => "blob:fake");
});

describe("renderOriginals", () => {
  it("shows a password prompt when locked", () => {
    const node = renderOriginals(opts({ unlock: unlocked("locked") }));
    expect(node.querySelector("input[type='password']")).not.toBeNull();
  });

  it("explains an unsupported browser instead of showing a broken button", () => {
    const node = renderOriginals(opts({ unlock: unlocked("unsupported") }));
    expect(node.textContent).toContain("no webcrypto");
    expect(node.querySelector("button")).toBeNull();
  });

  it("offers view and download when unlocked", () => {
    const node = renderOriginals(opts());
    expect(node.textContent).toContain("Download original");
    expect(node.textContent).toContain("View full size");
  });

  it("omits the controls when the photo has no wrapped key", () => {
    const node = renderOriginals(opts({ photo: photo("no-key") }));
    expect(node.querySelector("button")).toBeNull();
    expect(node.textContent).toMatch(/no original/i);
  });

  it("decrypts once and reuses the blob for view and download", async () => {
    const o = opts();
    const node = renderOriginals(o);
    (node.querySelector("[data-action='view']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(o.onImage).toHaveBeenCalledWith("blob:fake"));
    (node.querySelector("[data-action='download']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(node.querySelector("a[download]")).not.toBeNull());
    expect(o.decrypt).toHaveBeenCalledTimes(1);
  });

  it("reports progress while decrypting", async () => {
    const o = opts({
      decrypt: vi.fn(async (_p, _k, onProgress: (d: number, t: number) => void) => {
        onProgress(50, 100);
        return new Uint8Array([1]);
      }),
    });
    const node = renderOriginals(o);
    (node.querySelector("[data-action='view']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(node.querySelector("progress")!.getAttribute("value")).toBe("50"));
  });

  it("reports corruption and offers nothing when a chunk fails to authenticate", async () => {
    const o = opts({ decrypt: vi.fn(async () => { throw new Error("OperationError"); }) });
    const node = renderOriginals(o);
    (node.querySelector("[data-action='view']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(node.textContent).toMatch(/could not be decrypted/i));
    expect(o.onImage).not.toHaveBeenCalled();
  });

  it("refuses the download when the sha256 does not match", async () => {
    const o = opts({ sha256: vi.fn(async () => "not-the-expected-hash") });
    const node = renderOriginals(o);
    (node.querySelector("[data-action='view']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(node.textContent).toMatch(/does not match/i));
    expect(o.onImage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test site/test/originals.test.ts`
Expected: FAIL — `Cannot find module '../src/originals.js'`.

- [ ] **Step 3: Implement**

```ts
// site/src/originals.ts
import type { KeysFile, Photo } from "@photos/core";
import type { UnlockController } from "./unlock.js";

export interface OriginalsOptions {
  photo: Photo;
  unlock: UnlockController;
  keysFile: KeysFile | null;
  unwrap: (master: Uint8Array, wrapped: { iv: string; ct: string }, id: string) => Promise<Uint8Array>;
  decrypt: (
    photo: Photo,
    dataKey: Uint8Array,
    onProgress: (done: number, total: number) => void,
  ) => Promise<Uint8Array>;
  sha256: (bytes: Uint8Array) => Promise<string>;
  onImage: (url: string) => void;
}

export function renderOriginals(opts: OriginalsOptions): HTMLElement {
  const root = document.createElement("div");
  root.className = "originals";

  const state = opts.unlock.state();

  if (state.kind === "unsupported") {
    root.append(message(state.reason));
    return root;
  }

  if (state.kind !== "unlocked") {
    root.innerHTML = `
      <form class="unlock-form">
        <label>Have the password? <input type="password" name="password" autocomplete="current-password" /></label>
        <button type="submit">Unlock originals</button>
      </form>
      <p class="unlock-status" role="status"></p>
    `;
    const form = root.querySelector("form")!;
    const status = root.querySelector(".unlock-status")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.elements.namedItem("password") as HTMLInputElement;
      status.textContent = "Checking…";
      try {
        await opts.unlock.submit(input.value);
        status.textContent =
          opts.unlock.state().kind === "wrong-password" ? "That password is not right." : "";
      } catch {
        status.textContent = "Could not reach the key file. Check your connection and try again.";
      }
    });
    return root;
  }

  const wrappedKey = opts.keysFile?.keys[opts.photo.id];
  if (!wrappedKey) {
    root.append(message("There is no original on file for this photo."));
    return root;
  }

  let blob: Blob | null = null;
  let objectUrl: string | null = null;

  const controls = document.createElement("div");
  controls.innerHTML = `
    <button type="button" data-action="view">View full size</button>
    <button type="button" data-action="download">Download original</button>
    <progress value="0" max="100" hidden></progress>
    <p class="originals-status" role="status"></p>
  `;
  root.append(controls);

  const progress = controls.querySelector("progress") as HTMLProgressElement;
  const status = controls.querySelector(".originals-status") as HTMLElement;

  async function ensureDecrypted(): Promise<Blob | null> {
    if (blob) return blob;

    const master = opts.unlock.masterKey();
    if (!master) return null;

    progress.hidden = false;
    status.textContent = "Downloading and decrypting…";
    try {
      const dataKey = await opts.unwrap(master, wrappedKey, opts.photo.id);
      const bytes = await opts.decrypt(opts.photo, dataKey, (done, total) => {
        progress.setAttribute("value", String(done));
        progress.setAttribute("max", String(total || 100));
      });

      const digest = await opts.sha256(bytes);
      if (digest !== opts.photo.original.sha256) {
        status.textContent =
          "The decrypted file does not match its recorded checksum, so it was discarded.";
        return null;
      }

      blob = new Blob([bytes], { type: opts.photo.original.mime });
      status.textContent = "";
      return blob;
    } catch {
      status.textContent =
        "This original could not be decrypted. The file may be corrupt or may have been altered.";
      return null;
    } finally {
      progress.hidden = true;
    }
  }

  controls.querySelector("[data-action='view']")!.addEventListener("click", async () => {
    const ready = await ensureDecrypted();
    if (!ready) return;
    objectUrl ??= URL.createObjectURL(ready);
    opts.onImage(objectUrl);
  });

  controls.querySelector("[data-action='download']")!.addEventListener("click", async () => {
    const ready = await ensureDecrypted();
    if (!ready) return;
    objectUrl ??= URL.createObjectURL(ready);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${opts.photo.id}.jpg`;
    link.textContent = "Saving…";
    root.append(link);
    link.click();
  });

  return root;

  function message(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "originals-note";
    p.textContent = text;
    return p;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test site/test/originals.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire into `main.ts` and commit**

`main.ts` creates one `UnlockController` and one worker for the page, calls `restore()` on load, and on every lightbox open calls `handle.setSlot("originals", renderOriginals({…}))`, passing an `onImage` that swaps the lightbox `img`'s `src` to the object URL.

```bash
git add site/src/originals.ts site/src/main.ts site/src/styles.css site/test/originals.test.ts
git commit -m "feat(site): view and download decrypted originals with full failure handling"
```

---

## Task 26: End-to-end pass

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/fixture.ts`, `e2e/gallery.spec.ts`
- Modify: root `package.json` (add `test:e2e`)

**Interfaces:**
- Consumes: every task above.
- Produces: `npm run test:e2e`.

This is the test that proves the CLI's writer and the site's reader agree. It runs the real `addPhotos` against a memory store, dumps the resulting objects to a directory, serves that directory with the built site, and drives a browser through it.

- [ ] **Step 1: Write the fixture builder and the failing spec**

```ts
// e2e/fixture.ts
import { mkdir, writeFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import sharp from "sharp";
import { createMemoryStore } from "../cli/src/memory-store.js";
import { addPhotos } from "../cli/src/commands/add.js";
import { setFeatured } from "../cli/src/commands/curate.js";
import { closeExif } from "../cli/src/exif.js";

export const PASSWORD = "a long shared family passphrase";

const config = {
  bucket: "b", region: "us-east-1", profile: "p", distributionId: "d",
  siteUrl: "https://photos.example.test", creator: "Test Photographer",
  copyright: "© 2026 Test Photographer", usageTerms: "No AI training.",
  sizes: { display: 2048, thumb: 640 },
};

/** Builds a two-photo library on disk, and returns the plaintext of photo one. */
export async function buildFixture(outDir: string): Promise<{ sources: string[] }> {
  const store = createMemoryStore();
  const sources: string[] = [];

  for (const [i, colour] of [["0001", "#3a5f7d"], ["0002", "#7d5f3a"]] as const) {
    const path = join(outDir, "sources", `DSCF${i}.jpg`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: colour },
    }).jpeg().toBuffer());
    sources.push(path);
  }

  const added = await addPhotos(
    {
      store, config,
      prompt: async (file) => ({
        title: file.includes("0001") ? "First light" : "Second light",
        caption: "A test photograph.",
        location: "Somewhere, Texas",
      }),
      password: async () => PASSWORD,
    },
    sources,
    { offset: "-06:00" },
  );

  await setFeatured(store, [added[0]!.id], true);
  await closeExif();

  for (const [key, value] of store.objects) {
    const dest = join(outDir, "site", key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, value.body);
  }
  await cp("site/dist", join(outDir, "site"), { recursive: true });

  return { sources };
}
```

```ts
// e2e/gallery.spec.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PASSWORD } from "./fixture.js";

test("browse, unlock, and download an original", async ({ page }) => {
  await page.goto("/");

  // The home page shows only the curated set.
  await expect(page.locator("h1")).toHaveText("Selected work");
  await expect(page.locator("figure")).toHaveCount(1);

  // The month rail leads to the full archive.
  await page.getByRole("link", { name: /Browse all/ }).click();
  await page.getByRole("link", { name: /\(2\)/ }).click();
  await expect(page.locator("figure")).toHaveCount(2);

  // Opening a photo is linkable.
  await page.locator("figure a").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(page.url()).toMatch(/photo=/);

  // A wrong password fails fast and downloads nothing.
  await page.getByLabel(/Have the password/).fill("not the password");
  await page.getByRole("button", { name: "Unlock originals" }).click();
  await expect(page.getByText("That password is not right.")).toBeVisible();

  // The right password unlocks.
  await page.getByLabel(/Have the password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock originals" }).click();
  await expect(page.getByRole("button", { name: "Download original" })).toBeVisible();

  // The decrypted bytes match the source file exactly.
  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download original" }).click(),
  ]).then(([d]) => d);

  const saved = await download.path();
  const sourceList = JSON.parse(readFileSync("e2e/.fixture/sources.json", "utf8")) as string[];
  const expectedHashes = sourceList.map((p) =>
    createHash("sha256").update(readFileSync(p)).digest("hex"),
  );
  const actual = createHash("sha256").update(readFileSync(saved!)).digest("hex");
  expect(expectedHashes).toContain(actual);

  // Escape closes and returns to the grid.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the gallery still browses without unlocking", async ({ page }) => {
  await page.goto("/?m=2026-03");
  await expect(page.locator("figure").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Download original" })).toHaveCount(0);
});
```

```ts
// e2e/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npx http-server e2e/.fixture/site -p 4173 --silent",
    url: "http://localhost:4173",
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:e2e`
Expected: FAIL — the fixture has not been built.

- [ ] **Step 3: Add the scripts and the global setup**

Add to the root `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "typecheck": "tsc -b",
  "build:site": "npm run build --workspace site",
  "fixture": "node --experimental-strip-types e2e/build-fixture.ts",
  "test:e2e": "npm run build:site && npm run fixture && playwright test -c e2e/playwright.config.ts"
}
```

```ts
// e2e/build-fixture.ts
import { mkdir, writeFile } from "node:fs/promises";
import { buildFixture } from "./fixture.js";

const OUT = "e2e/.fixture";

await mkdir(OUT, { recursive: true });
const { sources } = await buildFixture(OUT);
await writeFile(`${OUT}/sources.json`, JSON.stringify(sources, null, 2));
process.stdout.write(`fixture built in ${OUT} with ${sources.length} photos\n`);
```

Add `e2e/.fixture/` to `.gitignore`.

Run: `npm install -D @playwright/test@^1.48.0 http-server@^14.1.0 && npx playwright install chromium`

- [ ] **Step 4: Run the end-to-end suite**

Run: `npm run test:e2e`
Expected: PASS, 2 tests. The download-hash assertion is the one that proves the whole chain.

- [ ] **Step 5: Commit**

```bash
git add e2e/ package.json .gitignore package-lock.json
git commit -m "test: end-to-end pass from CLI ingest through browser decryption"
```

---

## Final verification

- [ ] `npm test` — the whole unit suite passes
- [ ] `npm run typecheck` — no type errors across workspaces
- [ ] `npm run test:e2e` — the browser pass passes
- [ ] `bash infra/bootstrap.sh <bucket> <domain> <profile>` has been run, the remaining manual steps in `infra/README.md` are complete, and the distribution id is in `photos.config.json`
- [ ] `photos add` on a real photo with `--location`, then `photos ls` shows it and `photos verify --decrypt-sample` reports OK
- [ ] `photos record-backup` after the first real `aws s3 sync` of `orig/` and `data/`
- [ ] Confirm in a browser that a web copy carries the rights and no-AI tags: `exiftool <downloaded web copy>` shows Creator, UsageTerms, and Robots, and shows no GPS
