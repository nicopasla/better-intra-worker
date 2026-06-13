import { Env, UserData, FortyTwoUser, CursusUser } from "../types";
import {
  decryptTokenData,
  encryptTokenData,
  getBearerToken,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";
import { FRIEND_USER_IDS, ONLINE_CACHE } from "../constants";

const INTRA_API = "https://api.intra.42.fr/v2";
const PAGE_SIZE = 100;

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
    (await env.BETTER_INTRA_KV.get<Record<string, number>>(FRIEND_USER_IDS, {
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
    const users = await fetchAllPages<FortyTwoUser>(
      `${INTRA_API}/users?filter[login]=${unknownLogins.join(",")}&page[size]=${PAGE_SIZE}`,
      intraToken,
    );
    for (const u of users) {
      if (u?.id && u?.login) {
        loginToId[u.login] = u.id;
        idMap[u.login] = u.id;
      }
    }
    env.BETTER_INTRA_KV.put(FRIEND_USER_IDS, JSON.stringify(idMap)).catch(
      () => {},
    );
  }

  const allIds = Object.values(loginToId);
  if (allIds.length === 0) return jsonRes({ friends: [] });

  const cursusUsers = await fetchAllPages<CursusUser>(
    `${INTRA_API}/cursus_users?filter[user_id]=${allIds.join(",")}&filter[cursus_id]=21&page[size]=${PAGE_SIZE}`,
    intraToken,
  );

  const friends: any[] = [];
  const now = Date.now();
  const rawCache = await env.BETTER_INTRA_KV.get(ONLINE_CACHE);
  let onlineCache: Record<string, { location: string; seenAt: number }> = {};
  if (rawCache) {
    try {
      onlineCache = await decryptTokenData(env, rawCache);
    } catch {
      onlineCache = {};
    }
  }
  let cacheDirty = false;

  for (const entry of cursusUsers) {
    const user = entry?.user;
    if (!user?.login) continue;

    const isOnline = user.location !== null;
    const lastSeen = user.location ?? null;

    if (isOnline && user.location) {
      onlineCache[user.login] = { location: user.location, seenAt: now };
      cacheDirty = true;
    }

    const poolLabel = user.pool_month && user.pool_year
      ? `${String(new Date(`${user.pool_month} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${user.pool_year}`
      : null;

    const cached = onlineCache[user.login];
    friends.push({
      login: user.login,
      displayName: user.displayname ?? user.login,
      avatar: user.image?.versions?.small ?? user.image?.link ?? null,
      level: entry.level ?? 0,
      grade: entry.grade ?? null,
      isOnline,
      lastSeen,
      poolLabel,
      wallet: user.wallet ?? 0,
      correctionPoints: user.correction_point ?? 0,
      lastOnlineTimestamp: cached?.seenAt ?? null,
    });
  }

  if (cacheDirty) {
    const encrypted = await encryptTokenData(env, onlineCache);
    await env.BETTER_INTRA_KV.put(ONLINE_CACHE, encrypted);
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
