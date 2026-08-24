import { Env } from "../types";
import { jsonRes, textRes } from "../utils";

async function countNew(env: Env, days: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const row = await env.better_intra_d1
    .prepare("SELECT COUNT(*) AS c FROM users WHERE created_at > ?")
    .bind(cutoff)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function handleStats(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const total = await env.better_intra_d1
    .prepare("SELECT COUNT(*) AS c FROM users")
    .first<{ c: number }>();

  const [newLast30Days, newLast14Days, newLast7Days] = await Promise.all([
    countNew(env, 30),
    countNew(env, 14),
    countNew(env, 7),
  ]);

  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT COALESCE(country, '?') AS country, COUNT(*) AS c FROM users GROUP BY country ORDER BY c DESC",
    )
    .all<{ country: string; c: number }>();

  return jsonRes({
    total: total?.c ?? 0,
    newLast30Days,
    newLast14Days,
    newLast7Days,
    countries: (results || []).map((r) => ({
      country: r.country,
      count: r.c,
    })),
  });
}
