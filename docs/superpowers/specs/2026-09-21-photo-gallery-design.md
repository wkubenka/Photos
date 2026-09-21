# Photo Gallery — Design

- **Date:** 2026-09-21
- **Status:** Approved for planning
- **Author:** William Kubenka (with Claude)

## 1. Overview

A static photography website. Web-sized photos are public. Full-resolution
originals are stored encrypted and unlocked in the browser with a shared
password, so friends and family can see the originals while everyone else
sees only the smaller copies.

Three deliverables:

1. A command-line tool that ingests photos, resizes them for the web, stamps
   rights and no-AI metadata, encrypts the originals, and publishes everything
   to S3.
2. A static site that renders a paginated grid and a lightbox from JSON.
3. A password-gated path to the originals that requires no server.

### Goals

- No backend. No servers to run, patch, or pay for.
- The password never leaves the browser.
- Changing the password must not require re-uploading the photo library.
- Originals must be safe to store in a bucket whose contents could leak.
- The CLI must work from any machine with AWS credentials and nothing else.

### Non-goals

- Accounts, per-person identity, or knowing who viewed what. There is no
  backend, so there is no access log of unlock attempts.
- Preventing a person who has the password from redistributing originals.
- Serving the gallery without JavaScript.
- Search, tags, albums, or collections. Deferred until the library is large
  enough to need them.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Originals protection | Client-side AES-256-GCM; ciphertext served publicly | Zero backend; password never transmitted |
| Key management | Random per-photo data key, wrapped by a password-derived key | Password rotation rewrites one small file instead of the library |
| KDF | Argon2id (m=64 MiB, t=3, p=1) | Ciphertext is public, so guessing is offline and unthrottled |
| Hosting | S3 behind CloudFront, custom domain, ACM certificate | HTTPS is required for WebCrypto; one origin means no CORS |
| Source of truth | S3 | No local state to maintain or migrate between computers |
| Site build | Vite, vanilla TypeScript, no framework | The complexity is in the crypto, not the view layer |
| Shared code | One `core/` module used by CLI and browser, via WebCrypto | Makes writer/reader format drift structurally impossible |
| CLI stack | Node 20+ / TypeScript | Shares `core/` with the site |
| Pagination | Single page file now, sharding behind a loader interface | Simplest thing that does not become a rewrite later |
| Watermarking | None | Rejected: permanently degrades the image people came to see |

### Rejected alternatives

- **Auth backend issuing presigned URLs.** Allows instant revocation and real
  access logs, but adds a deployed service and a second release process to a
  hobby project. Rejected in favor of zero infrastructure.
- **CloudFront signed cookies.** Best large-file delivery performance, most
  AWS-specific machinery. Rejected as over-built for this scale.
- **Local library directory as source of truth.** Offers offline work and git
  -diffable history, but creates state that must survive a computer migration
  and consumes local disk. Rejected: the failure mode (forgetting to carry it)
  is worse than the failure mode it prevents.
- **PBKDF2.** Native to WebCrypto with no dependency, but GPU-friendly.
  Rejected for a ~12 KB WASM dependency that is memory-hard.

## 3. Architecture

### Repository layout

```
core/     Shared TypeScript: crypto, container format, schema types, validation
cli/      Commands, image pipeline, S3 client
site/     Vite app: index.html, TypeScript modules, CSS
infra/    Bucket policy, CloudFront config, setup runbook
docs/     Specs and plans
```

`core/` imports from neither `cli/` nor `site/`. It targets the WebCrypto API
(`globalThis.crypto.subtle`), which Node 20 and every current browser
implement identically, so the same source runs in both and a Node round-trip
test genuinely exercises the browser's code path.

### S3 layout

One bucket, one CloudFront distribution, no CORS configuration required.

