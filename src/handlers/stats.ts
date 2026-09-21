import { Env } from "../types";
import { jsonRes, textRes } from "../utils";

const STATS_CACHE = "PUBLIC_STATS_CACHE";
const STATS_CACHE_TTL = 60 * 60;

type CampusCount = { name: string; count: number };

type CountryStats = {
  country: string;
  count: number;
  campuses: CampusCount[];
};

type HistoryPoint = { date: string; total: number };

type StatsPayload = {
  total: number;
  newToday: number;
  newLast30Days: number;
  newLast14Days: number;
  newLast7Days: number;
  history: HistoryPoint[];
  countries: CountryStats[];
};

async function countSince(env: Env, cutoff: number): Promise<number> {
  const row = await env.better_intra_d1
    .prepare("SELECT COUNT(*) AS c FROM users WHERE created_at > ?")
    .bind(cutoff)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

function countNew(env: Env, days: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  return countSince(env, cutoff);
}

function countNewToday(env: Env): Promise<number> {
  const todayStart = Math.floor(Date.now() / 1000) % 86_400;
  return countSince(env, Math.floor(Date.now() / 1000) - todayStart);
}

async function buildHistory(env: Env): Promise<HistoryPoint[]> {
  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS c FROM users GROUP BY day ORDER BY day",
    )
    .all<{ day: string; c: number }>();

  const history: HistoryPoint[] = [];
  let running = 0;
  for (const row of results || []) {
    if (!row.day) continue;
    running += row.c;
    history.push({ date: row.day, total: running });
  }
  return history;
}

async function buildStats(env: Env): Promise<StatsPayload> {
  const total = await env.better_intra_d1
    .prepare("SELECT COUNT(*) AS c FROM users")
    .first<{ c: number }>();

  const [newToday, newLast30Days, newLast14Days, newLast7Days, history] =
    await Promise.all([
      countNewToday(env),
      countNew(env, 30),
      countNew(env, 14),
      countNew(env, 7),
      buildHistory(env),
    ]);

  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT COALESCE(country, '?') AS country, COUNT(*) AS c FROM users GROUP BY country ORDER BY c DESC",
    )
    .all<{ country: string; c: number }>();

  const campusRows = await env.better_intra_d1
    .prepare(
      "SELECT COALESCE(country, '?') AS country, campus_name AS campus, COUNT(*) AS c FROM users WHERE campus_name IS NOT NULL GROUP BY country, campus_name ORDER BY c DESC",
    )
    .all<{ country: string; campus: string; c: number }>();

  const campusesByCountry = new Map<string, CampusCount[]>();
  for (const row of campusRows.results || []) {
    const list = campusesByCountry.get(row.country) || [];
    list.push({ name: row.campus, count: row.c });
    campusesByCountry.set(row.country, list);
  }

  return {
    total: total?.c ?? 0,
    newToday,
    newLast30Days,
    newLast14Days,
    newLast7Days,
    history,
    countries: (results || []).map((r) => ({
      country: r.country,
      count: r.c,
      campuses: campusesByCountry.get(r.country) || [],
    })),
  };
}

export async function handleStats(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  try {
    const cached = await env.BETTER_INTRA_KV.get<StatsPayload>(STATS_CACHE, {
      type: "json",
    });
    if (cached) return jsonRes(cached);
  } catch {}

  const payload = await buildStats(env);

  try {
    await env.BETTER_INTRA_KV.put(STATS_CACHE, JSON.stringify(payload), {
      expirationTtl: STATS_CACHE_TTL,
    });
  } catch {}

  return jsonRes(payload);
}
