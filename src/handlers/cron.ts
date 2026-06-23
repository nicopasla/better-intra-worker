import { Env, UserData } from "../types";
import { getUserToken } from "../utils";
import { sendDiscordDm, DiscordEmbed } from "./discord";

const DELAY_MS = 600;
const DEADLINE_MS = 25_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInQuietHours(userData: UserData): boolean {
  if (!userData?.discordQuietEnabled) return false;
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
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
  fortyTwoToken: string,
  page: number,
): Promise<{ data: any[]; rateLimited: boolean }> {
  const url = `https://api.intra.42.fr/v2/me/scale_teams/as_corrector?page[size]=100&page[number]=${page}`;

  let waitMs = 1500;

  for (let attempt = 0; attempt < 3; attempt++) {
    const apiRes = await fetch(url, {
      headers: { Authorization: `Bearer ${fortyTwoToken}` },
    });

    if (apiRes.status !== 429) {
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

    if (attempt < 2) {
      const retryAfter = apiRes.headers.get("Retry-After");
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : waitMs;
      await delay(delayMs);
      waitMs *= 2;
    }
  }

  return { data: [], rateLimited: true };
}

async function processItem(
  env: Env,
  ctx: ExecutionContext,
  item: any,
  hash: string,
  projectMap: Record<string, { name: string; slug: string }>,
  discordId: string | undefined,
) {
  const id = item.id;
  const beginAt: string = item.begin_at;
  const duration: number = item.scale?.duration ?? 0;
  const endAt = new Date(
    new Date(beginAt).getTime() + duration * 1000,
  ).toISOString();
  const team = item.team ?? null;
  const projectId = team?.project_id ?? null;
  const project = projectId ? (projectMap[String(projectId)] ?? null) : null;
  const projectName = project?.name ?? null;
  const projectSlug = project?.slug ?? null;
  const teamName = team?.name ?? null;

  const shortHash = hash.slice(0, 6);
  const isInvisible = (v: any) => typeof v === "string" && v === "invisible";

  if (isInvisible(item.correcteds) || Array.isArray(item.correcteds)) {
    const role = "evaluator";
    const correctedsVisible =
      Array.isArray(item.correcteds) && item.correcteds.length > 0;

    let row: { state: string } | null = null;
    try {
      row = await env.better_intra_d1
        .prepare(
          "SELECT state FROM eval_states WHERE hash = ? AND eval_id = ? AND role = ?",
        )
        .bind(hash, id, role)
        .first<{ state: string }>();
    } catch (e) {
      console.warn(
        `[cron] D1 SELECT eval_states failed ${shortHash} eval=${id}: ${e}`,
      );
      return;
    }

    const currentState = row?.state ?? null;

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
              "UPDATE eval_states SET state = 'revealed', updated_at = unixepoch() WHERE hash = ? AND eval_id = ? AND role = ?",
            )
            .bind(hash, id, role)
            .run();
        } else {
          await env.better_intra_d1
            .prepare(
              "INSERT OR REPLACE INTO eval_states (hash, eval_id, role, state, begin_at) VALUES (?, ?, ?, 'revealed', ?)",
            )
            .bind(hash, id, role, beginAt)
            .run();
        }
      } catch (e) {
        console.warn(
          `[cron] D1 WRITE eval_states failed ${shortHash} eval=${id}: ${e}`,
        );
        return;
      }

      const notif = {
        type: "revealed",
        role,
        id,
        projectName,
        beginAt,
        endAt,
        logins,
        teamName,
      };
      try {
        await env.better_intra_d1
          .prepare(
            "INSERT OR IGNORE INTO pending_notifs (hash, eval_id, role, data) VALUES (?, ?, ?, ?)",
          )
          .bind(hash, id, role, JSON.stringify(notif))
          .run();
      } catch (e) {
        console.warn(
          `[cron] D1 INSERT pending_notifs failed ${shortHash} eval=${id}: ${e}`,
        );
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
        ctx.waitUntil(sendDiscordDm(discordId, [embed], env));
        console.log(
          `[discord] ${shortHash} DM queued type=revealed eval=${id}`,
        );
      } else {
        console.log(
          `[discord] ${shortHash} DM skipped type=revealed eval=${id} reason=${env.DISCORD_ENABLED !== "true" ? "global_disabled" : "no_discord_id"}`,
        );
      }
    } else if (!correctedsVisible && currentState === null) {
      console.log(
        `[cron] ${shortHash} eval=${id} null→booked project=${projectName ?? "?"}`,
      );
      try {
        await env.better_intra_d1
          .prepare(
            "INSERT OR IGNORE INTO eval_states (hash, eval_id, role, state, begin_at) VALUES (?, ?, ?, 'booked', ?)",
          )
          .bind(hash, id, role, beginAt)
          .run();
      } catch (e) {
        console.warn(
          `[cron] D1 WRITE eval_states failed ${shortHash} eval=${id}: ${e}`,
        );
        return;
      }

      const notif = {
        type: "booked",
        role,
        id,
        projectName,
        beginAt,
        endAt,
        teamName,
      };
      try {
        await env.better_intra_d1
          .prepare(
            "INSERT OR IGNORE INTO pending_notifs (hash, eval_id, role, data) VALUES (?, ?, ?, ?)",
          )
          .bind(hash, id, role, JSON.stringify(notif))
          .run();
      } catch (e) {
        console.warn(
          `[cron] D1 INSERT pending_notifs failed ${shortHash} eval=${id}: ${e}`,
        );
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
        ctx.waitUntil(sendDiscordDm(discordId, [embed], env));
        console.log(`[discord] ${shortHash} DM queued type=booked eval=${id}`);
      } else {
        console.log(
          `[discord] ${shortHash} DM skipped type=booked eval=${id} reason=${env.DISCORD_ENABLED !== "true" ? "global_disabled" : "no_discord_id"}`,
        );
      }
    }
  }
}

