import { Env, UserData, Evaluation } from "../types";
import { getTokens, jsonRes, textRes } from "../utils";
import { getAppToken } from "../utils";

export async function handlePublicVisuals(
  request: Request,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const settings = existingData?.settings || {};

  return jsonRes({
    // Existing visual settings
    avatar: settings.PROFILE_IMAGE_URL || "",
    banner: settings.PROFILE_BANNER_URL || "",
    bannerMode: settings.PROFILE_BANNER_MODE || "fill",
    background: settings.PROFILE_BACKGROUND_URL || "",
    backgroundMode: settings.PROFILE_BACKGROUND_MODE || "fill",

    // Theme settings (for profile card)
    theme: {
      profileColor: settings.LOGTIME_CALENDAR_COLOR,
    },

    // Public Logtime settings
    logtime: {
      calendarColor: settings.LOGTIME_CALENDAR_COLOR,
      labelsColor: settings.LOGTIME_LABELS_COLOR,
      emoji: settings.LOGTIME_EMOJI,
      emojiDivisor: settings.LOGTIME_EMOJI_DIVISOR,
      emojiRate: settings.LOGTIME_EMOJI_RATE,
    },
  });
}

export async function handlePrivateSettings(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const authHeader = request.headers
    .get("Authorization")
    ?.replace("Bearer ", "");
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  const data = existingData || { settings: {} };
  const tokensList = getTokens(data);

  if (existingData && !tokensList.includes(authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  if (request.method === "GET") {
    return jsonRes({
      settings: data.settings || {},
      activeSessions: tokensList.length,
    });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const settingsToSave = {
      ...(data.settings || {}),
      ...(body.settings || {}),
    };
    const updatedTokens = tokensList.length > 0 ? tokensList : [authHeader];

    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: updatedTokens,
        settings: settingsToSave,
      }),
    );
    return textRes("Saved");
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      await env.BETTER_INTRA_KV.delete(loginParam);
      return textRes("All cloud data deleted");
    }
    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: tokensList.filter((t) => t !== authHeader),
        settings: data.settings || {},
      }),
    );
    return textRes("Session removed");
  }

  return textRes("Method not allowed", 405);
}

export async function handlePrivateEvaluations(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = request.headers
    .get("Authorization")
    ?.replace("Bearer ", "");
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  const tokensList = getTokens(existingData);
  if (!existingData || !tokensList.includes(authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const url = new URL(request.url);
  const intraLogin = url.searchParams.get("intra_login");
  if (!intraLogin) return textRes("Missing intra_login", 400);

  const appToken = await getAppToken(env);

  const res = await fetch(
    `https://api.intra.42.fr/v2/users/${intraLogin}/scale_teams/as_corrector`,
    {
      headers: { Authorization: `Bearer ${appToken}` },
    },
  );

  if (!res.ok) return textRes("Failed to fetch from 42 API", 502);

  const scaleTeams = await res.json();

  const evaluations: Evaluation[] = scaleTeams.map(
    (e: any): Evaluation => ({
      id: e.id,
      begin_at: e.begin_at,
      project_name:
        e.team?.project_session?.project?.name ??
        e.scale?.name ??
        e.team?.project?.name ??
        "Unknown project",
      user: e.correcteds?.[0]?.login ?? "unknown",
      kind: "evaluator",
    }),
  );

  evaluations.sort(
    (a, b) => new Date(a.begin_at).getTime() - new Date(b.begin_at).getTime(),
  );

  return jsonRes({ evaluations });
}
