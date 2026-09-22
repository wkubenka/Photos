// site/test/lightbox.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { openLightbox, exifLine } from "../src/lightbox.js";
import type { Photo } from "@photos/core";

const photo = (id: string): Photo => ({
  id, title: `Title ${id}`, caption: `Caption ${id}`, location: "Big Bend NP",
  takenAt: "2026-03-14T18:22:05-06:00", featured: false,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "Fujifilm X-T5", lens: "XF 16-55mm", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

let opener: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = "<button id='opener'>open</button>";
  opener = document.querySelector("#opener")!;
});

function open(overrides: Partial<Parameters<typeof openLightbox>[0]> = {}) {
  return openLightbox({
    photo: photo("b"),
    neighbours: { prev: photo("a"), next: photo("c") },
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    returnFocusTo: opener,
    ...overrides,
  });
}

describe("exifLine", () => {
  it("joins the whitelisted fields", () => {
    expect(exifLine(photo("a")))
      .toBe("Fujifilm X-T5 · XF 16-55mm · 23mm · f/8 · 1/60 · ISO 400");
  });

  it("omits fields that are empty rather than printing separators", () => {
    const p = photo("a");
    p.exif = { ...p.exif, lens: "", focalLength: "" };
    expect(exifLine(p)).toBe("Fujifilm X-T5 · f/8 · 1/60 · ISO 400");
  });
});

describe("lightbox", () => {
  it("shows the display copy, title, caption, and location", () => {
    const h = open();
    expect(h.element.querySelector("img")!.getAttribute("src")).toBe("/web/b-2048.aaaaaaaa.jpg");
    expect(h.element.textContent).toContain("Title b");
    expect(h.element.textContent).toContain("Caption b");
    expect(h.element.textContent).toContain("Big Bend NP");
  });

  it("is a modal dialog that traps focus", () => {
    const h = open();
    expect(h.element.getAttribute("role")).toBe("dialog");
    expect(h.element.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).not.toBe(opener);
  });

  it("moves to the next photo on ArrowRight and the previous on ArrowLeft", () => {
    const onNavigate = vi.fn();
    open({ onNavigate });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("does nothing at the ends of a month", () => {
    const onNavigate = vi.fn();
    open({ neighbours: { prev: null, next: null }, onNavigate });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("closes on Escape and restores focus to the thumbnail", () => {
    const onClose = vi.fn();
    open({ onClose });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("removes its keydown listener once closed", () => {
    const onNavigate = vi.fn();
    const h = open({ onNavigate });
    h.close();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("exposes an originals slot for the unlock UI to fill", () => {
    const h = open();
    const node = document.createElement("span");
    node.textContent = "unlock goes here";
    h.setSlot("originals", node);
    expect(h.element.querySelector("[data-slot='originals']")!.textContent).toBe("unlock goes here");
  });
});
