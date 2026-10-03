import { Env } from "../types";
import { getAppToken, jsonRes } from "../utils";

const CAMPUS_SYNC_TTL = 30 * 24 * 60 * 60; // seconds
const SYNC_KEY = "campus_list_synced_at";
const FAIL_KEY = "campus_list_sync_failed_at";
const FAIL_THROTTLE = 10 * 60; // seconds

interface CampusRow {
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
}

interface Campus {
  id?: number;
  name?: string;
  city?: string | null;
  country?: string | null;
  time_zone?: string | null;
}

export async function handleCampusLocation(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  if (request.method !== "GET") return jsonRes({}, 405);

  try {
    let row = await readCampus(env, id);
    if (hasCoords(row)) return respond(row);

    // Not cached → seed the whole campus list (at most once per TTL).
    const now = Math.floor(Date.now() / 1000);
    const lastSync = Number(await env.BETTER_INTRA_KV.get(SYNC_KEY)) || 0;
    const lastFail = Number(await env.BETTER_INTRA_KV.get(FAIL_KEY)) || 0;
    if (now - lastSync >= CAMPUS_SYNC_TTL && now - lastFail >= FAIL_THROTTLE) {
      try {
        const token = await getAppToken(env);
        await syncAllCampuses(env, token);
        await env.BETTER_INTRA_KV.put(SYNC_KEY, String(now));
        await env.BETTER_INTRA_KV.delete(FAIL_KEY);
      } catch {
        await env.BETTER_INTRA_KV.put(FAIL_KEY, String(now));
      }
    }

    row = await readCampus(env, id);
    if (hasCoords(row)) return respond(row);
    return jsonRes({}, 404);
  } catch (e) {
    return jsonRes({ error: String(e) }, 500);
  }
}

function respond(row: {
  latitude: number;
  longitude: number;
  timezone: string;
}): Response {
  return jsonRes({
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
  });
}

async function readCampus(env: Env, id: string): Promise<CampusRow | null> {
  try {
    return await env.better_intra_d1
      .prepare(
        "SELECT latitude, longitude, timezone FROM campus_locations WHERE id = ? AND not_found = 0",
      )
      .bind(id)
      .first<CampusRow>();
  } catch {
    return null;
  }
}

function hasCoords(
  row: CampusRow | null,
): row is { latitude: number; longitude: number; timezone: string } {
  return (
    !!row &&
    typeof row.latitude === "number" &&
    typeof row.longitude === "number" &&
    !!row.timezone
  );
}

/** Fetches every 42 campus and geocodes its city via Open-Meteo, then upserts into D1. */
async function syncAllCampuses(env: Env, token: string): Promise<void> {
  const campuses: Campus[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `https://api.intra.42.fr/v2/campus?page[size]=100&page[number]=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`campus list ${res.status}`);
    const list = (await res.json()) as Campus[];
    if (!Array.isArray(list) || list.length === 0) break;
    campuses.push(...list);
    if (list.length < 100) break;
  }

  const rows = await mapLimit(campuses, 8, async (c) => {
    if (typeof c.id !== "number") return null;
    const candidates = [c.city, c.name].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    let geo: Awaited<ReturnType<typeof geocodeCity>> = null;
    for (const query of candidates) {
      geo = await geocodeCity(query);
      if (geo) break;
    }
    if (!geo) return null;
    return {
      id: String(c.id),
      latitude: geo.latitude,
      longitude: geo.longitude,
      timezone: c.time_zone ?? geo.timezone ?? null,
    };
  });

  const stmt = env.better_intra_d1.prepare(
    "INSERT OR REPLACE INTO campus_locations (id, latitude, longitude, timezone, not_found, cached_at) VALUES (?, ?, ?, ?, 0, unixepoch())",
  );
  const batch = rows
    .filter(
      (
        r,
      ): r is {
        id: string;
        latitude: number;
        longitude: number;
        timezone: string | null;
      } => r !== null && !!r.timezone,
    )
    .map((r) => stmt.bind(r.id, r.latitude, r.longitude, r.timezone));
  if (batch.length) await env.better_intra_d1.batch(batch);
}

async function geocodeCity(query: string): Promise<{
  latitude: number;
  longitude: number;
  timezone?: string;
} | null> {
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        query,
      )}&count=1&language=en&format=json`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{
        latitude?: number;
        longitude?: number;
        timezone?: string;
      }>;
    };
    const first = data.results?.[0];
    if (
      !first ||
      typeof first.latitude !== "number" ||
      typeof first.longitude !== "number"
    ) {
      return null;
    }
    return {
      latitude: first.latitude,
      longitude: first.longitude,
      timezone: first.timezone,
    };
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}
