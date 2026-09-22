import { monthOf as monthOfPhoto, type MonthEntry, type Photo } from "@photos/core";
import type { Library } from "./library.js";
import { currentView, navigate, type View } from "./urlstate.js";
import { renderHome, renderMonth, renderRail, renderError } from "./gallery.js";
import { openLightbox, type LightboxHandle } from "./lightbox.js";

export interface AppElements {
  app: HTMLElement;
  nav: HTMLElement;
  // Both optional: only main.ts's production wiring supplies them, to fill
  // the lightbox's "originals" slot (Task 25) and to release the object URL
  // behind it. Kept as a callback pair rather than exposing the internal
  // `lightbox` handle, so this module stays the one place that owns the
  // open/close lifecycle and can be unit-tested without any of that wiring.
  onLightboxOpen?: (handle: LightboxHandle, photo: Photo) => void;
  onLightboxClose?: () => void;
}

export interface App {
  render(): Promise<void>;
  browseAll(): Promise<void>;
}

// Safari lacked requestIdleCallback for years, so prefetching falls back to a macrotask.
const idle: (fn: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (fn) => { requestIdleCallback(fn); }
    : (fn) => { setTimeout(fn, 0); };

/**
 * All of the gallery's view logic, as a factory over injected dependencies
 * (the library and the two DOM roots it renders into) rather than module-level
 * singletons. That's what makes it possible to unit test `render()` — the
 * focus-management bugs found in this module only show up when you actually
 * drive a DOM, and `main.ts`'s top-level bootstrap (real `#app`/`#nav`
 * lookups, a real `document.body` click listener, a real popstate
 * subscription) has side effects the moment the module is imported, which
 * would fire against whatever jsdom document happens to exist at import time
 * in a test file. Splitting the two keeps `main.ts` a thin, untested
 * bootstrap shim and this module the testable core.
 */
export function createApp(library: Library, elements: AppElements): App {
  const { app, nav } = elements;

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
  // return focus to, dropping a keyboard user back on <body>. Both helpers
  // report whether they actually rebuilt, so callers can tell a same-view
  // close (where a thumbnail the lightbox already focused survives) from a
  // real view change (where it does not, and focus needs somewhere else to go).
  let renderedGrid: { kind: "home" } | { kind: "month"; month: string } | null = null;

  function ensureMonthGrid(month: string, photos: Photo[]): boolean {
    if (renderedGrid?.kind === "month" && renderedGrid.month === month) return false;
    renderMonth(app, month, photos);
    renderedGrid = { kind: "month", month };
    return true;
  }

  function ensureHomeGrid(photos: Photo[]): boolean {
    if (renderedGrid?.kind === "home") return false;
    renderHome(app, photos);
    renderedGrid = { kind: "home" };
    return true;
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

    // Not a CSS attribute selector: `CSS.escape` isn't implemented in jsdom
    // (nor guaranteed in every real environment), and a plain value
    // comparison over the id sidesteps needing to escape anything at all.
    const opener = Array.from(app.querySelectorAll<HTMLElement>("a[data-photo]"))
      .find((a) => a.getAttribute("data-photo") === photo.id) ?? null;

    closeLightbox();
    lightbox = openLightbox({
      photo,
      neighbours: { prev, next },
      onNavigate: (target) => {
        navigate({ kind: "photo", id: target.id, month: monthOfPhoto(target.takenAt) });
      },
      onClose: () => {
        lightbox = null;
        elements.onLightboxClose?.();
        if (closingProgrammatically) return;
        navigate({ kind: "month", month });
      },
      returnFocusTo: opener,
    });
    elements.onLightboxOpen?.(lightbox, photo);
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

      // A lightbox open at this point belongs to a photo in the view we're
      // about to leave. If the grid underneath it turns out to be the same
      // one already on screen, closing it below returns focus to a thumbnail
      // that survives (ensureMonthGrid/ensureHomeGrid will skip rebuilding).
      // If the grid actually changes, that thumbnail is destroyed a few lines
      // later, so focus needs to move somewhere deliberate instead of falling
      // back to <body> — the new view's own heading.
      const hadLightbox = lightbox !== null;
      closeLightbox();
      const month = viewMonth(view);
      renderRail(nav, months, month);

      const rebuilt = month
        ? ensureMonthGrid(month, (await library.month(month)).photos)
        : ensureHomeGrid(await library.featured());
      if (month) prefetchNeighbours(month, months);

      if (hadLightbox && rebuilt) {
        app.querySelector<HTMLElement>("h1")?.focus();
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

  return { render, browseAll };
}