```
index.html                    Site entry point
assets/*.<hash>.{js,css}      Vite build output
robots.txt                    AI crawler opt-out
data/index.json               Schema version, counts, page list
data/page-0001.json           Photo records
data/keys.json                KDF parameters, verifier, wrapped data keys
web/<id>-2048.<hash>.jpg      Display copy
web/<id>-640.<hash>.jpg       Grid thumbnail
orig/<id>.enc                 Encrypted original
```

Content-hashed filenames under `assets/`, `web/`, and `orig/` are immutable
and cached for a year. Only the three `data/` files and `index.html` carry
short TTLs, and `publish` invalidates them.

### CloudFront

- Origin: the S3 bucket, private, reached through an Origin Access Control.
  The bucket has no public access and no website endpoint.
- Default root object `index.html`.
- Cache policy A (`assets/*`, `web/*`, `orig/*`): `max-age=31536000, immutable`.
- Cache policy B (`data/*.json`, `index.html`): `max-age=60, must-revalidate`.
- Response headers policy adds `X-Robots-Tag: noai, noimageai` to all
  responses and the Content Security Policy below to HTML.

### Content Security Policy

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
img-src 'self' data: blob:;
connect-src 'self';
style-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none'
```

`wasm-unsafe-eval` is required by the Argon2id WASM module. The policy admits
no third-party origins, which matters because a derived key lives in
`sessionStorage`: script injection is the one attack that would expose it, and
there are no third-party scripts to be injected through.

## 4. Data model

### `data/index.json`

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-21T14:02:11Z",
  "lastBackupAt": "2026-09-19T08:30:00Z",
  "photoCount": 137,
  "pageSize": 60,
  "shardSize": 300,
  "sort": "takenAt:desc",
  "shards": ["data/page-0001.json", "data/page-0002.json"]
}
```

Photos are sorted by `takenAt` descending, and shards are listed newest first.

Two different numbers are at work here, and conflating them is the easiest
mistake to make in this design:

- **`pageSize`** is a display concern: how many photos the grid shows before
  the reader clicks to the next page. The site slices this out of whatever it
  has already loaded.
- **`shardSize`** is a transport concern: how many photo records go in one JSON
  file. Below `shardThreshold` total photos there is exactly one shard holding
  the entire library, and the grid still paginates by `pageSize` client-side.

So a 137-photo library is one shard file and three display pages.
`lastBackupAt` is written by `photos verify` and drives the staleness warning
in section 8.

### `data/page-NNNN.json`

```json
{
  "schemaVersion": 1,
  "page": 1,
  "photos": [
    {
      "id": "2026-03-14-big-bend-0031",
      "title": "Santa Elena at dusk",
      "caption": "The canyon mouth from the river trail, twenty minutes after sunset.",
      "location": "Big Bend National Park, Texas",
      "takenAt": "2026-03-14T18:22:05-06:00",
      "web":   { "path": "web/2026-03-14-big-bend-0031-2048.a1b2c3d4.jpg",
                 "w": 2048, "h": 1365, "bytes": 812446 },
      "thumb": { "path": "web/2026-03-14-big-bend-0031-640.e5f6a7b8.jpg",
                 "w": 640, "h": 427, "bytes": 71230 },
      "lqip": "data:image/jpeg;base64,/9j/4AAQ...",
      "exif": {
        "camera": "Fujifilm X-T5",
        "lens": "XF 16-55mm F2.8 R LM WR",
        "focalLength": "23mm",
        "aperture": "f/8",
        "shutter": "1/60",
        "iso": 400
      },
      "original": {
        "path": "orig/2026-03-14-big-bend-0031.enc",
        "bytes": 41903882,
        "mime": "image/jpeg",
        "sha256": "9f2c...",
        "chunkSize": 4194304,
        "chunkCount": 10
      }
    }
  ]
}
```

- `id` is a slug: capture date, a slug of the title, and the source frame
  number. It is stable, is used as AES additional authenticated data, and is
  never reused after deletion.
- `location` is free text the photographer types. It is public.
- `exif` is a fixed whitelist of six fields. Everything else in the source
  EXIF is discarded, including GPS unless `--keep-gps` is passed.
