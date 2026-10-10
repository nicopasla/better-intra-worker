import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";

export async function handleEvaluations(
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
  const action = url.searchParams.get("action") || "";

  if (action === "register") {
    if (!existingData.discordId) {
      return jsonRes({ registered: false, reason: "discord_not_linked" });
    }

    const evalRow = await env.better_intra_d1
      .prepare("SELECT evals_enabled FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ evals_enabled: number }>();
    const alreadyEnabled = evalRow?.evals_enabled === 1;

    if (!alreadyEnabled && !existingData.discordTestedAt) {
      return jsonRes({ registered: false, reason: "discord_not_tested" });
    }

    const tokenRow = await env.better_intra_d1
      .prepare("SELECT forty_two_token FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ forty_two_token: string | null }>();
    if (!tokenRow?.forty_two_token) {
      return jsonRes({ registered: false, reason: "missing_42_token" });
    }
    await env.better_intra_d1
      .prepare(
        "INSERT INTO users (hash, evals_enabled) VALUES (?, 1) ON CONFLICT(hash) DO UPDATE SET evals_enabled = 1",
      )
      .bind(loginParam)
      .run();
    return jsonRes({ registered: true });
  }

  if (action === "unregister") {
    await env.better_intra_d1
      .prepare("UPDATE users SET evals_enabled = 0 WHERE hash = ?")
      .bind(loginParam)
      .run();
    return jsonRes({ unregistered: true });
  }

  if (action === "ping") {
    return jsonRes({ ok: true });
  }

  if (action === "upcoming") {
    const nowIso = new Date().toISOString();
    const { results } = await env.better_intra_d1
      .prepare(
        `SELECT es.eval_id AS id, es.begin_at AS begin_at, es.state, es.correcteds,
                p.name AS project, p.slug, 'evaluator' AS role, NULL AS corrector
         FROM eval_states es
         LEFT JOIN projects p ON es.project_id = p.id
         WHERE es.hash = ? AND es.begin_at >= ? AND es.state IN ('booked', 'revealed')
         UNION ALL
         SELECT ec.eval_id AS id, ec.begin_at AS begin_at, ec.state, NULL AS correcteds,
                p.name AS project, p.slug, 'corrected' AS role, ec.corrector AS corrector
         FROM eval_corrected ec
         LEFT JOIN projects p ON ec.project_id = p.id
         WHERE ec.hash = ? AND ec.begin_at >= ? AND ec.state IN ('booked', 'revealed')
         ORDER BY begin_at ASC`,
      )
      .bind(loginParam, nowIso, loginParam, nowIso)
      .all<{
        id: number;
        begin_at: string;
        state: string;
        correcteds: string | null;
        project: string | null;
        slug: string | null;
        role: string;
        corrector: string | null;
      }>();

    const trackedRow = await env.better_intra_d1
      .prepare("SELECT evals_enabled FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ evals_enabled: number }>();

    return jsonRes({
      items: (results || []).map((r) => ({
        id: r.id,
        beginAt: r.begin_at,
        state: r.state,
        project: r.project ?? null,
        slug: r.slug ?? null,
        role: r.role,
        correcteds: r.correcteds ? JSON.parse(r.correcteds) : [],
        corrector: r.corrector ?? null,
      })),
      tracked: trackedRow?.evals_enabled === 1,
    });
  }

  return textRes("Unknown action", 400);
}
