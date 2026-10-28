import { describe, it, expect } from "vitest";
import {
  dueEvents,
  eventKey,
  pruneNotified,
  EVENT_LEAD_MS,
  EVENT_WINDOW_MS,
} from "../src/handlers/event-notify";
import { buildEventPush, formatPushTime } from "../src/push-payloads";
import type { ParsedEvent } from "../src/ics";

const NOW = new Date("2026-10-23T12:00:00.000Z").getTime();

function eventAt(offsetMs: number, name = "Hackathon"): ParsedEvent {
  const begin = new Date(NOW + offsetMs);
  return {
    id: 42,
    name,
    beginAt: begin.toISOString(),
    endAt: new Date(NOW + offsetMs + 60 * 60 * 1000).toISOString(),
    location: "Cluster 1",
    description: null,
    subscribers: null,
    maxSubscribers: null,
    url: null,
  };
}

describe("dueEvents", () => {
  it("matches an event exactly 15 minutes out", () => {
    expect(dueEvents([eventAt(EVENT_LEAD_MS)], NOW)).toHaveLength(1);
  });

  it("matches within the widened window", () => {
    expect(
      dueEvents([eventAt(EVENT_LEAD_MS - EVENT_WINDOW_MS + 1000)], NOW),
    ).toHaveLength(1);
  });

  it("does not match once the window has passed", () => {
    expect(
      dueEvents([eventAt(EVENT_LEAD_MS - EVENT_WINDOW_MS - 1000)], NOW),
    ).toHaveLength(0);
  });

  it("does not match events further than 15 minutes away", () => {
    expect(dueEvents([eventAt(EVENT_LEAD_MS + 1000)], NOW)).toHaveLength(0);
    expect(dueEvents([eventAt(60 * 60 * 1000)], NOW)).toHaveLength(0);
  });

  it("does not match an event that already started", () => {
    expect(dueEvents([eventAt(-60 * 1000)], NOW)).toHaveLength(0);
  });

  it("ignores unparseable start times", () => {
    const broken = { ...eventAt(EVENT_LEAD_MS), beginAt: "nope" };
    expect(dueEvents([broken], NOW)).toHaveLength(0);
  });

  it("matches every event due in the same tick", () => {
    const due = dueEvents(
      [eventAt(EVENT_LEAD_MS, "A"), eventAt(14 * 60 * 1000, "B")],
      NOW,
    );
    expect(due.map((e) => e.name)).toEqual(["A", "B"]);
  });
});

describe("eventKey", () => {
  it("ignores the display name so renames can't re-notify", () => {
    expect(eventKey(eventAt(0, "Old"))).toBe(eventKey(eventAt(0, "New")));
  });

  it("changes when the event is rescheduled", () => {
    expect(eventKey(eventAt(0))).not.toBe(eventKey(eventAt(60 * 1000)));
  });

  it("falls back to the name for events without an id", () => {
    expect(eventKey({ ...eventAt(0, "No id"), id: null })).toContain("No id");
  });
});

describe("pruneNotified", () => {
  it("keeps recent claims and drops expired ones", () => {
    const pruned = pruneNotified(
      {
        recent: NOW - 60 * 1000,
        week: NOW - 6 * 24 * 60 * 60 * 1000,
        ancient: NOW - 8 * 24 * 60 * 60 * 1000,
      },
      NOW,
    );
    expect(Object.keys(pruned).sort()).toEqual(["recent", "week"]);
  });

  it("drops malformed values", () => {
    const pruned = pruneNotified(
      { bad: "yesterday" as unknown as number },
      NOW,
    );
    expect(pruned).toEqual({});
  });
});

describe("buildEventPush", () => {
  const beginAt = "2026-10-23T13:30:00.000Z";

  it("uses the fixed 15-minute title and the local time", () => {
    const push = buildEventPush({
      name: "Hackathon",
      location: "Cluster 1",
      beginAt,
      timeZone: "Europe/Brussels",
    });
    expect(push.title).toBe("Event in 15 min");
    expect(push.body).toBe(
      `Hackathon at ${formatPushTime(beginAt, "Europe/Brussels")} · Cluster 1`,
    );
    expect(push.kind).toBe("event");
    expect(push.body).toContain("15:30");
  });

  it("omits the location when the event has none", () => {
    const push = buildEventPush({ name: "Talk", beginAt, location: null });
    expect(push.body).not.toContain("·");
    expect(push.body).toContain(`at ${formatPushTime(beginAt, null)}`);
  });

  it("does not ship the raw instant", () => {
    expect("beginAt" in buildEventPush({ name: "Talk", beginAt })).toBe(false);
  });
});
