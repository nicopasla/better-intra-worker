import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  accumulate,
  handleLogtimeHistory,
  handleLogtimeWeek,
  replaceDays,
} from "../src/handlers/logtime";
import {
  decryptBytes,
  encryptBytes,
  hashLogin,
  resolveUserToken,
} from "../src/utils";
import type { Env, UserData } from "../src/types";

vi.mock("../src/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils")>();
  return { ...actual, resolveUserToken: vi.fn() };
});

const HOUR = 3600;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://api.betterintra.com";
const USER: UserData = { sessionTokens: ["token"], fortyTwoLogin: "alice" };
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

interface LocationEntry {
  id: number;
  begin_at: string;
  end_at: string | null;
}

const day = (offset: number): string =>
  new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);

const at = (d: string, hour: number): string =>
  `${d}T${String(hour).padStart(2, "0")}:00:00.000Z`;

function request(path: string): Request {
  const headers = new Headers();
  headers.set("Authorization", "Bearer token");
  return new Request(`${ORIGIN}${path}`, { headers });
}

interface StoredRow {
  days_json: Uint8Array | string;
  updated_at: number;
}

function makeEnv() {
  let row: StoredRow | null = null;
  const kv = new Map<string, string>();
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]) => ({
      first: vi.fn(async () => (/SELECT days_json/i.test(sql) ? row : null)),
      run: vi.fn(async () => {
        if (/logtime_history/i.test(sql)) {
          row = {
            days_json: args[1] as Uint8Array,
            updated_at: args[2] as number,
          };
        }
        return {};
      }),
    })),
  }));
  const env = {
    TOKEN_ENCRYPTION_KEY: KEY,
    better_intra_d1: { prepare },
    BETTER_INTRA_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        kv.delete(key);
      }),
    },
  } as unknown as Env;

  return {
    env,
    kv,
    async setStored(days: Record<string, number>, updatedAt = Date.now()) {
      row = {
        days_json: await encryptBytes(env, JSON.stringify(days)),
        updated_at: updatedAt,
      };
    },
    async storedDays(): Promise<Record<string, number> | null> {
      if (!row) return null;
      const decoded = await decryptBytes(env, row.days_json);
      return decoded ? JSON.parse(decoded) : null;
    },
    storedUpdatedAt: () => row?.updated_at ?? null,
  };
}

/** Serves the 42 locations endpoint from a fixed session list, honouring the
 *  `range[begin_at]` filter the handler sends. `"fail"` makes every call 500. */
