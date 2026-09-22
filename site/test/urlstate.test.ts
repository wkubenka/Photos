import { describe, it, expect } from "vitest";
import { parseView, viewToSearch } from "../src/urlstate.js";

describe("parseView", () => {
  it("defaults to the curated home page", () => {
    expect(parseView("")).toEqual({ kind: "home" });
    expect(parseView("?")).toEqual({ kind: "home" });
  });

  it("reads a month", () => {
    expect(parseView("?m=2026-03")).toEqual({ kind: "month", month: "2026-03" });
  });

  it("reads a photo, carrying its month when present", () => {
    expect(parseView("?m=2026-03&photo=abc")).toEqual({ kind: "photo", id: "abc", month: "2026-03" });
    expect(parseView("?photo=abc")).toEqual({ kind: "photo", id: "abc", month: null });
  });

  it("ignores a malformed month rather than showing an error page", () => {
    expect(parseView("?m=2026-3")).toEqual({ kind: "home" });
    expect(parseView("?m=nonsense")).toEqual({ kind: "home" });
  });
});

describe("viewToSearch", () => {
  it("round-trips every view", () => {
    for (const view of [
      { kind: "home" } as const,
      { kind: "month", month: "2026-03" } as const,
      { kind: "photo", id: "abc", month: "2026-03" } as const,
      { kind: "photo", id: "abc", month: null } as const,
    ]) {
      expect(parseView(viewToSearch(view))).toEqual(view);
    }
  });

  it("produces a clean url for home", () => {
    expect(viewToSearch({ kind: "home" })).toBe("");
  });
});
