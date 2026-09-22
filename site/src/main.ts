import type { MonthEntry } from "@photos/core";
import { createLibrary } from "./library.js";
import { currentView, navigate, onNavigate, parseView, type View } from "./urlstate.js";
import { renderHome, renderMonth, renderRail, renderError } from "./gallery.js";

const library = createLibrary();
const app = document.querySelector("#app") as HTMLElement;
const nav = document.querySelector("#nav") as HTMLElement;

// Safari lacked requestIdleCallback for years, so prefetching falls back to a macrotask.
const idle: (fn: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (fn) => { requestIdleCallback(fn); }
    : (fn) => { setTimeout(fn, 0); };

function monthOf(view: View): string | null {
  return view.kind === "home" ? null : view.month;
}

function prefetchNeighbours(month: string, months: MonthEntry[]): void {
  const index = months.findIndex((m) => m.month === month);
  if (index === -1) return;
  const before = months[index - 1];
  const after = months[index + 1];
  idle(() => {
    if (before) library.prefetch(before.month);
    if (after) library.prefetch(after.month);
  });
}

async function render(): Promise<void> {
  const view = currentView();
  const month = monthOf(view);
  try {
    const months = await library.months();
    renderRail(nav, months, month);

    if (month) {
      renderMonth(app, month, (await library.month(month)).photos);
      prefetchNeighbours(month, months);
    } else {
      renderHome(app, await library.featured());
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not load photos";
    renderError(app, message, () => void render());
  }
}

async function browseAll(): Promise<void> {
  try {
    const months = await library.months();
    const newest = months[0];
    if (newest) navigate({ kind: "month", month: newest.month });
  } catch {
    // The rail (or the error page it triggered) already surfaced this failure.
  }
}

// Intercept in-app links (thumbnails, rail entries, "Browse all") so navigation
// goes through history.pushState instead of a full page load. Modifier-clicks
// and non-primary buttons are left alone so "open in new tab" keeps working.
document.body.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;

  if (anchor.hasAttribute("data-browse-all")) {
    event.preventDefault();
    void browseAll();
    return;
  }

  if (!nav.contains(anchor) && !app.contains(anchor)) return;
  const href = anchor.getAttribute("href");
  if (!href || !href.startsWith("?")) return;

  event.preventDefault();
  navigate(parseView(href));
});

onNavigate(() => void render());
void render();
