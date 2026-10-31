import { describe, it, expect, beforeEach, vi } from "vitest";
import { Env, UserData } from "../src/types";
import {
  handleMyCampus,
  primaryCampusFromMe,
  requireBelgiumCampus,
} from "../src/handlers/campus-access";

vi.mock("../src/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils")>();
  return {
    ...actual,
    resolveUserToken: vi.fn(async () => ({ token: "forty-two-token" })),
  };
});

vi.mock("../src/rate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rate")>();
  return {
    ...actual,
    intraFetch: vi.fn(async () =>
      Response.json({
        campus: [{ id: 12, name: "Belgium" }],
        campus_users: [{ campus_id: 12, is_primary: true }],
      }),
    ),
  };
});

import { intraFetch } from "../src/rate";

class MockKV {
  store = new Map<string, string>();
  async get(key: string, opts?: { type?: string }) {
    const value = this.store.get(key);
    if (value == null) return null;
    return opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

interface UserRow {
  campus_id: number | null;
  campus_name: string | null;
}

class MockD1 {
  rows = new Map<string, UserRow>();
  updates: { id: number; name: string | null; hash: string }[] = [];
  private sql = "";
  private args: unknown[] = [];

  prepare(sql: string) {
    this.sql = sql;
    this.args = [];
    return this;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first() {
    if (/SELECT campus_id/i.test(this.sql)) {
      return this.rows.get(String(this.args[0])) ?? null;
    }
    return null;
  }

  async run() {
    if (/UPDATE users SET campus_id/i.test(this.sql)) {
      const [id, name, hash] = this.args as [number, string | null, string];
      this.updates.push({ id, name, hash });
      this.rows.set(hash, {
        campus_id: id,
        campus_name: name ?? this.rows.get(hash)?.campus_name ?? null,
      });
    }
    return { success: true };
  }
}

function makeEnv() {
  const kv = new MockKV();
  const d1 = new MockD1();
  const env = {
    BETTER_INTRA_KV: kv,
    better_intra_d1: d1,
  } as unknown as Env;
  return { env, kv, d1 };
}

const request = () =>
  new Request("https://api.betterintra.com/api/v1/students?login=hash", {
    headers: { Authorization: "Bearer session" },
  });

const userData = (data: Partial<UserData>): UserData => data;

describe("primaryCampusFromMe", () => {
  it("prefers the primary campus from campus_users", () => {
    expect(
      primaryCampusFromMe({
        campus: [
          { id: 12, name: "Belgium" },
          { id: 57, name: "Paris" },
        ],
        campus_users: [
          { campus_id: 57, is_primary: true },
          { campus_id: 12, is_primary: false },
        ],
      }),
    ).toEqual({ id: 57, name: "Paris" });
  });

  it("falls back to the first campus and tolerates an empty payload", () => {
    expect(
      primaryCampusFromMe({ campus: [{ id: 12, name: "Belgium" }] }),
    ).toEqual({ id: 12, name: "Belgium" });
    expect(primaryCampusFromMe(null)).toEqual({ id: null, name: null });
  });
});

describe("requireBelgiumCampus", () => {
  beforeEach(() => {
    vi.mocked(intraFetch).mockClear();
  });

  it("allows a Belgium campus from KV without touching D1 or the 42 API", async () => {
    const { env, d1 } = makeEnv();
    const res = await requireBelgiumCampus(
      request(),
      env,
      "hash",
      userData({ campusId: 12 }),
    );
    expect(res).toBeNull();
    expect(d1.updates).toHaveLength(0);
    expect(intraFetch).not.toHaveBeenCalled();
  });

  it("denies another campus", async () => {
    const { env } = makeEnv();
    const res = await requireBelgiumCampus(
      request(),
      env,
      "hash",
      userData({ campusId: 57 }),
    );
    expect(res?.status).toBe(403);
  });

  it("falls back to D1 and backfills KV", async () => {
    const { env, kv, d1 } = makeEnv();
    d1.rows.set("hash", { campus_id: 12, campus_name: "Belgium" });
    const data = userData({});
    const res = await requireBelgiumCampus(request(), env, "hash", data);
    expect(res).toBeNull();
    expect(data.campusId).toBe(12);
    expect(JSON.parse(kv.store.get("hash") ?? "{}").campusId).toBe(12);
    expect(intraFetch).not.toHaveBeenCalled();
  });

  it("checks the me endpoint when the campus is unknown", async () => {
    const { env, d1 } = makeEnv();
    vi.mocked(intraFetch).mockResolvedValueOnce(
      Response.json({
        campus_users: [{ campus_id: 12, is_primary: true }],
        campus: [{ id: 12, name: "Belgium" }],
      }),
    );
    const res = await requireBelgiumCampus(
      request(),
      env,
      "hash",
      userData({}),
    );
    expect(res).toBeNull();
    expect(intraFetch).toHaveBeenCalledTimes(1);
    expect(d1.rows.get("hash")?.campus_id).toBe(12);
  });

  it("denies when the me endpoint reports another campus", async () => {
    const { env } = makeEnv();
    vi.mocked(intraFetch).mockResolvedValueOnce(
      Response.json({
        campus_users: [{ campus_id: 57, is_primary: true }],
      }),
    );
    const res = await requireBelgiumCampus(
      request(),
      env,
      "hash",
      userData({}),
    );
    expect(res?.status).toBe(403);
  });

  it("denies when the me endpoint cannot be reached", async () => {
    const { env } = makeEnv();
    vi.mocked(intraFetch).mockResolvedValueOnce(
      new Response("nope", { status: 502 }),
    );
    const res = await requireBelgiumCampus(
      request(),
      env,
      "hash",
      userData({}),
    );
    expect(res?.status).toBe(403);
  });
});

describe("handleMyCampus", () => {
  beforeEach(() => {
    vi.mocked(intraFetch).mockClear();
  });

  it("returns the campus stored in D1 without calling the 42 API", async () => {
    const { env, d1 } = makeEnv();
    d1.rows.set("hash", { campus_id: 57, campus_name: "Paris" });
    const res = await handleMyCampus(
      new Request("https://x/api/v1/private/campus?login=hash", {
        headers: { Authorization: "Bearer session" },
      }),
      env,
      "hash",
      userData({ sessionTokens: ["session"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      campusId: 57,
      campusName: "Paris",
      allowed: false,
    });
    expect(intraFetch).not.toHaveBeenCalled();
  });

  it("rejects a request without a valid session", async () => {
    const { env } = makeEnv();
    const res = await handleMyCampus(
      new Request("https://x/api/v1/private/campus?login=hash"),
      env,
      "hash",
      userData({ sessionTokens: ["session"] }),
    );
    expect(res.status).toBe(401);
  });
});