- `lqip` is a ~400-byte blurred JPEG data URI, inline to avoid a request.
- `sha256` is of the **plaintext** original, so a viewer can verify a decrypted
  download end to end.

### `data/keys.json`

```json
{
  "schemaVersion": 1,
  "kdf": {
    "alg": "argon2id",
    "salt": "base64...",
    "m": 65536,
    "t": 3,
    "p": 1,
    "keyLen": 32
  },
  "verifier": { "iv": "base64...", "ct": "base64..." },
  "keys": {
    "2026-03-14-big-bend-0031": { "iv": "base64...", "ct": "base64..." }
  }
}
```

`verifier` is the fixed ASCII string `photo-gallery-verifier-v1` encrypted
under the master key. Decrypting it confirms a correct password in
milliseconds, before any large download begins. `keys[id].ct` is a photo's
32-byte data key wrapped with AES-256-GCM under the master key, with the photo
id as additional authenticated data so a wrapped key cannot be moved between
entries.

`m` is in KiB, so 65536 is 64 MiB.

## 5. Encrypted original container format

A `.enc` file is a 22-byte header followed by chunks.

```
Offset  Size  Field
0       8     Magic, ASCII "PHOTOENC"
8       1     Format version, currently 1
9       1     Cipher id, 1 = AES-256-GCM
10      4     Chunk size, uint32 big-endian (4194304)
14      4     Chunk count, uint32 big-endian
18      4     Nonce prefix, random, unique per file
22      ...   Chunks
```

Each chunk is `plaintextLength + 16` bytes: AES-256-GCM ciphertext followed by
its 16-byte tag. Every chunk is exactly `chunkSize` of plaintext except the
last, which is the remainder and must be at least 1 byte.

- **Nonce** (12 bytes): the 4-byte file nonce prefix, then the chunk index as a
  uint64 big-endian. Unique per chunk per file by construction.
- **Additional authenticated data**: the 22 header bytes, then the photo id as
  UTF-8, then the chunk index as uint32 big-endian, then one byte that is 1 for
  the final chunk and 0 otherwise.

Binding the header into every chunk's AAD authenticates the chunk count, which
means a truncated file fails authentication rather than decrypting to a
plausible shorter image. Binding the photo id prevents chunks being spliced
between files. Binding the final-chunk flag prevents a truncation that removes
whole chunks.

A `chunkCount` of 0 is invalid and must be rejected on read.

### Key hierarchy

```
password ──Argon2id(salt, m=64MiB, t=3, p=1)──► master key (32 bytes)
                                                  │
                                    AES-256-GCM wrap, AAD = photo id
                                                  │
                                                  ▼
                            per-photo data key (32 bytes, random)
                                                  │
                                                  ▼
                                    AES-256-GCM chunks of the original
```

### Rotation

`photos rotate-password` prompts for the old and new passwords, derives both
master keys, unwraps every data key and re-wraps it under the new master key,
generates a fresh salt and verifier, and writes `keys.json`. No object under
`orig/` is read, rewritten, or re-uploaded.

**Rotation's limit, stated plainly:** it prevents future access by someone who
knew the old password. It cannot revoke originals that person already
downloaded. Rotation is the remedy for a leaked password, not for un-sharing a
photo.

## 6. The upload CLI

### State

The CLI keeps no persistent local state. Each command fetches the three
`data/` files from S3, works in a scratch directory under the OS temp
directory, and removes it on exit. A new machine needs AWS credentials and
`photos.config.json`.

Source photos are read once, at `add` time, and are never needed again. After
`add`, the encrypted copies in S3 are the archive of record — which is why the
backup requirements in section 8 are not optional.

### Commands

