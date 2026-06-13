import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";
import { EVAL_REG_PREFIX, PENDING_PREFIX } from "../constants";

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
    const prefix = `${PENDING_PREFIX}${loginParam}_`;
    const list = await env.EVAL_KV.list({ prefix });

    const notifications: any[] = [];
    for (const key of list.keys) {
      const notif = await env.EVAL_KV.get<Record<string, unknown>>(key.name, { type: "json" });
      if (notif) notifications.push(notif);
      await env.EVAL_KV.delete(key.name);
    }

    // Also handle legacy array-format PENDING key (without suffix)
    const legacyKey = `${PENDING_PREFIX}${loginParam}`;
    const legacy: any[] =
      (await env.EVAL_KV.get<any[]>(legacyKey, { type: "json" })) ?? [];
    if (legacy.length > 0) {
      notifications.push(...legacy);
      await env.EVAL_KV.delete(legacyKey);
    }

    return jsonRes({ notifications });
  }

  if (action === "register") {
    await env.EVAL_KV.put(`${EVAL_REG_PREFIX}${loginParam}`, "1");
    return jsonRes({ registered: true });
  }

  if (action === "unregister") {
    await env.EVAL_KV.delete(`${EVAL_REG_PREFIX}${loginParam}`);
    return jsonRes({ unregistered: true });
  }

  if (action === "ping") {
    return jsonRes({ ok: true });
  }

  return textRes("Unknown action", 400);
}
