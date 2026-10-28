import { describe, it, expect } from "vitest";
import {
  normalizeBadgeRow,
  normalizeBadges,
  parseLogins,
} from "../src/handlers/custom-badges";

const row = (overrides: Record<string, unknown> = {}) => ({
  badge: "example",
  label: "Example",
  color: "#3366cc",
  icon: "★",
  tooltip: "Fixture badge",
  logins: "user-one,user-two",
  ...overrides,
});

describe("parseLogins", () => {
  it("splits a comma-separated list, lowercased and deduped", () => {
    expect(parseLogins("User-One, user-two ,USER-ONE")).toEqual([
      "user-one",
      "user-two",
    ]);
  });

  it("accepts spaces, semicolons and newlines", () => {
    expect(parseLogins("a b;c\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("accepts a JSON array", () => {
    expect(parseLogins('["User-One","user-two"]')).toEqual([
      "user-one",
      "user-two",
    ]);
  });

  it("returns nothing for empty or broken values", () => {
    expect(parseLogins("")).toEqual([]);
    expect(parseLogins(null)).toEqual([]);
    expect(parseLogins("[not json")).toEqual([]);
  });
});

describe("normalizeBadgeRow", () => {
  it("keeps the renderable fields and the owner list", () => {
    expect(normalizeBadgeRow(row())).toEqual({
      id: "example",
      label: "Example",
      color: "#3366cc",
      icon: "★",
      tooltip: "Fixture badge",
      logins: ["user-one", "user-two"],
    });
  });

  it("drops rows without a badge id or label", () => {
    expect(normalizeBadgeRow(row({ badge: "  " }))).toBeNull();
    expect(normalizeBadgeRow(row({ label: " " }))).toBeNull();
  });

  it("only allows hex colours", () => {
    expect(normalizeBadgeRow(row({ color: "red" }))?.color).toBeNull();
    expect(
      normalizeBadgeRow(row({ color: "url(javascript:1)" }))?.color,
    ).toBeNull();
    expect(normalizeBadgeRow(row({ color: "#abc" }))?.color).toBe("#abc");
  });

  it("normalises optional fields to null", () => {
    const badge = normalizeBadgeRow(row({ icon: "", tooltip: "  " }));
    expect(badge?.icon).toBeNull();
    expect(badge?.tooltip).toBeNull();
  });

  it("caps long labels and tooltips", () => {
    const badge = normalizeBadgeRow(
      row({ label: "x".repeat(80), tooltip: "y".repeat(300) }),
    );
    expect(badge?.label.length).toBe(32);
    expect(badge?.tooltip?.length).toBe(160);
  });
});

describe("normalizeBadges", () => {
  it("skips invalid rows and keeps the rest in order", () => {
    const badges = normalizeBadges([
      row({ badge: "a", label: "A" }),
      row({ badge: "", label: "Broken" }),
      row({ badge: "b", label: "B" }),
    ]);
    expect(badges.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("handles a missing result set", () => {
    expect(normalizeBadges(null)).toEqual([]);
    expect(normalizeBadges(undefined)).toEqual([]);
  });
});
