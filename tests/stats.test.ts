import { describe, it, expect, beforeEach } from "vitest";
import { handleStats } from "../src/handlers/stats";
import { Env } from "../src/types";

type UserRow = { country: string | null; campus: string | null; created_at: number };

class MockD1 {
  rows: UserRow[] = [];
  private sql = "";
  private bindArgs: any[] = [];

  prepare(sql: string) {
    this.sql = sql;
    return this;
  }

  bind(...args: any[]) {
    this.bindArgs = args;
    return this;
  }

  async first() {
    if (this.bindArgs.length > 0) {
      const cutoff = this.bindArgs[0] as number;
      const count = this.rows.filter((r) => r.created_at > cutoff).length;
      return { c: count };
    }
    return { c: this.rows.length };
  }

  async all() {
    // Mirrors the real handler queries:
    // - country-only query: all rows grouped by country
    // - campus query: only rows with a non-null campus, grouped by country+campus
    const byCampus = /campus_name IS NOT NULL/i.test(this.sql);
    const counts = new Map<string, number>();
    for (const r of this.rows) {
      if (byCampus && !r.campus) continue;
      const key = byCampus
        ? `${r.country || "?"}\u0000${r.campus}`
        : r.country || "?";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const results = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, c]) => {
        const [country, campus] = key.split("\u0000");
        return byCampus ? { country, campus, c } : { country, c };
      });
    return { results };
  }
}

function makeEnv(d1: MockD1): Env {
  return { better_intra_d1: d1 as any, BETTER_INTRA_KV: {} as any } as Env;
}

const NOW = Math.floor(Date.now() / 1000);

describe("handleStats", () => {
  let d1: MockD1;
  let env: Env;

  beforeEach(() => {
    d1 = new MockD1();
    env = makeEnv(d1);
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await handleStats(
      new Request("https://x/stats", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("returns zeroes when the users table is empty", async () => {
    const res = await handleStats(new Request("https://x/stats"), env);
    expect(await res.json()).toEqual({
      total: 0,
      newToday: 0,
      newLast30Days: 0,
      newLast14Days: 0,
      newLast7Days: 0,
      countries: [],
    });
  });

  it("counts all users and groups by country", async () => {
    d1.rows = [
      { country: "BE", campus: "Brussels", created_at: NOW - 100 },
      { country: "BE", campus: "Brussels", created_at: NOW - 200 },
      { country: "FR", campus: "Paris", created_at: NOW - 300 },
      { country: null, campus: null, created_at: NOW - 400 },
    ];

    const res = await handleStats(new Request("https://x/stats"), env);
    const body = (await res.json()) as {
      total: number;
      newToday: number;
      newLast30Days: number;
      newLast14Days: number;
      newLast7Days: number;
      countries: {
        country: string;
        count: number;
        campuses: { name: string; count: number }[];
      }[];
    };
    expect(body.total).toBe(4);
    const dayStart = NOW - (NOW % 86_400);
    expect(body.newToday).toBe(
      d1.rows.filter((r) => r.created_at > dayStart).length,
    );
    expect(body.newLast30Days).toBe(4);
    expect(body.newLast14Days).toBe(4);
    expect(body.newLast7Days).toBe(4);
    expect(body.countries).toEqual([
      { country: "BE", count: 2, campuses: [{ name: "Brussels", count: 2 }] },
      { country: "FR", count: 1, campuses: [{ name: "Paris", count: 1 }] },
      { country: "?", count: 1, campuses: [] },
    ]);
  });

  it("lists campuses per country and drops null campus names", async () => {
    d1.rows = [
      { country: "BE", campus: "Brussels", created_at: NOW - 100 },
      { country: "BE", campus: "Brussels", created_at: NOW - 200 },
      { country: "BE", campus: "Brussels", created_at: NOW - 300 },
      { country: "BE", campus: null, created_at: NOW - 400 },
      { country: "FR", campus: "Paris", created_at: NOW - 500 },
      { country: "US", campus: null, created_at: NOW - 600 },
    ];

    const res = await handleStats(new Request("https://x/stats"), env);
    const body = (await res.json()) as {
      countries: {
        country: string;
        count: number;
        campuses: { name: string; count: number }[];
      }[];
    };

    const be = body.countries.find((c) => c.country === "BE");
    const fr = body.countries.find((c) => c.country === "FR");
    const us = body.countries.find((c) => c.country === "US");

    // null campus still counts toward the country badge
    expect(be).toMatchObject({ country: "BE", count: 4 });
    expect(be?.campuses).toEqual([{ name: "Brussels", count: 3 }]);
    expect(fr).toMatchObject({ country: "FR", count: 1 });
    expect(fr?.campuses).toEqual([{ name: "Paris", count: 1 }]);
    // a country whose users all have no campus name gets an empty list
    expect(us).toMatchObject({ country: "US", count: 1 });
    expect(us?.campuses).toEqual([]);
  });

  it("splits the window counts by age", async () => {
    const d = (days: number) => NOW - days * 24 * 60 * 60;
    d1.rows = [
      { country: "BE", campus: "Brussels", created_at: d(1) },
      { country: "FR", campus: "Paris", created_at: d(10) },
      { country: "US", campus: null, created_at: d(20) },
      { country: "DE", campus: "Berlin", created_at: d(40) },
    ];

    const res = await handleStats(new Request("https://x/stats"), env);
    const body = (await res.json()) as {
      total: number;
      newToday: number;
      newLast30Days: number;
      newLast14Days: number;
      newLast7Days: number;
      countries: { country: string; count: number }[];
    };
    expect(body.total).toBe(4);
    expect(body.newToday).toBe(0);
    expect(body.newLast30Days).toBe(3);
    expect(body.newLast14Days).toBe(2);
    expect(body.newLast7Days).toBe(1);
    expect(body.countries).toHaveLength(4);
  });
});