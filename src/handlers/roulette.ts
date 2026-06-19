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
  stopAtHistoricId: number,
): Promise<void> {
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    const url = `https://api.intra.42.fr/v2/users/${userId}/correction_point_historics?filter[reason]=${encodeURIComponent("Thursday Roulette")}&page[size]=100&page[number]=${page}&sort=-id`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) break;

    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const batch: D1PreparedStatement[] = [];
    for (const item of data) {
      if (stopAtHistoricId && item.id <= stopAtHistoricId) {
        if (batch.length > 0) await env.better_intra_d1.batch(batch);
        return;
      }
      batch.push(
        env.better_intra_d1
          .prepare(
            "INSERT OR IGNORE INTO correction_point_historics (hash, historic_id, sum, total, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(hash, item.id, item.sum, item.total, item.created_at),
      );
    }
    if (batch.length > 0) await env.better_intra_d1.batch(batch);

    if (data.length < 100) break;
    page++;
  }
}

async function queryD1(
  env: Env,
  hash: string,
): Promise<
  { historic_id: number; sum: number; total: number; created_at: string }[]
> {
  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT historic_id, sum, total, created_at FROM correction_point_historics WHERE hash = ? ORDER BY created_at ASC",
    )
    .bind(hash)
    .all<{
      historic_id: number;
      sum: number;
      total: number;
      created_at: string;
    }>();
  return results || [];
}

export async function handleRoulette(
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
        "SELECT historic_id FROM correction_point_historics WHERE hash = ? ORDER BY historic_id DESC LIMIT 1",
      )
      .bind(loginParam)
      .first<{ historic_id: number }>();

    await syncFromApi(
      env,
      loginParam,
      userToken,
      userId,
      latest?.historic_id ?? 0,
    );
  }

  const entries = await queryD1(env, loginParam);
  return jsonRes({ entries });
}
