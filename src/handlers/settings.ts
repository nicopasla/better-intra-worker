import { Env, UserData } from "../types";
import { getBearerToken, getTokens, jsonRes, textRes, validateSession } from "../utils";

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
  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  if (!existingData) return textRes("User not found", 404);

  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const tokensList = getTokens(existingData);

  if (request.method === "GET") {
    return jsonRes({
      settings: existingData.settings || {},
      activeSessions: tokensList.length,
      discordId: existingData.discordId,
      discordUsername: existingData.discordUsername,
    });
  }

  if (request.method === "POST") {
    let body: any;
    try { body = await request.json(); }
    catch { return textRes("Invalid JSON body", 400); }

    if (typeof body?.settings !== "object" || body.settings === null) {
      return textRes("Invalid settings payload", 400);
    }

    const settingsToSave = {
      ...(existingData.settings || {}),
      ...body.settings,
    };

    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: tokensList,
        settings: settingsToSave,
        discordId: existingData.discordId,
        discordUsername: existingData.discordUsername,
        discordQuietEnabled: existingData.discordQuietEnabled,
        discordQuietStart: existingData.discordQuietStart,
        discordQuietEnd: existingData.discordQuietEnd,
        discordQuietTimezone: existingData.discordQuietTimezone,
        tokenBroken: existingData.tokenBroken,
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
        settings: existingData.settings || {},
        discordId: existingData.discordId,
        discordUsername: existingData.discordUsername,
        discordQuietEnabled: existingData.discordQuietEnabled,
        discordQuietStart: existingData.discordQuietStart,
        discordQuietEnd: existingData.discordQuietEnd,
        discordQuietTimezone: existingData.discordQuietTimezone,
        tokenBroken: existingData.tokenBroken,
      }),
    );
    return textRes("Session removed");
  }

  return textRes("Method not allowed", 405);
}
