import { describe, it, expect, vi } from "vitest";
import {
  groupSeatRows,
  handleSeatHistory,
  handleSeatReports,
  isValidSeatHost,
  parseSeatReports,
  SEAT_REPORT_CAMPUS,
} from "../src/handlers/seat-reports";
import type { Env, UserData } from "../src/types";

const HASH = "a".repeat(32);
const USER: UserData = { sessionTokens: ["token"] };
const ORIGIN = "https://api.betterintra.com";

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer token");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function makeEnv(rows: ReturnType<typeof groupSeatRows> = []) {
  const kv = new Map<string, string>();
  const flat = rows.flatMap((seat) =>
    seat.components.map((component) => ({
      host: seat.host,
      cluster: seat.cluster,
      component: component.component,
      status: component.status,
      updatedAt: component.updatedAt,
      confirmations: component.confirmations,
    })),
  );
  const env = {
    BETTER_INTRA_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    },
    better_intra_d1: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: flat })),
          run: vi.fn(async () => ({})),
        })),
      })),
      batch: vi.fn(async () => []),
    },
  } as unknown as Env;
  return { env, kv };
}

describe("isValidSeatHost", () => {
  it("accepts cluster hostnames", () => {
    expect(isValidSeatHost("shi-r1-p1")).toBe(true);
    expect(isValidSeatHost("fu-c4-p1")).toBe(true);
    expect(isValidSeatHost("  MI-R2-P3  ")).toBe(true);
  });

  it("rejects unsafe or empty values", () => {
    expect(isValidSeatHost("")).toBe(false);
    expect(isValidSeatHost("a")).toBe(false);
    expect(isValidSeatHost("shi r1 p1")).toBe(false);
    expect(isValidSeatHost("shi/r1")).toBe(false);
    expect(isValidSeatHost(null)).toBe(false);
  });
});

describe("parseSeatReports", () => {
  it("accepts the full catalog", () => {
    const reports = parseSeatReports([
      { component: "audio", status: "works" },
      { component: "keyboard", status: "broken" },
    ]);
    expect(reports).toEqual([
      { component: "audio", status: "works" },
      { component: "keyboard", status: "broken" },
    ]);
  });

  it("keeps the last status per component", () => {
    expect(
      parseSeatReports([
        { component: "mouse_scroll", status: "broken" },
        { component: "mouse_scroll", status: "works" },
      ]),
    ).toEqual([{ component: "mouse_scroll", status: "works" }]);
  });

  it("rejects unknown components, statuses and empty batches", () => {
    expect(parseSeatReports([])).toBeNull();
    expect(parseSeatReports(null)).toBeNull();
    expect(
      parseSeatReports([{ component: "coffee", status: "broken" }]),
    ).toBeNull();
    expect(
      parseSeatReports([{ component: "audio", status: "maybe" }]),
    ).toBeNull();
    expect(parseSeatReports([{ component: "audio" }])).toBeNull();
  });
});

describe("groupSeatRows", () => {
  it("groups components per seat and drops malformed rows", () => {
    const seats = groupSeatRows([
      {
        host: "shi-r1-p1",
        cluster: "shi",
        component: "audio",
        status: "works",
        updatedAt: 10,
        confirmations: 2,
      },
      {
        host: "shi-r1-p1",
        cluster: "shi",
        component: "keyboard",
        status: "broken",
        updatedAt: 20,
        confirmations: 1,
      },
      {
        host: "shi-r1-p1",
        cluster: "shi",
        component: "coffee" as never,
        status: "broken",
        updatedAt: 20,
        confirmations: 1,
      },
    ]);
    expect(seats).toHaveLength(1);
    expect(seats[0].host).toBe("shi-r1-p1");
    expect(seats[0].components.map((c) => c.component)).toEqual([
      "audio",
      "keyboard",
    ]);
  });
});

describe("handleSeatReports", () => {
  it("returns grouped reports for the Belgium campus", async () => {
    const { env } = makeEnv([
      {
        host: "shi-r1-p1",
        cluster: "shi",
        components: [
          {
            component: "keyboard",
            status: "broken",
            updatedAt: 5,
            confirmations: 3,
          },
        ],
      },
    ]);
    const res = await handleSeatReports(
      request("/api/v1/private/cluster/reports"),
      env,
      HASH,
      USER,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seats: unknown[] };
    expect(body.seats).toHaveLength(1);
  });

  it("requires a valid session", async () => {
    const { env } = makeEnv();
    const res = await handleSeatReports(
      new Request(`${ORIGIN}/api/v1/private/cluster/reports`),
      env,
      HASH,
      USER,
    );
    expect(res.status).toBe(401);
  });

  it("rejects another campus", async () => {
    const { env } = makeEnv();
    const res = await handleSeatReports(
      request("/api/v1/private/cluster/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campus: "21",
          host: "shi-r1-p1",
          reports: [{ component: "audio", status: "broken" }],
        }),
      }),
      env,
      HASH,
      USER,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(String(SEAT_REPORT_CAMPUS));
  });

  it("stores a valid report", async () => {
    const { env } = makeEnv();
    const res = await handleSeatReports(
      request("/api/v1/private/cluster/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "shi-r1-p1",
          cluster: "shi",
          reports: [{ component: "audio", status: "works" }],
        }),
      }),
      env,
      HASH,
      USER,
    );
    expect(res.status).toBe(200);
    expect(env.better_intra_d1.batch).toHaveBeenCalledOnce();
  });

  it("rate-limits a reporter", async () => {
    const { env, kv } = makeEnv();
    kv.set(`SEAT_REPORT_RATE_${HASH}`, "60");
    const res = await handleSeatReports(
      request("/api/v1/private/cluster/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "shi-r1-p1",
          reports: [{ component: "audio", status: "broken" }],
        }),
      }),
      env,
      HASH,
      USER,
    );
    expect(res.status).toBe(429);
  });
});

describe("handleSeatHistory", () => {
  function historyEnv() {
    const { env } = makeEnv();
    const db = env.better_intra_d1 as unknown as {
      prepare: {
        mockImplementation: (fn: (sql: string) => unknown) => void;
      };
    };
    db.prepare.mockImplementation((sql: string) => ({
      bind: () => ({
        all: async () => ({
          results: sql.includes("seat_component_events")
            ? [{ component: "audio", status: "works", created_at: 100 }]
            : [],
        }),
        run: async () => ({}),
      }),
    }));
    return env;
  }

  it("returns the newest events for a seat", async () => {
    const res = await handleSeatHistory(
      request(
        "/api/v1/private/cluster/reports/history?host=shi-r1-p1",
      ),
      historyEnv(),
      HASH,
      USER,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { component: string; status: string; createdAt: number }[];
    };
    expect(body.events).toEqual([
      { component: "audio", status: "works", createdAt: 100_000 },
    ]);
  });

  it("rejects an invalid seat", async () => {
    const res = await handleSeatHistory(
      request("/api/v1/private/cluster/reports/history?host=../etc"),
      historyEnv(),
      HASH,
      USER,
    );
    expect(res.status).toBe(400);
  });
});
