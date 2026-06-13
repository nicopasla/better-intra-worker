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
    const pendingKey = `PENDING_${loginParam}`;
    const pending: any[] =
      (await env.EVAL_KV.get(pendingKey, { type: "json" })) ?? [];
    await env.EVAL_KV.delete(pendingKey);
    return jsonRes({ notifications: pending });
  }

  if (action === "register") {
    const hashes: string[] =
      (await env.EVAL_KV.get("EVAL_ENABLED_HASHES", { type: "json" })) ?? [];
    if (!hashes.includes(loginParam)) {
      hashes.push(loginParam);
      await env.EVAL_KV.put("EVAL_ENABLED_HASHES", JSON.stringify(hashes));
    }
    return jsonRes({ registered: true });
  }

  if (action === "unregister") {
    const hashes: string[] =
      (await env.EVAL_KV.get("EVAL_ENABLED_HASHES", { type: "json" })) ?? [];
    const idx = hashes.indexOf(loginParam);
    if (idx !== -1) {
      hashes.splice(idx, 1);
      await env.EVAL_KV.put("EVAL_ENABLED_HASHES", JSON.stringify(hashes));
    }
    return jsonRes({ unregistered: true });
  }

  if (action === "ping") {
    return jsonRes({ ok: true });
  }

  return textRes("Unknown action", 400);
}
