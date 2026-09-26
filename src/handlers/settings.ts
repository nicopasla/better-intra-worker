import { Env, UserData } from "../types";
import {
  getBearerToken,
  getTokens,
  jsonRes,
  serializeUserData,
  textRes,
  validateSession,
} from "../utils";

const MAX_LOOK_STRING = 64;
const SETTINGS_HISTORY_LIMIT = 5;

interface SettingsHistoryEntry {
  revision: string | null;
  createdAt: number;
  settings: Record<string, unknown>;
}

export function appendHistory(
  entries: SettingsHistoryEntry[],
  entry: SettingsHistoryEntry,
  limit = SETTINGS_HISTORY_LIMIT,
): SettingsHistoryEntry[] {
  if (
    entries.length > 0 &&
    JSON.stringify(entries[0].settings) === JSON.stringify(entry.settings)
  ) {
    return entries;
  }
  return [entry, ...entries].slice(0, limit);
}

function unauthorizedResponse(
  request: Request,
  loginParam: string,
  existingData: UserData | null,
): Response | null {
  const authHeader = getBearerToken(request);
  if (
    !authHeader ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, authHeader)
  ) {
    return textRes("Unauthorized", 401);
  }
  return null;
}

export async function handleSettingsHistory(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const unauthorized = unauthorizedResponse(request, loginParam, existingData);
  if (unauthorized) return unauthorized;
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const entries = existingData!.settingsHistory || [];
  return jsonRes({
    entries: entries.map((entry, index) => ({
      index,
      revision: entry.revision,
      createdAt: entry.createdAt,
    })),
  });
}

export async function handleSettingsRestore(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const unauthorized = unauthorizedResponse(request, loginParam, existingData);
  if (unauthorized) return unauthorized;
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON body", 400);
  }

  const entries = existingData!.settingsHistory || [];
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    return textRes("Snapshot not found", 404);
  }

  const history = appendHistory(entries, {
    revision: existingData!.settingsRevision ?? null,
    createdAt: Date.now(),
    settings: existingData!.settings || {},
  });

  const settings = entries[index].settings;
  const revision = crypto.randomUUID();
  await env.BETTER_INTRA_KV.put(
    loginParam,
    serializeUserData({
      ...existingData!,
      settings,
      settingsHistory: history,
      settingsRevision: revision,
    }),
  );
  return jsonRes({ ok: true, revision, settings });
}

export function settingsWriteDecision(
  current: string | null | undefined,
  base: unknown,
  force: unknown,
): "conflict" | "write" {
  if (force === true) return "write";
  if (base === undefined) return "write";
  const currentRev = typeof current === "string" && current ? current : null;
  const baseRev = typeof base === "string" && base ? base : null;
  if (currentRev && baseRev !== currentRev) return "conflict";
  return "write";
}

export function publicLook(
  settings: Record<string, unknown>,
): { preset: string; theme: string } | null {
  const preset = settings.PROFILE_THEME_PRESET;
  if (
    typeof preset !== "string" ||
    preset.length === 0 ||
    preset.length > MAX_LOOK_STRING
  ) {
    return null;
  }
  const theme = settings.BETTER_INTRA_THEME;
  return {
    preset,
    theme:
      typeof theme === "string" && theme.length <= MAX_LOOK_STRING
        ? theme
        : "system",
  };
}

export async function handlePublicVisuals(
  request: Request,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const settings = existingData?.settings || {};

  return jsonRes({
    // Theme the user opted in to publish for visitors (or null)
    look: publicLook(settings),

    // Existing visual settings
    avatar: settings.PROFILE_IMAGE_URL || "",
    banner: settings.PROFILE_BANNER_URL || "",
    bannerMode: settings.PROFILE_BANNER_MODE || "fill",
    bannerColor: settings.PROFILE_BANNER_COLOR || "",
    background: settings.PROFILE_BACKGROUND_URL || "",
    backgroundMode: settings.PROFILE_BACKGROUND_MODE || "fill",
    backgroundColor: settings.PROFILE_BACKGROUND_COLOR || "",
    avatarBg: settings.PROFILE_AVATAR_BG || "transparent",
    decoration: settings.PROFILE_DECORATION || "none",
    avatarPosX: Number(settings.PROFILE_AVATAR_POSITION_X ?? 50),
    avatarPosY: Number(settings.PROFILE_AVATAR_POSITION_Y ?? 50),
    avatarScale: Number(settings.PROFILE_AVATAR_SCALE ?? 100),
    badgeBg: settings.PROFILE_BADGE_BG || "",

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
      rainbowPalette: settings.LOGTIME_RAINBOW_PALETTE,
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
      revision: existingData.settingsRevision ?? null,
      activeSessions: tokensList.length,
      discordId: existingData.discordId,
      discordUsername: existingData.discordUsername,
    });
  }

  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return textRes("Invalid JSON body", 400);
    }

    if (typeof body?.settings !== "object" || body.settings === null) {
      return textRes("Invalid settings payload", 400);
    }

    if (
      settingsWriteDecision(
        existingData.settingsRevision,
        body.baseRevision,
        body.force,
      ) === "conflict"
    ) {
      return jsonRes(
        {
          conflict: true,
          revision: existingData.settingsRevision ?? null,
          settings: existingData.settings || {},
        },
        409,
      );
    }

    const settingsToSave = {
      ...(existingData.settings || {}),
      ...body.settings,
    };
    const revision = crypto.randomUUID();
    const history =
      Object.keys(existingData.settings || {}).length > 0
        ? appendHistory(existingData.settingsHistory || [], {
            revision: existingData.settingsRevision ?? null,
            createdAt: Date.now(),
            settings: existingData.settings || {},
          })
        : existingData.settingsHistory || [];

    await env.BETTER_INTRA_KV.put(
      loginParam,
      serializeUserData({
        ...existingData,
        settings: settingsToSave,
        settingsHistory: history,
        settingsRevision: revision,
      }),
    );
    return jsonRes({ ok: true, revision });
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      await env.BETTER_INTRA_KV.delete(loginParam);
      return textRes("All cloud data deleted");
    }
    const sessionMeta = { ...(existingData.sessionMeta || {}) };
    delete sessionMeta[authHeader];
    await env.BETTER_INTRA_KV.put(
      loginParam,
      serializeUserData({
        ...existingData,
        sessionTokens: tokensList.filter((t) => t !== authHeader),
        sessionMeta,
      }),
    );
    return textRes("Session removed");
  }

  return textRes("Method not allowed", 405);
}
