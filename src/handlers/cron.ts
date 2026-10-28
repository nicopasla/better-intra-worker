import { Env, UserData, PushSubscription } from "../types";
import { resolveUserToken } from "../utils";
import { intraFetch } from "../rate";
import { pushTransition } from "../push-send";
import {
  buildEvalPush,
  buildCorrectedPush,
  isValidTimeZone,
} from "../push-payloads";
import { normalizeIsoUtc } from "../time";

const CONCURRENCY = 2;
const DEADLINE_MS = 30_000;

/**
 * D1 is the source of truth for the Upcoming card, so notifications must use the
 * same instant. The live API value can drift (reschedules / timezone
 * representation) and must not leak into pushes.
 */
export function pickNotifyBeginAt(
  stored: string | null | undefined,
  api: string | null | undefined,
): string {
  return normalizeIsoUtc(stored || api);
}

async function fetchScaleTeams(
  env: Env,
  fortyTwoToken: string,
  page: number,
): Promise<{ data: any[]; rateLimited: boolean }> {
  const url = `https://api.intra.42.fr/v2/me/scale_teams?page[size]=100&page[number]=${page}`;

  const apiRes = await intraFetch(env, fortyTwoToken, url);

  if (apiRes.status === 429) {
    console.warn(`[cron] scale_teams page=${page} status=429 rate limited`);
    return { data: [], rateLimited: true };
  }
  if (!apiRes.ok) {
    console.warn(
      `[cron] scale_teams page=${page} status=${apiRes.status} error`,
    );
    return { data: [], rateLimited: false };
  }

  const data: any[] = await apiRes.json();
  console.log(
    `[cron] scale_teams page=${page} status=${apiRes.status} items=${data.length}`,
  );
  return { data, rateLimited: false };
}

/**
 * The current user's 42 login, cached in KV. Needed to tell a scale_team where
 * the user is the corrector from one where they are being corrected (the
 * payload alone is ambiguous once both sides are revealed). Fetched once.
 */
