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
