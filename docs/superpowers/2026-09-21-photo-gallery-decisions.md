# Photo gallery — decisions and residual risks

Written at the end of the automated build of this project. It records two things a
reader cannot recover from the git history: the decisions taken without asking, and the
risks known to remain. The design spec and implementation plan sit beside this file.

## Residual risks — read before running against real photographs

1. **The blurred placeholder only paints on modern engines.** The Content Security
   Policy blocks inline styles, so placeholders are painted through a constructable
   stylesheet (Chrome/Edge 73+, Firefox 101+, Safari 16.4+). The `<style>` fallback in
   `site/src/gallery.ts` is itself blocked by that policy and is effectively dead code.
   Older Safari shows thumbnails with no placeholder — graceful, not broken.

2. **The `lqip` schema pattern is a one-way gate.** It is enforced on every shard read,
   so a single hand-edited record whose placeholder is not a JPEG data URI would hard-fail
   `add`, `verify`, `gc`, `publish` and `repair`. Everything this CLI writes matches;
   the exposure is hand-edited or migrated data, and there is no migration path.

3. **An empty library holding encrypted originals cannot be garbage-collected.** `gc`
   refuses when no photo is referenced but `orig/` is non-empty — the guard that stops it
   deleting your archive after a lost index. `repair` does not break the loop. Reachable
   by interrupting a first-ever `add` after uploads but before the manifest commit.
   Removal then requires the AWS CLI directly.

4. **"Lock" returns the key but not already-decrypted images.** A photograph decrypted
   in the current lightbox session stays in memory until the lightbox closes. On a shared
   machine, Lock *and* closing the lightbox is the complete action.

5. **`cli/src/bin.ts` is almost untested** — only `--help` has coverage. The `edit`/`rm`
   usage guards, the `restore` dry run, the keys.json confirmation and the repair
   reminder have no automated tests. Reaching them needs config and credentials.

6. **`confirm()` can hang on a non-TTY stdin** (`< /dev/null`, CI), rather than aborting.

7. **`repair` keys shards by the `month` field inside the file**, not the object key. A
   mis-keyed shard is rebuilt under its declared month and the stale object is left for
   `gc`. Harmless, but not obvious.

## Decisions taken without asking

Sixty rulings were made during the build, each recorded with its reasoning and what it
would cost if wrong. They are reproduced below in the order they were made.