| Command | Behavior |
|---|---|
| `photos add <files…>` | Prompts per file for title, caption, location; extracts EXIF; builds derivatives; encrypts the original; wraps its key, and publishes — all in one run |
| `photos edit <id>` | Amends title, caption, or location in place |
| `photos rm <id>` | Removes the record, its key entry, and its objects |
| `photos publish` | Re-uploads any object the manifest references but S3 is missing, and invalidates `data/*` and `index.html`. Repairs an interrupted run; a no-op otherwise |
| `photos deploy-site` | Builds `site/` and uploads `assets/`, `index.html`, `robots.txt` |
| `photos rotate-password` | Re-wraps every data key under a new password |
| `photos reindex` | Rebuilds page shards, applying the current page size |
| `photos verify` | Checks manifest, keys, and S3 agree; round-trip decrypts a sample; warns on a stale backup |
| `photos gc` | Lists objects no manifest references and offers to delete them |
| `photos restore --manifest` | Rolls `data/` back to a previous S3 object version |

Because there is no local state, there is nowhere for a half-finished `add` to
wait. `add` therefore runs to completion or leaves the site untouched, per the
write ordering below, and `publish` is the repair command rather than a
deferred second step.

`add`, `rm`, and `rotate-password` need the password to wrap or unwrap keys.
The CLI prompts without echo, or reads `PHOTOS_PASSWORD`. It is never written
to disk.

### Write ordering

Within a run, in this order:

1. Derivatives and the encrypted original (inert; nothing references them yet)
2. `data/keys.json` (a wrapped key for an unreferenced photo is harmless)
3. The page shard
4. `data/index.json`

Each is a single atomic S3 PUT. An interruption at any point leaves the live
site exactly as it was, plus orphaned bytes that `photos gc` reclaims. There is
no lock and no concurrency control; this is a single-user tool.

### Image pipeline

Per source file, using sharp:

1. Decode, apply EXIF orientation, convert to sRGB.
2. Resize to 2048px and 640px on the long edge (Lanczos, no upscaling).
3. Encode mozjpeg, quality 82, progressive, 4:2:0 chroma.
4. **Strip all metadata.**
5. Generate the LQIP: 16px wide, heavily blurred, quality 30, as a data URI.
6. Re-inject metadata deliberately, via `exiftool-vendored`:
   - The six whitelisted EXIF fields.
   - `IPTC:CopyrightNotice`, `XMP-dc:Rights`, `XMP-dc:Creator`,
     `XMP-xmpRights:UsageTerms`, `XMP-xmpRights:WebStatement`.
   - `XMP-photoshop:Credit`.
   - Opt-out signals: `XMP-xmpRights:Marked=True`,
     `XMP:Robots="noai, noimageai"`, a TDM reservation of 1, and
     `XMP-Iptc4xmpExt:DigitalSourceType` set to the IPTC
     `digitalCapture` value.
   - GPS only when `--keep-gps` is passed for that file.

Strip-then-reinject, rather than selective removal, is what guarantees no
unexpected field survives. A test asserts that a source image carrying GPS
produces a derivative with no GPS tags.

`exiftool-vendored` ships the exiftool binary as an npm dependency, so there is
no separate install step.

### robots.txt

Disallows the known AI training and scraping crawlers by user agent: GPTBot,
ChatGPT-User, OAI-SearchBot, CCBot, ClaudeBot, anthropic-ai, Google-Extended,
Applebot-Extended, Bytespider, PerplexityBot, Amazonbot, Meta-ExternalAgent,
Diffbot, ImagesiftBot, and Omgilibot. Ordinary search indexing is left allowed.

### Configuration

`photos.config.json`, committed to the repo:

```json
{
  "bucket": "photos.example.com",
  "region": "us-east-1",
  "profile": "photos",
  "distributionId": "E1234567890ABC",
  "siteUrl": "https://photos.example.com",
  "creator": "William Kubenka",
  "copyright": "© 2026 William Kubenka. All rights reserved.",
  "usageTerms": "No reproduction, redistribution, or use as AI training data without written permission.",
  "sizes": { "display": 2048, "thumb": 640 },
  "pageSize": 60,
  "shardSize": 300,
  "shardThreshold": 300
}
```