async function getLogin(
  env: Env,
  hash: string,
  fortyTwoToken: string,
): Promise<string | null> {
  const key = `LOGIN_${hash}`;
  const cached = await env.BETTER_INTRA_KV.get(key);
  if (cached) return cached;
  try {
    const res = await intraFetch(
      env,
      fortyTwoToken,
      "https://api.intra.42.fr/v2/me",
    );
    if (!res.ok) return null;
    const me = (await res.json()) as { login?: string };
    if (me?.login) {
      await env.BETTER_INTRA_KV.put(key, me.login);
      return me.login;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Campus timezone of the user, used when a subscription has none yet (device
 *  registered before timezones were stored). Cached per user. */
async function getCampusTimeZone(
  env: Env,
  hash: string,
  fortyTwoToken: string,
): Promise<string | null> {
  const key = `TZ_${hash}`;
  const cached = await env.BETTER_INTRA_KV.get(key);
  if (cached !== null) return isValidTimeZone(cached) ? cached : null;
  try {
    const res = await intraFetch(
      env,
      fortyTwoToken,
      "https://api.intra.42.fr/v2/me",
    );
    if (!res.ok) throw new Error(`/v2/me ${res.status}`);
    const me = (await res.json()) as {
      campus?: Array<{ time_zone?: string }>;
    };
    const timeZone = (me.campus || [])
      .map((campus) => campus.time_zone)
      .find(isValidTimeZone);
    if (!timeZone) throw new Error("no campus timezone");
    await env.BETTER_INTRA_KV.put(key, timeZone);
    return timeZone;
  } catch {
    // Back off for an hour so a challenged API doesn't add one request per run.
    try {
      await env.BETTER_INTRA_KV.put(key, "", { expirationTtl: 3600 });
    } catch {
      /* best effort */
    }
    return null;
  }
}

async function processEvaluatorItem(
  env: Env,
  ctx: ExecutionContext,
  item: any,
  hash: string,
  projectMap: Record<string, { name: string; slug: string }>,
  pushSubs: PushSubscription[],
  settings: Record<string, unknown> | undefined,
  fallbackTimeZone?: string | null,
) {
  const id = item.id;
  const beginAt = normalizeIsoUtc(item.begin_at);
  const team = item.team ?? null;
  const projectId = team?.project_id ?? null;
  const project = projectId ? (projectMap[String(projectId)] ?? null) : null;
  const projectName = project?.name ?? null;

  const shortHash = hash.slice(0, 6);
  const isInvisible = (v: any) => typeof v === "string" && v === "invisible";

  if (isInvisible(item.correcteds) || Array.isArray(item.correcteds)) {
    const role = "evaluator";
    const correctedsVisible =
      Array.isArray(item.correcteds) && item.correcteds.length > 0;

    let row: {
      state: string;
      correcteds: string | null;
      begin_at: string | null;
    } | null = null;
    try {
      row = await env.better_intra_d1
        .prepare(
          "SELECT state, correcteds, begin_at FROM eval_states WHERE hash = ? AND eval_id = ? AND role = ?",
        )
        .bind(hash, id, role)
        .first<{
          state: string;
          correcteds: string | null;
          begin_at: string | null;
        }>();
    } catch (e) {
      console.warn(
        `[cron] D1 SELECT eval_states failed ${shortHash} eval=${id}: ${e}`,
      );
      return;
    }

    const currentState = row?.state ?? null;
    // D1 is the source of truth for the Upcoming card, so notify with the same
    // instant. The live API value can drift (reschedules / timezone
    // representation) and must not leak into notifications.
    const notifyBeginAt = pickNotifyBeginAt(row?.begin_at, beginAt);
    if (row?.begin_at && row.begin_at !== beginAt) {
      console.log(
        `[cron] ${shortHash} eval=${id} begin_at mismatch d1=${row.begin_at} api=${beginAt} using=d1`,
      );
    }

    const correctedsLogins: string[] = correctedsVisible
      ? item.correcteds.map((c: any) => String(c.login))
      : [];
    const correctedsJson = JSON.stringify(correctedsLogins);

    if (correctedsVisible && currentState !== "revealed") {
      const transition =
        currentState === "booked" ? "booked→revealed" : "null→revealed";
      console.log(
        `[cron] ${shortHash} eval=${id} ${transition} project=${projectName ?? "?"}`,
      );

      try {
        if (currentState === "booked") {
          await env.better_intra_d1
            .prepare(
              "UPDATE eval_states SET state = 'revealed', project_id = ?, correcteds = ?, updated_at = unixepoch() WHERE hash = ? AND eval_id = ? AND role = ?",
            )
            .bind(projectId, correctedsJson, hash, id, role)
            .run();
        } else {
          await env.better_intra_d1
            .prepare(
              "INSERT OR REPLACE INTO eval_states (hash, eval_id, role, state, project_id, begin_at, correcteds) VALUES (?, ?, ?, 'revealed', ?, ?, ?)",
            )
            .bind(hash, id, role, projectId, beginAt, correctedsJson)
            .run();
        }
      } catch (e) {
        console.warn(
          `[cron] D1 WRITE eval_states failed ${shortHash} eval=${id}: ${e}`,
        );
        return;
      }

      if (settings?.EVAL_NOTIFY_EVALUATOR_REVEALED !== false) {
        ctx.waitUntil(
          pushTransition(
            env,
            hash,
            pushSubs,
            (timeZone) =>
              buildEvalPush({
                kind: "revealed",
                project: projectName,
                beginAt: notifyBeginAt,
                correcteds: correctedsLogins,
                timeZone,
              }),
            {
              url: "https://mobile.betterintra.com/",
              tag: `eval-${id}-revealed`,
            },
            fallbackTimeZone,
          ),
        );
      }
    } else if (
      correctedsVisible &&
      currentState === "revealed" &&
      !row?.correcteds
    ) {
      try {
        await env.better_intra_d1
          .prepare(
            "UPDATE eval_states SET correcteds = ? WHERE hash = ? AND eval_id = ? AND role = ?",
          )
          .bind(correctedsJson, hash, id, role)
          .run();
        console.log(
          `[cron] ${shortHash} eval=${id} backfilled correcteds=${correctedsLogins.join(",")}`,
        );
      } catch (e) {
        console.warn(
          `[cron] D1 backfill correcteds failed ${shortHash} eval=${id}: ${e}`,
        );
      }
    } else if (!correctedsVisible && currentState === null) {
      console.log(
        `[cron] ${shortHash} eval=${id} null→booked project=${projectName ?? "?"}`,
      );
      try {
        await env.better_intra_d1
          .prepare(
            "INSERT OR IGNORE INTO eval_states (hash, eval_id, role, state, project_id, begin_at) VALUES (?, ?, ?, 'booked', ?, ?)",
          )
          .bind(hash, id, role, projectId, beginAt)
          .run();
      } catch (e) {
        console.warn(
          `[cron] D1 WRITE eval_states failed ${shortHash} eval=${id}: ${e}`,
        );
        return;
      }

      if (settings?.EVAL_NOTIFY_EVALUATOR_BOOKED !== false) {
        ctx.waitUntil(
          pushTransition(
            env,
            hash,
            pushSubs,
            (timeZone) =>
              buildEvalPush({
                kind: "booked",
                project: projectName,
                beginAt: notifyBeginAt,
                timeZone,
              }),
            {
              url: "https://mobile.betterintra.com/",
              tag: `eval-${id}-booked`,
            },
            fallbackTimeZone,
          ),
        );
      }
    }
  }
}

/** Handles a scale_team where the user is being corrected (someone evaluates
 *  them). The project is known even while booked; the corrector only appears at
 *  reveal (15 min before), which is when we push. */
async function processCorrectedItem(
  env: Env,
  ctx: ExecutionContext,
  item: any,
  hash: string,
  projectMap: Record<string, { name: string; slug: string }>,
  pushSubs: PushSubscription[],
  settings: Record<string, unknown> | undefined,
  fallbackTimeZone?: string | null,
) {
  const id = item.id;
  const beginAt = normalizeIsoUtc(item.begin_at);
  const projectId = item.team?.project_id ?? null;
  const project = projectId ? (projectMap[String(projectId)] ?? null) : null;
  const projectName = project?.name ?? null;

  const correctorInvisible = typeof item.corrector === "string";
  const correctorLogin =
    !correctorInvisible && item.corrector?.login
      ? String(item.corrector.login)
      : null;
  const state = correctorInvisible ? "booked" : "revealed";
  const shortHash = hash.slice(0, 6);

  let row: { state: string; begin_at: string | null } | null = null;
  try {
    row = await env.better_intra_d1
      .prepare(
        "SELECT state, begin_at FROM eval_corrected WHERE hash = ? AND eval_id = ?",
      )
      .bind(hash, id)
      .first<{ state: string; begin_at: string | null }>();
  } catch (e) {
    console.warn(
      `[cron] D1 SELECT eval_corrected failed ${shortHash} eval=${id}: ${e}`,
    );
    return;
  }
  const currentState = row?.state ?? null;
  // Match the Upcoming card (D1) rather than a potentially drifted API value.
  const notifyBeginAt = pickNotifyBeginAt(row?.begin_at, beginAt);
  if (row?.begin_at && row.begin_at !== beginAt) {
    console.log(
      `[cron] ${shortHash} eval=${id} begin_at mismatch (corrected) d1=${row.begin_at} api=${beginAt} using=d1`,
    );
  }

  if (state === "revealed") {
    try {
      if (currentState === "booked") {
        await env.better_intra_d1
          .prepare(
            "UPDATE eval_corrected SET state = 'revealed', project_id = ?, corrector = ?, updated_at = unixepoch() WHERE hash = ? AND eval_id = ?",
          )
          .bind(projectId, correctorLogin, hash, id)
          .run();
      } else if (currentState === null) {
        await env.better_intra_d1
          .prepare(
            "INSERT OR REPLACE INTO eval_corrected (hash, eval_id, state, project_id, corrector, begin_at) VALUES (?, ?, 'revealed', ?, ?, ?)",
          )
          .bind(hash, id, projectId, correctorLogin, beginAt)
          .run();
      } else {
        await env.better_intra_d1
          .prepare(
            "UPDATE eval_corrected SET corrector = COALESCE(corrector, ?), project_id = COALESCE(project_id, ?) WHERE hash = ? AND eval_id = ?",
          )
          .bind(correctorLogin, projectId, hash, id)
          .run();
      }
    } catch (e) {
      console.warn(
        `[cron] D1 WRITE eval_corrected failed ${shortHash} eval=${id}: ${e}`,
      );
      return;
    }

    if (currentState !== "revealed" && correctorLogin) {
      console.log(
        `[cron] ${shortHash} eval=${id} ${currentState ?? "null"}→revealed (corrected) project=${projectName ?? "?"} corrector=${correctorLogin}`,
      );
      if (settings?.EVAL_NOTIFY_CORRECTED_REVEALED !== false) {
        ctx.waitUntil(
          pushTransition(
            env,
            hash,
            pushSubs,
            (timeZone) =>
              buildCorrectedPush({
                beginAt: notifyBeginAt,
                corrector: correctorLogin,
                timeZone,
              }),
            {
              url: "https://mobile.betterintra.com/",
              tag: `eval-corrected-${id}-revealed`,
            },
            fallbackTimeZone,
          ),
        );
      }
    }
  } else if (currentState === null) {
    try {
      await env.better_intra_d1
        .prepare(
          "INSERT OR IGNORE INTO eval_corrected (hash, eval_id, state, project_id, begin_at) VALUES (?, ?, 'booked', ?, ?)",
        )
        .bind(hash, id, projectId, beginAt)
        .run();
      console.log(
        `[cron] ${shortHash} eval=${id} null→booked (corrected) project=${projectName ?? "?"}`,
      );
    } catch (e) {
      console.warn(
        `[cron] D1 WRITE eval_corrected failed ${shortHash} eval=${id}: ${e}`,
      );
    }
  }
}

async function processCronUser(
  env: Env,
  ctx: ExecutionContext,
  hash: string,
  projectMap: Record<string, { name: string; slug: string }>,
  prefix: string,
): Promise<void> {
  const shortHash = hash.slice(0, 6);

  const userData = await env.BETTER_INTRA_KV.get<UserData>(hash, {
    type: "json",
  });
  if (!userData) {
    console.log(`[${prefix}] ${shortHash} skip: no userData`);
    return;
  }
  const tokenRow = await env.better_intra_d1
    .prepare("SELECT forty_two_token FROM users WHERE hash = ?")
    .bind(hash)
    .first<{ forty_two_token: string | null }>();
  if (!tokenRow?.forty_two_token) {
    if (userData?.fortyTwoToken) {
      await env.better_intra_d1
        .prepare(
          "INSERT INTO users (hash, forty_two_token) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET forty_two_token = ?",
        )
        .bind(hash, userData.fortyTwoToken, userData.fortyTwoToken)
        .run();
      console.log(
        `[${prefix}] ${shortHash} backfilled fortyTwoToken from KV to D1`,
      );
    } else {
      console.log(`[${prefix}] ${shortHash} skip: no fortyTwoToken`);
      return;
    }
  }

  // Use a cached token only. Token refreshes are spread across the every-minute
  // sweep so the eval cron never clusters refresh requests.
  const tokenResult = await resolveUserToken(env, userData, hash, null, {
    noRefresh: true,
  });
  if ("failure" in tokenResult) {
    console.log(
      `[${prefix}] ${shortHash} skip: ${tokenResult.failure.detail} (sweep will refresh)`,
    );
    return;
  }
  const fortyTwoToken = tokenResult.token;

  const pushSubs: PushSubscription[] =
    userData.settings?.PUSH_ENABLED !== false
      ? userData.pushSubscriptions || []
      : [];

  const { data: rawData, rateLimited } = await fetchScaleTeams(
    env,
    fortyTwoToken,
    1,
  );
  if (rateLimited) {
    console.warn(`[${prefix}] 429 rate limited for ${shortHash}`);
    return;
  }

  const me = await getLogin(env, hash, fortyTwoToken);
  const settings = userData.settings;
  // Only needed while some device has no stored timezone (pre-migration subs).
  const fallbackTimeZone =
    pushSubs.length > 0 && pushSubs.some((sub) => !sub.timeZone)
      ? await getCampusTimeZone(env, hash, fortyTwoToken)
      : null;

  for (const item of rawData) {
    const correcteds = item.correcteds;
    const corrector = item.corrector;
    const correctedsInvisible = typeof correcteds === "string";
    const correctorInvisible = typeof corrector === "string";

    if (correctedsInvisible) {
      await processEvaluatorItem(
        env,
        ctx,
        item,
        hash,
        projectMap,
        pushSubs,
        settings,
        fallbackTimeZone,
      );
    } else if (correctorInvisible) {
      await processCorrectedItem(
        env,
        ctx,
        item,
        hash,
        projectMap,
        pushSubs,
        settings,
        fallbackTimeZone,
      );
    } else if (me) {
      // Both sides revealed → resolve by whether the user is the corrector.
      if (corrector?.login === me) {
        await processEvaluatorItem(
          env,
          ctx,
          item,
          hash,
          projectMap,
          pushSubs,
          settings,
          fallbackTimeZone,
        );
      } else {
        await processCorrectedItem(
          env,
          ctx,
          item,
          hash,
          projectMap,
          pushSubs,
          settings,
          fallbackTimeZone,
        );
      }
    }
  }

  await env.better_intra_d1
    .prepare("UPDATE users SET last_checked = unixepoch() WHERE hash = ?")
    .bind(hash)
    .run();

  console.log(
    `[${prefix}] ${shortHash} done — ${rawData.length} items checked`,
  );
}

export async function handleMainCron(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { results } = await env.better_intra_d1
    .prepare("SELECT hash FROM users WHERE evals_enabled = 1")
    .all<{ hash: string }>();
  if (!results || results.length === 0) return;
  console.log(`[cron] main cron start — ${results.length} eval users`);

  const { results: projectResults } = await env.better_intra_d1
    .prepare("SELECT id, name, slug FROM projects")
    .all<{ id: number; name: string; slug: string }>();
  const projectMap: Record<string, { name: string; slug: string }> = {};

  for (const row of projectResults) {
    projectMap[String(row.id)] = { name: row.name, slug: row.slug };
  }

  const startTime = Date.now();

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    if (Date.now() - startTime > DEADLINE_MS) {
      const remaining = results.length - i;
      console.warn(
        `[cron] deadline reached, ${remaining} users left unprocessed`,
      );
      return;
    }
    const batch = results.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(({ hash }) =>
        processCronUser(env, ctx, hash, projectMap, "cron").catch((e) =>
          console.warn(`[cron] ${hash.slice(0, 6)} error: ${e}`),
        ),
      ),
    );
  }
  console.log(`[cron] main cron done`);
}

export async function handleRevealCatchup(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT DISTINCT es.hash FROM eval_states es
       JOIN users u ON es.hash = u.hash
       WHERE u.evals_enabled = 1
       AND es.state = 'booked'
       AND es.begin_at IS NOT NULL
       AND (unixepoch(es.begin_at) - 900) <= unixepoch()
       AND (unixepoch(es.begin_at) - 900) > unixepoch() - 120`,
    )
    .all<{ hash: string }>();
  if (!results || results.length === 0) return;
  console.log(
    `[reveal-catchup] start — ${results.length} hashes needing catchup`,
  );

  const { results: projectResults } = await env.better_intra_d1
    .prepare("SELECT id, name, slug FROM projects")
    .all<{ id: number; name: string; slug: string }>();
  const projectMap: Record<string, { name: string; slug: string }> = {};
  for (const row of projectResults) {
    projectMap[String(row.id)] = { name: row.name, slug: row.slug };
  }

  const startTime = Date.now();

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    if (Date.now() - startTime > DEADLINE_MS) {
      const remaining = results.length - i;
      console.warn(
        `[reveal-catchup] deadline reached, ${remaining} users left`,
      );
      return;
    }
    const batch = results.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(({ hash }) =>
        processCronUser(env, ctx, hash, projectMap, "reveal-catchup").catch(
          (e) =>
            console.warn(`[reveal-catchup] ${hash.slice(0, 6)} error: ${e}`),
        ),
      ),
    );
  }
  console.log(`[reveal-catchup] done`);
}

const SWEEP_CURSOR_KEY = "TOKEN_SWEEP_CURSOR";
const SWEEP_REFRESH_WITHIN_MS = 30 * 60 * 1000;

/**
 * Every-minute best-effort token refresh. Refreshes ONE eval-enabled user per
 * run (rotation) so token refreshes are spread out in time instead of clustering
 * in the 10-min eval cron — which Cloudflare challenges. Never marks tokens
 * broken (transient failures are just retried next minute).
 */
export async function handleTokenRefreshSweep(env: Env): Promise<void> {
  const { results } = await env.better_intra_d1
    .prepare("SELECT hash FROM users WHERE evals_enabled = 1 ORDER BY hash")
    .all<{ hash: string }>();
  if (!results || results.length === 0) return;

  const cursor = await env.BETTER_INTRA_KV.get(SWEEP_CURSOR_KEY);
  const prev = cursor ? results.findIndex((r) => r.hash === cursor) : -1;
  const next = results[(prev + 1) % results.length];

  const userData = await env.BETTER_INTRA_KV.get<UserData>(next.hash, {
    type: "json",
  });
  if (!userData) {
    await env.BETTER_INTRA_KV.put(SWEEP_CURSOR_KEY, next.hash);
    return;
  }

  try {
    const result = await resolveUserToken(env, userData, next.hash, null, {
      refreshWithinMs: SWEEP_REFRESH_WITHIN_MS,
    });
    if ("failure" in result && result.failure.reason === "transient") {
      // Challenged / unavailable — stay on this user and retry next minute.
      console.warn(
        `[token-sweep] ${next.hash.slice(0, 6)} transient (${result.failure.detail}) — retrying next minute`,
      );
      return;
    }
    console.log(
      `[token-sweep] ${next.hash.slice(0, 6)} ${"token" in result ? "fresh" : `reconnect:${result.failure.detail}`}`,
    );
    await env.BETTER_INTRA_KV.put(SWEEP_CURSOR_KEY, next.hash);
  } catch (e) {
    console.warn(`[token-sweep] ${next.hash.slice(0, 6)} error: ${e}`);
    return;
  }
}
