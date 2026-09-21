import { describe, it, expect } from "vitest";
import { monthOf, slugify, makePhotoId } from "../src/months.js";

describe("monthOf", () => {
  it("uses the local date, not UTC, at a negative offset", () => {
    // 2026-04-01T01:22:05Z in UTC, but still March where it was shot.
    expect(monthOf("2026-03-31T19:22:05-06:00")).toBe("2026-03");
  });

  it("uses the local date, not UTC, at a positive offset", () => {
    // 2026-03-31T22:00:00Z in UTC, but already April where it was shot.
    expect(monthOf("2026-04-01T01:00:00+03:00")).toBe("2026-04");
  });

  it("accepts a Z offset", () => {
    expect(monthOf("2026-07-04T12:00:00Z")).toBe("2026-07");
  });

  it("rejects a timestamp with no offset", () => {
    expect(() => monthOf("2026-03-14T18:22:05")).toThrow(/offset/);
  });
});

describe("slugify", () => {
  it("lowercases, strips punctuation, and joins with hyphens", () => {
    expect(slugify("Santa Elena at Dusk!")).toBe("santa-elena-at-dusk");
  });

  it("collapses runs and trims hyphens", () => {
    expect(slugify("  --A   B--  ")).toBe("a-b");
  });
});

describe("makePhotoId", () => {
  it("combines local date, title slug, and frame number", () => {
    expect(makePhotoId("2026-03-14T18:22:05-06:00", "Santa Elena at dusk", "0031"))
      .toBe("2026-03-14-santa-elena-at-dusk-0031");
  });

  it("truncates a very long title to keep ids manageable", () => {
    const id = makePhotoId("2026-03-14T18:22:05-06:00", "x".repeat(200), "1");
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id.endsWith("-1")).toBe(true);
  });
});
