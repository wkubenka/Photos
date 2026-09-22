import { createLibrary } from "./library.js";
import { navigate, onNavigate, parseView } from "./urlstate.js";
import { createApp } from "./app.js";

const library = createLibrary();
const app = document.querySelector("#app") as HTMLElement;
const nav = document.querySelector("#nav") as HTMLElement;

const instance = createApp(library, { app, nav });

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
    void instance.browseAll();
    return;
  }

  if (!nav.contains(anchor) && !app.contains(anchor)) return;
  const href = anchor.getAttribute("href");
  if (!href || !href.startsWith("?")) return;

  event.preventDefault();
  navigate(parseView(href));
});

onNavigate(() => void instance.render());
void instance.render();
