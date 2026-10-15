import { describe, it, expect, beforeEach } from "vitest";
import {
  handleSubjectsReport,
  handleSubjectsState,
} from "../src/handlers/subjects";
import { Env, UserData } from "../src/types";

const TOKEN = "test-session-token";

interface SubjectRecord {
  url: string;
  lastChangedAt: number | null;
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
      return r ? { url: r.url, last_changed_at: r.lastChangedAt } : null;
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
      this.subjects.set(slug, { url, lastChangedAt: null });
      return {};
    }
    if (sql.startsWith("UPDATE subjects")) {
      const [url, at, slug] = this.bindArgs;
      this.subjects.set(slug, { url, lastChangedAt: at });
      return {};
    }
    return {};
  }
}

function makeEnv(d1: MockD1): Env {
  return { better_intra_d1: d1 as any, BETTER_INTRA_KV: {} as any } as Env;
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

  it("registers a new slug without a change date", async () => {
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
      lastChangedAt: null,
    });
    expect(d1.subjects.get("python-module-10")).toEqual({
      url: URL_A,
      lastChangedAt: null,
    });
  });

  it("is known for an unchanged url and keeps the recorded change date", async () => {
    d1.subjects.set("libft", { url: URL_A, lastChangedAt: 1234 });
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({
      status: "known",
      lastChangedAt: 1234,
    });
    expect(d1.subjects.get("libft")).toEqual({
      url: URL_A,
      lastChangedAt: 1234,
    });
  });

  it("detects a changed url and records when it changed", async () => {
    d1.subjects.set("minishell", { url: URL_A, lastChangedAt: 111 });
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_B }] }),
      env,
      "hash-b",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    const entry = body.subjects[0];
    expect(entry.status).toBe("changed");
    expect(entry.lastChangedAt).toBeTruthy();
    expect(entry.lastChangedAt).toBeGreaterThan(111);

    expect(d1.subjects.get("minishell")).toEqual({
      url: URL_B,
      lastChangedAt: entry.lastChangedAt,
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
        lastChangedAt: null,
      },
    ]);
  });

  it("returns the recorded url and change date for tracked slugs", async () => {
    d1.subjects.set("libft", { url: URL_A, lastChangedAt: 999 });
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
      lastChangedAt: 999,
    });
  });
});
