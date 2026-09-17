import { describe, it, expect } from "vitest";
import { publicLook } from "../src/handlers/settings";

describe("publicLook", () => {
  it("returns null unless the user opted in", () => {
    expect(publicLook({ PROFILE_THEME_PRESET: "synthwave" })).toBeNull();
    expect(
      publicLook({ SHARE_LOOK: false, PROFILE_THEME_PRESET: "synthwave" }),
    ).toBeNull();
  });

  it("returns the preset and mode when sharing is on", () => {
    expect(
      publicLook({
        SHARE_LOOK: true,
        PROFILE_THEME_PRESET: "dracula",
        BETTER_INTRA_THEME: "dark",
      }),
    ).toEqual({ preset: "dracula", theme: "dark" });
  });

  it("falls back to 'system' for a missing or oversized theme value", () => {
    expect(
      publicLook({ SHARE_LOOK: true, PROFILE_THEME_PRESET: "nord" }),
    ).toEqual({ preset: "nord", theme: "system" });
    expect(
      publicLook({
        SHARE_LOOK: true,
        PROFILE_THEME_PRESET: "nord",
        BETTER_INTRA_THEME: "x".repeat(65),
      }),
    ).toEqual({ preset: "nord", theme: "system" });
  });

  it("drops invalid or oversized presets", () => {
    expect(
      publicLook({ SHARE_LOOK: true, PROFILE_THEME_PRESET: 42 }),
    ).toBeNull();
    expect(
      publicLook({ SHARE_LOOK: true, PROFILE_THEME_PRESET: "" }),
    ).toBeNull();
    expect(
      publicLook({ SHARE_LOOK: true, PROFILE_THEME_PRESET: "x".repeat(65) }),
    ).toBeNull();
  });
});
