import { describe, it, expect } from "vitest";
import { publicLook } from "../src/handlers/settings";

describe("publicLook", () => {
  it("returns the look even when sharing was not explicitly opted in", () => {
    expect(
      publicLook({ PROFILE_THEME_PRESET: "synthwave" }),
    ).toEqual({ preset: "synthwave", theme: "system" });
    expect(
      publicLook({ SHARE_LOOK: false, PROFILE_THEME_PRESET: "synthwave" }),
    ).toEqual({ preset: "synthwave", theme: "system" });
  });

  it("returns the preset and mode", () => {
    expect(
      publicLook({
        PROFILE_THEME_PRESET: "dracula",
        BETTER_INTRA_THEME: "dark",
      }),
    ).toEqual({ preset: "dracula", theme: "dark" });
  });

  it("falls back to 'system' for a missing or oversized theme value", () => {
    expect(
      publicLook({ PROFILE_THEME_PRESET: "nord" }),
    ).toEqual({ preset: "nord", theme: "system" });
    expect(
      publicLook({
        PROFILE_THEME_PRESET: "nord",
        BETTER_INTRA_THEME: "x".repeat(65),
      }),
    ).toEqual({ preset: "nord", theme: "system" });
  });

  it("drops invalid or oversized presets", () => {
    expect(publicLook({ PROFILE_THEME_PRESET: 42 })).toBeNull();
    expect(publicLook({ PROFILE_THEME_PRESET: "" })).toBeNull();
    expect(
      publicLook({ PROFILE_THEME_PRESET: "x".repeat(65) }),
    ).toBeNull();
  });
});