function stubLocations(sessions: LocationEntry[] | "fail") {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    if (sessions === "fail") return new Response("nope", { status: 500 });
    const url = new URL(String(input));
    const [from, to] = (url.searchParams.get("range[begin_at]") ?? ",").split(
      ",",
    );
    const number = Number(url.searchParams.get("page[number]") ?? "1");
    const size = Number(url.searchParams.get("page[size]") ?? "100");
    const rows = sessions
      .filter((s) => s.begin_at >= from && s.begin_at < to)
      .sort((a, b) => (a.begin_at < b.begin_at ? -1 : 1));
    return new Response(
      JSON.stringify(rows.slice((number - 1) * size, number * size)),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.mocked(resolveUserToken).mockResolvedValue({ token: "forty-two-token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("replaceDays", () => {
  it("drops only the recomputed window", () => {
    const days = {
      "2026-01-01": 10,
      "2026-01-02": 20,
      "2026-01-03": 30,
    };
    replaceDays(days, "2026-01-02", "2026-01-04");
    expect(days).toEqual({ "2026-01-01": 10 });
  });
});

describe("accumulate", () => {
  it("counts an ongoing session up to now", () => {
    const now = Date.now();
    const days: Record<string, number> = {};
    accumulate(
      days,
      [
        {
          id: 1,
          begin_at: new Date(now - 2 * HOUR * 1000).toISOString(),
          end_at: null,
        },
      ],
      now,
    );
    const total = Object.values(days)[0];
    expect(Math.abs(total - 2 * HOUR)).toBeLessThanOrEqual(1);
  });

  it("ignores sessions with a non-positive duration", () => {
    const days: Record<string, number> = {};
    accumulate(
      days,
      [{ id: 1, begin_at: "2026-01-01T10:00:00.000Z", end_at: null }],
      new Date("2026-01-01T09:00:00.000Z").getTime(),
    );
    expect(days).toEqual({});
  });
});

describe("handleLogtimeHistory", () => {
  it("recomputes the newest stored day instead of adding to it", async () => {
    const today = day(0);
    const env = makeEnv();
    await env.setStored({ [today]: 6 * HOUR }, Date.now() - 10 * 60_000);
    stubLocations([
      { id: 1, begin_at: at(today, 8), end_at: at(today, 12) },
      { id: 2, begin_at: at(today, 9), end_at: at(today, 10) },
    ]);

    const res = await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice`),
      env.env,
      "alice-hash",
      USER,
    );
    const body = (await res.json()) as { days: Record<string, number> };

    expect(res.status).toBe(200);
    expect(body.days[today]).toBe(5 * HOUR);
    expect(await env.storedDays()).toEqual({ [today]: 5 * HOUR });
  });

  it("counts the session that is still running", async () => {
    const today = day(0);
    const env = makeEnv();
    const now = Date.now();
    stubLocations([
      {
        id: 1,
        begin_at: new Date(now - 2 * HOUR * 1000).toISOString(),
        end_at: null,
      },
    ]);

    const res = await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice`),
      env.env,
      "alice-hash",
      USER,
    );
    const body = (await res.json()) as { days: Record<string, number> };

    expect(Math.abs(body.days[today] - 2 * HOUR)).toBeLessThanOrEqual(1);
  });

  it("backfills older days while recomputing the stored boundary days", async () => {
    const d1 = day(2);
    const d2 = day(1);
    const d3 = day(3);
    const env = makeEnv();
    await env.setStored(
      {
        [d2]: 2 * HOUR,
        [d1]: 2 * HOUR,
      },
      Date.now() - 10 * 60_000,
    );
    stubLocations([
      { id: 1, begin_at: at(d3, 9), end_at: at(d3, 12) },
      { id: 2, begin_at: at(d1, 9), end_at: at(d1, 11) },
      { id: 3, begin_at: at(d2, 9), end_at: at(d2, 11) },
    ]);

    const res = await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice&back=1`),
      env.env,
      "alice-hash",
      USER,
    );
    const body = (await res.json()) as {
      days: Record<string, number>;
      partial?: boolean;
    };

    // d2/d1 are re-read, not doubled; d3 is newly backfilled.
    expect(body.days[d2]).toBe(2 * HOUR);
    expect(body.days[d1]).toBe(2 * HOUR);
    expect(body.days[d3]).toBe(3 * HOUR);
    expect(body.partial).toBeUndefined();
  });

  it("serves the stored snapshot with stale=true when 42 fails", async () => {
    const d1 = day(1);
    const env = makeEnv();
    await env.setStored({ [d1]: 3 * HOUR }, Date.now() - 10 * 60_000);
    const updatedAt = env.storedUpdatedAt();
    stubLocations("fail");

    const res = await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice&back=1`),
      env.env,
      "alice-hash",
      USER,
    );
    const body = (await res.json()) as {
      days: Record<string, number>;
      stale?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.days).toEqual({ [d1]: 3 * HOUR });
    // Nothing was applied, so the row must not claim a fresh sync.
    expect(env.storedUpdatedAt()).toBe(updatedAt);
  });

  it("returns 503 when the 42 token is gone and nothing is cached", async () => {
    const env = makeEnv();
    vi.mocked(resolveUserToken).mockResolvedValue({
      failure: { reason: "transient", detail: "challenge" },
    });

    const res = await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice`),
      env.env,
      "alice-hash",
      USER,
    );

    expect(res.status).toBe(503);
  });

  it("keeps the cached days when the token is gone", async () => {
    const d1 = day(1);
    const env = makeEnv();
    await env.setStored({ [d1]: 3 * HOUR });
    vi.mocked(resolveUserToken).mockResolvedValue({
      failure: { reason: "reconnect", detail: "no_token" },
    });

    const res = await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice&back=1`),
      env.env,
      "alice-hash",
      USER,
    );
    const body = (await res.json()) as {
      days: Record<string, number>;
      stale?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.days).toEqual({ [d1]: 3 * HOUR });
  });

  it("does not hit the 42 API again within the freshness window", async () => {
    const today = day(0);
    const env = makeEnv();
    await env.setStored({ [today]: HOUR });
    const fetchStub = stubLocations([]);

    await handleLogtimeHistory(
      request(`/api/v1/private/logtime/history?user=alice`),
      env.env,
      "alice-hash",
      USER,
    );

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("handleLogtimeWeek", () => {
  // Dates follow the real clock: the rate limiter sleeps against Date.now(), so
  // freezing it would stall the outbound gate.
  const TODAY = new Date().toISOString().slice(0, 10);
  const shift = (day: string, days: number): string =>
    new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * DAY_MS)
      .toISOString()
      .slice(0, 10);
  const MONDAY = shift(
    TODAY,
    -((new Date(`${TODAY}T00:00:00.000Z`).getUTCDay() + 6) % 7),
  );
  const YESTERDAY = shift(TODAY, -1);
  const HAS_PAST_DAY = MONDAY !== TODAY;

  const week = (start = MONDAY) =>
    request(`/api/v1/private/logtime/week?user=alice&start=${start}`);

  const rangeStart = (stub: ReturnType<typeof stubLocations>, call = 0) =>
    new URL(String(stub.mock.calls[call]?.[0])).searchParams
      .get("range[begin_at]")!
      .split(",")[0];

  interface WeekBody {
    start: string;
    days: Record<string, number>;
    total: number;
    updatedAt: number | null;
    stale?: boolean;
  }

  it("returns seven keys and refetches only today", async () => {
    const ctl = makeEnv();
    const stored: Record<string, number> = { [YESTERDAY]: 2 * HOUR };
    await ctl.setStored(stored, Date.now());
    const api = stubLocations([
      {
        id: 1,
        begin_at: `${TODAY}T08:00:00.000Z`,
        end_at: `${TODAY}T10:00:00.000Z`,
      },
    ]);

    const res = await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    const body = (await res.json()) as WeekBody;

    expect(res.status).toBe(200);
    expect(Object.keys(body.days)).toHaveLength(7);
    expect(body.days[TODAY]).toBe(2 * HOUR);
    // A past day inside the week is served from the cache, never refetched.
    if (HAS_PAST_DAY) expect(body.days[YESTERDAY]).toBe(2 * HOUR);
    expect(rangeStart(api)).toBe(`${TODAY}T00:00:00.000Z`);
  });

  it("backfills the days missed while the app stayed closed", async () => {
    const ctl = makeEnv();
    const synced = shift(TODAY, -5);
    const missed = shift(TODAY, -4);
    await ctl.setStored({ [synced]: HOUR }, Date.parse(`${synced}T20:00:00Z`));
    const api = stubLocations([
      {
        id: 1,
        begin_at: `${missed}T09:00:00.000Z`,
        end_at: `${missed}T11:00:00.000Z`,
      },
      {
        id: 2,
        begin_at: `${TODAY}T09:00:00.000Z`,
        end_at: `${TODAY}T10:00:00.000Z`,
      },
    ]);

    const res = await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    const body = (await res.json()) as WeekBody;

    expect(rangeStart(api)).toBe(`${missed}T00:00:00.000Z`);
    expect(body.days[TODAY]).toBe(HOUR);
    // The gap is written back even for days outside the requested week.
    expect((await ctl.storedDays())?.[missed]).toBe(2 * HOUR);
  });

  it("re-reads yesterday once on the first call of a new day", async () => {
    const ctl = makeEnv();
    await ctl.setStored(
      { [YESTERDAY]: HOUR },
      Date.parse(`${YESTERDAY}T20:00:00Z`),
    );
    const api = stubLocations([
      {
        id: 1,
        begin_at: `${YESTERDAY}T22:00:00.000Z`,
        end_at: `${TODAY}T01:00:00.000Z`,
      },
    ]);

    const first = await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    expect(rangeStart(api)).toBe(`${YESTERDAY}T00:00:00.000Z`);
    if (HAS_PAST_DAY) {
      const firstBody = (await first.json()) as WeekBody;
      expect(firstBody.days[YESTERDAY]).toBe(3 * HOUR);
    }

    await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    expect(rangeStart(api, 1)).toBe(`${TODAY}T00:00:00.000Z`);
  });

  it("keeps the start day of a running session live", async () => {
    const ctl = makeEnv();
    const openDay = shift(TODAY, -2);
    const openKey = `LOGTIME_OPEN_${await hashLogin("alice")}`;
    ctl.kv.set(openKey, openDay);
    await ctl.setStored({ [openDay]: HOUR }, Date.now());
    const api = stubLocations([
      { id: 1, begin_at: `${openDay}T22:00:00.000Z`, end_at: null },
    ]);

    await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    expect(rangeStart(api)).toBe(`${openDay}T00:00:00.000Z`);
    expect(ctl.kv.get(openKey)).toBe(openDay);

    stubLocations([
      {
        id: 1,
        begin_at: `${openDay}T22:00:00.000Z`,
        end_at: `${TODAY}T02:00:00.000Z`,
      },
    ]);
    await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    expect(ctl.kv.has(openKey)).toBe(false);
  });

  it("serves the cached week when the API fails", async () => {
    const ctl = makeEnv();
    const storedAt = Date.now();
    await ctl.setStored({ [TODAY]: HOUR }, storedAt);
    stubLocations("fail");

    const res = await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    const body = (await res.json()) as WeekBody;

    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.days[TODAY]).toBe(HOUR);
    expect(body.updatedAt).toBe(storedAt);
  });

  it("returns a zero-filled week when nothing is cached and the API fails", async () => {
    const ctl = makeEnv();
    stubLocations("fail");

    const res = await handleLogtimeWeek(week(), ctl.env, "alice-hash", USER);
    const body = (await res.json()) as WeekBody;

    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.total).toBe(0);
    expect(Object.values(body.days).every((secs) => secs === 0)).toBe(true);
  });

  it("seeds the requested week when there is no cache", async () => {
    const ctl = makeEnv();
    const api = stubLocations([]);
    const start = shift(TODAY, -20);

    const res = await handleLogtimeWeek(
      week(start),
      ctl.env,
      "alice-hash",
      USER,
    );
    const body = (await res.json()) as WeekBody;

    expect(body.start).toBe(start);
    expect(rangeStart(api)).toBe(`${start}T00:00:00.000Z`);
  });

  it("rejects a malformed start", async () => {
    const ctl = makeEnv();
    const res = await handleLogtimeWeek(
      week("nope"),
      ctl.env,
      "alice-hash",
      USER,
    );
    expect(res.status).toBe(400);
  });
});
