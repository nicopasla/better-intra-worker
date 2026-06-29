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

  return textRes("Unknown action", 400);
}
