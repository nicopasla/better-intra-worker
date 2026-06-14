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

  if (action === "pending") {
    const { results } = await env.better_intra_d1.prepare(
      "SELECT data FROM pending_notifs WHERE hash = ? AND consumed = 0",
    )
      .bind(loginParam)
      .all<{ data: string }>();

    const notifications = (results || []).map((r) => JSON.parse(r.data));

    await env.better_intra_d1.prepare(
      "UPDATE pending_notifs SET consumed = 1 WHERE hash = ? AND consumed = 0",
    )
      .bind(loginParam)
      .run();

    return jsonRes({ notifications });
  }

  if (action === "register") {
    await env.better_intra_d1.prepare(
      "INSERT OR IGNORE INTO eval_users (hash) VALUES (?)",
    )
      .bind(loginParam)
      .run();
    return jsonRes({ registered: true });
  }

  if (action === "unregister") {
    await env.better_intra_d1.prepare("DELETE FROM eval_users WHERE hash = ?")
      .bind(loginParam)
      .run();
    return jsonRes({ unregistered: true });
  }

  if (action === "ping") {
    return jsonRes({ ok: true });
  }

  return textRes("Unknown action", 400);
}