- Ruling R1: `readExif` takes `(path: string, offsetOverride?: string)`. Task 11's Interfaces
- Ruling R2: `--keep-gps` is currently inert — Global Constraints require GPS to be written
- Ruling R3: test fixtures built with `sharp({create})` carry no DateTimeOriginal, so
- Ruling R4: `node --experimental-strip-types` cannot resolve the `.js`-suffixed TypeScript
- Ruling R5: `KdfParams` (kdf.ts) and `KeysFileSchema.kdf` (schema.ts) describe the same
- Ruling R6 (deferred minor): `KEYS` in maintain.ts and `CACHE_SHORT`/`KEYS` in verify.ts may
- Ruling R7 (deferred minor): Task 23's Interfaces block lists `monthLabel` as consumed; the
- Ruling R8: the Important finding is real and I own it — the plan defines a `typecheck`
- Ruling R9 (deferred minor): core/tsconfig.json `rootDir: "."` would emit dist/test/ beside
- Ruling R10: the Important finding is real and I own it — my plan text had `monthOf` and
- Ruling R11: reviewer's minor "equal() is dead code" is wrong — Task 5's decodeHeader uses
- Ruling R12 (deferred minor): toBase64's per-byte string building. Only ever handed 16-32
- Ruling R13: hash-wasm declared as ^4.12.0 where the brief said ^4.11.0. Accepted, no fix —
- Ruling R14: the Important finding is real and I own it — my header test asserts chunkSize
- Ruling R15: I am RAISING the reviewer's Minor on encodeHeader not validating
- Ruling R16: reviewer proved by probe that "rejects truncation of the final chunk" removes
- Ruling R17: the error-message rewrite (container.ts:161-166) must go. It sniffs a
- Ruling R18: delete the second validation loop (container.ts:129-138). Reviewer showed
- Ruling R19: all eight remaining negative tests get message matchers. Bare .rejects.toThrow()
- Ruling R20: RAISING the reviewer's Minor on stream.ts not wrapping its decrypt failure.
- Ruling R21: the trailing-bytes-after-final-chunk path in finish() is implemented but has no
- Ruling R22: zod declared ^3.25.76 where the brief said ^3.23.0. Accepted, no fix — same
- Ruling R23: the Critical is real and confirmed — adding @types/node at the root silently
- Ruling R24: folding the Minor about Step 0's missing rationale into the same round. The
- Ruling R25: my prescribed fix in R23 was insufficient — a plan gap I did not anticipate.
- Ruling R26: AWS SDK declared ^3.1137.0 where the brief said ^3.665.0 — accepted on the same
- Ruling R27: folding in the Minor test gap — Task 10's tests never call head() or delete()
- Ruling R28: fix the ExifDateTime handling via a pure exported helper (exifDateString) that
- Ruling R29: cli/test/fixtures/make-fixtures.ts appears in Task 11's Files list but no step in
- Ruling R30: exiftool-vendored declared ^28.8.0 vs brief's ^28.3.0. Accepted, same basis as
- Ruling R31: three of the six whitelisted camera fields — focalLength, aperture, shutter —
- Ruling R32: the TDM reservation is written but unasserted, and — the structural point the
- Ruling R33: folding in two Minors — assert GPSLongitude as well as GPSLatitude on the opt-in
- Ruling R34: absent is not the same as unparseable. Omit the tag when the value is empty;
- Ruling R35: close both coverage gaps. The negative GPS test omits the composite GPSPosition
- Ruling R36: folding in the Minor that the wrong-password test asserts only the thrown error,
- Ruling R37: the Important is mine and the reviewer is right. rm writes keys.json BEFORE
- Ruling R38: folding in the Minor that setFeatured's rejection test uses a single bad id, so
- Ruling R39: the Critical is mine, verbatim from my plan — on JSON.parse or schema failure it
- Ruling R40: folding in the unused KEYS import in maintain.test.ts.
- Ruling R41: ACCEPT the implementer's exactOptionalPropertyTypes fix. The brief's bin.ts built
- Ruling R42: the packaging concern is REAL and is not a later task — there is no later
- Ruling R43: the implementer's jsdom finding is CORRECT but its consequence is smaller than
- Ruling R44: the implementer's other concern is my arithmetic — the brief predicts 7 tests
- Ruling R45: the CRITICAL is real, subtle, and reproduced — "types": [] does NOT keep Node
- Ruling R46: the reviewer correctly notes R43 was ruled but not yet enacted — that is my
- Ruling R47 (CRITICAL, mine): every cache slot stores the promise object regardless of how it
- Ruling R48 (CRITICAL, mine): month() checks the cache, then `await index()`, THEN writes the
- Ruling R49: add the missing over-fetch test — the no-hint photo() test places its target in
- Ruling R50: the Important is real and traces to the spec, not just the test name. Spec §7
- Ruling R51: folding in the Minor that gallery.ts re-derives the month with .slice(0, 7)
- Ruling R52 (SECURITY, mine): a background security review flagged XSS via manual HTML
- Ruling R53: no automated guard exists for the focus-preservation fix. The defect was found
- Ruling R54: the rail-click focus loss is real and reachable by a keyboard user. Returning
- Ruling R55: restore()'s try/catch conflates a rotation mismatch with a transient keys.json
- Ruling R56: worker.ts typechecks under lib DOM with no WebWorker entry, so `self` types as
- Ruling R57: close the worker's total lack of coverage before Task 26 depends on its contract.
- Ruling R58: network failure and GCM authentication failure collapse into one message
- Ruling R59: the object-URL leak on download-without-view is real and on the path most likely
- Ruling R60: no test touches main.ts's wiring or the app.ts hooks — which is precisely where
