import { Env, UserData } from "../types";
import {
  getAppToken,
  getBearerToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

const API_BASE = "https://api.intra.42.fr";
const BELGIUM_CAMPUS_ID = 12;
const PAGE_SIZE = 100;
const STUDENTS_CURSUS_ID = 21;
const PISCINE_CURSUS_ID = 64;

interface StudentEntry {
  login: string;
  displayname: string;
  image_url: string;
  begin_at: string | null;
  blackholed_at: string | null;
  active: boolean;
  alumni: boolean;
  pool_month: string | null;
  pool_year: string | null;
}

interface Range {
  begin: string;
  end: string;
}

function monthRange(year: number, month: number): Range {
  const endMonth = month + 1;
  const endYear = endMonth > 12 ? year + 1 : year;
  return {
    begin: `${year}-${String(month).padStart(2, "0")}-01`,
    end: `${endYear}-${String(endMonth > 12 ? 1 : endMonth).padStart(2, "0")}-01`,
  };
}

function checkSecret(request: Request, env: Env): boolean {
  return (
    !!env.PROXY_SECRET &&
    request.headers.get("X-Proxy-Key") === env.PROXY_SECRET
  );
}

async function ensureCacheTable(env: Env): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "CREATE TABLE IF NOT EXISTS students_cache (cursus_id INTEGER NOT NULL, range_begin TEXT NOT NULL, range_end TEXT NOT NULL, data TEXT NOT NULL, cached_at INTEGER NOT NULL, PRIMARY KEY (cursus_id, range_begin, range_end))",
    )
    .run();
}

async function readCache(
  env: Env,
  origin: string | null,
  cursusId: number,
  cacheBegin: string,
  cacheEnd: string,
): Promise<Response> {
  await ensureCacheTable(env);
  const cached = await env.better_intra_d1
    .prepare(
      "SELECT data, cached_at FROM students_cache WHERE cursus_id = ? AND range_begin = ? AND range_end = ?",
    )
    .bind(cursusId, cacheBegin, cacheEnd)
    .first<{ data: string; cached_at: number }>();

  if (cached) {
    const wrapped = `{"cached_at":${cached.cached_at},"data":${cached.data}}`;
    return new Response(wrapped, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
      },
    });
  }
  return jsonRes({ cached_at: 0, data: [] });
}

async function fetchAllCursusUsers(
  env: Env,
  cursusId: number,
  rangeBegin?: string,
  rangeEnd?: string,
): Promise<StudentEntry[] | null> {
  const token = await getAppToken(env);
  const all: StudentEntry[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      "filter[cursus_id]": String(cursusId),
      "filter[campus_id]": String(BELGIUM_CAMPUS_ID),
      "page[size]": String(PAGE_SIZE),
      "page[number]": String(page),
    });
    if (rangeBegin && rangeEnd) {
      params.set("range[begin_at]", `${rangeBegin},${rangeEnd}`);
    }

    const apiRes = await fetch(`${API_BASE}/v2/cursus_users?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!apiRes.ok) return null;

    const users = (await apiRes.json()) as Array<{
      begin_at?: string | null;
      blackholed_at?: string | null;
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
    .bind(cursusId, cacheBegin, cacheEnd, JSON.stringify(all), now)
    .run();
  return now;
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

  return readCache(env, origin, STUDENTS_CURSUS_ID, "", "");
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

  const range = monthRange(year, month);
  return readCache(env, origin, PISCINE_CURSUS_ID, range.begin, range.end);
}

export async function handleStudentsRefresh(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  if (!checkSecret(request, env)) return textRes("Forbidden", 403);

  const all = await fetchAllCursusUsers(env, STUDENTS_CURSUS_ID);
  if (!all) return textRes("42 API error", 502);

  const cachedAt = await writeCache(env, STUDENTS_CURSUS_ID, "", "", all);
  return jsonRes({ cached_at: cachedAt, data: all });
}

export async function handlePiscinersRefresh(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  if (!checkSecret(request, env)) return textRes("Forbidden", 403);

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

  const range = monthRange(year, month);
  const all = await fetchAllCursusUsers(
    env,
    PISCINE_CURSUS_ID,
    range.begin,
    range.end,
  );
  if (!all) return textRes("42 API error", 502);

  const cachedAt = await writeCache(
    env,
    PISCINE_CURSUS_ID,
    range.begin,
    range.end,
    all,
  );
  return jsonRes({ cached_at: cachedAt, data: all });
}
