import { Env, UserData, FortyTwoUser, CursusUser } from "../types";
import {
  decodeBytes,
  encryptBytes,
  getBearerToken,
  getCursusMap,
  hashLogin,
  jsonRes,
  resolveUserToken,
  textRes,
  tokenFailureResponse,
  validateSession,
} from "../utils";
import { FRIEND_USER_IDS } from "../constants";
import { intraFetch } from "../rate";
import { markCache, recordCacheLookup } from "../metrics";
import { mintAvatarUrl } from "./avatar";
import {
  FriendProfileRow,
  ensureFriendProfilesTable,
  needsLocationRefresh,
  needsProfileRefresh,
  normalizeLogins,
  pickProfileFields,
  poolLabel,
} from "./friends-cache";

const INTRA_API = "https://api.intra.42.fr/v2";
const PAGE_SIZE = 100;

interface FriendProfileRecord {
  login_hash: string;
  payload: ArrayBuffer | string;
  cached_at: number;
  location: string | null;
  location_at: number | null;
}

/** `/v2/users` returns the seat; the shared type only carries id/login. */
interface LocatedUser {
  id: number;
  login: string;
  location?: string | null;
}

/** Reads the `logins` list from a POST body (new) or the GET query (legacy). */
async function readRequestedLogins(request: Request): Promise<string[] | null> {
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    return normalizeLogins((body as { logins?: unknown } | null)?.logins);
  }

  const raw = new URL(request.url).searchParams.get("logins");
  return raw ? normalizeLogins(raw) : [];
}

