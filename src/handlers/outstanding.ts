import { Env, UserData } from "../types";
import {
  getBearerToken,
  validateSession,
  jsonRes,
  textRes,
  getUserToken,
  hashLogin,
} from "../utils";

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
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) break;

    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const batch: D1PreparedStatement[] = [];
    for (const st of data) {
      if (stopAtScaleTeamId && st.id <= stopAtScaleTeamId) {
        if (batch.length > 0) await env.better_intra_d1.batch(batch);
        return;
      }
      if (st.team?.users?.[0]?.projects_user_id) {
        batch.push(
          env.better_intra_d1
            .prepare(
              "INSERT OR IGNORE INTO outstanding_projects (hash, scale_team_id, projects_user_id, updated_at) VALUES (?, ?, ?, unixepoch())",
            )
            .bind(hash, st.id, st.team.users[0].projects_user_id),
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

    const syncRow = await env.better_intra_d1
      .prepare(
        "SELECT completed_count FROM outstanding_sync_state WHERE hash = ?",
      )
      .bind(targetHash)
      .first<{ completed_count: number }>();

    const storedCount = syncRow?.completed_count;
    const countChanged =
      storedCount === undefined || String(storedCount) !== countParam;

    if (countChanged && userToken) {
      const latest = await env.better_intra_d1
        .prepare(
          "SELECT scale_team_id FROM outstanding_projects WHERE hash = ? ORDER BY scale_team_id DESC LIMIT 1",
        )
        .bind(targetHash)
        .first<{ scale_team_id: number }>();

      await syncFromApi(
        env,
        targetHash,
        userToken,
        targetLogin,
        latest?.scale_team_id ?? 0,
      );

      if (countParam) {
        await env.better_intra_d1
          .prepare(
            "INSERT OR REPLACE INTO outstanding_sync_state (hash, completed_count, updated_at) VALUES (?, ?, unixepoch())",
          )
          .bind(targetHash, Number(countParam))
          .run();
      }
    }

    return buildResponse(await queryD1(env, targetHash));
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
    const meRes = await fetch("https://api.intra.42.fr/v2/me", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (meRes.ok) {
      const meData = (await meRes.json()) as {
        id?: number;
        campus?: Array<{ id: number; name: string }>;
        pool_month?: string;
        pool_year?: string;
      };
      if (meData.id) {
        userId = meData.id;
        const campusJson = meData.campus
          ? JSON.stringify(
              meData.campus.map((c) => ({ id: c.id, name: c.name })),
            )
          : null;
        const poolLabel =
          meData.pool_month && meData.pool_year
            ? `${String(new Date(`${meData.pool_month} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${meData.pool_year}`
            : null;
        await env.better_intra_d1
          .prepare(
            "UPDATE users SET forty_two_user_id = ?, campus = COALESCE(users.campus, ?), pool = COALESCE(users.pool, ?) WHERE hash = ?",
          )
          .bind(userId, campusJson, poolLabel, loginParam)
          .run();
      }
    }
  }

  if (userId && userToken) {
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
  }

  return buildResponse(await queryD1(env, loginParam));
}
