const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export type View =
  | { kind: "home" }
  | { kind: "month"; month: string }
  | { kind: "photo"; id: string; month: string | null };

export function parseView(search: string): View {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawMonth = params.get("m");
  const month = rawMonth && MONTH.test(rawMonth) ? rawMonth : null;
  const photo = params.get("photo");
  if (photo) return { kind: "photo", id: photo, month };
  if (month) return { kind: "month", month };
  return { kind: "home" };
}

export function viewToSearch(view: View): string {
  const params = new URLSearchParams();
  if (view.kind === "month") params.set("m", view.month);
  if (view.kind === "photo") {
    if (view.month) params.set("m", view.month);
    params.set("photo", view.id);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function navigate(view: View): void {
  history.pushState(view, "", `${location.pathname}${viewToSearch(view)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function onNavigate(fn: (view: View) => void): void {
  window.addEventListener("popstate", () => fn(parseView(location.search)));
}

export function currentView(): View {
  return parseView(location.search);
}
