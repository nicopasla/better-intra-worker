import { Env, UserData } from "../types";
import {
  getBearerToken,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

const API_BASE = "https://api.intra.42.fr";
const CACHE_TTL = 21_600;

interface EvalStatsResponse {
  byMonth: Record<
    string,
    { total: number; failed: number; successPercentage: number | null }
  >;
  global: { total: number; failed: number; successPercentage: number | null };
}

export async function handleEvalStats(
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

  const now = Math.floor(Date.now() / 1000);
  const cached = await env.better_intra_d1
    .prepare(
      "SELECT response_body, cached_at FROM eval_stats_cache WHERE target_login = ?",
    )
    .bind(targetUsername)
    .first<{ response_body: string; cached_at: number }>();

  if (cached && now - cached.cached_at < CACHE_TTL) {
    return jsonRes(JSON.parse(cached.response_body));
  }

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  const token = await getUserToken(env, existingData, loginParam, country);

  const graphPath = `/v2/users/${targetUsername}/scale_teams/graph/on/created_at/by/month`;

  const [totalRes, failedRes] = await Promise.all([
    fetch(`${API_BASE}${graphPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`${API_BASE}${graphPath}?filter[final_mark]=0`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (!totalRes.ok) return textRes("API error", totalRes.status);
  if (!failedRes.ok) return textRes("API error", failedRes.status);

  const totalMap = (await totalRes.json()) as Record<string, number>;
  const failedMap = (await failedRes.json()) as Record<string, number>;

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

  const body: EvalStatsResponse = {
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

  await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO eval_stats_cache (target_login, response_body, cached_at) VALUES (?, ?, ?)",
    )
    .bind(targetUsername, JSON.stringify(body), now)
    .run();

  return jsonRes(body);
}
