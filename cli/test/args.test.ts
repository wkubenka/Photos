import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("separates positionals from a flag and its value", () => {
    const { positional, flags } = parseArgs(["a.jpg", "--offset", "-06:00", "b.jpg"]);
    expect(positional).toEqual(["a.jpg", "b.jpg"]);
    expect(flags.offset).toBe("-06:00");
  });

  it("treats a flag with no value as a boolean", () => {
    const { positional, flags } = parseArgs(["a.jpg", "--keep-gps"]);
    expect(positional).toEqual(["a.jpg"]);
    expect(flags["keep-gps"]).toBe(true);
  });

  it("does not swallow a following flag as a value", () => {
    const { flags } = parseArgs(["--keep-gps", "--offset", "+01:00"]);
    expect(flags["keep-gps"]).toBe(true);
    expect(flags.offset).toBe("+01:00");
  });

  it("accepts --flag=value", () => {
    expect(parseArgs(["--title=Santa Elena"]).flags.title).toBe("Santa Elena");
  });

  it("keeps a negative number as a flag value, not a flag", () => {
    expect(parseArgs(["--offset", "-06:00"]).flags.offset).toBe("-06:00");
  });

  it("returns empty results for no arguments", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });
});
