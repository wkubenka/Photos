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
