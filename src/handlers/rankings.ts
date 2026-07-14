import { Env, UserData } from "../types";
import {
  getBearerToken,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

const API_BASE = "https://api.intra.42.fr";
const CACHE_TTL = 3600;
const BELGIUM_CAMPUS_ID = 12;

interface RankingEntry {
  rank: number;
  login: string;
  image_url: string;
  level: number;
}

function cacheKey(cursusId: string, rangeBegin: string, rangeEnd: string): string {
  return `RANKINGS_${cursusId}_${rangeBegin}_${rangeEnd}`;
}

export async function handleRankings(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader))
    return textRes("Unauthorized: Invalid Session Token", 401);

  const url = new URL(request.url);
  const cursusId = url.searchParams.get("cursus_id");
  const rangeBegin = url.searchParams.get("range_begin");
  const rangeEnd = url.searchParams.get("range_end");
  if (!cursusId || !rangeBegin || !rangeEnd)
    return textRes("Missing cursus_id, range_begin, or range_end", 400);

  const kvKey = cacheKey(cursusId, rangeBegin, rangeEnd);
  const now = Math.floor(Date.now() / 1000);

  const raw = await env.BETTER_INTRA_KV.get(kvKey, { type: "json" }) as
    | { data: RankingEntry[]; cached_at: number }
    | null;
  if (raw && now - raw.cached_at < CACHE_TTL) {
    return jsonRes(raw.data);
  }

  const token = await getUserToken(env, existingData, loginParam);
  if (!token) return textRes("Failed to get API token", 500);

  const apiUrl = `${API_BASE}/v2/cursus_users?filter[cursus_id]=${cursusId}&filter[campus_id]=${BELGIUM_CAMPUS_ID}&sort=-level&range[begin_at]=${rangeBegin},${rangeEnd}&page[size]=10`;

  const apiRes = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!apiRes.ok) {
    return textRes(`42 API error: ${apiRes.status}`, apiRes.status);
  }

  const users = (await apiRes.json()) as Array<{
    user: { login: string; image?: { versions?: { small?: string } } };
    level: number;
  }>;

  const data: RankingEntry[] = users.map((u, i) => ({
    rank: i + 1,
    login: u.user.login,
    image_url: u.user.image?.versions?.small
      || `https://cdn.intra.42.fr/users/${u.user.login}.jpg`,
    level: Math.round(u.level * 100) / 100,
  }));

  await env.BETTER_INTRA_KV.put(
    kvKey,
    JSON.stringify({ data, cached_at: now }),
    { expirationTtl: CACHE_TTL + 60 },
  );

  return jsonRes(data);
}
