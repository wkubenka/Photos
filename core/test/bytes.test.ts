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
