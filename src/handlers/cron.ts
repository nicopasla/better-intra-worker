import { Env, UserData, PushSubscription } from "../types";
import { serializeUserData, resolveUserToken } from "../utils";
import { intraFetch } from "../rate";
import { sendDiscordDm, DiscordEmbed } from "./discord";
import { sendWebPush, PushPayload } from "./push";

const CONCURRENCY = 2;
const DEADLINE_MS = 30_000;

function isInQuietHours(userData: UserData): boolean {
  if (!userData?.discordQuietEnabled) return false;
  const now = new Date();
  const offset = userData.discordQuietTimezone ?? 0;
  const currentMinutes =
    (now.getUTCHours() * 60 + now.getUTCMinutes() - offset + 1440) % 1440;
  const [startH, startM] = (userData.discordQuietStart || "22:00")
    .split(":")
    .map(Number);
  const [endH, endM] = (userData.discordQuietEnd || "08:00")
    .split(":")
    .map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;

  if (start < end) {
    return currentMinutes >= start && currentMinutes < end;
  }
  return currentMinutes >= start || currentMinutes < end;
}

async function fetchScaleTeams(
  env: Env,
  fortyTwoToken: string,
  page: number,
): Promise<{ data: any[]; rateLimited: boolean }> {
  const url = `https://api.intra.42.fr/v2/me/scale_teams/as_corrector?page[size]=100&page[number]=${page}`;

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

async function pushTransition(
  env: Env,
  hash: string,
  subs: PushSubscription[],
  payload: PushPayload,
): Promise<void> {
  if (!subs || subs.length === 0) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  const results = await Promise.allSettled(
    subs.map(async (sub) => ({
      endpoint: sub.endpoint,
      status: (await sendWebPush(env, sub, payload)).status,
    })),
  );

  const stale = new Set<string>();
  for (const r of results) {
    if (
      r.status === "fulfilled" &&
      (r.value.status === 404 || r.value.status === 410)
    ) {
      stale.add(r.value.endpoint);
    }
  }
  if (stale.size === 0) return;

  const remaining = subs.filter((s) => !stale.has(s.endpoint));
  const fresh = await env.BETTER_INTRA_KV.get<UserData>(hash, { type: "json" });
  if (fresh) {
    await env.BETTER_INTRA_KV.put(
      hash,
      serializeUserData({ ...fresh, pushSubscriptions: remaining }),
    );
    console.log(`[push] ${hash.slice(0, 6)} pruned ${stale.size} stale sub(s)`);
  }
}

function formatPushTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    });
  } catch {
    return "";
  }
}