Below `shardThreshold` photos the library stays a single shard file. At or
above it, `reindex` splits the library into shards of `shardSize` records. The
site does not care which, because it reads the shard list from `index.json` and
paginates the display by `pageSize` independently.

## 7. The site

### Modules

- `library.ts` — fetches `index.json`, exposes `getPage(n)` and `getPhoto(id)`,
  and hides whether the library is one shard file or twenty. It reads the shard
  list from `index.json` and slices display pages of `pageSize` out of it. This
  is the seam that makes sharding a contained change.
- `gallery.ts` — grid rendering, lightbox, keyboard and swipe navigation, URL
  state.
- `unlock.ts` — password entry, key derivation, decryption, and the locked and
  unlocked UI states.
- `worker.ts` — Argon2id derivation and chunk decryption off the main thread.

### Grid and pagination

Thumbnails render over their inline LQIP with explicit `width` and `height`
so nothing shifts as images arrive, and `loading="lazy"` below the fold.
Pagination state lives in the URL as `?page=N`, so browser history and a
pasted link both work. The next page's JSON prefetches on idle.

### Lightbox

Shows the 2048px copy with title, caption, location, and a single EXIF line.
Arrow keys and touch swipes move between photos; Escape closes; focus is
trapped while open and restored to the originating thumbnail on close. The
photo id enters the URL as `?photo=<id>`, making a single shot linkable. Alt
text is the title, with the caption as the accessible description.

### Unlock flow

1. An "Originals" control reveals a password field.
2. The password goes to the worker, which runs Argon2id. This is intentionally
   about a second of work; on the main thread it would freeze the page. A
   progress indicator runs during it.
3. The worker decrypts the verifier. Failure means a wrong password, reported
   immediately, with nothing downloaded.
4. On success the derived key is stored in `sessionStorage` and the UI enters
   the unlocked state: every photo gains a full-size view and a Download
   Original button.
5. Requesting an original streams the `.enc` file, decrypting chunk by chunk in
   the worker with a byte-accurate progress bar, and assembles a Blob. The
   lightbox swaps to an object URL from that Blob and the download button uses
   the same Blob, so viewing and then saving costs one download.
6. After decryption the Blob's SHA-256 is compared with `original.sha256`.

**`sessionStorage`, not a variable:** both are cleared when the tab closes,
which is the behavior chosen; the difference is that a page refresh re-prompts
with a variable and does not with `sessionStorage`. The Content Security
Policy in section 3 exists largely to protect this value. Revisit if
memory-only strictness is preferred later.

### Failure modes

| Condition | Behavior |
|---|---|
| Wrong password | Verifier fails; message shown in under a second; nothing downloaded |
| Network failure mid-transfer | Retry the failed byte range up to three times, then offer a manual retry |
| Chunk fails its GCM tag | Report the file as corrupt or tampered; render nothing partial |
| SHA-256 mismatch after decrypt | Same as above; the download is not offered |
| Photo has no entry in `keys.json` | The original control is absent for that photo, not broken |
| No WebCrypto or no WASM | A plain explanation of the browser requirement, gallery still browsable |
| JavaScript disabled | `<noscript>` explains the gallery requires it |
| A shard fails to load | Error state with a retry; already-loaded photos remain usable |

## 8. Infrastructure setup

These are setup tasks in the implementation plan, not optional hardening.

1. **S3 bucket** with all public access blocked and no website endpoint.
2. **Bucket versioning enabled.** S3 now holds the only copy of the originals.
   Versioning turns an overwritten manifest or a mistaken delete into a
   one-command recovery, and is what `photos restore --manifest` depends on.
3. **Lifecycle rule** expiring noncurrent versions after 90 days, so
   versioning does not grow without bound.
