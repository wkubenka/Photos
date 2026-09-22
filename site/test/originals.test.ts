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
