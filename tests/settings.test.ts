import { describe, it, expect } from "vitest";
import {
  appendHistory,
  publicLook,
  settingsWriteDecision,
} from "../src/handlers/settings";

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

describe("settingsWriteDecision", () => {
  it("writes when there is no current revision", () => {
    expect(settingsWriteDecision(undefined, "base", false)).toBe("write");
    expect(settingsWriteDecision(null, "base", false)).toBe("write");
  });

  it("writes when the base revision matches", () => {
    expect(settingsWriteDecision("rev-1", "rev-1", false)).toBe("write");
  });

  it("writes for a legacy client that omits baseRevision", () => {
    expect(settingsWriteDecision("rev-1", undefined, false)).toBe("write");
  });

  it("conflicts when the client never pulled but the cloud has a revision", () => {
    expect(settingsWriteDecision("rev-1", null, false)).toBe("conflict");
  });

  it("writes when neither side has a revision", () => {
    expect(settingsWriteDecision(null, null, false)).toBe("write");
    expect(settingsWriteDecision(undefined, null, false)).toBe("write");
  });

  it("conflicts on a stale base revision", () => {
    expect(settingsWriteDecision("rev-2", "rev-1", false)).toBe("conflict");
  });

  it("force always writes", () => {
    expect(settingsWriteDecision("rev-2", "rev-1", true)).toBe("write");
  });
});

describe("appendHistory", () => {
  const mk = (
    n: number,
    settings: Record<string, unknown>,
  ): {
    revision: string | null;
    createdAt: number;
    settings: Record<string, unknown>;
  } => ({
    revision: `rev-${n}`,
    createdAt: n,
    settings,
  });

  it("prepends the new entry and caps the list", () => {
    const entries = [mk(1, { a: 1 }), mk(2, { a: 2 })];
    const next = appendHistory(entries, mk(3, { a: 3 }), 2);
    expect(next.map((e) => e.revision)).toEqual(["rev-3", "rev-1"]);
  });

  it("skips when identical to the latest snapshot", () => {
    const entries = [mk(1, { a: 1 })];
    expect(appendHistory(entries, mk(2, { a: 1 }))).toBe(entries);
  });

  it("caps at the default limit of 5", () => {
    let entries: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 8; i++) {
      entries = appendHistory(entries, mk(i, { a: i }));
    }
    expect(entries.length).toBe(5);
    expect(entries[0].revision).toBe("rev-7");
  });
});