4. **CloudFront distribution** with Origin Access Control, the two cache
   policies, the response headers policy, and an ACM certificate in
   `us-east-1` for the custom domain.
5. **Bucket policy** permitting only that distribution to read.
6. **IAM user or role** for the CLI, scoped to this bucket and to
   `CreateInvalidation` on this distribution.
7. **Backup routine.** Versioning protects against your own mistakes; it does
   not protect against a lost or compromised AWS account. Encrypted originals
   are safe to copy anywhere, so `orig/` and `data/` sync to an external drive
   or a second provider on a schedule. `photos verify` records the date of the
   last backup in `data/index.json` and warns when it is more than 30 days old.

Bucket and distribution setup is documented as a runbook in `infra/`, with the
AWS CLI commands to create each piece. It is done once, by hand, and verified
by `photos verify`.

## 9. Security model

**What this protects against.** Anyone without the password who finds the
bucket, the CDN, or a direct URL to a `.enc` object gets ciphertext. Originals
are safe at rest against a bucket misconfiguration, a leaked object listing, or
a curious visitor reading the network tab.

**What it does not protect against.**

- Anyone with the password. They can download, keep, and redistribute
  originals. Rotation does not reach what they already have.
- Web-sized copies. They are public by design, and the no-AI tags are
  voluntary signals that a bad actor will ignore.
- Metadata. Titles, captions, locations, and EXIF in `photos.json` are public.
  Location is free text precisely so it can be as vague as wanted.
- Offline password guessing. The ciphertext is public, so guessing is
  unthrottled. Argon2id at 64 MiB and a long passphrase are the entire defense,
  which is why the password should be long rather than clever.
- Knowing who unlocked anything. There is no backend and therefore no log.

## 10. Testing

**`core/` (vitest, no network, no browser):**

- Encrypt and decrypt round trips across sizes: 1 byte, exactly one chunk,
  one byte over a chunk, several chunks, and a realistic 40 MB file.
- A `chunkCount` of 0 is rejected.
- Tampering: flipping a byte in any chunk's ciphertext, tag, or header causes
  decryption to fail rather than return data.
- Truncation: removing the final chunk fails authentication.
- Splicing: a chunk from another file, or the same chunk at a different index,
  fails authentication.
- Key wrapping: a wrapped key cannot be unwrapped under a different photo id.
- Wrong password fails at the verifier.
- Rotation: after rotating, every photo decrypts under the new password and
  none under the old.
- Schema validation accepts the documented shapes and rejects malformed ones.

**`cli/` (vitest, S3 behind an in-memory fake):**

- A source image with GPS produces derivatives with no GPS tags.
- `--keep-gps` preserves them.
- Rights and opt-out tags are present in output, verified by reading them back
  with exiftool.
- Write ordering: a simulated failure at each step leaves the live manifest
  consistent.
- `gc` identifies exactly the orphans and nothing referenced.
- Sharding math: shard boundaries, `reindex` idempotence, and insertion of an
  older photo landing in the correct shard.

**`site/` (vitest with jsdom):**

- Library loader over a single shard and over many, through the same
  interface, including a display page that spans a shard boundary.
- URL state round trips for page and photo.
- The unlock state machine: locked, deriving, wrong password, unlocked,
  decrypting, failed.

**End to end (Playwright, one pass):** the CLI generates a small fixture
library with a known password; the test loads the grid, opens the lightbox,
submits a wrong password and asserts the failure, submits the right one,
decrypts an original, and asserts the bytes match the source file. This is the
test that proves the writer and the reader agree.

## 11. Deferred

Not in this project; noted so the design does not foreclose them.

- Albums or collections, and per-album passwords. The key hierarchy already
  supports multiple wrapped copies of a data key, so this is additive.
- Multiple passwords for revoking one person without disturbing others. Same
  mechanism.
- Search and tag filtering.
- Sharding is designed for but not built; `shardThreshold` triggers it and the
  loader interface absorbs it.
- An RSS or JSON feed of new photos.
