import { describe, it, expect } from "vitest";
import {
  localHour,
  pickNotifyBeginAt,
  shouldSkipNightPoll,
} from "../src/handlers/cron";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

describe("formatTime", () => {
  it("formats a valid ISO string to HH:MM", () => {
    const result = formatTime("2024-06-15T14:30:00Z");
    const d = new Date("2024-06-15T14:30:00Z");
    const expected = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    expect(result).toBe(expected);
  });

  it("always produces two-digit hours and minutes", () => {
    const result = formatTime("2024-01-01T09:05:00Z");
    expect(/^\d{2}:\d{2}$/.test(result)).toBe(true);
  });

  it("handles midnight", () => {
    const result = formatTime("2024-01-01T00:00:00Z");
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("pickNotifyBeginAt", () => {
  it("prefers the persisted D1 value over the live API value", () => {
    expect(
      pickNotifyBeginAt("2026-10-22T09:00:00.000Z", "2026-10-22T11:00:00.000Z"),
    ).toBe("2026-10-22T09:00:00.000Z");
  });

  it("falls back to the API value when D1 has none", () => {
    expect(pickNotifyBeginAt(null, "2026-10-22T09:00:00.000Z")).toBe(
      "2026-10-22T09:00:00.000Z",
    );
    expect(pickNotifyBeginAt(undefined, "2026-10-22T09:00:00.000Z")).toBe(
      "2026-10-22T09:00:00.000Z",
    );
  });

  it("returns an empty string when neither value exists", () => {
    expect(pickNotifyBeginAt(null, undefined)).toBe("");
  });
});

const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

describe("localHour", () => {
  it("resolves the hour in the user's timezone", () => {
    const winter = new Date("2026-01-15T02:30:00Z");
    expect(localHour(winter, "Europe/Paris")).toBe(3); // UTC+1
    expect(localHour(winter, "Africa/Nairobi")).toBe(5); // UTC+3
    expect(localHour(winter, "Europe/Lisbon")).toBe(2); // UTC+0
  });

  it("handles midnight without returning 24", () => {
    expect(localHour(new Date("2026-01-15T23:30:00Z"), "Europe/Paris")).toBe(0);
  });

  it("returns null for a missing or invalid timezone", () => {
    expect(localHour(new Date(), null)).toBeNull();
    expect(localHour(new Date(), undefined)).toBeNull();
    expect(localHour(new Date(), "Not/AZone")).toBeNull();
  });
});

describe("shouldSkipNightPoll", () => {
  const now = at("2026-01-15T02:30:00Z"); // 03:30 in Paris

  it("skips a night poll inside the thirty-minute window", () => {
    expect(shouldSkipNightPoll(now - 5 * 60, "Europe/Paris", now)).toBe(true);
    expect(shouldSkipNightPoll(now - 29 * 60, "Europe/Paris", now)).toBe(true);
  });

  it("polls again once thirty minutes have passed", () => {
    expect(shouldSkipNightPoll(now - 30 * 60, "Europe/Paris", now)).toBe(false);
    expect(shouldSkipNightPoll(now - 120 * 60, "Europe/Paris", now)).toBe(false);
  });

  it("never throttles during the day", () => {
    const noon = at("2026-01-15T12:00:00Z"); // 13:00 in Paris
    expect(shouldSkipNightPoll(noon - 60, "Europe/Paris", noon)).toBe(false);
  });

  it("treats the window as [01:00, 07:00) local", () => {
    const oneAm = at("2026-01-15T00:00:00Z"); // 01:00 in Paris
    const sevenAm = at("2026-01-15T06:00:00Z"); // 07:00 in Paris
    expect(shouldSkipNightPoll(oneAm - 60, "Europe/Paris", oneAm)).toBe(true);
    expect(shouldSkipNightPoll(sevenAm - 60, "Europe/Paris", sevenAm)).toBe(
      false,
    );
  });

  it("does not throttle users we cannot place or never polled", () => {
    expect(shouldSkipNightPoll(now - 60, null, now)).toBe(false);
    expect(shouldSkipNightPoll(now - 60, "Not/AZone", now)).toBe(false);
    expect(shouldSkipNightPoll(null, "Europe/Paris", now)).toBe(false);
  });

  it("uses each user's own timezone", () => {
    // 05:30 in Nairobi -> night; 02:30 in Lisbon -> night; 12:30 in Dubai -> day
    expect(shouldSkipNightPoll(now - 60, "Africa/Nairobi", now)).toBe(true);
    const dubaiNoon = at("2026-01-15T08:30:00Z"); // 12:30 in Dubai
    expect(shouldSkipNightPoll(dubaiNoon - 60, "Asia/Dubai", dubaiNoon)).toBe(
      false,
    );
  });
});
