import { Env, UserData } from "../types";
import {
  decryptBytes,
  encryptBytes,
  getBearerToken,
  getUserToken,
  hashLogin,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";
const CACHE_TTL = 3_600;

interface RouletteEntry {
  historic_id: number;
  sum: number;
  total: number;
  created_at: string;
}

interface EvalStatsResponse {
  byMonth: Record<
    string,
    { total: number; failed: number; successPercentage: number | null }
  >;
  global: { total: number; failed: number; successPercentage: number | null };
}

async function syncRouletteFromApi(
  env: Env,
  hash: string,
  userToken: string,
  login: string,
  stopAtHistoricId: number,
): Promise<void> {
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    const url = `${API_BASE}/v2/users/${login}/correction_point_historics?filter[reason]=Thursday+Roulette&page[size]=100&page[number]=${page}&sort=-id`;
    const res = await intraFetch(userToken, url);
    if (!res.ok) break;

    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const batch: D1PreparedStatement[] = [];
    for (const item of data) {
      if (stopAtHistoricId && item.id <= stopAtHistoricId) {
        if (batch.length > 0) await env.better_intra_d1.batch(batch);
        return;
      }
      batch.push(
        env.better_intra_d1
          .prepare(
            "INSERT OR IGNORE INTO correction_point_historics (hash, historic_id, sum, total, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(hash, item.id, item.sum, item.total, item.created_at),
      );
    }
    if (batch.length > 0) await env.better_intra_d1.batch(batch);

    if (data.length < 100) break;
    page++;
  }
}

async function getRouletteEntries(
  env: Env,
  hash: string,
): Promise<RouletteEntry[]> {
  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT historic_id, sum, total, created_at FROM correction_point_historics WHERE hash = ? ORDER BY created_at DESC",
    )
    .bind(hash)
    .all<RouletteEntry>();
  return results || [];
}

function computeEvalStats(
  totalMap: Record<string, number>,
  failedMap: Record<string, number>,
): EvalStatsResponse {
  const allMonths = new Set([
    ...Object.keys(totalMap),
    ...Object.keys(failedMap),
  ]);
  const byMonth: Record<
    string,
    { total: number; failed: number; successPercentage: number | null }
  > = {};
  let globalTotal = 0;
  let globalFailed = 0;

  for (const month of [...allMonths].sort()) {
    const total = totalMap[month] ?? 0;
    const failed = failedMap[month] ?? 0;
    globalTotal += total;
    globalFailed += failed;
    byMonth[month] = {
      total,
      failed,
      successPercentage:
        total > 0 ? Math.round(((total - failed) / total) * 1000) / 10 : null,
    };
  }

  return {
    byMonth,
    global: {
      total: globalTotal,
      failed: globalFailed,
      successPercentage:
        globalTotal > 0
          ? Math.round(((globalTotal - globalFailed) / globalTotal) * 1000) / 10
          : null,
    },
  };
}

export async function handleProfileStats(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
  targetUsername: string,
): Promise<Response> {
  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization header", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader))
    return textRes("Invalid session", 401);

  const url = new URL(request.url);
  const force = url.searchParams.has("force");

  const now = Math.floor(Date.now() / 1000);
  const targetHash = await hashLogin(targetUsername);
  const cached = await env.better_intra_d1
    .prepare(
      "SELECT response_body, cached_at FROM profile_stats_cache WHERE target_hash = ?",
    )
    .bind(targetHash)
    .first<{ response_body: ArrayBuffer | string; cached_at: number }>();

  if (!force && cached && now - cached.cached_at < CACHE_TTL) {
    const decoded = await decryptBytes(env, cached.response_body);
    if (decoded) return jsonRes(JSON.parse(decoded));
  }

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  const token = await getUserToken(env, existingData, loginParam, country);
  if (!token) return textRes("Failed to get API token", 500);

  const hash = targetHash;

  // Roulette: sync from 42 API if needed
  const existingEntries = await getRouletteEntries(env, hash);
  if (existingEntries.length === 0) {
    await syncRouletteFromApi(env, hash, token, targetUsername, 0);
  } else {
    const latestId = Math.max(...existingEntries.map((e) => e.historic_id));
    await syncRouletteFromApi(env, hash, token, targetUsername, latestId);
  }
  const rouletteEntries = await getRouletteEntries(env, hash);

  // Eval stats: fetch from 42 API
  const graphPath = `/v2/users/${targetUsername}/scale_teams/graph/on/created_at/by/month`;

  const totalRes = await intraFetch(token, `${API_BASE}${graphPath}`);
  if (!totalRes.ok)
    return textRes(`42 API error (total): ${totalRes.status}`, totalRes.status);
  const totalMap = (await totalRes.json()) as Record<string, number>;

  const failedRes = await intraFetch(
    token,
    `${API_BASE}${graphPath}?range[final_mark]=0,49`,
  );
  if (!failedRes.ok)
    return textRes(
      `42 API error (failed): ${failedRes.status}`,
      failedRes.status,
    );
  const failedMap = (await failedRes.json()) as Record<string, number>;

  const evalStats = computeEvalStats(totalMap, failedMap);

  const body = {
    roulette: { entries: rouletteEntries },
    evalStats,
  };

  await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO profile_stats_cache (target_hash, response_body, cached_at) VALUES (?, ?, ?)",
    )
    .bind(targetHash, await encryptBytes(env, JSON.stringify(body)), now)
    .run();

  return jsonRes(body);
}
