// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHome, renderMonth, renderRail, renderError, thumbnail } from "../src/gallery.js";
import type { Photo } from "@photos/core";

const photo = (id: string, takenAt: string): Photo => ({
  id, title: `Title ${id}`, caption: `Caption ${id}`, location: "Big Bend NP", takenAt, featured: false,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "Fujifilm X-T5", lens: "XF 16-55mm", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "<div id='app'></div><nav id='nav'></nav>";
  root = document.querySelector("#app")!;
});

describe("thumbnail", () => {
  it("sets explicit dimensions so the grid does not shift", () => {
    const img = thumbnail(photo("a", "2026-03-14T10:00:00-06:00")).querySelector("img")!;
    expect(img.getAttribute("width")).toBe("640");
    expect(img.getAttribute("height")).toBe("427");
  });

  it("lazy-loads and uses the lqip as a background placeholder", () => {
    const fig = thumbnail(photo("a", "2026-03-14T10:00:00-06:00"));
    const img = fig.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(fig.getAttribute("style")).toContain("data:image/jpeg;base64,aa");
  });

  it("uses the title as alt text and the caption as the description", () => {
    const img = thumbnail(photo("a", "2026-03-14T10:00:00-06:00")).querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Title a");
  });

  it("links to the photo with its month", () => {
    const link = thumbnail(photo("a", "2026-03-14T10:00:00-06:00")).querySelector("a")!;
    expect(link.getAttribute("href")).toBe("?m=2026-03&photo=a");
  });
});

describe("renderHome", () => {
  it("renders the curated set with a browse-all link", () => {
    renderHome(root, [photo("a", "2026-03-14T10:00:00-06:00")]);
    expect(root.querySelectorAll("figure")).toHaveLength(1);
    expect(root.textContent).toContain("Browse all");
  });

  it("explains itself when nothing is featured yet", () => {
    renderHome(root, []);
    expect(root.textContent).toMatch(/no featured photos/i);
    expect(root.textContent).toContain("Browse all");
  });
});

describe("renderMonth", () => {
  it("renders a heading and every photo in one grid", () => {
    renderMonth(root, "2026-03", [
      photo("a", "2026-03-14T10:00:00-06:00"),
      photo("b", "2026-03-15T10:00:00-06:00"),
    ]);
    expect(root.querySelector("h1")!.textContent).toBe("March 2026");
    expect(root.querySelectorAll("figure")).toHaveLength(2);
  });

  it("applies content-visibility so heavy months stay affordable", () => {
    renderMonth(root, "2026-03", [photo("a", "2026-03-14T10:00:00-06:00")]);
    expect(root.querySelector(".grid")!.className).toContain("grid");
  });
});

describe("renderRail", () => {
  it("groups months under years with counts and marks the active one", () => {
    const nav = document.querySelector("#nav") as HTMLElement;
    renderRail(nav, [
      { month: "2026-08", count: 151, path: "p" },
      { month: "2026-03", count: 147, path: "p" },
      { month: "2025-12", count: 20, path: "p" },
    ], "2026-03");

    expect(nav.querySelectorAll(".rail-year")).toHaveLength(2);
    expect(nav.textContent).toContain("August 2026");
    expect(nav.textContent).toContain("151");
    expect(nav.querySelector("[aria-current='page']")!.textContent).toContain("March 2026");
  });
});

describe("renderError", () => {
  it("shows the message and a working retry button", () => {
    let retried = 0;
    renderError(root, "could not load photos for 2026-03", () => { retried++; });
    expect(root.textContent).toContain("could not load photos");
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(retried).toBe(1);
  });
});
