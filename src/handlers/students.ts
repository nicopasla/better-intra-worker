import { Env, UserData } from "../types";
import { PISCINE_INTAKES } from "./piscine-intakes";
import {
  decryptBytes,
  encryptBytes,
  getAppToken,
  getBearerToken,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";
const BELGIUM_CAMPUS_ID = 12;
const PAGE_SIZE = 100;
const STUDENTS_CURSUS_ID = 21;
const STUDENTS_CACHE_TTL = 24 * 60 * 60;
const PISCINE_CACHE_TTL = 30 * 24 * 60 * 60;
const STUDENTS_CACHE_VERSION = "v2";

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 100;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface StudentEntry {
  login: string;
  displayname: string;
  image_url: string;
  begin_at: string | null;
  blackholed_at: string | null;
  active: boolean;
  alumni: boolean;
  pool_month: string | null;
  pool_year: string | null;
  alumnized_at?: string;
  level?: number;
  correction_point?: number;
  wallet?: number;
}

function checkSecret(request: Request, env: Env): boolean {
  return (
    !!env.PROXY_SECRET &&
    request.headers.get("X-Proxy-Key") === env.PROXY_SECRET
  );
}

export function cursusUsersParams(
  cursusId: number,
  opts?: { future?: boolean; rangeBegin?: string; rangeEnd?: string },
): URLSearchParams {
  const params = new URLSearchParams({
    "filter[cursus_id]": String(cursusId),
    "filter[campus_id]": String(BELGIUM_CAMPUS_ID),
    "page[size]": String(PAGE_SIZE),
  });
  if (opts?.future) params.set("filter[future]", "true");
  if (opts?.rangeBegin && opts?.rangeEnd) {
    params.set("range[begin_at]", `${opts.rangeBegin},${opts.rangeEnd}`);
  }
  return params;
}

async function ensureCacheTable(env: Env): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "CREATE TABLE IF NOT EXISTS students_cache (cursus_id INTEGER NOT NULL, range_begin TEXT NOT NULL, range_end TEXT NOT NULL, data BLOB NOT NULL, cached_at INTEGER NOT NULL, PRIMARY KEY (cursus_id, range_begin, range_end))",
    )
    .run();
}

interface CacheRow {
  data: string;
  cached_at: number;
}

async function readCacheRow(
  env: Env,
  cursusId: number,
  cacheBegin: string,
  cacheEnd: string,
): Promise<CacheRow | null> {
  await ensureCacheTable(env);
  const cached = await env.better_intra_d1
    .prepare(
      "SELECT data, cached_at FROM students_cache WHERE cursus_id = ? AND range_begin = ? AND range_end = ?",
    )
    .bind(cursusId, cacheBegin, cacheEnd)
    .first<{ data: ArrayBuffer | string; cached_at: number }>();

  if (!cached) return null;
  const decoded = await decryptBytes(env, cached.data);
  if (decoded === null) return null;
  return { data: decoded, cached_at: cached.cached_at };
}

function cacheResponse(origin: string | null, row: CacheRow): Response {
  const wrapped = `{"cached_at":${row.cached_at},"data":${row.data}}`;
  return new Response(wrapped, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin || "*",
    },
  });
}

async function readCache(
  env: Env,
  origin: string | null,
  cursusId: number,
  cacheBegin: string,
  cacheEnd: string,
): Promise<Response> {
  const row = await readCacheRow(env, cursusId, cacheBegin, cacheEnd);
  if (row) return cacheResponse(origin, row);
  return jsonRes({ cached_at: 0, data: [] });
}

