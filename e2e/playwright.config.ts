import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// With `testDir: "."` and this config file living in `e2e/`, Playwright's
// default rootDir (and so the webServer command's cwd) is `e2e/` itself —
// not the repo root the fixture path below is written relative to. Without
// an explicit `cwd` here, "e2e/.fixture/site" resolves to the nonexistent
// "e2e/e2e/.fixture/site", http-server serves 404s for everything under it,
// and Playwright's readiness check (which waits for a 2xx response) times
// out after 60s having never seen one.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: ".",
  // e2e/tsconfig.json (added so `npm run typecheck` covers this directory
  // too) emits compiled output to e2e/dist/, including a second copy of
  // gallery.spec.js. Playwright's default testMatch is recursive, so without
  // this it picks up both copies; the compiled one's relative imports are
  // one directory level shallower than the source's and fail at runtime.
  // Restricting to *.spec.ts (plus ignoring dist/.fixture as a second guard)
  // keeps exactly one copy of the suite in play.
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/dist/**", "**/.fixture/**"],
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npx http-server e2e/.fixture/site -p 4173 --silent",
    cwd: repoRoot,
    url: "http://localhost:4173",
    reuseExistingServer: false,
  },
});
