import { Env, UserData } from "../types";
import {
  getBearerToken,
  hashLogin,
  jsonRes,
  resolveUserToken,
  textRes,
  tokenFailureResponse,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";
/** Same order of magnitude as `ME_CACHE_TTL`: profiles are cheap to re-read. */
const PROFILE_CACHE_TTL = 120;

const BANNER_MODES = new Set(["fill", "fit", "stretch", "center", "tile"]);

export function rankCursus(kind: string | undefined): number {
  if (kind === "main") return 0;
  if (kind === "piscine" || kind === "piscine_community") return 1;
  if (
    kind === "piscine_deprecated" ||
    kind === "professional_training" ||
    kind === "professional_training_deprecated"
  ) {
    return 2;
  }
  if (kind === "main_deprecated") return 3;
  return 4;
}

interface RawCursusUser {
  level?: number;
  grade?: string | null;
  cursus_id?: number;
  blackholed_at?: string | null;
  begin_at?: string | null;
  end_at?: string | null;
  cursus?: { id?: number; name?: string; slug?: string; kind?: string };
}

/** The cursus the profile should be shown for (main first, then the highest level). */
export function pickBestCursus(
  cursusUsers: RawCursusUser[],
): RawCursusUser | null {
  let best: RawCursusUser | null = null;
  for (const cu of cursusUsers) {
    if (!best) {
      best = cu;
      continue;
    }
    const rank = rankCursus(cu.cursus?.kind);
    const bestRank = rankCursus(best.cursus?.kind);
    if (rank < bestRank) best = cu;
    else if (rank === bestRank && (cu.level ?? 0) > (best.level ?? 0))
      best = cu;
  }
  return best;
}

interface RawProject {
  id?: number;
  occurrence?: number;
  status?: string;
  "validated?"?: boolean;
  final_mark?: number | null;
  marked_at?: string | null;
  cursus_ids?: number[];
  project?: { name?: string; slug?: string };
}

const projectEntry = (p: RawProject) => ({
  id: p.id ?? null,
  name: p.project?.name ?? "?",
  slug: p.project?.slug ?? null,
  occurrence: p.occurrence ?? 0,
});

/** Project summary scoped to the user's main cursus (mirrors `/me`). */
export function buildProjects(
  projectsUsers: unknown,
  mainCursusId: number | null,
) {
  const all: RawProject[] = Array.isArray(projectsUsers) ? projectsUsers : [];
  const scoped =
    mainCursusId != null
      ? all.filter((p) => (p.cursus_ids ?? []).includes(mainCursusId))
      : all;
  const finished = scoped.filter((p) => p.status === "finished");
  const inProgress = scoped.filter((p) => p.status === "in_progress");
  return {
    total: scoped.length,
    validated: finished.filter((p) => p["validated?"] === true).length,
    failed: finished.filter((p) => p["validated?"] === false).length,
    inProgress: inProgress.length,
    active: inProgress.map(projectEntry),
    recent: finished
      .filter((p) => p.marked_at)
      .sort((a, b) => String(b.marked_at).localeCompare(String(a.marked_at)))
      .map((p) => ({
        ...projectEntry(p),
        finalMark: p.final_mark ?? null,
        validated: p["validated?"] === true,
        markedAt: p.marked_at ?? null,
      })),
  };
}

export interface ProfileVisuals {
  profileColor: string | null;
  customAvatar: string | null;
  avatarBg: string;
  avatarShape: "round" | "square";
  avatarPosX: number;
  avatarPosY: number;
  avatarScale: number;
  banner: string | null;
  bannerMode: string;
  bannerColor: string | null;
  background: string | null;
  backgroundMode: string;
  backgroundColor: string | null;
}

const asUrl = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asColor = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw : null;
};

const asMode = (value: unknown): string =>
  typeof value === "string" && BANNER_MODES.has(value) ? value : "fill";

/** A 42 group with its own colour, shared with the PWA so badges match 42. */
export interface ProfileGroup {
  name: string;
  color: string | null;
}

export function pickGroups(groups: unknown): ProfileGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g: any) => ({
      name: typeof g?.name === "string" ? g.name.trim() : "",
      color: asColor(g?.color),
    }))
    .filter((g): g is ProfileGroup => Boolean(g.name));
}

const asNumber = (value: unknown, min: number, max: number, base: number) => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return base;
  return Math.min(max, Math.max(min, n));
};

