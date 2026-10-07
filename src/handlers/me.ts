import { Env, UserData } from "../types";
import {
  getBearerToken,
  getCursusMap,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

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
  const token = await getUserToken(env, existingData, loginParam, country);
  if (!token) return textRes("Failed to get API token", 500);

  const meRes = await fetch(`${API_BASE}/v2/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) return textRes(`42 API error: ${meRes.status}`, 502);
  const me = (await meRes.json()) as any;

  const login: string = me.login;
  const cursusRes = await fetch(
    `${API_BASE}/v2/users/${login}/cursus_users?page[size]=100&page[number]=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  let level = 0;
  let grade: string | null = null;
  if (cursusRes.ok) {
    const cursusUsers = (await cursusRes.json()) as any[];
    const cursusMap = await getCursusMap(env);
    let best: any = null;
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

  const s = existingData.settings || {};
  const body = {
    login,
    displayName: me.displayname ?? login,
    image: me.image?.versions?.large ?? me.image?.link ?? null,
    wallet: me.wallet ?? 0,
    correctionPoints: me.correction_point ?? 0,
    level,
    grade,
    campusId: me.campus?.[0]?.id ?? null,
    campusName: me.campus?.[0]?.name ?? null,
    poolLabel:
      me.pool_month && me.pool_year
        ? `${String(new Date(`${me.pool_month} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${me.pool_year}`
        : null,
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