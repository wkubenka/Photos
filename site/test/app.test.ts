// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { Library } from "../src/library.js";
import type { IndexFile, MonthEntry, MonthFile, Photo } from "@photos/core";

const photo = (id: string, takenAt: string): Photo => ({
  id, title: `Title ${id}`, caption: `Caption ${id}`, location: "Big Bend NP", takenAt, featured: false,
  web: { path: `web/${id}-2048.aaaaaaaa.jpg`, w: 2048, h: 1365, bytes: 100 },
  thumb: { path: `web/${id}-640.bbbbbbbb.jpg`, w: 640, h: 427, bytes: 10 },
  lqip: "data:image/jpeg;base64,aa",
  exif: { camera: "Fujifilm X-T5", lens: "XF 16-55mm", focalLength: "23mm", aperture: "f/8", shutter: "1/60", iso: 400 },
  original: { path: `orig/${id}.enc`, bytes: 1000, mime: "image/jpeg", sha256: "ab", chunkSize: 4194304, chunkCount: 1 },
});

const MONTHS: MonthEntry[] = [
  { month: "2026-03", count: 2, path: "data/months/2026-03.json" },
  { month: "2026-02", count: 1, path: "data/months/2026-02.json" },
];

const MARCH: MonthFile = {
  schemaVersion: 1,
  month: "2026-03",
  photos: [photo("b", "2026-03-15T10:00:00-06:00"), photo("a", "2026-03-14T10:00:00-06:00")],
};

const FEBRUARY: MonthFile = {
  schemaVersion: 1,
  month: "2026-02",
  photos: [photo("z", "2026-02-01T10:00:00-06:00")],
};

// A fake Library, not a mocked module: createApp takes it as a plain
// argument, so there is no need to reach for vi.mock here.
function fakeLibrary(): Library {
  return {
    index(): Promise<IndexFile> {
      throw new Error("not used by app.ts");
    },
    async months() {
      return MONTHS;
    },
    async month(m) {
      if (m === "2026-03") return MARCH;
      if (m === "2026-02") return FEBRUARY;
      throw new Error(`no photos for ${m}`);
    },
    async featured() {
      return [];
    },
    async photo(id, hint) {
      const pool = hint === "2026-02" ? FEBRUARY.photos : MARCH.photos;
      return pool.find((p) => p.id === id) ?? null;
    },
    prefetch() {
      // no-op: prefetching is a background nicety, irrelevant to these tests
    },
  };
}

let app: HTMLElement;
let nav: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "<main id='app'></main><nav id='nav'></nav>";
  app = document.querySelector("#app")!;
  nav = document.querySelector("#nav")!;
  history.replaceState(null, "", "/");
});

describe("createApp", () => {
  it("returns focus to the originating thumbnail after Escape closes the lightbox", async () => {
    const instance = createApp(fakeLibrary(), { app, nav });
    history.pushState(null, "", "?m=2026-03&photo=b");
    await instance.render();

    const opener = app.querySelector<HTMLElement>('a[data-photo="b"]');
    expect(opener).not.toBeNull();
    expect(document.querySelector(".lightbox")).not.toBeNull();

    // Escape closes the lightbox synchronously: it restores focus and pushes
    // the URL back to the month view, the same way the × button or an
    // onClose-driven navigate() would. main.ts's onNavigate listener is what
    // turns that URL change into a second render() in the real app; drive
    // that explicitly here rather than wiring a real popstate listener, since
    // it is that second render() — rebuilding the grid it renders into —
    // that regressed the focus fix this test guards.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await instance.render();

    expect(document.querySelector(".lightbox")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("moves focus to the new heading when the view behind a closed lightbox actually changes", async () => {
    const instance = createApp(fakeLibrary(), { app, nav });
    history.pushState(null, "", "?m=2026-03&photo=b");
    await instance.render();
    expect(document.querySelector(".lightbox")).not.toBeNull();

    // A rail click (or any navigation) to a *different* month while the
    // lightbox is still open: the thumbnail it would otherwise return focus
    // to is torn out when the grid is rebuilt for the new month, so focus
    // must land somewhere real instead of falling back to <body>.
    history.pushState(null, "", "?m=2026-02");
    await instance.render();

    expect(document.querySelector(".lightbox")).toBeNull();
    const heading = app.querySelector("h1");
    expect(heading).not.toBeNull();
    expect(heading!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
  });

  it("does not steal focus when no lightbox was open", async () => {
    const instance = createApp(fakeLibrary(), { app, nav });
    history.pushState(null, "", "?m=2026-03");
    await instance.render();

    // Focus something outside both render roots (the rail is rebuilt on
    // every render() regardless, unrelated to this fix — see the plan's
    // explicitly deferred "cache renderRail").
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    history.pushState(null, "", "?m=2026-02");
    await instance.render();

    // No lightbox was open, so render() must not have touched focus at all —
    // it stays exactly wherever it already was.
    expect(document.activeElement).toBe(outside);
  });
});
