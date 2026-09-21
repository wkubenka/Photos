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
