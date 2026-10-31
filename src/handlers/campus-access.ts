import { Env, UserData } from "../types";
import {
  getBearerToken,
  jsonRes,
  resolveUserToken,
  serializeUserData,
  textRes,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";

export const BELGIUM_CAMPUS_ID = 12;

export interface CampusRef {
  id: number | null;
  name: string | null;
}

interface RawCampus {
  id?: number;
  name?: string;
}

interface RawCampusUser {
  campus_id?: number;
  is_primary?: boolean;
  campus?: RawCampus;
}

interface RawMe {
  campus?: RawCampus[];
  campus_users?: RawCampusUser[];
}

/**
 * The user's primary campus, as returned by `/v2/me`. Only the primary campus
 * counts for access: being attached to Belgium as a secondary campus is not
 * enough.
 */
export function primaryCampusFromMe(raw: RawMe | null | undefined): CampusRef {
  const campuses = Array.isArray(raw?.campus) ? raw.campus : [];
  const campusUsers = Array.isArray(raw?.campus_users)
    ? raw.campus_users
    : [];
  const primary = campusUsers.find((cu) => cu?.is_primary === true);
  const id = primary?.campus_id ?? campuses[0]?.id ?? null;
  const name =
    campuses.find((c) => c.id === id)?.name ?? primary?.campus?.name ?? null;
  return {
    id: typeof id === "number" && Number.isFinite(id) ? id : null,
    name,
  };
}

async function readCampusFromD1(
  env: Env,
  hash: string,
): Promise<CampusRef | null> {
  try {
    const row = await env.better_intra_d1
      .prepare("SELECT campus_id, campus_name FROM users WHERE hash = ?")
      .bind(hash)
      .first<{ campus_id: number | null; campus_name: string | null }>();
    if (!row || row.campus_id == null) return null;
    return { id: row.campus_id, name: row.campus_name };
  } catch {
    return null;
  }
}

async function persistCampus(
  env: Env,
  hash: string,
  existingData: UserData | null,
  campus: CampusRef,
): Promise<void> {
  if (campus.id == null) return;

  if (existingData && existingData.campusId !== campus.id) {
    existingData.campusId = campus.id;
    if (campus.name) existingData.campusName = campus.name;
    try {
      await env.BETTER_INTRA_KV.put(hash, serializeUserData(existingData));
    } catch {
      /* best effort */
    }
  }

  try {
    await env.better_intra_d1
      .prepare(
        "UPDATE users SET campus_id = ?, campus_name = COALESCE(?, campus_name) WHERE hash = ?",
      )
      .bind(campus.id, campus.name, hash)
      .run();
  } catch {
    /* best effort */
  }
}

/**
 * Resolves the caller's primary campus: KV (written at login) → D1 → the
 * `/api/v1/me` cache → a live `/v2/me` call. The live call is the last resort
 * for accounts that logged in before campus tracking existed.
 */
async function resolveCallerCampus(
  env: Env,
  request: Request,
  hash: string,
  existingData: UserData | null,
): Promise<CampusRef | null> {
  if (typeof existingData?.campusId === "number") {
    return { id: existingData.campusId, name: existingData.campusName ?? null };
  }

  const fromD1 = await readCampusFromD1(env, hash);
  if (fromD1) {
    // Backfill KV so later requests skip the D1 read.
    if (existingData) {
      existingData.campusId = fromD1.id;
      if (fromD1.name) existingData.campusName = fromD1.name;
      try {
        await env.BETTER_INTRA_KV.put(hash, serializeUserData(existingData));
      } catch {
        /* best effort */
      }
    }
    return fromD1;
  }

  const meCache = await env.BETTER_INTRA_KV.get<{
    campusId?: number | null;
    campusName?: string | null;
  }>(`ME_CACHE_${hash}`, { type: "json" });
  if (typeof meCache?.campusId === "number") {
    const campus = { id: meCache.campusId, name: meCache.campusName ?? null };
    await persistCampus(env, hash, existingData, campus);
    return campus;
  }

  const country: string | null =
    (request.cf?.country as string | undefined) || null;
  try {
    const tokenResult = await resolveUserToken(
      env,
      existingData,
      hash,
      country,
    );
    if ("failure" in tokenResult) return null;
    const res = await intraFetch(env, tokenResult.token, `${API_BASE}/v2/me`);
    if (!res.ok) return null;
    const campus = primaryCampusFromMe((await res.json()) as RawMe);
    if (campus.id == null) return null;
    await persistCampus(env, hash, existingData, campus);
    return campus;
  } catch {
    return null;
  }
}

/**
 * Lightweight campus lookup for the PWA tab gating: reads the campus stored in
 * KV/D1 and only falls back to the 42 me endpoint when it is unknown.
 */
export async function handleMyCampus(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const bearer = getBearerToken(request);
  if (
    !bearer ||
    !loginParam ||
    !existingData ||
    !validateSession(existingData, bearer)
  ) {
    return textRes("Unauthorized", 401);
  }

  const campus = await resolveCallerCampus(
    env,
    request,
    loginParam,
    existingData,
  );
  return jsonRes({
    campusId: campus?.id ?? null,
    campusName: campus?.name ?? null,
    allowed: campus?.id === BELGIUM_CAMPUS_ID,
  });
}

/**
 * Returns a 403 response when the caller's primary campus is not Belgium, or
 * null when access is allowed. Campus lookups that fail also deny the request.
 */
export async function requireBelgiumCampus(
  request: Request,
  env: Env,
  hash: string,
  existingData: UserData | null,
): Promise<Response | null> {
  const campus = await resolveCallerCampus(env, request, hash, existingData);
  if (campus?.id === BELGIUM_CAMPUS_ID) return null;
  return jsonRes({ error: "campus_not_allowed" }, 403);
}
