import { monthOf, type MonthEntry, type Photo } from "@photos/core";
import { viewToSearch } from "./urlstate.js";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

// The lqip must not travel as an inline `style` attribute. This page ships
// `style-src 'self'` with no `'unsafe-inline'` (both in the meta tag and in
// the CloudFront response headers policy), and `style-src-attr` falls back
// to `style-src`, so the browser drops the attribute on every thumbnail and
// no placeholder ever renders. Weakening the policy is not an option: it is
// what protects a page holding a derived key in sessionStorage.
//
// A rule inserted through the CSSOM is not inline content and is not
// subject to that restriction, so each photo gets a generated class and one
// rule in a stylesheet this module owns.
//
// That stylesheet is a *constructable* one, adopted by the document. An
// empty <style> element is not a way around the policy: Chromium blocks the
// element itself and names the empty string's own hash in the violation, so
// its `.sheet` never joins the document and no rule in it ever applies.
// A constructable sheet is not inline content at all and is not checked.
// Engines without `adoptedStyleSheets` (jsdom, notably) fall back to a
// <style> element, which works wherever there is no CSP enforcing this.
const LQIP_DATA_URI = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

let lqipSheet: CSSStyleSheet | null | undefined;
const lqipClasses = new Map<string, string>();

function lqipStyleSheet(): CSSStyleSheet | null {
  if (lqipSheet !== undefined) return lqipSheet;
  lqipSheet = null;

  if ("adoptedStyleSheets" in document && typeof CSSStyleSheet === "function") {
    try {
      const sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      lqipSheet = sheet;
      return lqipSheet;
    } catch {
      // Fall through to the <style> element below.
    }
  }

  const style = document.createElement("style");
  document.head.append(style);
  // null when the CSP blocked the element: thumbnails then render with no
  // placeholder, which is the same graceful degradation as a malformed lqip.
  lqipSheet = style.sheet;
  return lqipSheet;
}

/**
 * The class that paints this photo's lqip, or null if it cannot be painted
 * (a malformed lqip, or no stylesheet to insert into). One rule per photo,
 * reused across re-renders so browsing back and forth does not grow the
 * sheet.
 */
export function lqipClassFor(photo: Photo): string | null {
  const existing = lqipClasses.get(photo.id);
  if (existing !== undefined) return existing;
  // Defence in depth behind PhotoSchema, which pins lqip to this same shape:
  // this is the one manifest string that reaches a CSS context.
  if (!LQIP_DATA_URI.test(photo.lqip)) return null;

  const sheet = lqipStyleSheet();
  if (!sheet) return null;

  const className = `lqip-${lqipClasses.size}`;
  try {
    sheet.insertRule(
      `.${className}{background-image:url("${photo.lqip}");background-size:cover;}`,
      sheet.cssRules.length,
    );
  } catch {
    return null;
  }
  lqipClasses.set(photo.id, className);
  return className;
}

export function thumbnail(photo: Photo): HTMLElement {
  const month = monthOf(photo.takenAt);
  const href = viewToSearch({ kind: "photo", id: photo.id, month });

  const img = el("img", {
    src: `/${photo.thumb.path}`,
    alt: photo.title,
    width: String(photo.thumb.w),
    height: String(photo.thumb.h),
    loading: "lazy",
    decoding: "async",
  });

  // The lqip sits behind the image so there is no flash of empty space.
  const lqipClass = lqipClassFor(photo);
  const figure = el("figure", {
    class: lqipClass ? `thumb ${lqipClass}` : "thumb",
  });
  figure.append(el("a", { href, "data-photo": photo.id }, img));
  // The alt text is the title; the caption becomes the figure's accessible
  // description via the native figure/figcaption relationship (figcaption
  // must be a direct child of figure), so no aria-describedby or id wiring
  // is needed. Visually hidden but present for screen readers. Skipped
  // entirely when there is no caption, since an empty description is noise.
  if (photo.caption !== "") {
    figure.append(el("figcaption", { class: "visually-hidden" }, photo.caption));
  }
  return figure;
}

function grid(photos: Photo[]): HTMLElement {
  const g = el("div", { class: "grid" });
  for (const p of photos) g.append(thumbnail(p));
  return g;
}

export function renderHome(root: HTMLElement, photos: Photo[]): void {
  root.replaceChildren();
  // tabindex="-1" makes the heading a valid, deliberate place to move focus
  // to programmatically (e.g. when a lightbox closes into a different view)
  // without adding it to the normal Tab order.
  root.append(el("h1", { tabindex: "-1" }, "Selected work"));
  if (photos.length === 0) {
    root.append(el("p", { class: "empty" },
      "There are no featured photos yet. Everything published lives in the archive."));
  } else {
    root.append(grid(photos));
  }
  root.append(el("p", { class: "browse-all" },
    el("a", { href: "#", "data-browse-all": "true" }, "Browse all photos →")));
}

export function renderMonth(root: HTMLElement, month: string, photos: Photo[]): void {
  root.replaceChildren();
  // See renderHome: tabindex="-1" lets focus move here deliberately without
  // joining the normal Tab order.
  root.append(el("h1", { tabindex: "-1" }, monthLabel(month)));
  root.append(el("p", { class: "count" }, `${photos.length} photographs`));
  root.append(grid(photos));
}

export function renderRail(nav: HTMLElement, months: MonthEntry[], active: string | null): void {
  nav.replaceChildren();
  const byYear = new Map<string, MonthEntry[]>();
  for (const m of months) {
    const year = m.month.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), m]);
  }

  for (const [year, entries] of byYear) {
    const section = el("details", { class: "rail-year", ...(entries.some((e) => e.month === active) ? { open: "" } : {}) });
    section.append(el("summary", {}, year));
    const list = el("ul");
    for (const entry of entries) {
      const link = el(
        "a",
        {
          href: viewToSearch({ kind: "month", month: entry.month }),
          ...(entry.month === active ? { "aria-current": "page" } : {}),
        },
        `${monthLabel(entry.month)} (${entry.count})`,
      );
      list.append(el("li", {}, link));
    }
    section.append(list);
    nav.append(section);
  }
}

export function renderError(root: HTMLElement, message: string, retry: () => void): void {
  root.replaceChildren();
  root.append(el("p", { class: "error", role: "alert" }, message));
  const button = el("button", { type: "button" }, "Try again");
  button.addEventListener("click", retry);
  root.append(button);
}
