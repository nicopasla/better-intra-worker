import { describe, it, expect } from "vitest";
import { normalizeIsoUtc } from "../src/time";

describe("normalizeIsoUtc", () => {
  it("keeps a UTC ISO string unchanged", () => {
    expect(normalizeIsoUtc("2026-10-22T09:00:00.000Z")).toBe(
      "2026-10-22T09:00:00.000Z",
    );
  });

  it("converts an explicit offset to UTC", () => {
    expect(normalizeIsoUtc("2026-10-22T11:00:00.000+02:00")).toBe(
      "2026-10-22T09:00:00.000Z",
    );
  });

  it("returns an empty string for missing values", () => {
    expect(normalizeIsoUtc(null)).toBe("");
    expect(normalizeIsoUtc(undefined)).toBe("");
    expect(normalizeIsoUtc("")).toBe("");
    expect(normalizeIsoUtc("   ")).toBe("");
  });

  it("keeps an unparseable value instead of dropping it", () => {
    expect(normalizeIsoUtc("not-a-date")).toBe("not-a-date");
  });
});
