import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleSubjectsReport,
  handleSubjectsState,
} from "../src/handlers/subjects";
import { Env, UserData } from "../src/types";

const TOKEN = "test-session-token";
const OLD_DATE = Date.UTC(2026, 7, 11, 14, 19, 24);
const NEW_DATE = Date.UTC(2026, 8, 1, 8, 9, 0);

interface SubjectRecord {
  url: string;
  createdAt: number | null;
  modifiedAt: number | null;
  lastChangedAt: number | null;
}

class MockKV {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

class MockD1 {
  subjects = new Map<string, SubjectRecord>();
  projectNames = new Map<string, string>();

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

  async first(): Promise<any> {
    const sql = this.sql;
    if (sql.includes("FROM subjects WHERE slug")) {
      const r = this.subjects.get(this.bindArgs[0]);
      return r
        ? {
            url: r.url,
            created_at: r.createdAt,
            modified_at: r.modifiedAt,
            last_changed_at: r.lastChangedAt,
          }
        : null;
    }
    if (sql.includes("FROM projects WHERE slug")) {
      const name = this.projectNames.get(this.bindArgs[0]);
      return name === undefined ? null : { name };
    }
    return null;
  }

  async run(): Promise<any> {
    const sql = this.sql;
    if (sql.startsWith("INSERT INTO subjects")) {
      const [slug, url] = this.bindArgs;
      this.subjects.set(slug, {
        url,
        createdAt: null,
        modifiedAt: null,
        lastChangedAt: null,
      });
      return {};
    }
    if (sql.startsWith("UPDATE subjects")) {
      const [url, createdAt, modifiedAt, lastChangedAt, slug] = this.bindArgs;
      this.subjects.set(slug, { url, createdAt, modifiedAt, lastChangedAt });
      return {};
    }
    return {};
  }
}

function projectResponse(createdAt: number, updatedAt: number): Response {
  return new Response(
    JSON.stringify({
      created_at: new Date(createdAt).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Mocks the two 42 API calls the handler makes: the client-credentials token
 * exchange and the project lookup.
 */
function mockIntraApi(project: Response | (() => Response)): string[] {
  const calls: string[] = [];
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "app-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return typeof project === "function" ? project() : project;
  });
  return calls;
}

function makeEnv(d1: MockD1): Env {
  return {
    better_intra_d1: d1 as any,
    BETTER_INTRA_KV: new MockKV() as any,
    CLIENT_ID: "client-id",
    CLIENT_SECRET: "client-secret",
  } as Env;
}

function sessionData(): UserData {
  return { sessionTokens: [TOKEN] };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(url: string): Request {
  return new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

const URL_A = "https://cdn.example.com/pdf/pdf/900001/en.subject.example.pdf";
const URL_B = "https://cdn.example.com/pdf/pdf/900002/en.subject.example.pdf";

describe("handleSubjectsReport", () => {
  let d1: MockD1;
  let env: Env;

  beforeEach(() => {
    d1 = new MockD1();
    d1.projectNames.set("python-module-10", "Python Module 10");
    env = makeEnv(d1);
    vi.restoreAllMocks();
  });

  it("rejects non-POST", async () => {
    const res = await handleSubjectsReport(
      new Request("https://x/report"),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(405);
  });

  it("rejects missing auth", async () => {
    const res = await handleSubjectsReport(
      new Request("https://x/report", { method: "POST", body: "{}" }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(401);
  });

  it("registers a new slug without querying the api", async () => {
    const calls = mockIntraApi(projectResponse(OLD_DATE, OLD_DATE));
    const res = await handleSubjectsReport(
      post("https://x/report", {
        items: [{ slug: "python-module-10", url: URL_A }],
      }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({
      slug: "python-module-10",
      status: "first",
      name: "Python Module 10",
      createdAt: null,
      modifiedAt: null,
      lastChangedAt: null,
    });
    expect(calls).toHaveLength(0);
    expect(d1.subjects.get("python-module-10")).toEqual({
      url: URL_A,
      createdAt: null,
      modifiedAt: null,
      lastChangedAt: null,
    });
  });

  it("is known for an unchanged url without querying the api", async () => {
    d1.subjects.set("libft", {
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: OLD_DATE,
      lastChangedAt: 111,
    });
    const calls = mockIntraApi(projectResponse(OLD_DATE, OLD_DATE));
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({
      status: "known",
      createdAt: OLD_DATE,
      modifiedAt: OLD_DATE,
      lastChangedAt: 111,
    });
    expect(calls).toHaveLength(0);
  });

  it("records a change when the project was updated", async () => {
    d1.subjects.set("minishell", {
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: OLD_DATE,
      lastChangedAt: null,
    });
    mockIntraApi(projectResponse(OLD_DATE, NEW_DATE));
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_B }] }),
      env,
      "hash-b",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    const entry = body.subjects[0];
    expect(entry.status).toBe("changed");
    expect(entry.createdAt).toBe(OLD_DATE);
    expect(entry.modifiedAt).toBe(NEW_DATE);
    expect(entry.lastChangedAt).toBeTruthy();

    expect(d1.subjects.get("minishell")).toEqual({
      url: URL_B,
      createdAt: OLD_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: entry.lastChangedAt,
    });
  });

  it("adopts a differing url without recording a change when not newer", async () => {
    d1.subjects.set("minishell", {
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: 555,
    });
    mockIntraApi(projectResponse(OLD_DATE, NEW_DATE));
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_B }] }),
      env,
      "hash-b",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({
      status: "known",
      modifiedAt: NEW_DATE,
      lastChangedAt: 555,
    });
    expect(d1.subjects.get("minishell")).toEqual({
      url: URL_B,
      createdAt: OLD_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: 555,
    });
  });

  it("leaves the row untouched when the api is unavailable", async () => {
    d1.subjects.set("minishell", {
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: OLD_DATE,
      lastChangedAt: null,
    });
    mockIntraApi(new Response("boom", { status: 500 }));
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_B }] }),
      env,
      "hash-b",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({
      status: "known",
      modifiedAt: OLD_DATE,
      lastChangedAt: null,
    });
    expect(d1.subjects.get("minishell")).toEqual({
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: OLD_DATE,
      lastChangedAt: null,
    });
  });

  it("rejects entries missing a slug or url", async () => {
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "" }, { url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toEqual([
      { slug: "", status: "unknown", reason: "missing_slug_or_url" },
      { slug: "", status: "unknown", reason: "missing_slug_or_url" },
    ]);
  });
});

describe("handleSubjectsState", () => {
  let d1: MockD1;
  let env: Env;

  beforeEach(() => {
    d1 = new MockD1();
    env = makeEnv(d1);
  });

  it("requires auth", async () => {
    const res = await handleSubjectsState(
      new Request("https://x/state?slugs=libft"),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(401);
  });

  it("returns tracked:false for unknown slugs", async () => {
    const res = await handleSubjectsState(
      get("https://x/state?slugs=libft"),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toEqual([
      {
        slug: "libft",
        tracked: false,
        name: null,
        url: null,
        createdAt: null,
        modifiedAt: null,
        lastChangedAt: null,
      },
    ]);
  });

  it("returns the recorded url and dates for tracked slugs", async () => {
    d1.subjects.set("libft", {
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: 999,
    });
    const res = await handleSubjectsState(
      get("https://x/state?slugs=libft"),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toEqual({
      slug: "libft",
      tracked: true,
      name: null,
      url: URL_A,
      createdAt: OLD_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: 999,
    });
  });
});
