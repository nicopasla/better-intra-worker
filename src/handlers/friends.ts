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
  for (const entry of cursusUsers) {
    const user = entry?.user;
    if (!user?.login) continue;

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
    if (!res.ok) break;
    const data = (await res.json()) as T[];
    if (data.length === 0) break;
    results.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  return results;
}
