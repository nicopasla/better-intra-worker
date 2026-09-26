import { describe, it, expect } from "vitest";
import {
  paginateStudents,
  parseStudentPageOptions,
  type StudentEntry,
} from "../src/handlers/students";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const past = new Date(now - 30 * DAY).toISOString();
const future = new Date(now + 30 * DAY).toISOString();
const blackholeDate = new Date(now - 5 * DAY).toISOString();
const freezeDate = new Date(now + 10 * DAY).toISOString();

function entry(overrides: Partial<StudentEntry>): StudentEntry {
  return {
    login: "login",
    displayname: "Login",
    image_url: "",
    begin_at: past,
    blackholed_at: null,
    active: true,
    alumni: false,
    pool_month: null,
    pool_year: null,
    ...overrides,
  };
}

const ALICE = entry({
  login: "alice",
  displayname: "Alice",
  pool_month: "july",
  pool_year: "2023",
  correction_point: 5,
  wallet: 100,
});
const BOB = entry({
  login: "bob",
  displayname: "Bob",
  active: false,
  blackholed_at: blackholeDate,
  pool_month: "july",
  pool_year: "2023",
});
const CAROL = entry({
  login: "carol",
  displayname: "Carol",
  active: false,
  blackholed_at: freezeDate,
  pool_month: "august",
  pool_year: "2024",
});
const DAVE = entry({
  login: "dave",
  displayname: "Dave",
  alumni: true,
  alumnized_at: new Date(now - 2 * DAY).toISOString(),
  pool_month: "august",
  pool_year: "2024",
});
const EMILE = entry({
  login: "emile",
  displayname: "Émile",
  pool_month: "july",
  pool_year: "2023",
});
const EVE = entry({
  login: "eve",
  displayname: "Eve",
  begin_at: future,
  pool_month: "july",
  pool_year: "2023",
});

const ALL = [ALICE, BOB, CAROL, DAVE, EMILE, EVE];

const baseOpts = {
  offset: 0,
  limit: 100,
  sort: "name" as const,
  dir: "asc" as const,
  filter: "none" as const,
  poolMonth: null,
  poolYear: null,
  q: "",
};

describe("paginateStudents", () => {
  it("excludes future students and counts active/roster", () => {
    const res = paginateStudents(ALL, baseOpts);
    expect(res.total).toBe(5);
    expect(res.active).toBe(3);
    expect(res.data.map((e) => e.login)).toEqual([
      "alice",
      "bob",
      "carol",
      "dave",
      "emile",
    ]);
  });

  it("sorts by name asc and desc", () => {
    expect(
      paginateStudents(ALL, { ...baseOpts, dir: "asc" }).data.map(
        (e) => e.login,
      ),
    ).toEqual(["alice", "bob", "carol", "dave", "emile"]);
    expect(
      paginateStudents(ALL, { ...baseOpts, dir: "desc" }).data.map(
        (e) => e.login,
      ),
    ).toEqual(["emile", "dave", "carol", "bob", "alice"]);
  });

  it("sorts by begin_at date, newest first", () => {
    const res = paginateStudents(ALL, { ...baseOpts, sort: "date" });
    expect(res.data[0].login).toBe("alice");
  });

  it("filters blackholed and sorts by blackholed_at desc", () => {
    const res = paginateStudents(ALL, { ...baseOpts, filter: "blackhole" });
    expect(res.filtered).toBe(1);
    expect(res.data.map((e) => e.login)).toEqual(["bob"]);
  });

  it("filters frozen", () => {
    const res = paginateStudents(ALL, { ...baseOpts, filter: "freeze" });
    expect(res.data.map((e) => e.login)).toEqual(["carol"]);
  });

  it("filters alumni and sorts by alumnized_at desc", () => {
    const res = paginateStudents(ALL, { ...baseOpts, filter: "alumni" });
    expect(res.data.map((e) => e.login)).toEqual(["dave"]);
  });

  it("filters by pool month + year", () => {
    const res = paginateStudents(ALL, {
      ...baseOpts,
      poolMonth: 7,
      poolYear: 2023,
    });
    expect(res.data.map((e) => e.login)).toEqual(["alice", "bob", "emile"]);
  });

  it("filters by pool year only", () => {
    const res = paginateStudents(ALL, { ...baseOpts, poolYear: 2024 });
    expect(res.data.map((e) => e.login)).toEqual(["carol", "dave"]);
  });

  it("matches accented names in search", () => {
    const res = paginateStudents(ALL, { ...baseOpts, q: "emile" });
    expect(res.data.map((e) => e.login)).toEqual(["emile"]);
  });

  it("pages with offset and limit", () => {
    const first = paginateStudents(ALL, { ...baseOpts, offset: 0, limit: 2 });
    const second = paginateStudents(ALL, { ...baseOpts, offset: 2, limit: 2 });
    expect(first.data.map((e) => e.login)).toEqual(["alice", "bob"]);
    expect(second.data.map((e) => e.login)).toEqual(["carol", "dave"]);
    expect(first.filtered).toBe(5);
  });

  it("returns filter options only on the first page", () => {
    const first = paginateStudents(ALL, { ...baseOpts, offset: 0 });
    expect(first.options?.poolYears).toEqual([2024, 2023]);
    expect(first.options?.intakes.map((i) => `${i.month}-${i.year}`)).toEqual([
      "8-2024",
      "7-2023",
    ]);
    const second = paginateStudents(ALL, { ...baseOpts, offset: 1 });
    expect(second.options).toBeUndefined();
  });
});

describe("parseStudentPageOptions", () => {
  it("applies defaults", () => {
    const opts = parseStudentPageOptions(
      new URL("https://api.betterintra.com/api/v1/students?limit=1"),
    );
    expect(opts.limit).toBe(1);
    expect(opts.offset).toBe(0);
    expect(opts.sort).toBe("name");
    expect(opts.dir).toBe("asc");
    expect(opts.filter).toBe("none");
    expect(opts.poolMonth).toBeNull();
    expect(opts.poolYear).toBeNull();
  });

  it("caps the page size and parses filters", () => {
    const opts = parseStudentPageOptions(
      new URL(
        "https://x/api/v1/students?limit=500&offset=30&sort=date&dir=asc&filter=freeze&pool_month=7&pool_year=2023&q=bob",
      ),
    );
    expect(opts.limit).toBe(100);
    expect(opts.offset).toBe(30);
    expect(opts.sort).toBe("date");
    expect(opts.dir).toBe("asc");
    expect(opts.filter).toBe("freeze");
    expect(opts.poolMonth).toBe(7);
    expect(opts.poolYear).toBe(2023);
    expect(opts.q).toBe("bob");
  });
});