async function fetchAllCursusUsers(
  env: Env,
  cursusId: number,
  rangeBegin?: string,
  rangeEnd?: string,
  opts?: { future?: boolean; token?: string },
): Promise<StudentEntry[] | null> {
  const token = opts?.token ?? (await getAppToken(env));
  const all: StudentEntry[] = [];
  let page = 1;

  while (true) {
    const params = cursusUsersParams(cursusId, {
      future: opts?.future,
      rangeBegin,
      rangeEnd,
    });
    params.set("page[number]", String(page));

    const apiRes = await intraFetch(token, `${API_BASE}/v2/cursus_users?${params}`);
    if (!apiRes.ok) return null;

    const users = (await apiRes.json()) as Array<{
      begin_at?: string | null;
      blackholed_at?: string | null;
      level?: number;
      user: {
        login: string;
        displayname?: string;
        first_name?: string;
        last_name?: string;
        image?: { versions?: { small?: string } };
        kind?: string;
        "active?"?: boolean;
        "alumni?"?: boolean;
        pool_month?: string | null;
        pool_year?: string | null;
        alumnized_at?: string | null;
        correction_point?: number;
        wallet?: number;
      };
    }>;

    if (users.length === 0) break;

    for (const u of users) {
      if (u.user.kind === "admin") continue;
      all.push({
        login: u.user.login,
        displayname:
          u.user.displayname ||
          [u.user.first_name, u.user.last_name].filter(Boolean).join(" ") ||
          u.user.login,
        image_url:
          u.user.image?.versions?.small ||
          `https://cdn.intra.42.fr/users/${u.user.login}.jpg`,
        begin_at: u.begin_at ?? null,
        blackholed_at: u.blackholed_at ?? null,
        active: u.user["active?"] ?? true,
        alumni: u.user["alumni?"] ?? false,
        pool_month: u.user.pool_month ?? null,
        pool_year: u.user.pool_year ?? null,
        level: u.level ?? 0,
        correction_point: u.user.correction_point ?? 0,
        wallet: u.user.wallet ?? 0,
        ...(u.user.alumnized_at ? { alumnized_at: u.user.alumnized_at } : {}),
      });
    }

    if (users.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

async function writeCache(
  env: Env,
  cursusId: number,
  cacheBegin: string,
  cacheEnd: string,
  all: StudentEntry[],
): Promise<number> {
  await ensureCacheTable(env);
  const now = Math.floor(Date.now() / 1000);
  await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO students_cache (cursus_id, range_begin, range_end, data, cached_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      cursusId,
      cacheBegin,
      cacheEnd,
      await encryptBytes(env, JSON.stringify(all)),
      now,
    )
    .run();
  return now;
}

export type StudentSortField = "name" | "date";
export type StudentSortDir = "asc" | "desc";
export type StudentStatusFilter = "none" | "blackhole" | "alumni" | "freeze";

export interface StudentPageOptions {
  offset: number;
  limit: number;
  sort: StudentSortField;
  dir: StudentSortDir;
  filter: StudentStatusFilter;
  poolMonth: number | null;
  poolYear: number | null;
  q: string;
}

export interface StudentPageResult {
  total: number;
  active: number;
  filtered: number;
  data: StudentEntry[];
  options?: {
    intakes: { month: number; year: number; label: string }[];
    poolYears: number[];
  };
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isFutureStudent(e: StudentEntry, now = Date.now()): boolean {
  if (!e.begin_at) return false;
  const t = new Date(e.begin_at).getTime();
  return Number.isFinite(t) && t > now;
}

function isBlackholed(e: StudentEntry, now = Date.now()): boolean {
  return (
    e.active === false &&
    typeof e.blackholed_at === "string" &&
    new Date(e.blackholed_at).getTime() < now
  );
}

function isFrozen(e: StudentEntry, now = Date.now()): boolean {
  return (
    e.active === false &&
    typeof e.blackholed_at === "string" &&
    new Date(e.blackholed_at).getTime() >= now
  );
}

function beginTimestamp(e: StudentEntry): number {
  return e.begin_at ? new Date(e.begin_at).getTime() : 0;
}

function poolTimestamp(e: StudentEntry): number {
  if (!e.pool_year || !e.pool_month) return 0;
  const d = new Date(Date.parse(`${e.pool_month} 1, ${e.pool_year}`));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function monthNumber(name?: string | null): number | null {
  if (!name) return null;
  const idx = MONTH_NAMES.indexOf(name.toLowerCase());
  return idx === -1 ? null : idx + 1;
}

function poolIntakes(
  entries: StudentEntry[],
  currentYear: number,
): { month: number; year: number; label: string }[] {
  const seen = new Set<string>();
  const list: { month: number; year: number; label: string }[] = [];
  for (const e of entries) {
    const y = Number(e.pool_year);
    const m = monthNumber(e.pool_month);
    if (!Number.isInteger(y) || y <= 0 || y > currentYear || m == null)
      continue;
    const key = `${m}-${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ month: m, year: y, label: `${MONTH_LABELS[m - 1]} ${y}` });
  }
  return list.sort((a, b) => b.year - a.year || b.month - a.month);
}

function yearOptions(currentYear: number): number[] {
  const years: number[] = [];
  for (let y = currentYear; y >= 2023; y--) years.push(y);
  return years;
}

function poolYearOptions(
  entries: StudentEntry[],
  currentYear: number,
): number[] {
  const years = new Set<number>();
  for (const e of entries) {
    const y = Number(e.pool_year);
    if (Number.isInteger(y) && y > 0 && y <= currentYear) years.add(y);
  }
  const list = [...years].sort((a, b) => b - a);
  return list.length > 0 ? list : yearOptions(currentYear);
}

export function paginateStudents(
  entries: StudentEntry[],
  opts: StudentPageOptions,
): StudentPageResult {
  const now = Date.now();
  const base = entries.filter((e) => !isFutureStudent(e, now));
  const active = base.filter((e) => e.active !== false).length;

  const q = normalizeSearch(opts.q.trim());
  const filtered = base.filter((e) => {
    if (opts.filter === "blackhole" && !isBlackholed(e, now)) return false;
    if (opts.filter === "alumni" && !e.alumni) return false;
    if (opts.filter === "freeze" && !isFrozen(e, now)) return false;
    if (opts.poolMonth != null) {
      if (
        e.pool_year !== String(opts.poolYear) ||
        e.pool_month?.toLowerCase() !== MONTH_NAMES[opts.poolMonth - 1]
      )
        return false;
    } else if (opts.poolYear != null && e.pool_year !== String(opts.poolYear)) {
      return false;
    }
    return !q || normalizeSearch(`${e.login} ${e.displayname}`).includes(q);
  });

  let display: StudentEntry[];
  if (opts.filter === "blackhole") {
    display = [...filtered].sort(
      (a, b) =>
        new Date(b.blackholed_at ?? 0).getTime() -
        new Date(a.blackholed_at ?? 0).getTime(),
    );
  } else if (opts.filter === "alumni") {
    display = [...filtered].sort((a, b) => {
      const ta = a.alumnized_at ? new Date(a.alumnized_at).getTime() : 0;
      const tb = b.alumnized_at ? new Date(b.alumnized_at).getTime() : 0;
      return tb - ta;
    });
  } else if (opts.sort === "date") {
    display = [...filtered].sort((a, b) => {
      const diff = beginTimestamp(b) - beginTimestamp(a);
      const result = opts.dir === "desc" ? diff : -diff;
      return result || a.login.localeCompare(b.login);
    });
  } else {
    display = [...filtered].sort((a, b) => {
      const an = normalizeSearch(`${a.displayname || a.login}`);
      const bn = normalizeSearch(`${b.displayname || b.login}`);
      const cmp = an.localeCompare(bn) || a.login.localeCompare(b.login);
      return opts.dir === "asc" ? cmp : -cmp;
    });
  }

  const result: StudentPageResult = {
    total: base.length,
    active,
    filtered: display.length,
    data: display.slice(opts.offset, opts.offset + opts.limit),
  };

  if (opts.offset === 0) {
    const currentYear = new Date(now).getFullYear();
    result.options = {
      intakes: poolIntakes(base, currentYear),
      poolYears: poolYearOptions(base, currentYear),
    };
  }

  return result;
}

export function parseStudentPageOptions(url: URL): StudentPageOptions {
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  const sort: StudentSortField =
    url.searchParams.get("sort") === "date" ? "date" : "name";
  const dirParam = url.searchParams.get("dir");
  const dir: StudentSortDir =
    dirParam === "asc" || dirParam === "desc"
      ? dirParam
      : sort === "name"
        ? "asc"
        : "desc";
  const filterParam = url.searchParams.get("filter");
  const filter: StudentStatusFilter =
    filterParam === "blackhole" ||
    filterParam === "alumni" ||
    filterParam === "freeze"
      ? filterParam
      : "none";
  const poolMonthRaw = Number(url.searchParams.get("pool_month"));
  const poolMonth =
    Number.isInteger(poolMonthRaw) && poolMonthRaw >= 1 && poolMonthRaw <= 12
      ? poolMonthRaw
      : null;
  const poolYearRaw = Number(url.searchParams.get("pool_year"));
  const poolYear =
    Number.isInteger(poolYearRaw) && poolYearRaw > 0 ? poolYearRaw : null;
  return {
    offset,
    limit,
    sort,
    dir,
    filter,
    poolMonth,
    poolYear,
    q: url.searchParams.get("q") ?? "",
  };
}

export async function handleStudentsList(
  request: Request,
  env: Env,
  origin: string | null,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const bearer = getBearerToken(request);
  if (
    !bearer ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, bearer)
  ) {
    return textRes("Unauthorized", 401);
  }

  const url = new URL(request.url);
  const paged = url.searchParams.has("limit");
  const pageOpts = paged ? parseStudentPageOptions(url) : null;

  const respond = (row: CacheRow): Response => {
    if (!paged || !pageOpts) return cacheResponse(origin, row);
    let entries: StudentEntry[] = [];
    try {
      entries = JSON.parse(row.data) as StudentEntry[];
    } catch {
      entries = [];
    }
    return jsonRes({
      cached_at: row.cached_at,
      ...paginateStudents(entries, pageOpts),
    });
  };

  const cached = await readCacheRow(
    env,
    STUDENTS_CURSUS_ID,
    STUDENTS_CACHE_VERSION,
    "",
  );
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.cached_at > now - STUDENTS_CACHE_TTL) {
    return respond(cached);
  }

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  let token: string | null = null;
  try {
    token = await getUserToken(env, existingData, loginParam, country, {
      appTokenFallback: true,
    });
  } catch {
    token = null;
  }

  if (token) {
    const all = await fetchAllCursusUsers(
      env,
      STUDENTS_CURSUS_ID,
      undefined,
      undefined,
      { token },
    );
    if (all) {
      const cachedAt = await writeCache(
        env,
        STUDENTS_CURSUS_ID,
        STUDENTS_CACHE_VERSION,
        "",
        all,
      );
      return respond({ data: JSON.stringify(all), cached_at: cachedAt });
    }
  }

  if (cached) return respond(cached);
  if (paged && pageOpts) {
    return jsonRes({
      cached_at: 0,
      total: 0,
      active: 0,
      filtered: 0,
      offset: pageOpts.offset,
      limit: pageOpts.limit,
      data: [],
    });
  }
  return jsonRes({ cached_at: 0, data: [] });
}

export async function handlePiscinersList(
  request: Request,
  env: Env,
  origin: string | null,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const bearer = getBearerToken(request);
  if (
    !bearer ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, bearer)
  ) {
    return textRes("Unauthorized", 401);
  }

  const url = new URL(request.url);
  const year = Number(url.searchParams.get("year"));
  const month = Number(url.searchParams.get("month"));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return textRes("Missing or invalid year/month", 400);
  }

  const cacheBegin = `PISCINE:${year}-${String(month).padStart(2, "0")}`;

  const now = Math.floor(Date.now() / 1000);
  const cached = await readCacheRow(env, STUDENTS_CURSUS_ID, cacheBegin, "");
  if (cached && cached.cached_at > now - PISCINE_CACHE_TTL) {
    return cacheResponse(origin, cached);
  }

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  let token: string | null = null;
  try {
    token = await getUserToken(env, existingData, loginParam, country, {
      appTokenFallback: true,
    });
  } catch {
    token = null;
  }

  if (token) {
    const entries = await fetchPiscineCohort(token, year, month);
    if (entries && entries.length > 0) {
      const cachedAt = await writeCache(
        env,
        STUDENTS_CURSUS_ID,
        cacheBegin,
        "",
        entries,
      );
      return cacheResponse(origin, {
        data: JSON.stringify(entries),
        cached_at: cachedAt,
      });
    }
  }

  if (cached) return cacheResponse(origin, cached);
  return jsonRes({ cached_at: 0, data: [] });
}

async function fetchPiscineCohort(
  token: string,
  year: number,
  month: number,
): Promise<StudentEntry[] | null> {
  const monthName = MONTH_NAMES[month - 1];
  if (!monthName) return null;

  const all: StudentEntry[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      "filter[primary_campus_id]": String(BELGIUM_CAMPUS_ID),
      "filter[pool_month]": monthName,
      "filter[pool_year]": String(year),
      "page[size]": String(PAGE_SIZE),
      "page[number]": String(page),
    });

    const res = await intraFetch(token, `${API_BASE}/v2/users?${params}`);
    if (!res.ok) return all.length > 0 ? all : null;

    const users = (await res.json()) as Array<{
      login: string;
      displayname?: string;
      first_name?: string;
      last_name?: string;
      image?: { versions?: { small?: string } };
      kind?: string;
      "active?"?: boolean;
      "alumni?"?: boolean;
      pool_month?: string | null;
      pool_year?: string | null;
      alumnized_at?: string | null;
      correction_point?: number;
      wallet?: number;
    }>;

    if (users.length === 0) break;

    for (const u of users) {
      if (u.kind === "admin") continue;
      all.push({
        login: u.login,
        displayname:
          u.displayname ||
          [u.first_name, u.last_name].filter(Boolean).join(" ") ||
          u.login,
        image_url:
          u.image?.versions?.small ||
          `https://cdn.intra.42.fr/users/${u.login}.jpg`,
        begin_at: null,
        blackholed_at: null,
        active: u["active?"] ?? true,
        alumni: u["alumni?"] ?? false,
        pool_month: u.pool_month ?? null,
        pool_year: u.pool_year ?? null,
        correction_point: u.correction_point ?? 0,
        wallet: u.wallet ?? 0,
      });
    }

    if (users.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

export async function handlePiscinesList(
  request: Request,
  env: Env,
  origin: string | null,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const bearer = getBearerToken(request);
  if (
    !bearer ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, bearer)
  ) {
    return textRes("Unauthorized", 401);
  }

  return new Response(
    JSON.stringify({
      cached_at: Math.floor(Date.now() / 1000),
      data: PISCINE_INTAKES,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
      },
    },
  );
}

export async function handleFutureStudentsList(
  request: Request,
  env: Env,
  origin: string | null,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const bearer = getBearerToken(request);
  if (
    !bearer ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, bearer)
  ) {
    return textRes("Unauthorized", 401);
  }

  return readCache(env, origin, STUDENTS_CURSUS_ID, "FUTURE", "FUTURE");
}

export async function handleFutureStudentsRefresh(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  if (!checkSecret(request, env)) return textRes("Forbidden", 403);

  const all = await fetchAllCursusUsers(
    env,
    STUDENTS_CURSUS_ID,
    undefined,
    undefined,
    { future: true },
  );
  if (!all) return textRes("42 API error", 502);

  const cachedAt = await writeCache(
    env,
    STUDENTS_CURSUS_ID,
    "FUTURE",
    "FUTURE",
    all,
  );
  return jsonRes({ cached_at: cachedAt, data: all });
}

export async function refreshFutureStudents(env: Env): Promise<void> {
  const all = await fetchAllCursusUsers(
    env,
    STUDENTS_CURSUS_ID,
    undefined,
    undefined,
    { future: true },
  );
  if (!all) {
    console.warn("[future-students] 42 API error during cron refresh");
    return;
  }
  const cachedAt = await writeCache(
    env,
    STUDENTS_CURSUS_ID,
    "FUTURE",
    "FUTURE",
    all,
  );
  console.log(
    `[future-students] cron refresh done — ${all.length} users (cached_at=${cachedAt})`,
  );
}
