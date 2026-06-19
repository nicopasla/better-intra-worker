import { Env, UserData } from "../types";
import {
  getBearerToken,
  validateSession,
  jsonRes,
  textRes,
  getUserToken,
} from "../utils";

async function syncFromApi(
  env: Env,
  hash: string,
  userToken: string,
  userId: number,
  stopAtScaleTeamId: number,
): Promise<void> {
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const url = `https://api.intra.42.fr/v2/users/${userId}/scale_teams/as_corrected?filter[flag_id]=9&page[size]=100&page[number]=${page}&sort=-id`;
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

  let userId: number | undefined = existingData.fortyTwoUserId;
  const userToken = await getUserToken(env, existingData, loginParam);

  if (userToken && !userId) {
    const meRes = await fetch("https://api.intra.42.fr/v2/me", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (meRes.ok) {
      const meData = (await meRes.json()) as { id?: number };
      userId = meData.id;
      if (userId) {
        existingData.fortyTwoUserId = userId;
        await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));
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
      userId,
      latest?.scale_team_id ?? 0,
    );
  }

  return buildResponse(await queryD1(env, loginParam));
}
