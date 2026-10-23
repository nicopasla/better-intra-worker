import { describe, it, expect } from "vitest";
import {
  buildCorrectedPush,
  buildEvalPush,
  formatPushTime,
  isValidTimeZone,
} from "../src/handlers/eval-notify";

const NOON_UTC = new Date("2026-10-23T12:00:00.000Z");

describe("isValidTimeZone", () => {
  it("accepts IANA zones", () => {
    expect(isValidTimeZone("Europe/Brussels")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown or malformed values", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("formatPushTime", () => {
  it("renders the instant in the device timezone", () => {
    expect(
      formatPushTime("2026-10-23T13:30:00.000Z", "Europe/Brussels", NOON_UTC),
    ).toBe("15:30");
  });

  it("falls back to UTC when the zone is missing or invalid", () => {
    expect(formatPushTime("2026-10-23T13:30:00.000Z", null, NOON_UTC)).toBe(
      "13:30",
    );
    expect(formatPushTime("2026-10-23T13:30:00.000Z", undefined, NOON_UTC)).toBe(
      "13:30",
    );
    expect(formatPushTime("2026-10-23T13:30:00.000Z", "Nope/Nope", NOON_UTC)).toBe(
      "13:30",
    );
  });

  it("follows daylight saving time", () => {
    expect(
      formatPushTime(
        "2026-07-01T13:30:00.000Z",
        "Europe/Brussels",
        new Date("2026-07-01T09:00:00.000Z"),
      ),
    ).toBe("15:30");
    expect(
      formatPushTime(
        "2026-12-01T13:30:00.000Z",
        "Europe/Brussels",
        new Date("2026-12-01T09:00:00.000Z"),
      ),
    ).toBe("14:30");
  });

  it("adds the date when the eval is not today in that zone", () => {
    expect(
      formatPushTime("2026-10-24T13:30:00.000Z", "Europe/Brussels", NOON_UTC),
    ).toBe("24/10/26 15:30");
  });

  it("compares days in the target zone, not UTC", () => {
    // 23:30Z is already 01:30 the next day in Brussels.
    const evening = new Date("2026-10-23T20:00:00.000Z");
    expect(
      formatPushTime("2026-10-23T23:30:00.000Z", "Europe/Brussels", evening),
    ).toBe("24/10/26 01:30");
    expect(formatPushTime("2026-10-23T23:30:00.000Z", "UTC", evening)).toBe(
      "23:30",
    );
  });

  it("returns an empty string for unparseable dates", () => {
    expect(formatPushTime("not-a-date", "Europe/Brussels", NOON_UTC)).toBe("");
  });
});

describe("buildEvalPush", () => {
  const beginAt = "2026-10-23T13:30:00.000Z";

  it("renders the booked time in the device timezone", () => {
    const push = buildEvalPush({
      kind: "booked",
      project: null,
      beginAt,
      timeZone: "Europe/Brussels",
    });
    expect(push.title).toBe("Evaluation Booked");
    expect(push.body).toBe(
      `Evaluating someone at ${formatPushTime(beginAt, "Europe/Brussels")}`,
    );
    expect(push.body).toContain("15:30");
  });

  it("keeps the project and corrected logins on reveal", () => {
    const push = buildEvalPush({
      kind: "revealed",
      project: "ft_transcendence",
      beginAt,
      correcteds: ["elmo", "kermit"],
      timeZone: "Europe/Brussels",
    });
    expect(push.title).toBe("Evaluation in 15 min");
    expect(push.body).toContain("Correcting elmo, kermit");
    expect(push.body).toContain("ft_transcendence");
    expect(push.body).toContain("15:30");
  });

  it("does not ship the raw instant, so clients cannot re-format it in UTC", () => {
    const push = buildEvalPush({ kind: "booked", project: null, beginAt });
    expect("beginAt" in push).toBe(false);
  });
});

describe("buildCorrectedPush", () => {
  it("renders the evaluator and the local time", () => {
    const push = buildCorrectedPush({
      beginAt: "2026-10-23T13:30:00.000Z",
      corrector: "elmo",
      timeZone: "Europe/Brussels",
    });
    expect(push.title).toBe("Evaluation in 15 min");
    expect(push.body).toContain("Your evaluator: elmo");
    expect(push.body).toContain("15:30");
    expect("beginAt" in push).toBe(false);
  });
});
