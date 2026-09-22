import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    assetsDir: "assets",
    // The worker is a separate entry so Argon2id never runs on the main thread.
    rollupOptions: { output: { entryFileNames: "assets/[name].[hash].js" } },
  },
  worker: { format: "es" },
  // A `test.environment` setting here would be inert: the repo's `npm test`
  // runs a single root-level `vitest run` with no root vitest/workspace
  // config, so Vitest resolves config once from the invocation root and
  // never discovers this file. Tests that need jsdom instead declare it
  // per file with a `// @vitest-environment jsdom` directive at the top.
});
