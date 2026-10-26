import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";
import { normalizeIsoUtc } from "../time";

/** How far back the evaluations endpoint returns history for the PWA card. */
const HISTORY_DAYS = 30;

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

  if (action === "sync") {
    let body: { enabled?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      /* body required for sync */
    }
    const enabled = body?.enabled === true;

    const evalRow = await env.better_intra_d1
      .prepare("SELECT evals_enabled FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ evals_enabled: number }>();
    const currentlyTracked = evalRow?.evals_enabled === 1;

    if (enabled) {
      if (currentlyTracked) return jsonRes({ tracked: true });
      // A stored subscription is enough: the PWA rolls it back when the test
      // push fails, so existing subscribers (grandfathered) recover too.
      const hasSubscription = (existingData.pushSubscriptions?.length ?? 0) > 0;
      if (!existingData.pushTestedAt && !hasSubscription) {
        return jsonRes({ tracked: false, reason: "push_not_tested" });
      }
      await env.better_intra_d1
        .prepare(
          "INSERT INTO users (hash, evals_enabled) VALUES (?, 1) ON CONFLICT(hash) DO UPDATE SET evals_enabled = 1",
        )
        .bind(loginParam)
        .run();
      return jsonRes({ tracked: true });
    }

    // Disabling notifications on one device must not kill tracking while
    // another device still has a subscription. The push unsubscribe handler
    // clears tracking when the last subscription is removed.
    if ((existingData.pushSubscriptions?.length ?? 0) > 0) {
      return jsonRes({ tracked: currentlyTracked });
    }

    await env.better_intra_d1
      .prepare("UPDATE users SET evals_enabled = 0 WHERE hash = ?")
      .bind(loginParam)
      .run();
    return jsonRes({ tracked: false });
  }

  if (action === "status") {
    const row = await env.better_intra_d1
      .prepare("SELECT evals_enabled FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ evals_enabled: number }>();
    return jsonRes({
      tracked: row?.evals_enabled === 1,
      pushTestedAt: existingData.pushTestedAt ?? null,
      subscriptions: existingData.pushSubscriptions?.length ?? 0,
    });
  }

  if (action === "ping") {
    return jsonRes({ ok: true });
  }

  if (action === "upcoming") {
    // The PWA card keeps a history: past evals stay in D1, so a fresh device can
    // rebuild the "Past" section from the last HISTORY_DAYS.
    const sinceIso = new Date(
      Date.now() - HISTORY_DAYS * 86_400_000,
    ).toISOString();
    const { results } = await env.better_intra_d1
      .prepare(
        `SELECT es.eval_id AS id, es.begin_at AS begin_at, es.state, es.correcteds,
                p.name AS project, p.slug, 'evaluator' AS role, NULL AS corrector
         FROM eval_states es
         LEFT JOIN projects p ON es.project_id = p.id
         WHERE es.hash = ? AND datetime(es.begin_at) >= datetime(?) AND es.state IN ('booked', 'revealed')
         UNION ALL
         SELECT ec.eval_id AS id, ec.begin_at AS begin_at, ec.state, NULL AS correcteds,
                p.name AS project, p.slug, 'corrected' AS role, ec.corrector AS corrector
         FROM eval_corrected ec
         LEFT JOIN projects p ON ec.project_id = p.id
         WHERE ec.hash = ? AND datetime(ec.begin_at) >= datetime(?) AND ec.state IN ('booked', 'revealed')
         ORDER BY begin_at ASC
         LIMIT 300`,
      )
      .bind(loginParam, sinceIso, loginParam, sinceIso)
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
        beginAt: normalizeIsoUtc(r.begin_at),
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
