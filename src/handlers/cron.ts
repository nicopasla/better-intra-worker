import { Env } from "../types";
import { getUserToken } from "../utils";
import { sendDiscordDm, DiscordEmbed } from "./discord";

const PROJECT_MAP_KEY = "PROJECT_MAP";

export async function handleCron(env: Env, ctx: ExecutionContext): Promise<void> {
  const all: Set<string> = new Set();

  const evalHashes: string[] = (await env.EVAL_KV.get("EVAL_ENABLED_HASHES", { type: "json" })) ?? [];
  for (const h of evalHashes) all.add(h);

  const discordHashes: string[] = (await env.EVAL_KV.get("DISCORD_HASHES", { type: "json" })) ?? [];
  for (const h of discordHashes) all.add(h);

  if (all.size === 0) return;

  const projectMap: Record<string, string> =
    (await env.BETTER_INTRA_KV.get<Record<string, string>>(PROJECT_MAP_KEY, { type: "json" })) ?? {};

  const pendingNotifications: Record<string, any[]> = {};

  for (const hash of all) {
    const userData = await env.BETTER_INTRA_KV.get<any>(hash, { type: "json" });
    if (!userData?.fortyTwoToken) continue;

    const fortyTwoToken = await getUserToken(env, userData, hash);
    if (!fortyTwoToken) continue;

    const apiRes = await fetch(
      "https://api.intra.42.fr/v2/me/scale_teams?page[size]=100",
      { headers: { Authorization: `Bearer ${fortyTwoToken}` } },
    );
    if (!apiRes.ok) continue;

    const rawData: any[] = await apiRes.json();
    const discordId: string | undefined = userData.discordId;

    for (const item of rawData) {
      const id = item.id;
      const beginAt: string = item.begin_at;
      const duration: number = item.scale?.duration ?? 0;
      const endAt = new Date(new Date(beginAt).getTime() + duration * 1000).toISOString();
      const team = item.team ?? null;
      const projectId = team?.project_id ?? null;
      const projectName = projectId ? (projectMap[String(projectId)] ?? null) : null;
      const teamName = team?.name ?? null;

      const isInvisible = (v: any) => typeof v === "string" && v === "invisible";

      if (isInvisible(item.correcteds) || Array.isArray(item.correcteds)) {
        const role = "evaluator";
        const evalKey = `EVAL_${hash}_${id}_${role}`;
        const currentState: string | null = await env.EVAL_KV.get(evalKey);
        const correctedsVisible = Array.isArray(item.correcteds) && item.correcteds.length > 0;

        if (correctedsVisible && currentState !== "revealed") {
          const logins = item.correcteds.map((c: any) => c.login).join(", ");
          const embed: DiscordEmbed = {
            title: "Evaluation in 15 min",
            color: 0x57F287,
            fields: [
              { name: "Project", value: projectName || "Unknown", inline: true },
              { name: "Time", value: formatTime(beginAt), inline: true },
              { name: "Role", value: "Evaluator", inline: true },
              { name: "Correcting", value: logins },
            ],
            timestamp: beginAt,
          };
          await env.EVAL_KV.put(evalKey, "revealed");

          const notif = { type: "revealed", role, id, projectName, beginAt, endAt, logins, teamName };
          (pendingNotifications[hash] ??= []).push(notif);

          if (discordId) {
            ctx.waitUntil(sendDiscordDm(discordId, embed, env));
          }
        } else if (!correctedsVisible && currentState === null) {
          const embed: DiscordEmbed = {
            title: "Evaluation Booked",
            color: 0x5865F2,
            fields: [
              { name: "Project", value: projectName || "Unknown", inline: true },
              { name: "Time", value: formatTime(beginAt), inline: true },
              { name: "Role", value: "Evaluator", inline: true },
            ],
            timestamp: beginAt,
          };
          await env.EVAL_KV.put(evalKey, "booked");

          const notif = { type: "booked", role, id, projectName, beginAt, endAt, teamName };
          (pendingNotifications[hash] ??= []).push(notif);

          if (discordId) {
            ctx.waitUntil(sendDiscordDm(discordId, embed, env));
          }
        }
      }

      if (isInvisible(item.corrector) || (item.corrector && typeof item.corrector === "object")) {
        const role = "evaluated";
        const evalKey = `EVAL_${hash}_${id}_${role}`;
        const currentState: string | null = await env.EVAL_KV.get(evalKey);
        const correctorVisible = item.corrector && typeof item.corrector === "object";

        if (correctorVisible && currentState !== "revealed") {
          const login = item.corrector?.login || "Unknown";
          const embed: DiscordEmbed = {
            title: "Evaluation in 15 min",
            color: 0x57F287,
            fields: [
              { name: "Project", value: projectName || "Unknown", inline: true },
              { name: "Time", value: formatTime(beginAt), inline: true },
              { name: "Role", value: "Being evaluated", inline: true },
              { name: "Evaluator", value: login },
            ],
            timestamp: beginAt,
          };
          await env.EVAL_KV.put(evalKey, "revealed");

          const notif = { type: "revealed", role, id, projectName, beginAt, endAt, login, teamName };
          (pendingNotifications[hash] ??= []).push(notif);

          if (discordId) {
            ctx.waitUntil(sendDiscordDm(discordId, embed, env));
          }
        } else if (!correctorVisible && currentState === null) {
          const embed: DiscordEmbed = {
            title: "Evaluation Booked",
            color: 0x5865F2,
            fields: [
              { name: "Project", value: projectName || "Unknown", inline: true },
              { name: "Time", value: formatTime(beginAt), inline: true },
              { name: "Role", value: "Being evaluated", inline: true },
            ],
            timestamp: beginAt,
          };
          await env.EVAL_KV.put(evalKey, "booked");

          const notif = { type: "booked", role, id, projectName, beginAt, endAt, teamName };
          (pendingNotifications[hash] ??= []).push(notif);

          if (discordId) {
            ctx.waitUntil(sendDiscordDm(discordId, embed, env));
          }
        }
      }
    }
  }

  for (const [hash, notifs] of Object.entries(pendingNotifications)) {
    if (notifs.length > 0) {
      const existing: any[] = (await env.EVAL_KV.get<any[]>(`PENDING_${hash}`, { type: "json" })) ?? [];
      existing.push(...notifs);
      await env.EVAL_KV.put(`PENDING_${hash}`, JSON.stringify(existing));
    }
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
