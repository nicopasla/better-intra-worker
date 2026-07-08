import { Env, UserData } from "../types";
import { getBearerToken, getUserToken, jsonRes, textRes, validateSession } from "../utils";

const API_BASE = "https://api.intra.42.fr";

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
  if (!validateSession(existingData, authHeader)) return textRes("Invalid session", 401);

  const country: string | null = (request.cf?.country as string | undefined) || null;
  const token = await getUserToken(env, existingData, loginParam, country);

  const graphPath = `/v2/users/${targetUsername}/scale_teams/graph/on/created_at/by/month`;

  const [totalRes, failedRes] = await Promise.all([
    fetch(`${API_BASE}${graphPath}`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${API_BASE}${graphPath}?filter[final_mark]=0`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (!totalRes.ok) return textRes("API error", totalRes.status);
  if (!failedRes.ok) return textRes("API error", failedRes.status);

  const totalMap = await totalRes.json() as Record<string, number>;
  const failedMap = await failedRes.json() as Record<string, number>;

  const allMonths = new Set([...Object.keys(totalMap), ...Object.keys(failedMap)]);
  const byMonth: Record<string, { total: number; failed: number; successPercentage: number | null }> = {};
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
      successPercentage: total > 0 ? Math.round(((total - failed) / total) * 1000) / 10 : null,
    };
  }

  return jsonRes({
    byMonth,
    global: {
      total: globalTotal,
      failed: globalFailed,
      successPercentage: globalTotal > 0 ? Math.round(((globalTotal - globalFailed) / globalTotal) * 1000) / 10 : null,
    },
  });
}
