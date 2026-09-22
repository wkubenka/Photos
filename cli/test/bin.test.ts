import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Spawns the real `photos` entry point exactly as a user would invoke it
// (the cli/bin/photos shim, not a vitest-transformed import of bin.ts), so
// this actually exercises the shipped binary: the shim's own path
// resolution, tsx loading TypeScript at runtime, and tsx resolving
// @photos/core's TypeScript-only `main`/`exports`. Nothing else in this
// suite runs the CLI this way -- every other test imports command modules
// directly, which Vite/vitest transforms, masking exactly this kind of
// "can a plain `node`/shell invocation actually run this" gap.
const BIN = fileURLToPath(new URL("../bin/photos", import.meta.url));

describe("photos binary", () => {
  it(
    "runs --help as a subprocess, prints usage, and exits 0 with no AWS config",
    () => {
      // --help returns before loadConfig() is called, so this needs no
      // photos.config.json and no AWS credentials.
      const result = spawnSync(BIN, ["--help"], {
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("photos <command>");
      expect(result.stdout).toContain("deploy-site");
      expect(result.stdout).toContain("rotate-password");
    },
    30_000,
  );
});