export async function handleFriendsData(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return textRes("Method not allowed", 405);
  }

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const logins = await readRequestedLogins(request);
  if (logins === null) return textRes("Invalid JSON body", 400);
  if (logins.length === 0) return jsonRes({ friends: [] });

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  const tokenResult = await resolveUserToken(
    env,
    existingData,
    loginParam,
    country,
  );
  if ("failure" in tokenResult) return tokenFailureResponse(tokenResult.failure);
  const intraToken = tokenResult.token;

  // --- login → 42 id (shared KV map, only unknown logins cost a request) ---
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
      env,
      `${INTRA_API}/users?filter[login]=${unknownLogins.join(",")}&page[size]=${PAGE_SIZE}`,
      intraToken,
      "friends.users",
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

  const known = logins.filter((login) => typeof loginToId[login] === "number");
  if (known.length === 0) {
    return markCache(jsonRes({ friends: [] }), "miss");
  }

  const now = Math.floor(Date.now() / 1000);
  const hashes = await Promise.all(known.map((login) => hashLogin(login)));
  const hashByLogin = new Map<string, string>();
  known.forEach((login, index) => hashByLogin.set(login, hashes[index]));

  // --- shared profile cache (1 h), keyed by login hash ---
  await ensureFriendProfilesTable(env);
  const placeholders = hashes.map(() => "?").join(",");
  const rows = new Map<string, FriendProfileRow>();
  const { results: profileRows } = await env.better_intra_d1
    .prepare(
      `SELECT login_hash, payload, cached_at, location, location_at FROM friend_profiles WHERE login_hash IN (${placeholders})`,
    )
    .bind(...hashes)
    .all<FriendProfileRecord>();

  for (const row of profileRows || []) {
    const decoded = await decodeBytes(env, row.payload);
    if (!decoded.ok) {
      recordCacheLookup(
        env,
        "friend_profiles",
        decoded.reason,
        now - row.cached_at,
      );
      continue;
    }
    try {
      rows.set(row.login_hash, {
        profile: JSON.parse(decoded.text),
        cachedAt: row.cached_at,
        location: row.location,
        locationAt: row.location_at,
      });
    } catch {
      recordCacheLookup(
        env,
        "friend_profiles",
        "parse_error",
        now - row.cached_at,
      );
    }
  }

  const staleLogins = known.filter((login) =>
    needsProfileRefresh(rows.get(hashByLogin.get(login)!), now),
  );
  // Rows that existed but aged out are `stale`; logins never seen are `empty`.
  const profileWasCached = staleLogins.some((login) =>
    rows.has(hashByLogin.get(login)!),
  );

  let profileFetched = false;
  if (staleLogins.length > 0) {
    profileFetched = true;
    const ids = staleLogins
      .map((login) => loginToId[login])
      .filter((id): id is number => typeof id === "number");

    const cursusUsers = await fetchAllPages<CursusUser>(
      env,
      `${INTRA_API}/cursus_users?filter[user_id]=${ids.join(",")}&page[size]=${PAGE_SIZE}`,
      intraToken,
      "friends.cursus",
    );

    const cursusMap = await getCursusMap(env);
    const rank = (cursusId: number): number => {
      const kind = cursusMap[cursusId]?.kind;
      if (kind === "main") return 0;
      if (kind === "piscine" || kind === "piscine_community") return 1;
      if (
        kind === "piscine_deprecated" ||
        kind === "professional_training" ||
        kind === "professional_training_deprecated"
      ) {
        return 2;
      }
      if (kind === "main_deprecated") return 3;
      return 4;
    };

    const bestByLogin = new Map<string, CursusUser>();
    for (const entry of cursusUsers) {
      const login = entry?.user?.login;
      if (!login) continue;
      const existing = bestByLogin.get(login);
      if (
        !existing ||
        rank(entry.cursus_id) < rank(existing.cursus_id) ||
        (rank(entry.cursus_id) === rank(existing.cursus_id) &&
          entry.level > existing.level)
      ) {
        bestByLogin.set(login, entry);
      }
    }

    const stmts: D1PreparedStatement[] = [];
    for (const entry of bestByLogin.values()) {
      const profile = pickProfileFields(entry);
      if (!profile) continue;
      const hash = hashByLogin.get(profile.login.toLowerCase());
      if (!hash) continue;

      const location = entry.user?.location ?? null;
      rows.set(hash, {
        profile,
        cachedAt: now,
        location,
        locationAt: now,
      });
      stmts.push(
        env.better_intra_d1
          .prepare(
            "INSERT INTO friend_profiles (login_hash, payload, cached_at, location, location_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(login_hash) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at, location = excluded.location, location_at = excluded.location_at",
          )
          .bind(
            hash,
            await encryptBytes(env, JSON.stringify(profile)),
            now,
            location,
            now,
          ),
      );
    }
    if (stmts.length > 0) await env.better_intra_d1.batch(stmts);
    recordCacheLookup(
      env,
      "friend_profiles",
      profileWasCached ? "stale" : "empty",
      -1,
    );
  } else {
    recordCacheLookup(env, "friend_profiles", "hit", -1);
  }

  // --- online status: batched refresh for rows older than the 90 s window ---
  const locationLogins = known.filter((login) =>
    needsLocationRefresh(rows.get(hashByLogin.get(login)!), now),
  );

  let locationFetched = false;
  if (locationLogins.length > 0) {
    locationFetched = true;
    const users = await fetchAllPages<LocatedUser>(
      env,
      `${INTRA_API}/users?filter[login]=${locationLogins.join(",")}&page[size]=${PAGE_SIZE}`,
      intraToken,
      "friends.location",
    );
    const byLogin = new Map(
      users.filter((u) => u?.login).map((u) => [u.login, u]),
    );

    const stmts: D1PreparedStatement[] = [];
    for (const login of locationLogins) {
      const hash = hashByLogin.get(login)!;
      const row = rows.get(hash);
      if (!row) continue;
      const location = byLogin.get(login)?.location ?? null;
      row.location = location;
      row.locationAt = now;
      stmts.push(
        env.better_intra_d1
          .prepare(
            "UPDATE friend_profiles SET location = ?, location_at = ? WHERE login_hash = ?",
          )
          .bind(location, now, hash),
      );
    }
    if (stmts.length > 0) await env.better_intra_d1.batch(stmts);
    recordCacheLookup(env, "friend_locations", "stale", -1);
  } else {
    recordCacheLookup(env, "friend_locations", "hit", -1);
  }

  // --- last-seen history (D1 online_cache), unchanged ---
  const { results: d1Rows } = await env.better_intra_d1
    .prepare(
      `SELECT login_hash, seen_at FROM online_cache WHERE login_hash IN (${placeholders})`,
    )
    .bind(...hashes)
    .all<{ login_hash: string; seen_at: ArrayBuffer | string }>();
  const onlineCache: Record<string, { seenAt: number }> = {};
  for (const row of d1Rows || []) {
    const seen = await decodeBytes(env, row.seen_at);
    onlineCache[row.login_hash] = {
      seenAt: seen.ok ? Number(seen.text) : 0,
    };
  }

  const friends: any[] = [];
  for (const login of known) {
    const hash = hashByLogin.get(login)!;
    const row = rows.get(hash);
    if (!row) continue;
    const profile = row.profile;
    friends.push({
      login: profile.login,
      displayName: profile.displayName,
      avatar: profile.avatar,
      level: profile.level,
      grade: profile.grade,
      isOnline: row.location !== null,
      lastSeen: row.location,
      poolLabel: poolLabel(profile.poolMonth, profile.poolYear),
      wallet: profile.wallet,
      correctionPoints: profile.correctionPoints,
      lastOnlineTimestamp: onlineCache[hash]?.seenAt ?? null,
    });
  }

  await Promise.all(
    friends.map(async (friend) => {
      try {
        const friendHash =
          hashByLogin.get(String(friend.login).toLowerCase()) ??
          (await hashLogin(friend.login));
        const userData = await env.BETTER_INTRA_KV.get<UserData>(friendHash, {
          type: "json",
        });
        friend.customAvatar =
          (userData?.settings?.PROFILE_IMAGE_URL as string) || null;
        friend.avatarBg =
          (userData?.settings?.PROFILE_AVATAR_BG as string) || "transparent";
        friend.avatarShape =
          userData?.settings?.PROFILE_AVATAR_SHAPE === "square"
            ? "square"
            : "round";
        friend.avatarPosX =
          (userData?.settings?.PROFILE_AVATAR_POSITION_X as number) ?? 50;
        friend.avatarPosY =
          (userData?.settings?.PROFILE_AVATAR_POSITION_Y as number) ?? 50;
        friend.avatarScale =
          (userData?.settings?.PROFILE_AVATAR_SCALE as number) ?? 100;
      } catch {
        friend.customAvatar = null;
        friend.avatarBg = "transparent";
        friend.avatarShape = "round";
        friend.avatarPosX = 50;
        friend.avatarPosY = 50;
        friend.avatarScale = 100;
      }
    }),
  );

  const selfOrigin = new URL(request.url).origin;
  await Promise.all(
    friends.map(async (friend) => {
      friend.avatarUrl = await mintAvatarUrl(
        env,
        friend.login,
        selfOrigin,
        friend.avatar,
      );
    }),
  );

  // Upsert online friends into D1
  const upsertStmts: D1PreparedStatement[] = [];
  for (const friend of friends) {
    if (!friend.isOnline) continue;
    const hash = hashByLogin.get(String(friend.login).toLowerCase());
    if (!hash) continue;
    upsertStmts.push(
      env.better_intra_d1
        .prepare(
          "INSERT OR REPLACE INTO online_cache (login_hash, seen_at) VALUES (?, ?)",
        )
        .bind(hash, await encryptBytes(env, String(Date.now()))),
    );
  }
  if (upsertStmts.length > 0) await env.better_intra_d1.batch(upsertStmts);

  return markCache(
    jsonRes({ friends }),
    profileFetched || locationFetched ? "miss" : "hit",
  );
}

async function fetchAllPages<T>(
  env: Env,
  url: string,
  token: string,
  op: string,
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await intraFetch(
      env,
      token,
      `${url}${sep}page[number]=${page}`,
      {},
      { op },
    );
    const hourly = res.headers.get("x-hourly-ratelimit-remaining") ?? "?";
    const secondly = res.headers.get("x-secondly-ratelimit-remaining") ?? "?";
    console.log(
      `[42 API] page=${page} status=${res.status} hourly=${hourly} secondly=${secondly}`,
    );
    if (!res.ok) break;
    const data = (await res.json()) as T[];
    if (data.length === 0) break;
    results.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  return results;
}
