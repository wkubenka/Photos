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

  const figure = el("figure", {
    class: "thumb",
    // The lqip sits behind the image so there is no flash of empty space.
    style: `background-image:url(${photo.lqip});background-size:cover;`,
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
