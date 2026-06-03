import { Env, UserData } from "../types";
import { getAppToken, getTokens, jsonRes, textRes } from "../utils";

const INTRA_API = "https://api.intra.42.fr/v2";

export async function handleFriendsData(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = request.headers
    .get("Authorization")
    ?.replace("Bearer ", "");
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  if (!existingData) return textRes("User not found", 404);

  const tokensList = getTokens(existingData);
  if (!tokensList.includes(authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const url = new URL(request.url);
  const loginsParam = url.searchParams.get("logins");
  if (!loginsParam) return jsonRes({ friends: [] });

  const logins = loginsParam
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);

  if (logins.length === 0) return jsonRes({ friends: [] });

  const CACHE_TTL = 60;
  const cacheKey = `FRIENDS_DATA_${loginParam}`;
  const cached = await env.BETTER_INTRA_KV.get<{ friends: any[]; ts: number }>(
    cacheKey,
    { type: "json" },
  );
  if (cached && Date.now() - cached.ts < CACHE_TTL * 1000) {
    return jsonRes(cached);
  }

  const intraToken = await getAppToken(env);
  if (!intraToken) {
    return textRes("Failed to get API token", 500);
  }

  async function fetchUser(login: string, retries = 2): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(`${INTRA_API}/users/${login}`, {
        headers: { Authorization: `Bearer ${intraToken}` },
      });

      if (res.ok) {
        const user = (await res.json()) as any;

        const cursusUsers: any[] = user.cursus_users ?? [];
        const main =
          cursusUsers.find((c: any) => c.cursus_id === 21) ??
          cursusUsers[cursusUsers.length - 1] ??
          null;

        const lastSeen = user.location ?? null;

        return {
          login: user.login,
          displayName: user.displayname ?? user.login,
          avatar: user.image?.versions?.small ?? user.image?.link ?? null,
          level: main?.level ?? 0,
          grade: main?.grade ?? null,
          cursus: main?.cursus?.name ?? null,
          isOnline: user.location !== null,
          lastSeen,
          poolYear: user.pool_year ?? null,
          wallet: user.wallet ?? 0,
          correctionPoints: user.correction_point ?? 0,
        };
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
      }

      return null;
    }
    return null;
  }

  const results: any[] = [];
  const CONCURRENCY = 2;
  for (let i = 0; i < logins.length; i += CONCURRENCY) {
    const batch = logins.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map((login) => fetchUser(login)));
    results.push(...batchResults);
  }

  const friends = results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter(Boolean);

  const payload = { friends, ts: Date.now() };
  env.BETTER_INTRA_KV.put(cacheKey, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL,
  });

  return jsonRes(payload);
}