/** Whitelisted subset of a user's settings: only the profile visuals. */
export function pickVisuals(
  settings: Record<string, unknown> = {},
): ProfileVisuals {
  const s = settings ?? {};
  return {
    profileColor: asColor(s.LOGTIME_CALENDAR_COLOR),
    customAvatar: asUrl(s.PROFILE_IMAGE_URL),
    avatarBg: asColor(s.PROFILE_AVATAR_BG) ?? "transparent",
    avatarShape: s.PROFILE_AVATAR_SHAPE === "square" ? "square" : "round",
    avatarPosX: asNumber(s.PROFILE_AVATAR_POSITION_X, 0, 100, 50),
    avatarPosY: asNumber(s.PROFILE_AVATAR_POSITION_Y, 0, 100, 50),
    avatarScale: asNumber(s.PROFILE_AVATAR_SCALE, 10, 400, 100),
    banner: asUrl(s.PROFILE_BANNER_URL),
    bannerMode: asMode(s.PROFILE_BANNER_MODE),
    bannerColor: asColor(s.PROFILE_BANNER_COLOR),
    background: asUrl(s.PROFILE_BACKGROUND_URL),
    backgroundMode: asMode(s.PROFILE_BACKGROUND_MODE),
    backgroundColor: asColor(s.PROFILE_BACKGROUND_COLOR),
  };
}

const LOGTIME_VIEWS = new Set(["normal", "compact", "heatmap", "carousel"]);
const LOGTIME_DAYS_MODES = new Set(["date", "days", "both"]);

const asBool = (value: unknown, base: boolean): boolean =>
  typeof value === "boolean" ? value : base;

const asEmoji = (value: unknown, base: string): string => {
  if (typeof value !== "string" || !value.trim()) return base;
  return Array.from(value.trim()).slice(0, 3).join("");
};

/**
 * Logtime preferences (same keys/defaults as the extension's `LOGTIME_*`
 * settings), so a profile's calendar renders the way its owner configured it.
 */
export function pickLogtimeConfig(settings: Record<string, unknown> = {}) {
  const s = settings ?? {};
  const view =
    typeof s.LOGTIME_CALENDAR_VIEW === "string" &&
    LOGTIME_VIEWS.has(s.LOGTIME_CALENDAR_VIEW)
      ? s.LOGTIME_CALENDAR_VIEW
      : "normal";
  const daysMode =
    typeof s.LOGTIME_SHOW_DAYS_MODE === "string" &&
    LOGTIME_DAYS_MODES.has(s.LOGTIME_SHOW_DAYS_MODE)
      ? s.LOGTIME_SHOW_DAYS_MODE
      : "date";
  return {
    goalHours: asNumber(s.LOGTIME_GOAL_HOURS, 0, 10_000, 140),
    showAverage: asBool(s.LOGTIME_SHOW_AVERAGE, true),
    showGoal: asBool(s.LOGTIME_SHOW_GOAL, true),
    showTacos: asBool(s.LOGTIME_SHOW_TACOS, false),
    showTotalTacos: asBool(s.LOGTIME_SHOW_TOTAL_TACOS, false),
    showStreak: asBool(s.LOGTIME_SHOW_STREAK, true),
    emoji: asEmoji(s.LOGTIME_EMOJI, "🌮"),
    divisor: asNumber(s.LOGTIME_EMOJI_DIVISOR, 0.01, 1_000_000, 8.7),
    rate: asNumber(s.LOGTIME_EMOJI_RATE, 0, 1_000_000, 2),
    maxEarnings: asNumber(s.LOGTIME_MAX_EARNINGS, 0, 1_000_000, 500),
    showDaysMode: daysMode,
    calendarColor: asColor(s.LOGTIME_CALENDAR_COLOR) ?? "#00BCBA",
    labelsColor: asColor(s.LOGTIME_LABELS_COLOR) ?? "#26a641",
    rainbowPalette:
      typeof s.LOGTIME_RAINBOW_PALETTE === "string" &&
      s.LOGTIME_RAINBOW_PALETTE.trim()
        ? s.LOGTIME_RAINBOW_PALETTE.trim().slice(0, 32)
        : "rainbow",
    calendarView: view,
    fontScale: asNumber(s.GENERAL_FONT_SCALE, 50, 200, 100),
    disableAnimations: asBool(s.DISABLE_ANIMATIONS, false),
  };
}

