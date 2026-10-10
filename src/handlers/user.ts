import { Env, UserData } from "../types";
import {
  getBearerToken,
  jsonRes,
  resolveUserToken,
  textRes,
  tokenFailureResponse,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";

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

/**
 * Minimal 42 user lookup for the PWA (eval dialog): name, avatar, level,
 * location and campus, from a single `/v2/users/:login` call.
 */
export async function handleUserLookup(
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

  interface CursusEntry {
    level?: number;
    grade?: string | null;
    cursus?: { kind?: string };
  }

  const user = (await res.json()) as {
    login?: string;
    displayname?: string;
    usual_full_name?: string;
    image?: { link?: string; versions?: { small?: string } };
    location?: string | null;
    cursus_users?: CursusEntry[];
  };

  let best: CursusEntry | null = null;
  for (const cu of user.cursus_users ?? []) {
    if (
      !best ||
      rankCursus(cu.cursus?.kind) < rankCursus(best.cursus?.kind) ||
      (rankCursus(cu.cursus?.kind) === rankCursus(best.cursus?.kind) &&
        (cu.level ?? 0) > (best.level ?? 0))
    ) {
      best = cu;
    }
  }

  return jsonRes({
    login: user.login ?? login,
    displayName:
      user.usual_full_name ?? user.displayname ?? user.login ?? login,
    avatar: user.image?.versions?.small ?? user.image?.link ?? null,
    level: best?.level ?? 0,
    grade: best?.grade ?? null,
    location: user.location ?? null,
  });
}
