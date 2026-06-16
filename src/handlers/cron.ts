import { Env, UserData } from "../types";
import { getUserToken } from "../utils";
import { sendDiscordDm, DiscordEmbed } from "./discord";
import { PROJECT_MAP } from "../constants";

async function fetchScaleTeams(
  fortyTwoToken: string,
  page: number,
): Promise<{ data: any[]; rateLimited: boolean }> {
  const url = `https://api.intra.42.fr/v2/me/scale_teams/as_corrector?page[size]=100&page[number]=${page}`;
  const apiRes = await fetch(url, {
    headers: { Authorization: `Bearer ${fortyTwoToken}` },
  });

  if (apiRes.status === 429) return { data: [], rateLimited: true };
  if (!apiRes.ok) return { data: [], rateLimited: false };

  const data: any[] = await apiRes.json();
  return { data, rateLimited: false };
}

async function processItem(
  env: Env,
  ctx: ExecutionContext,
  item: any,
  hash: string,
  projectMap: Record<string, string>,
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
  const projectName = projectId
    ? (projectMap[String(projectId)] ?? null)
    : null;
  const teamName = team?.name ?? null;

  const isInvisible = (v: any) => typeof v === "string" && v === "invisible";

  if (isInvisible(item.correcteds) || Array.isArray(item.correcteds)) {
    const role = "evaluator";
    const correctedsVisible =
      Array.isArray(item.correcteds) && item.correcteds.length > 0;

    const row = await env.better_intra_d1
      .prepare(
        "SELECT state FROM eval_states WHERE hash = ? AND eval_id = ? AND role = ?",
      )
      .bind(hash, id, role)
      .first<{ state: string }>();

    const currentState = row?.state ?? null;

    if (correctedsVisible && currentState !== "revealed") {
      const logins = item.correcteds.map((c: any) => c.login).join(", ");

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
            "INSERT OR REPLACE INTO eval_states (hash, eval_id, role, state) VALUES (?, ?, ?, 'revealed')",
          )
          .bind(hash, id, role)
          .run();
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
      await env.better_intra_d1
        .prepare(
          "INSERT OR IGNORE INTO pending_notifs (hash, eval_id, role, data) VALUES (?, ?, ?, ?)",
        )
        .bind(hash, id, role, JSON.stringify(notif))
        .run();

      if (env.DISCORD_ENABLED === "true" && discordId) {
        const embed: DiscordEmbed = {
          title: "Evaluation in 15 min",
          color: 0x57f287,
          fields: [
            { name: "Project", value: projectName || "Unknown", inline: true },
            { name: "Time", value: formatTime(beginAt), inline: true },
            { name: "Role", value: "Evaluator", inline: true },
            { name: "Correcting", value: logins },
          ],
          timestamp: beginAt,
        };
        ctx.waitUntil(sendDiscordDm(discordId, [embed], env));
      }
    } else if (!correctedsVisible && currentState === null) {
      await env.better_intra_d1
        .prepare(
          "INSERT OR IGNORE INTO eval_states (hash, eval_id, role, state) VALUES (?, ?, ?, 'booked')",
        )
        .bind(hash, id, role)
        .run();

      const notif = {
        type: "booked",
        role,
        id,
        projectName,
        beginAt,
        endAt,
        teamName,
      };
      await env.better_intra_d1
        .prepare(
          "INSERT OR IGNORE INTO pending_notifs (hash, eval_id, role, data) VALUES (?, ?, ?, ?)",
        )
        .bind(hash, id, role, JSON.stringify(notif))
        .run();

      if (env.DISCORD_ENABLED === "true" && discordId) {
        const embed: DiscordEmbed = {
          title: "Evaluation Booked",
          color: 0x5865f2,
          fields: [
            { name: "Project", value: projectName || "Unknown", inline: true },
            { name: "Time", value: formatTime(beginAt), inline: true },
            { name: "Role", value: "Evaluator", inline: true },
          ],
          timestamp: beginAt,
        };
        ctx.waitUntil(sendDiscordDm(discordId, [embed], env));
      }
    }
  }
}

export async function handleCron(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { results } = await env.better_intra_d1
    .prepare("SELECT hash FROM eval_users")
    .all<{ hash: string }>();
  if (!results || results.length === 0) return;

  const projectMap: Record<string, string> =
    (await env.BETTER_INTRA_KV.get<Record<string, string>>(PROJECT_MAP, {
      type: "json",
    })) ?? {};

  for (const { hash } of results) {
    const userData = await env.BETTER_INTRA_KV.get<UserData>(hash, {
      type: "json",
    });
    if (!userData?.fortyTwoToken) continue;

    const fortyTwoToken = await getUserToken(env, userData, hash);
    if (!fortyTwoToken) continue;

    const discordId: string | undefined = userData.discordId;

    const { data: rawData, rateLimited } = await fetchScaleTeams(
      fortyTwoToken,
      1,
    );
    if (rateLimited) {
      console.warn(`[cron] 429 rate limited for ${hash}`);
      continue;
    }

    for (const item of rawData) {
      await processItem(env, ctx, item, hash, projectMap, discordId);
    }
  }
}

function formatTime(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${unix}:t>`;
}
