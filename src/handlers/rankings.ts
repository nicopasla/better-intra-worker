import { Env } from "../types";
import { getAppToken, jsonRes, textRes } from "../utils";

const API_BASE = "https://api.intra.42.fr";
const CACHE_TTL = 3600;
const BELGIUM_CAMPUS_ID = 12;

interface RankingEntry {
  rank: number;
  login: string;
  displayname: string;
  image_url: string;
  level: number;
}

export async function handleRankings(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const url = new URL(request.url);
  const cursusId = url.searchParams.get("cursus_id");
  const rangeBegin = url.searchParams.get("range_begin");
  const rangeEnd = url.searchParams.get("range_end");
  if (!cursusId || !rangeBegin || !rangeEnd)
    return textRes("Missing cursus_id, range_begin, or range_end", 400);

  const now = Math.floor(Date.now() / 1000);

  await env.better_intra_d1
    .prepare(
      "CREATE TABLE IF NOT EXISTS rankings_cache (cursus_id INTEGER NOT NULL, range_begin TEXT NOT NULL, range_end TEXT NOT NULL, data TEXT NOT NULL, cached_at INTEGER NOT NULL, PRIMARY KEY (cursus_id, range_begin, range_end))",
    )
    .run();

  const cached = await env.better_intra_d1
    .prepare(
      "SELECT data, cached_at FROM rankings_cache WHERE cursus_id = ? AND range_begin = ? AND range_end = ?",
    )
    .bind(Number(cursusId), rangeBegin, rangeEnd)
    .first<{ data: string; cached_at: number }>();

  if (cached && now - cached.cached_at < CACHE_TTL) {
    return new Response(cached.data, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
        "Cache-Control": "public, max-age=1800",
      },
    });
  }

  const token = await getAppToken(env);

  const params = new URLSearchParams({
    "filter[cursus_id]": cursusId,
    "filter[campus_id]": String(BELGIUM_CAMPUS_ID),
    sort: "-level",
    "range[begin_at]": `${rangeBegin},${rangeEnd}`,
    "page[size]": "100",
  });
  const apiUrl = `${API_BASE}/v2/cursus_users?${params}`;

  const apiRes = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!apiRes.ok) {
    return textRes(`42 API error: ${apiRes.status}`, apiRes.status);
  }

  const users = (await apiRes.json()) as Array<{
    user: {
      login: string;
      displayname?: string;
      first_name?: string;
      last_name?: string;
      image?: { versions?: { small?: string } };
    };
    level: number;
  }>;

  const data: RankingEntry[] = users.map((u, i) => ({
    rank: i + 1,
    login: u.user.login,
    displayname:
      u.user.displayname ||
      [u.user.first_name, u.user.last_name].filter(Boolean).join(" ") ||
      u.user.login,
    image_url:
      u.user.image?.versions?.small ||
      `https://cdn.intra.42.fr/users/${u.user.login}.jpg`,
    level: Math.round(u.level * 100) / 100,
  }));

  const json = JSON.stringify(data);

  if (data.length > 0) {
    await env.better_intra_d1
      .prepare(
        "INSERT OR REPLACE INTO rankings_cache (cursus_id, range_begin, range_end, data, cached_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(Number(cursusId), rangeBegin, rangeEnd, json, now)
      .run();
  }

  return new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin || "*",
      "Cache-Control": "public, max-age=1800",
    },
  });
}