/** Maps a 42 `/v2/users/:login` payload + the target's settings to the PWA shape. */
export function buildProfilePayload(
  user: Record<string, unknown>,
  settings: Record<string, unknown> = {},
) {
  const u = user as {
    login?: string;
    displayname?: string;
    usual_full_name?: string;
    image?: { link?: string; versions?: { large?: string; small?: string } };
    kind?: string | null;
    "staff?"?: boolean;
    "alumni?"?: boolean;
    "active?"?: boolean;
    created_at?: string | null;
    alumnized_at?: string | null;
    wallet?: number;
    correction_point?: number;
    location?: string | null;
    campus?: { id?: number; name?: string }[];
    pool_month?: string | null;
    pool_year?: string | null;
    groups?: { name?: string; color?: string }[];
    projects_users?: unknown;
    cursus_users?: RawCursusUser[];
  };

  const login = u.login ?? "";
  const cursusUsers = Array.isArray(u.cursus_users) ? u.cursus_users : [];
  const best = pickBestCursus(cursusUsers);
  const mainCursusId = best?.cursus_id ?? best?.cursus?.id ?? null;
  const poolMonth = u.pool_month ?? null;
  const poolYear = u.pool_year ?? null;

  return {
    login,
    displayName: u.displayname ?? login,
    usualFullName: u.usual_full_name ?? u.displayname ?? login,
    avatar:
      u.image?.versions?.large ??
      u.image?.link ??
      u.image?.versions?.small ??
      null,
    kind: u.kind ?? null,
    staff: Boolean(u["staff?"]),
    alumni: Boolean(u["alumni?"]),
    active: u["active?"] ?? true,
    memberSince: u.created_at ?? null,
    alumnizedAt: u.alumnized_at ?? null,
    wallet: u.wallet ?? 0,
    correctionPoints: u.correction_point ?? 0,
    level: best?.level ?? 0,
    grade: best?.grade ?? null,
    location: u.location ?? null,
    campusId: u.campus?.[0]?.id ?? null,
    campusName: u.campus?.[0]?.name ?? null,
    poolMonth,
    poolYear,
    poolLabel:
      poolMonth && poolYear
        ? `${String(new Date(`${poolMonth} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${poolYear}`
        : null,
    groups: pickGroups(u.groups),
    cursus: best
      ? {
          name: best.cursus?.name ?? null,
          slug: best.cursus?.slug ?? null,
          kind: best.cursus?.kind ?? null,
          beginAt: best.begin_at ?? null,
          endAt: best.end_at ?? null,
        }
      : null,
    blackholedAt: best?.blackholed_at ?? null,
    projects: buildProjects(u.projects_users, mainCursusId),
    visuals: pickVisuals(settings),
    logtime: pickLogtimeConfig(settings),
  };
}

/** Full public profile of any 42 user, for the PWA profile view. */
export async function handleProfile(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
  target: string,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const login = target.trim().toLowerCase();
  if (!login) return textRes("Missing target parameter", 400);

  const cacheKey = `USER_PROFILE_CACHE_${login}`;
  const cached = await env.BETTER_INTRA_KV.get(cacheKey, { type: "json" });
  if (cached) return jsonRes(cached);

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  const tokenResult = await resolveUserToken(
    env,
    existingData,
    loginParam,
    country,
  );
  if ("failure" in tokenResult)
    return tokenFailureResponse(tokenResult.failure);

  const res = await intraFetch(
    env,
    tokenResult.token,
    `${API_BASE}/v2/users/${encodeURIComponent(login)}`,
  );
  if (res.status === 404) return textRes("User not found", 404);
  if (!res.ok) return textRes(`42 API error: ${res.status}`, 502);

  const user = (await res.json()) as Record<string, unknown>;

  // `/v2/users/:login` usually embeds cursus_users; fetch them when it doesn't.
  if (
    !Array.isArray(user.cursus_users) ||
    (user.cursus_users as unknown[]).length === 0
  ) {
    const cursusRes = await intraFetch(
      env,
      tokenResult.token,
      `${API_BASE}/v2/users/${encodeURIComponent(login)}/cursus_users?page[size]=100&page[number]=1`,
    );
    if (cursusRes.ok) {
      const cursusUsers = await cursusRes.json();
      if (Array.isArray(cursusUsers)) user.cursus_users = cursusUsers;
    }
  }

  const targetLogin = (user.login as string | undefined) ?? login;
  const targetData = await env.BETTER_INTRA_KV.get<UserData>(
    await hashLogin(targetLogin),
    { type: "json" },
  );

  const payload = buildProfilePayload(user, targetData?.settings ?? {});
  await env.BETTER_INTRA_KV.put(cacheKey, JSON.stringify(payload), {
    expirationTtl: PROFILE_CACHE_TTL,
  });
  return jsonRes(payload);
}
