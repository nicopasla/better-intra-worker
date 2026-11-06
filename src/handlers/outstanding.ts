import { Env, UserData } from "../types";
import {
  getBearerToken,
  validateSession,
  jsonRes,
  textRes,
  getUserToken,
  hashLogin,
} from "../utils";
import { intraFetch } from "../rate";
import { markCache } from "../metrics";

const OUTSTANDING_RESYNC_SECONDS = 60;
/** Cached results are served for this long before another 42 API sync. */
const OUTSTANDING_CACHE_SECONDS = 5 * 60;

/** Row from `outstanding_sync_state`; `null` when the user was never synced. */
export interface OutstandingSyncState {
  completed_count: number | null;
  updated_at: number | null;
}

/**
 * Decides whether a request may spend a 42 API round trip.
 *
 * The 5-minute window is the cache: within it the stored flags are served as
 * is. A changed completed count means a project was just marked, so it may
 * resync earlier — but never sooner than {@link OUTSTANDING_RESYNC_SECONDS}, so
 * several tabs opening at once cannot fan out into a burst.
 */
export function shouldResync(
  state: OutstandingSyncState | null | undefined,
  countParam: string | null,
  nowSeconds: number,
  cacheSeconds = OUTSTANDING_CACHE_SECONDS,
  countSeconds = OUTSTANDING_RESYNC_SECONDS,
): boolean {
  const updatedAt = state?.updated_at;
  if (updatedAt == null) return true;

  const age = nowSeconds - updatedAt;
  if (age >= cacheSeconds) return true;

  if (countParam != null) {
    const stored = state?.completed_count;
    const countChanged = stored == null || String(stored) !== countParam;
    if (countChanged && age >= countSeconds) return true;
  }

  return false;
}

async function syncFromApi(
  env: Env,
  hash: string,
  userToken: string,
  userIdentifier: string,
  stopAtScaleTeamId: number,
): Promise<void> {
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const url = `https://api.intra.42.fr/v2/users/${userIdentifier}/scale_teams/as_corrected?filter[flag_id]=9&page[size]=100&page[number]=${page}&sort=-id`;
    const res = await intraFetch(env, userToken, url, {}, { op: "outstanding" });
    if (!res.ok) break;

    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const batch: D1PreparedStatement[] = [];
    const identifierLower = userIdentifier.toLowerCase();
    for (const st of data) {
      if (stopAtScaleTeamId && st.id <= stopAtScaleTeamId) {
        if (batch.length > 0) await env.better_intra_d1.batch(batch);
        return;
      }
      const targetUser = st.team?.users?.find(
        (u: { login?: string; projects_user_id?: number }) =>
          u.login?.toLowerCase() === identifierLower,
      );
      const puid =
        targetUser?.projects_user_id ??
        st.team?.users?.[0]?.projects_user_id;
      if (puid) {
        batch.push(
          env.better_intra_d1
            .prepare(
              "INSERT INTO outstanding_projects (hash, scale_team_id, projects_user_id, updated_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(hash, scale_team_id) DO UPDATE SET projects_user_id = excluded.projects_user_id, updated_at = excluded.updated_at",
            )
            .bind(hash, st.id, puid),
        );
      }
    }
    if (batch.length > 0) await env.better_intra_d1.batch(batch);

    if (data.length < 100) break;
    page++;
  }
}

async function queryD1(
  env: Env,
  hash: string,
): Promise<{ projects_user_id: number; count: number }[]> {
  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT projects_user_id, COUNT(*) as count FROM outstanding_projects WHERE hash = ? GROUP BY projects_user_id",
    )
    .bind(hash)
    .all<{ projects_user_id: number; count: number }>();
  return results || [];
}

function buildResponse(
  results: { projects_user_id: number; count: number }[],
): Response {
  const ids: Record<number, number> = {};
  for (const r of results) {
    ids[r.projects_user_id] = r.count;
  }
  return jsonRes({ ids });
}

