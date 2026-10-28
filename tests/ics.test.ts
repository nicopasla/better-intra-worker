import { describe, it, expect } from "vitest";
import { parseIcs, upcomingEvents, icsDateToIso, unescapeIcs } from "../src/ics";

function ics(blocks: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BetterIntra//Events//EN",
    ...blocks,
    "END:VCALENDAR",
  ].join("\r\n");
}

function event(fields: Record<string, string>): string {
  return [
    "BEGIN:VEVENT",
    ...Object.entries(fields).map(([k, v]) => `${k}:${v}`),
    "END:VEVENT",
  ].join("\r\n");
}

describe("icsDateToIso", () => {
  it("converts compact UTC dates", () => {
    expect(icsDateToIso("20261023T133000Z")).toBe("2026-10-23T13:30:00.000Z");
  });

  it("leaves values it cannot parse untouched", () => {
    expect(icsDateToIso("20261023")).toBe("20261023");
    expect(icsDateToIso("nonsense")).toBe("nonsense");
  });
});

describe("unescapeIcs", () => {
  it("unescapes commas, semicolons and newlines", () => {
    expect(unescapeIcs("a\\,b\\;c\\nd")).toBe("a,b;c\nd");
  });
});

describe("parseIcs", () => {
  it("parses the fields the app renders", () => {
    const raw = ics([
      event({
        UID: "1234@better-intra",
        DTSTART: "20261023T133000Z",
        DTEND: "20261023T160000Z",
        SUMMARY: "Piscine kick-off\\, day 1",
        LOCATION: "Cluster 1",
        DESCRIPTION: "Bring a laptop",
        "X-SUBSCRIBERS": "42",
        "X-MAX-SUBSCRIBERS": "100",
        URL: "https://profile.intra.42.fr/events/1234",
      }),
    ]);

    const [parsed] = parseIcs(raw);
    expect(parsed.id).toBe(1234);
    expect(parsed.name).toBe("Piscine kick-off, day 1");
    expect(parsed.beginAt).toBe("2026-10-23T13:30:00.000Z");
    expect(parsed.endAt).toBe("2026-10-23T16:00:00.000Z");
    expect(parsed.location).toBe("Cluster 1");
    expect(parsed.subscribers).toBe(42);
    expect(parsed.maxSubscribers).toBe(100);
    expect(parsed.url).toBe("https://profile.intra.42.fr/events/1234");
  });

  it("ignores VALARM sub-blocks so the alarm text never shadows the event", () => {
    const raw = ics([
      [
        "BEGIN:VEVENT",
        "UID:99@better-intra",
        "DTSTART:20261023T133000Z",
        "DTEND:20261023T140000Z",
        "SUMMARY:Workshop",
        "BEGIN:VALARM",
        "TRIGGER:-PT15M",
        "ACTION:DISPLAY",
        "DESCRIPTION:15 min before",
        "END:VALARM",
        "END:VEVENT",
      ].join("\r\n"),
    ]);

    const [parsed] = parseIcs(raw);
    expect(parsed.description).toBeNull();
    expect(parsed.name).toBe("Workshop");
  });

  it("unfolds continuation lines", () => {
    const raw = ics([
      "BEGIN:VEVENT\r\nUID:7@better-intra\r\nDTSTART:20261023T133000Z\r\nSUMMARY:Very long\r\n  name\r\nEND:VEVENT",
    ]);
    expect(parseIcs(raw)[0].name).toBe("Very long name");
  });

  it("skips events without a start or a summary", () => {
    const raw = ics([
      event({ UID: "1@x", SUMMARY: "No date" }),
      event({ UID: "2@x", DTSTART: "20261023T133000Z" }),
    ]);
    expect(parseIcs(raw)).toHaveLength(0);
  });

  it("falls back to the start when DTEND is missing", () => {
    const raw = ics([event({ UID: "5@x", DTSTART: "20261023T133000Z", SUMMARY: "One" })]);
    expect(parseIcs(raw)[0].endAt).toBe("2026-10-23T13:30:00.000Z");
  });

  it("returns nothing for an empty calendar body", () => {
    expect(parseIcs(ics([]))).toEqual([]);
    expect(parseIcs("")).toEqual([]);
  });
});

describe("upcomingEvents", () => {
  const now = new Date("2026-10-23T12:00:00.000Z").getTime();
  const raw = ics([
    event({
      UID: "1@x",
      DTSTART: "20261023T110000Z",
      DTEND: "20261023T115900Z",
      SUMMARY: "Ended",
    }),
    event({
      UID: "2@x",
      DTSTART: "20261023T130000Z",
      DTEND: "20261023T140000Z",
      SUMMARY: "Later",
    }),
    event({
      UID: "3@x",
      DTSTART: "20261023T090000Z",
      DTEND: "20261023T150000Z",
      SUMMARY: "Ongoing",
    }),
  ]);

  it("keeps ongoing and future events, sorted by start", () => {
    expect(upcomingEvents(raw, now).map((e) => e.name)).toEqual([
      "Ongoing",
      "Later",
    ]);
  });

  it("drops events that already ended", () => {
    expect(upcomingEvents(raw, now).some((e) => e.name === "Ended")).toBe(false);
  });
});
