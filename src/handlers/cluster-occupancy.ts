import { Env, UserData } from "../types";
import {
  decryptBytes,
  encryptBytes,
  getBearerToken,
  jsonRes,
  resolveUserToken,
  textRes,
  tokenFailureResponse,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";
const CDN_BASE = "https://cdn.intra.42.fr/users";
const CACHE_TTL_SECONDS = 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export interface OccupancyEntry {
  host: string;
  login: string;
  cdn_uri: string;
  begin_at: string;
  end_at: string | null;
}

interface RawLocation {
  host?: string | null;
  begin_at?: string | null;
  end_at?: string | null;
  user?: { login?: string | null } | null;
}

/**
 * Returns the currently active (physical) locations for a campus, normalized to
 * the shape the cluster map expects. Occupancy comes from the 42 API rather
 * than meta's `clusters.json`, so it needs the caller's stored 42 token.
 *
 * The per-campus response is cached encrypted in D1 (`cluster_occupancy_cache`)
 * so the 42 API is hit at most once per TTL across all users.
 */
export async function handleClusterOccupancy(
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

  const campus = new URL(request.url).searchParams.get("campus") ?? "";
  if (!/^\d+$/.test(campus)) {
    return textRes("Invalid campus parameter", 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const cached = await env.better_intra_d1
    .prepare(
      "SELECT response_body, cached_at FROM cluster_occupancy_cache WHERE campus = ?",
    )
    .bind(campus)
    .first<{ response_body: ArrayBuffer | string; cached_at: number }>();

  if (cached && now - cached.cached_at < CACHE_TTL_SECONDS) {
    const decoded = await decryptBytes(env, cached.response_body);
    if (decoded) return jsonRes(JSON.parse(decoded));
  }

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

  const entries: OccupancyEntry[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `${API_BASE}/v2/campus/${campus}/locations` +
        `?filter[active]=true&page[size]=${PAGE_SIZE}&page[number]=${page}`;
      const res = await intraFetch(env, token, url);
      if (!res.ok) return textRes(`42 API error: ${res.status}`, 502);
      const list = (await res.json()) as RawLocation[];
      if (!Array.isArray(list)) break;
      for (const loc of list) {
        const host = loc.host ?? "";
        const login = loc.user?.login ?? "";
        if (!host || !login) continue;
        entries.push({
          host,
          login,
          cdn_uri: `${CDN_BASE}/${login}.jpg`,
          begin_at: loc.begin_at ?? "",
          end_at: loc.end_at ?? null,
        });
      }
      if (list.length < PAGE_SIZE) break;
    }
  } catch {
    return textRes("Failed to fetch occupancy", 502);
  }

  const body = { campus, entries, updatedAt: Date.now() };
  await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO cluster_occupancy_cache (campus, response_body, cached_at) VALUES (?, ?, ?)",
    )
    .bind(campus, await encryptBytes(env, JSON.stringify(body)), now)
    .run();
  return jsonRes(body);
}
