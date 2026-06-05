import { Env, UserData } from "../types";
import {
  getBearerToken,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

const INTRA_API = "https://api.intra.42.fr/v2";
const PAGE_SIZE = 100;
const USER_IDS_KV_KEY = "FRIEND_USER_IDS";

export async function handleFriendsData(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const url = new URL(request.url);
  const loginsParam = url.searchParams.get("logins");
  if (!loginsParam) return jsonRes({ friends: [] });

  const logins = [
    ...new Set(
      loginsParam
        .split(",")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 50),
    ),
  ];

  if (logins.length === 0) return jsonRes({ friends: [] });

  const intraToken = await getUserToken(env, existingData, loginParam);
  if (!intraToken) {
    return textRes("Failed to get API token", 500);
  }

  const idMap =
    (await env.BETTER_INTRA_KV.get<Record<string, number>>(USER_IDS_KV_KEY, {
      type: "json",
    })) ?? {};

  const loginToId: Record<string, number> = {};
  const unknownLogins: string[] = [];
  for (const login of logins) {
    if (typeof idMap[login] === "number") {
      loginToId[login] = idMap[login];
    } else {
      unknownLogins.push(login);
    }
  }

  if (unknownLogins.length > 0) {
    const users = await fetchAllPages<any>(
      `${INTRA_API}/users?filter[login]=${unknownLogins.join(",")}&page[size]=${PAGE_SIZE}`,
      intraToken,
    );
    for (const u of users) {
      if (u?.id && u?.login) {
        loginToId[u.login] = u.id;
        idMap[u.login] = u.id;
      }
    }
    env.BETTER_INTRA_KV.put(USER_IDS_KV_KEY, JSON.stringify(idMap)).catch(
      () => {},
    );
  }

  const allIds = Object.values(loginToId);
  if (allIds.length === 0) return jsonRes({ friends: [] });

  const cursusUsers = await fetchAllPages<any>(
    `${INTRA_API}/cursus_users?filter[user_id]=${allIds.join(",")}&filter[cursus_id]=21&page[size]=${PAGE_SIZE}`,
    intraToken,
  );

  const friends: any[] = [];
  const friendLogins: string[] = [];
  for (const entry of cursusUsers) {
    const user = entry?.user;
    if (!user?.login) continue;
    friendLogins.push(user.login);

    const lastSeen = user.location ?? null;
    const poolLabel = user.pool_month && user.pool_year
      ? `${String(new Date(`${user.pool_month} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${user.pool_year}`
      : null;

    friends.push({
      login: user.login,
      displayName: user.displayname ?? user.login,
      avatar: user.image?.versions?.small ?? user.image?.link ?? null,
      level: entry.level ?? 0,
      grade: entry.grade ?? null,
      isOnline: user.location !== null,
      lastSeen,
      poolLabel,
      wallet: user.wallet ?? 0,
      correctionPoints: user.correction_point ?? 0,
    });
  }

  console.log(`[friends] fetching locations_stats for ${friendLogins.length} users`);
  const LOGTIME_CACHE_KEY = "LOGTIME_CACHE";
  const LOGTIME_CACHE_TTL = 3600;
  const cachedBundle =
    await env.BETTER_INTRA_KV.get<Record<string, any> & { _ts: number }>(
      LOGTIME_CACHE_KEY,
      { type: "json" },
    );
  const cacheValid =
    cachedBundle && Date.now() - cachedBundle._ts < LOGTIME_CACHE_TTL * 1000;

  const statsResults: any[] = [];
  const fetchLogins: string[] = [];
  for (const l of friendLogins) {
    if (cacheValid && cachedBundle[l]) {
      statsResults.push(cachedBundle[l]);
    } else {
      statsResults.push(null);
      fetchLogins.push(l);
    }
  }

  for (let i = 0; i < friendLogins.length; i++) {
    if (statsResults[i]) continue;
    if (i > 0) await new Promise((r) => setTimeout(r, 350));
    try {
      const res = await fetch(`${INTRA_API}/users/${friendLogins[i]}/locations_stats`, {
        headers: { Authorization: `Bearer ${intraToken}` },
      });
      const hourly = res.headers.get("x-hourly-ratelimit-remaining") ?? "?";
      console.log(`[42 API] locations_stats/${friendLogins[i]} status=${res.status} hourly=${hourly}`);
      if (res.ok) statsResults[i] = await res.json();
    } catch {
      // stays null
    }
  }

  // Update cache bundle if any were fetched
  if (fetchLogins.length > 0 && cacheValid) {
    for (let i = 0; i < friendLogins.length; i++) {
      if (statsResults[i]) cachedBundle[friendLogins[i]] = statsResults[i];
    }
    cachedBundle._ts = Date.now();
    env.BETTER_INTRA_KV.put(LOGTIME_CACHE_KEY, JSON.stringify(cachedBundle), {
      expirationTtl: LOGTIME_CACHE_TTL,
    }).catch(() => {});
  } else if (fetchLogins.length > 0) {
    const bundle: Record<string, any> = { _ts: Date.now() };
    for (let i = 0; i < friendLogins.length; i++) {
      if (statsResults[i]) bundle[friendLogins[i]] = statsResults[i];
    }
    env.BETTER_INTRA_KV.put(LOGTIME_CACHE_KEY, JSON.stringify(bundle), {
      expirationTtl: LOGTIME_CACHE_TTL,
    }).catch(() => {});
  }
  const statsOk = statsResults.filter(Boolean).length;
  console.log(`[friends] locations_stats ok=${statsOk} total=${friendLogins.length} cached=${friendLogins.length - fetchLogins.length}`);

  const friendMap = new Map(friends.map((f) => [f.login, f]));
  for (let i = 0; i < friendLogins.length; i++) {
    const stat = statsResults[i];
    if (!stat) continue;
    const friend = friendMap.get(friendLogins[i]);
    if (!friend) continue;

    const entries = Object.entries(stat as Record<string, string>);
    let totalSeconds = 0;
    let lastActiveDate: string | null = null;
    for (const [date, duration] of entries) {
      const [h, m, s] = duration.split(":").map(Number);
      totalSeconds += h * 3600 + m * 60 + (isNaN(s) ? 0 : s);
      if (!lastActiveDate || date > lastActiveDate) lastActiveDate = date;
    }

    friend.logtime = {
      totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
      lastActiveDate,
      dailyStats: stat,
    };
  }

  return jsonRes({ friends });
}

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}page[number]=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const hourly = res.headers.get("x-hourly-ratelimit-remaining") ?? "?";
    const secondly = res.headers.get("x-secondly-ratelimit-remaining") ?? "?";
    console.log(`[42 API] page=${page} status=${res.status} hourly=${hourly} secondly=${secondly}`);
    if (!res.ok) break;
    const data = (await res.json()) as T[];
    if (data.length === 0) break;
    results.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  return results;
}
