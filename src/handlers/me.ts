import { Env, UserData } from "../types";
import {
  getBearerToken,
  getCursusMap,
  jsonRes,
  resolveUserToken,
  textRes,
  tokenFailureResponse,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";
const ME_CACHE_TTL = 60;

function rankCursus(kind: string | undefined): number {
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

export async function handleMe(
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

  const cacheKey = `ME_CACHE_${loginParam}`;
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
  const token = tokenResult.token;

  const meRes = await intraFetch(env, token, `${API_BASE}/v2/me`);
  if (!meRes.ok) return textRes(`42 API error: ${meRes.status}`, 502);
  const me = (await meRes.json()) as any;

  const login: string = me.login;
  const cursusRes = await intraFetch(
    env,
    token,
    `${API_BASE}/v2/users/${login}/cursus_users?page[size]=100&page[number]=1`,
  );
  let level = 0;
  let grade: string | null = null;
  let best: any = null;
  if (cursusRes.ok) {
    const cursusUsers = (await cursusRes.json()) as any[];
    const cursusMap = await getCursusMap(env);
    for (const cu of cursusUsers) {
      const r = rankCursus(cursusMap[cu.cursus_id]?.kind);
      if (
        !best ||
        r < rankCursus(cursusMap[best.cursus_id]?.kind) ||
        (r === rankCursus(cursusMap[best.cursus_id]?.kind) &&
          cu.level > best.level)
      ) {
        best = cu;
      }
    }
    if (best) {
      level = best.level ?? 0;
      grade = best.grade ?? null;
    }
  }

  // --- Projects (scoped to the current main cursus) ---
  const mainCursusId: number | null = best?.cursus_id ?? null;
  const allProjects: any[] = Array.isArray(me.projects_users)
    ? me.projects_users
    : [];
  const scoped =
    mainCursusId != null
      ? allProjects.filter((p) => (p.cursus_ids ?? []).includes(mainCursusId))
      : allProjects;
  const finished = scoped.filter((p) => p.status === "finished");
  const inProgress = scoped.filter((p) => p.status === "in_progress");
  const projectEntry = (p: any) => ({
    id: p.id ?? null,
    name: p.project?.name ?? "?",
    slug: p.project?.slug ?? null,
    occurrence: p.occurrence ?? 0,
  });
  const projects = {
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

  const achievements = (Array.isArray(me.achievements) ? me.achievements : [])
    .map((a: any) => ({
      name: a.name ?? "?",
      description: a.description ?? "",
      tier: a.tier ?? null,
      kind: a.kind ?? null,
      nbrOfSuccess: a.nbr_of_success ?? null,
      image: a.image
        ? `https://cdn.intra.42.fr${String(a.image).replace(/^\/uploads/, "")}`
        : null,
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  const s = existingData.settings || {};
  const body = {
    login,
    displayName: me.displayname ?? login,
    usualFullName: me.usual_full_name ?? me.displayname ?? login,
    image: me.image?.versions?.large ?? me.image?.link ?? null,
    kind: me.kind ?? null,
    staff: Boolean(me["staff?"]),
    alumni: Boolean(me["alumni?"]),
    active: me["active?"] ?? true,
    memberSince: me.created_at ?? null,
    wallet: me.wallet ?? 0,
    correctionPoints: me.correction_point ?? 0,
    level,
    grade,
    location: me.location ?? null,
    campusId: me.campus?.[0]?.id ?? null,
    campusName: me.campus?.[0]?.name ?? null,
    poolMonth: me.pool_month ?? null,
    poolYear: me.pool_year ?? null,
    poolLabel:
      me.pool_month && me.pool_year
        ? `${String(new Date(`${me.pool_month} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${me.pool_year}`
        : null,
    groups: (Array.isArray(me.groups) ? me.groups : []).map((g: any) => g.name),
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
    projects,
    achievements,
    achievementsCount: achievements.length,
    customAvatar: (s.PROFILE_IMAGE_URL as string) || null,
    avatarBg: (s.PROFILE_AVATAR_BG as string) || "transparent",
    avatarPosX: Number(s.PROFILE_AVATAR_POSITION_X ?? 50),
    avatarPosY: Number(s.PROFILE_AVATAR_POSITION_Y ?? 50),
    avatarScale: Number(s.PROFILE_AVATAR_SCALE ?? 100),
  };

  await env.BETTER_INTRA_KV.put(cacheKey, JSON.stringify(body), {
    expirationTtl: ME_CACHE_TTL,
  });
  return jsonRes(body);
}
