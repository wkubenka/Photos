import { monthOf as monthOfPhoto, type MonthEntry, type Photo } from "@photos/core";
import { createLibrary } from "./library.js";
import { currentView, navigate, onNavigate, parseView, type View } from "./urlstate.js";
import { renderHome, renderMonth, renderRail, renderError } from "./gallery.js";
import { openLightbox, type LightboxHandle } from "./lightbox.js";

const library = createLibrary();
const app = document.querySelector("#app") as HTMLElement;
const nav = document.querySelector("#nav") as HTMLElement;

// Safari lacked requestIdleCallback for years, so prefetching falls back to a macrotask.
const idle: (fn: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (fn) => { requestIdleCallback(fn); }
    : (fn) => { setTimeout(fn, 0); };

function viewMonth(view: View): string | null {
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

// What's currently sitting behind any lightbox. A photo view renders the same
// month grid the photograph belongs to, so opening or closing the lightbox for
// a photo in the month already on screen must not rebuild that grid: doing so
// would tear out the very element the lightbox is about to (or just did)
// return focus to, dropping a keyboard user back on <body>.
let renderedGrid: { kind: "home" } | { kind: "month"; month: string } | null = null;

function ensureMonthGrid(month: string, photos: Photo[]): void {
  if (renderedGrid?.kind === "month" && renderedGrid.month === month) return;
  renderMonth(app, month, photos);
  renderedGrid = { kind: "month", month };
}

function ensureHomeGrid(photos: Photo[]): void {
  if (renderedGrid?.kind === "home") return;
  renderHome(app, photos);
  renderedGrid = { kind: "home" };
}

// At most one lightbox is ever open. `closingProgrammatically` distinguishes a
// user-initiated close (Escape, the × button, a swipe past the last photo's
// neighbour) — which should navigate back to the month view — from a close we
// trigger ourselves because navigation already happened (arrow-key/swipe to a
// neighbouring photo, or the URL changing out from under the lightbox via the
// rail, back/forward, or a fresh render). In the latter case the lightbox's
// own onClose must be a no-op or it would push a second, conflicting history
// entry.
let lightbox: LightboxHandle | null = null;
let closingProgrammatically = false;

function closeLightbox(): void {
  if (!lightbox) return;
  closingProgrammatically = true;
  lightbox.close();
  closingProgrammatically = false;
}

interface ResolvedPhoto {
  month: string;
  photos: Photo[];
  photo: Photo;
}

async function resolvePhoto(view: Extract<View, { kind: "photo" }>): Promise<ResolvedPhoto | null> {
  if (view.month) {
    const monthFile = await library.month(view.month);
    const photo = monthFile.photos.find((p) => p.id === view.id) ?? null;
    return photo ? { month: view.month, photos: monthFile.photos, photo } : null;
  }
  // No month in the URL: a bookmarked or shared `?photo=<id>` link. library.photo
  // searches months newest-first to find it.
  const photo = await library.photo(view.id, null);
  if (!photo) return null;
  const month = monthOfPhoto(photo.takenAt);
  const monthFile = await library.month(month);
  return { month, photos: monthFile.photos, photo };
}

function openPhotoLightbox(resolved: ResolvedPhoto): void {
  const { month, photos, photo } = resolved;
  const index = photos.findIndex((p) => p.id === photo.id);
  const prev = index > 0 ? (photos[index - 1] ?? null) : null;
  const next = index !== -1 && index < photos.length - 1 ? (photos[index + 1] ?? null) : null;

  const opener = app.querySelector<HTMLElement>(`a[data-photo="${CSS.escape(photo.id)}"]`) ?? null;

  closeLightbox();
  lightbox = openLightbox({
    photo,
    neighbours: { prev, next },
    onNavigate: (target) => {
      navigate({ kind: "photo", id: target.id, month: monthOfPhoto(target.takenAt) });
    },
    onClose: () => {
      lightbox = null;
      if (closingProgrammatically) return;
      navigate({ kind: "month", month });
    },
    returnFocusTo: opener,
  });
}

async function render(): Promise<void> {
  const view = currentView();
  try {
    const months = await library.months();

    if (view.kind === "photo") {
      const resolved = await resolvePhoto(view);
      if (!resolved) {
        closeLightbox();
        renderedGrid = null;
        renderRail(nav, months, null);
        renderError(app, `could not find that photograph`, () => void render());
        return;
      }
      renderRail(nav, months, resolved.month);
      ensureMonthGrid(resolved.month, resolved.photos);
      prefetchNeighbours(resolved.month, months);
      openPhotoLightbox(resolved);
      return;
    }

    closeLightbox();
    const month = viewMonth(view);
    renderRail(nav, months, month);

    if (month) {
      ensureMonthGrid(month, (await library.month(month)).photos);
      prefetchNeighbours(month, months);
    } else {
      ensureHomeGrid(await library.featured());
    }
  } catch (err) {
    closeLightbox();
    renderedGrid = null;
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
