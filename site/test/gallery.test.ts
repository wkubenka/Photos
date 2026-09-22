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

  // The placeholder cannot ride on an inline `style` attribute: the page
  // ships `style-src 'self'` with no `'unsafe-inline'`, and `style-src-attr`
  // falls back to `style-src`, so the browser drops the attribute on every
  // thumbnail. jsdom does not enforce CSP, so asserting the attribute is
  // present proved nothing about whether it renders. These assert the
  // mechanism actually shipped: a class plus a CSSOM-inserted rule, which
  // CSP does not block.
  it("lazy-loads and paints the lqip through a stylesheet rule, not an inline style", () => {
    const fig = thumbnail(photo("lqip-one", "2026-03-14T10:00:00-06:00"));
    const img = fig.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");

    expect(fig.getAttribute("style")).toBeNull();
    const lqipClass = Array.from(fig.classList).find((c) => c.startsWith("lqip-"));
    expect(lqipClass).toBeDefined();

    const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
    const rule = rules.find((r) => r.cssText.includes(`.${lqipClass}`))!;
    expect(rule).toBeDefined();
    expect(rule.cssText).toContain("data:image/jpeg;base64,aa");
    expect(rule.cssText).toContain("background-image");
  });

  it("reuses one rule per photo across re-renders", () => {
    const p = photo("lqip-repeat", "2026-03-14T10:00:00-06:00");
    const first = thumbnail(p).className;
    const second = thumbnail(p).className;
    expect(second).toBe(first);
    const lqipClass = first.split(" ").find((c) => c.startsWith("lqip-"))!;
    const matching = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((r) => r.cssText.includes(`.${lqipClass}`));
    expect(matching).toHaveLength(1);
  });

  it("renders the thumbnail without a placeholder rather than injecting an unrecognised lqip", () => {
    const p = photo("lqip-bad", "2026-03-14T10:00:00-06:00");
    p.lqip = "url(javascript:alert(1))";
    const fig = thumbnail(p);
    expect(Array.from(fig.classList)).toEqual(["thumb"]);
    expect(fig.querySelector("img")).not.toBeNull();
    const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
    expect(rules.some((r) => r.cssText.includes("javascript:"))).toBe(false);
  });

  it("uses the title as alt text and the caption as the description", () => {
    const fig = thumbnail(photo("a", "2026-03-14T10:00:00-06:00"));
    const img = fig.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Title a");
    expect(fig.querySelector("figcaption")!.textContent).toBe("Caption a");
  });

  it("omits the figcaption entirely when there is no caption", () => {
    const p = photo("a", "2026-03-14T10:00:00-06:00");
    p.caption = "";
    const fig = thumbnail(p);
    expect(fig.querySelector("figcaption")).toBeNull();
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