async function processItem(
  env: Env,
  ctx: ExecutionContext,
  item: any,
  hash: string,
  projectMap: Record<string, { name: string; slug: string }>,
  discordId: string | undefined,
  pushSubs: PushSubscription[],
) {
  const id = item.id;
  const beginAt: string = item.begin_at;
  const team = item.team ?? null;
  const projectId = team?.project_id ?? null;
  const project = projectId ? (projectMap[String(projectId)] ?? null) : null;
  const projectName = project?.name ?? null;
  const projectSlug = project?.slug ?? null;

  const shortHash = hash.slice(0, 6);
  const isInvisible = (v: any) => typeof v === "string" && v === "invisible";

  if (isInvisible(item.correcteds) || Array.isArray(item.correcteds)) {
    const role = "evaluator";
    const correctedsVisible =
      Array.isArray(item.correcteds) && item.correcteds.length > 0;

    let row: { state: string; correcteds: string | null } | null = null;
    try {
      row = await env.better_intra_d1
        .prepare(
          "SELECT state, correcteds FROM eval_states WHERE hash = ? AND eval_id = ? AND role = ?",
        )
        .bind(hash, id, role)
        .first<{ state: string; correcteds: string | null }>();
    } catch (e) {
      console.warn(
        `[cron] D1 SELECT eval_states failed ${shortHash} eval=${id}: ${e}`,
      );
      return;
    }

    const currentState = row?.state ?? null;

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
      const logins = item.correcteds
        .map(
          (c: any) =>
            `[${c.login}](https://profile-v3.intra.42.fr/users/${c.login})`,
        )
        .join(", ");

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

      if (env.DISCORD_ENABLED === "true" && discordId) {
        const embed: DiscordEmbed = {
          title: "Evaluation in 15 min",
          color: 0x57f287,
          fields: [
            {
              name: "Project",
              value: projectName
                ? `[${projectName}](https://projects.intra.42.fr/projects/${projectSlug})`
                : "Unknown",
              inline: true,
            },
            { name: "Time", value: formatTime(beginAt), inline: true },
            { name: "Correcting", value: logins },
          ],
          timestamp: beginAt,
        };
        env.better_intra_d1
          .prepare(
            "UPDATE eval_states SET notified_at = unixepoch() WHERE hash = ? AND eval_id = ? AND role = ?",
          )
          .bind(hash, id, role)
          .run()
          .catch(() => {});
        ctx.waitUntil(sendDiscordDm(discordId, [embed], env));
        console.log(
          `[discord] ${shortHash} DM queued type=revealed eval=${id}`,
        );
      } else {
        console.log(
          `[discord] ${shortHash} DM skipped type=revealed eval=${id} reason=${env.DISCORD_ENABLED !== "true" ? "global_disabled" : "no_discord_id"}`,
        );
      }

      const revealedBody = `Correcting ${correctedsLogins.join(", ")} · ${projectName ?? "Evaluation"} · ${formatPushTime(beginAt)}`;
      ctx.waitUntil(
        pushTransition(env, hash, pushSubs, {
          title: "Evaluation in 15 min",
          body: revealedBody,
          url: "https://mobile.betterintra.com/",
          tag: `eval-${id}-revealed`,
        }),
      );
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

      if (env.DISCORD_ENABLED === "true" && discordId) {
        const embed: DiscordEmbed = {
          title: "Evaluation Booked",
          color: 0x5865f2,
          fields: [
            {
              name: "Project",
              value: projectName
                ? `[${projectName}](https://projects.intra.42.fr/projects/${projectSlug})`
                : "Unknown",
              inline: true,
            },
            { name: "Time", value: formatTime(beginAt), inline: true },
          ],
          timestamp: beginAt,
        };
        env.better_intra_d1
          .prepare(
            "UPDATE eval_states SET notified_at = unixepoch() WHERE hash = ? AND eval_id = ? AND role = ?",
          )
          .bind(hash, id, role)
          .run()
          .catch(() => {});
        ctx.waitUntil(sendDiscordDm(discordId, [embed], env));
        console.log(`[discord] ${shortHash} DM queued type=booked eval=${id}`);
      } else {
        console.log(
          `[discord] ${shortHash} DM skipped type=booked eval=${id} reason=${env.DISCORD_ENABLED !== "true" ? "global_disabled" : "no_discord_id"}`,
        );
      }

      const bookedBody = `${projectName ?? "Evaluation"} · ${formatPushTime(beginAt)}`;
      ctx.waitUntil(
        pushTransition(env, hash, pushSubs, {
          title: "Evaluation Booked",
          body: bookedBody,
          url: "https://mobile.betterintra.com/",
          tag: `eval-${id}-booked`,
        }),
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

  if (isInQuietHours(userData)) {
    console.log(`[${prefix}] ${shortHash} skip: quiet hours`);
    return;
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

  const discordId: string | undefined =
    userData.settings?.DISCORD_ENABLED !== false
      ? userData.discordId
      : undefined;
  if (userData.settings?.DISCORD_ENABLED === false && userData.discordId) {
    console.log(`[${prefix}] ${shortHash} discord disabled in settings`);
  }

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

  for (const item of rawData) {
    await processItem(env, ctx, item, hash, projectMap, discordId, pushSubs);
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

function formatTime(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${unix}:t>`;
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
