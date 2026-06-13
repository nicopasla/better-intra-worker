import { Env } from "../types";
import { getBearerToken, hashLogin, jsonRes, textRes, validateSession } from "../utils";

export async function handleDiscordLink(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: any,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  let body: any;
  try { body = await request.json(); } catch { return textRes("Invalid JSON body", 400); }
  const discordId = String(body?.discordId || "").trim();
  if (!discordId) return textRes("Missing discordId", 400);

  existingData.discordId = discordId;
  await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));

  const hashes: string[] = (await env.EVAL_KV.get("DISCORD_HASHES", { type: "json" })) ?? [];
  if (!hashes.includes(loginParam)) {
    hashes.push(loginParam);
    await env.EVAL_KV.put("DISCORD_HASHES", JSON.stringify(hashes));
  }

  return jsonRes({ linked: true });
}

export async function handleDiscordUnlink(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: any,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  delete existingData.discordId;
  await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));

  const hashes: string[] = (await env.EVAL_KV.get("DISCORD_HASHES", { type: "json" })) ?? [];
  const idx = hashes.indexOf(loginParam);
  if (idx !== -1) {
    hashes.splice(idx, 1);
    await env.EVAL_KV.put("DISCORD_HASHES", JSON.stringify(hashes));
  }

  return jsonRes({ unlinked: true });
}

export async function handleDiscordTest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  let body: any;
  try { body = await request.json(); } catch { return textRes("Invalid JSON body", 400); }
  const rawLogin = String(body?.login || "").trim();
  if (!rawLogin) return textRes("Missing login", 400);

  const loginParam = await hashLogin(rawLogin);
  const existingData = await env.BETTER_INTRA_KV.get<any>(loginParam, { type: "json" });
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  if (!env.DISCORD_BOT_TOKEN) {
    return textRes("Discord bot not configured on the server. Contact admin.", 500);
  }

  const discordId: string | undefined = existingData.discordId;
  if (!discordId) {
    return textRes("No Discord linked. Set your Discord User ID first.", 400);
  }

  const embed: DiscordEmbed = {
    title: "Test Notification",
    color: 0x57F287,
    fields: [
      { name: "42 Login", value: rawLogin, inline: true },
      { name: "Status", value: "Discord notifications working!", inline: false },
    ],
  };

  const result = await sendDiscordDm(discordId, embed, env);
  if (!result.ok) {
    return textRes(`Discord API error (${result.status}): ${result.body}`, 502);
  }

  return jsonRes({ sent: true });
}

export async function sendDiscordDm(
  discordId: string,
  embed: DiscordEmbed,
  env: Env,
): Promise<{ ok: boolean; status?: number; body?: string }> {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, body: "DISCORD_BOT_TOKEN not set" };

  let channelRes: Response;
  try {
    channelRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordId }),
    });
  } catch {
    return { ok: false, body: "Network error creating DM channel" };
  }

  if (!channelRes.ok) {
    const err = await channelRes.text().catch(() => "Unknown");
    return { ok: false, status: channelRes.status, body: err };
  }

  let channel: any;
  try { channel = await channelRes.json(); } catch { return { ok: false, body: "Invalid channel response" }; }
  const channelId = channel.id;
  if (!channelId) return { ok: false, body: "No channel id in response" };

  let msgRes: Response;
  try {
    msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch {
    return { ok: false, body: "Network error sending message" };
  }

  if (!msgRes.ok) {
    const err = await msgRes.text().catch(() => "Unknown");
    return { ok: false, status: msgRes.status, body: err };
  }

  return { ok: true };
}

export interface DiscordEmbed {
  title: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}
