import { Env, UserData } from "../types";
import {
  getBearerToken,
  getSessionActivity,
  getTokens,
  jsonRes,
  MAX_SESSION_TOKENS,
  serializeUserData,
  sessionIdForToken,
  sessionLastUsed,
  textRes,
  validateSession,
  writeSessionActivity,
} from "../utils";

interface SessionView {
  id: string;
  label: string;
  name?: string;
  country?: string;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}

async function resolveId(
  token: string,
  existingData: UserData,
): Promise<string> {
  return (
    existingData.sessionMeta?.[token]?.id ?? (await sessionIdForToken(token))
  );
}

export async function handleSessions(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const bearer = getBearerToken(request);
  if (
    !bearer ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, bearer)
  ) {
    return textRes("Unauthorized", 401);
  }

  const tokens = getTokens(existingData);

  if (request.method === "GET") {
    const activity = await getSessionActivity(env, loginParam);
    const sessions: SessionView[] = [];
    for (const token of tokens) {
      const meta = existingData.sessionMeta?.[token];
      sessions.push({
        id: meta?.id ?? (await sessionIdForToken(token)),
        label: meta?.label ?? "Unknown device",
        name: meta?.name,
        country: meta?.country,
        createdAt: meta?.createdAt ?? 0,
        lastUsedAt: sessionLastUsed(activity, token, meta),
        current: token === bearer,
      });
    }
    sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return jsonRes({ sessions, max: MAX_SESSION_TOKENS });
  }

  if (request.method === "DELETE") {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return textRes("Missing session id", 400);

    let target: string | null = null;
    for (const token of tokens) {
      if ((await resolveId(token, existingData)) === id) {
        target = token;
        break;
      }
    }
    if (!target) return textRes("Session not found", 404);

    const sessionMeta = { ...(existingData.sessionMeta || {}) };
    delete sessionMeta[target];
    await env.BETTER_INTRA_KV.put(
      loginParam,
      serializeUserData({
        ...existingData,
        sessionTokens: tokens.filter((t) => t !== target),
        sessionMeta,
      }),
    );
    const activity = { ...(await getSessionActivity(env, loginParam)) };
    if (target in activity) {
      delete activity[target];
      await writeSessionActivity(env, loginParam, activity);
    }
    return jsonRes({ ok: true, current: target === bearer });
  }

  return textRes("Method not allowed", 405);
}
