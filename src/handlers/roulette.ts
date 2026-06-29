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
  login: string,
  stopAtHistoricId: number,
): Promise<void> {
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    const url = `https://api.intra.42.fr/v2/users/${login}/correction_point_historics?filter[reason]=Thursday+Roulette&page[size]=100&page[number]=${page}&sort=-id`;
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
      "SELECT historic_id, sum, total, created_at FROM correction_point_historics WHERE hash = ? ORDER BY created_at DESC",
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

  const country: string | null = (request.cf?.country as string | undefined) || null;
  const userToken = await getUserToken(env, existingData, loginParam, country);
  if (!userToken) return textRes("No valid token", 401);

  const url = new URL(request.url);
  const targetLogin = url.searchParams.get("target");
  if (!targetLogin) return textRes("Missing target param", 400);

  const hash = await hashLogin(targetLogin);

  const entries = await queryD1(env, hash);
  if (entries.length === 0) {
    await syncFromApi(env, hash, userToken, targetLogin, 0);
    const fresh = await queryD1(env, hash);
    return jsonRes({ entries: fresh });
  }

  const latestId = Math.max(...entries.map((e) => e.historic_id));
  await syncFromApi(env, hash, userToken, targetLogin, latestId);
  const merged = await queryD1(env, hash);
  return jsonRes({ entries: merged });
}
