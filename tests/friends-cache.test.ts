import { describe, it, expect } from "vitest";
import {
  FRIEND_LIMIT,
  FRIEND_LOCATION_TTL_SECONDS,
  FRIEND_PROFILE_TTL_SECONDS,
  needsLocationRefresh,
  needsProfileRefresh,
  normalizeLogins,
  pickProfileFields,
  poolLabel,
  type FriendProfileRow,
} from "../src/handlers/friends-cache";

const row = (
  cachedAt: number,
  locationAt: number | null = cachedAt,
): FriendProfileRow => ({
  profile: {
    login: "alice",
    displayName: "Alice",
    avatar: null,
    level: 1,
    grade: null,
    wallet: 0,
    correctionPoints: 0,
    poolMonth: null,
    poolYear: null,
  },
  cachedAt,
  location: null,
  locationAt,
});

describe("normalizeLogins", () => {
  it("accepts an array from a POST body", () => {
    expect(normalizeLogins(["alice", "Bob"])).toEqual(["alice", "bob"]);
  });

  it("accepts the legacy comma-separated string", () => {
    expect(normalizeLogins("alice,bob")).toEqual(["alice", "bob"]);
  });

  it("dedupes and trims", () => {
    expect(normalizeLogins([" alice ", "alice", "ALICE"])).toEqual(["alice"]);
  });

  it("drops invalid logins instead of failing the request", () => {
    expect(normalizeLogins(["ok", "bad login", "../etc", "", 42])).toEqual([
      "ok",
    ]);
  });

  it("keeps dotted and dashed logins", () => {
    expect(normalizeLogins(["jean.dupont", "sait-ouc", "a_b"])).toEqual([
      "jean.dupont",
      "sait-ouc",
      "a_b",
    ]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 80 }, (_, i) => `user${i}`);
    expect(normalizeLogins(many)).toHaveLength(FRIEND_LIMIT);
  });

  it("returns an empty list for unsupported shapes", () => {
    expect(normalizeLogins(null)).toEqual([]);
    expect(normalizeLogins({ logins: ["a"] })).toEqual([]);
    expect(normalizeLogins(12)).toEqual([]);
  });
});

describe("poolLabel", () => {
  it("formats month/year as MM/YYYY", () => {
    expect(poolLabel("january", "2020")).toBe("01/2020");
    expect(poolLabel("july", "2024")).toBe("07/2024");
  });

  it("returns null when either part is missing", () => {
    expect(poolLabel(null, "2024")).toBeNull();
    expect(poolLabel("july", null)).toBeNull();
  });
});

describe("pickProfileFields", () => {
  it("maps a cursus_users entry", () => {
    const profile = pickProfileFields({
      level: 12.5,
      grade: "Learner",
      user: {
        login: "alice",
        displayname: "Alice",
        wallet: 40,
        correction_point: 3,
        pool_month: "july",
        pool_year: "2024",
        image: { link: "https://cdn/x.jpg" },
      },
    });

    expect(profile).toEqual({
      login: "alice",
      displayName: "Alice",
      avatar: "https://cdn/x.jpg",
      level: 12.5,
      grade: "Learner",
      wallet: 40,
      correctionPoints: 3,
      poolMonth: "july",
      poolYear: "2024",
    });
  });

  it("falls back to the login when there is no display name", () => {
    expect(pickProfileFields({ user: { login: "bob" } })?.displayName).toBe(
      "bob",
    );
  });

  it("returns null without a user login", () => {
    expect(pickProfileFields({})).toBeNull();
    expect(pickProfileFields(null)).toBeNull();
  });
});

describe("needsProfileRefresh", () => {
  it("fetches when there is no row", () => {
    expect(needsProfileRefresh(undefined, 1_000)).toBe(true);
  });

  it("respects the one-hour window", () => {
    const now = 1_000_000;
    expect(
      needsProfileRefresh(row(now - FRIEND_PROFILE_TTL_SECONDS + 1), now),
    ).toBe(false);
    expect(needsProfileRefresh(row(now - FRIEND_PROFILE_TTL_SECONDS), now)).toBe(
      true,
    );
  });
});

describe("needsLocationRefresh", () => {
  it("fetches when there is no row or no location timestamp", () => {
    expect(needsLocationRefresh(undefined, 1_000)).toBe(true);
    expect(needsLocationRefresh(row(1_000, null), 1_000)).toBe(true);
  });

  it("respects the ninety-second window", () => {
    const now = 1_000_000;
    expect(
      needsLocationRefresh(
        row(now, now - FRIEND_LOCATION_TTL_SECONDS + 1),
        now,
      ),
    ).toBe(false);
    expect(
      needsLocationRefresh(row(now, now - FRIEND_LOCATION_TTL_SECONDS), now),
    ).toBe(true);
  });
});