export async function handleMainCron(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { results } = await env.better_intra_d1
    .prepare("SELECT hash FROM eval_users")
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

  for (const { hash } of results) {
    if (Date.now() - startTime > DEADLINE_MS) {
      const remaining = results.length;
      console.warn(
        `[cron] deadline reached, ${remaining} users left unprocessed`,
      );
      return;
    }

    const shortHash = hash.slice(0, 6);
    try {
      const userData = await env.BETTER_INTRA_KV.get<UserData>(hash, {
        type: "json",
      });
      if (!userData?.fortyTwoToken) {
        console.log(`[cron] ${shortHash} skip: no fortyTwoToken`);
        continue;
      }

      if (isInQuietHours(userData)) {
        console.log(`[cron] ${shortHash} skip: quiet hours`);
        continue;
      }

      const fortyTwoToken = await getUserToken(env, userData, hash);
      if (!fortyTwoToken) {
        console.log(`[cron] ${shortHash} skip: no getUserToken`);
        continue;
      }

      const discordId: string | undefined = userData.discordId;

      const { data: rawData, rateLimited } = await fetchScaleTeams(
        fortyTwoToken,
        1,
      );
      if (rateLimited) {
        console.warn(`[cron] 429 rate limited for ${shortHash}`);
        continue;
      }

      for (const item of rawData) {
        await processItem(env, ctx, item, hash, projectMap, discordId);
      }

      console.log(`[cron] ${shortHash} done — ${rawData.length} items checked`);

      try {
        await env.better_intra_d1
          .prepare(
            "UPDATE eval_users SET last_checked_at = unixepoch() WHERE hash = ?",
          )
          .bind(hash)
          .run();
      } catch (e) {
        console.warn(`[cron] D1 last_checked_at failed ${shortHash}: ${e}`);
      }

      await delay(DELAY_MS);
    } catch (e) {
      console.warn(`[cron] ${shortHash} error: ${e}`);
    }
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
       JOIN eval_users eu ON es.hash = eu.hash
       WHERE es.state = 'booked'
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

  for (const { hash } of results) {
    if (Date.now() - startTime > DEADLINE_MS) {
      console.warn(
        `[reveal-catchup] deadline reached, remaining users skipped`,
      );
      return;
    }

    const shortHash = hash.slice(0, 6);
    try {
      const userData = await env.BETTER_INTRA_KV.get<UserData>(hash, {
        type: "json",
      });
      if (!userData?.fortyTwoToken) {
        console.log(`[reveal-catchup] ${shortHash} skip: no fortyTwoToken`);
        continue;
      }

      if (isInQuietHours(userData)) {
        console.log(`[reveal-catchup] ${shortHash} skip: quiet hours`);
        continue;
      }

      const fortyTwoToken = await getUserToken(env, userData, hash);
      if (!fortyTwoToken) {
        console.log(`[reveal-catchup] ${shortHash} skip: no getUserToken`);
        continue;
      }

      const discordId: string | undefined = userData.discordId;

      const { data: rawData, rateLimited } = await fetchScaleTeams(
        fortyTwoToken,
        1,
      );
      if (rateLimited) {
        console.warn(`[reveal-catchup] 429 rate limited for ${shortHash}`);
        continue;
      }

      for (const item of rawData) {
        await processItem(env, ctx, item, hash, projectMap, discordId);
      }

      console.log(
        `[reveal-catchup] ${shortHash} done — ${rawData.length} items checked`,
      );

      if (results.length > 1) {
        await delay(DELAY_MS);
      }
    } catch (e) {
      console.warn(`[reveal-catchup] ${shortHash} error: ${e}`);
    }
  }
  console.log(`[reveal-catchup] done`);
}

function formatTime(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${unix}:t>`;
}