export async function handleOutstanding(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const sessionToken = getBearerToken(request);
  if (!sessionToken) return textRes("Missing Authorization header", 401);
  if (!existingData) return textRes("User not found in KV", 401);
  if (!validateSession(existingData, sessionToken))
    return textRes("Invalid session token", 401);

  const url = new URL(request.url);
  const targetLogin = url.searchParams.get("target");
  const force = url.searchParams.has("force");
  const country: string | null =
    (request.cf?.country as string | undefined) || null;

  if (targetLogin) {
    const userToken = await getUserToken(
      env,
      existingData,
      loginParam,
      country,
    );
    const targetHash = await hashLogin(targetLogin);
    const countParam = url.searchParams.get("count");
    const now = Math.floor(Date.now() / 1000);

    const syncRow = await env.better_intra_d1
      .prepare(
        "SELECT completed_count, updated_at FROM outstanding_sync_state WHERE hash = ?",
      )
      .bind(targetHash)
      .first<OutstandingSyncState>();

    const wantedSync = force || shouldResync(syncRow, countParam, now);
    const shouldSync = Boolean(userToken) && wantedSync;
    if (shouldSync && userToken) {
      await env.better_intra_d1
        .prepare("DELETE FROM outstanding_projects WHERE hash = ?")
        .bind(targetHash)
        .run();

      await syncFromApi(env, targetHash, userToken, targetLogin, 0);

      if (countParam) {
        await env.better_intra_d1
          .prepare(
            "INSERT OR REPLACE INTO outstanding_sync_state (hash, completed_count, updated_at) VALUES (?, ?, unixepoch())",
          )
          .bind(targetHash, Number(countParam))
          .run();
      } else {
        // `completed_count` is NOT NULL DEFAULT 0; omitting it lets the default
        // apply and keeps the conflict update from clobbering a known count.
        await env.better_intra_d1
          .prepare(
            "INSERT INTO outstanding_sync_state (hash, updated_at) VALUES (?, unixepoch()) ON CONFLICT(hash) DO UPDATE SET updated_at = excluded.updated_at",
          )
          .bind(targetHash)
          .run();
      }
    }

    const rows = await queryD1(env, targetHash);
    return markCache(
      buildResponse(rows),
      shouldSync ? "miss" : wantedSync ? "stale" : "hit",
    );
  }

  let userId: number | undefined = existingData.fortyTwoUserId;
  if (!userId) {
    const userRow = await env.better_intra_d1
      .prepare("SELECT forty_two_user_id FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ forty_two_user_id: number | null }>();
    userId = userRow?.forty_two_user_id ?? undefined;
  }
  const userToken = await getUserToken(env, existingData, loginParam, country);

  if (userToken && !userId) {
    const meRes = await intraFetch(
      env,
      userToken,
      "https://api.intra.42.fr/v2/me",
      {},
      { op: "outstanding.me" },
    );
    if (meRes.ok) {
      const meData = (await meRes.json()) as { id?: number };
      if (meData.id) {
        userId = meData.id;
        await env.better_intra_d1
          .prepare("UPDATE users SET forty_two_user_id = ? WHERE hash = ?")
          .bind(userId, loginParam)
          .run();
      }
    }
  }

  let wantsSync = false;
  let synced = false;
  if (userId && userToken) {
    const now = Math.floor(Date.now() / 1000);
    const syncRow = await env.better_intra_d1
      .prepare(
        "SELECT completed_count, updated_at FROM outstanding_sync_state WHERE hash = ?",
      )
      .bind(loginParam)
      .first<OutstandingSyncState>();

    wantsSync = force || shouldResync(syncRow, null, now);
    synced = wantsSync;
    if (synced) {
      const latest = await env.better_intra_d1
        .prepare(
          "SELECT scale_team_id FROM outstanding_projects WHERE hash = ? ORDER BY scale_team_id DESC LIMIT 1",
        )
        .bind(loginParam)
        .first<{ scale_team_id: number }>();

      await syncFromApi(
        env,
        loginParam,
        userToken,
        String(userId),
        latest?.scale_team_id ?? 0,
      );

      // Only advance the timestamp: `completed_count` belongs to the target
      // branch and must not be cleared here. The column is NOT NULL DEFAULT 0,
      // so it is omitted rather than bound to null.
      try {
        await env.better_intra_d1
          .prepare(
            "INSERT INTO outstanding_sync_state (hash, updated_at) VALUES (?, unixepoch()) ON CONFLICT(hash) DO UPDATE SET updated_at = excluded.updated_at",
          )
          .bind(loginParam)
          .run();
      } catch (e) {
        console.warn(`[outstanding] sync state write failed: ${e}`);
      }
    }
  }

  return markCache(
    buildResponse(await queryD1(env, loginParam)),
    synced ? "miss" : wantsSync ? "stale" : "hit",
  );
}
