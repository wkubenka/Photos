import type { Photo } from "@photos/core";

export interface LightboxOptions {
  photo: Photo;
  neighbours: { prev: Photo | null; next: Photo | null };
  onNavigate: (photo: Photo) => void;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}

export interface LightboxHandle {
  close(): void;
  element: HTMLElement;
  setSlot(name: "originals", node: Node): void;
}

export function exifLine(photo: Photo): string {
  const { camera, lens, focalLength, aperture, shutter, iso } = photo.exif;
  return [camera, lens, focalLength, aperture, shutter, iso ? `ISO ${iso}` : ""]
    .filter((part) => part !== "" && part !== null && part !== undefined)
    .join(" · ");
}

export function openLightbox(opts: LightboxOptions): LightboxHandle {
  const { photo } = opts;

  const element = document.createElement("div");
  element.className = "lightbox";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-label", photo.title);

  // The skeleton is static: nothing is interpolated into innerHTML. Photo fields
  // are free text the photographer typed, and a title containing a double quote
  // would break out of an attribute — so they are set as DOM properties, which
  // never re-parse as HTML.
  element.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close">×</button>
    <figure>
      <img decoding="async" />
      <figcaption>
        <h2></h2>
        <p class="caption"></p>
        <p class="location"></p>
        <p class="exif"></p>
        <div data-slot="originals"></div>
      </figcaption>
    </figure>
  `;
  const img = element.querySelector("img") as HTMLImageElement;
  img.src = `/${photo.web.path}`;
  img.alt = photo.title;
  img.width = photo.web.w;
  img.height = photo.web.h;

  element.querySelector("h2")!.textContent = photo.title;
  element.querySelector(".caption")!.textContent = photo.caption;
  element.querySelector(".location")!.textContent = photo.location;
  element.querySelector(".exif")!.textContent = exifLine(photo);

  const closeButton = element.querySelector(".lightbox-close") as HTMLButtonElement;

  function focusables(): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    )).filter((n) => !n.hasAttribute("disabled"));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowRight" && opts.neighbours.next) {
      opts.onNavigate(opts.neighbours.next); return;
    }
    if (event.key === "ArrowLeft" && opts.neighbours.prev) {
      opts.onNavigate(opts.neighbours.prev); return;
    }
    if (event.key === "Tab") {
      const nodes = focusables();
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  }

  let startX = 0;
  function onTouchStart(e: TouchEvent) { startX = e.changedTouches[0]!.clientX; }
  function onTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0]!.clientX - startX;
    if (dx < -50 && opts.neighbours.next) opts.onNavigate(opts.neighbours.next);
    if (dx > 50 && opts.neighbours.prev) opts.onNavigate(opts.neighbours.prev);
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchend", onTouchEnd);
    element.remove();
    opts.returnFocusTo?.focus();
    opts.onClose();
  }

  closeButton.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: true });

  document.body.append(element);
  closeButton.focus();

  return {
    element,
    close,
    setSlot(_name, node) {
      element.querySelector("[data-slot='originals']")!.replaceChildren(node);
    },
  };
}
