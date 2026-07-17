import { Env, UserData } from "../types";
import {
  getBearerToken,
  jsonRes,
  textRes,
  validateSession,
  getUserToken,
} from "../utils";

interface LocationEntry {
  id: number;
  begin_at: string;
  end_at: string;
}

const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RETRIES = 2;

async function fetchLocationsPage(
  token: string,
  targetLogin: string,
  page: number,
  pageSize: number,
  rangeStart: string,
  rangeEnd: string,
): Promise<LocationEntry[]> {
  const qs =
    `?range%5Bbegin_at%5D=${encodeURIComponent(rangeStart)},${encodeURIComponent(rangeEnd)}` +
    `&sort=begin_at` +
    `&page%5Bsize%5D=${pageSize}&page%5Bnumber%5D=${page}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://api.intra.42.fr/v2/users/${targetLogin}/locations${qs}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (res.ok) {
      const data = (await res.json()) as LocationEntry[];
      if (Array.isArray(data)) return data;
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
  }

  return [];
}

export async function handleLogtimeHistory(
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

  const url = new URL(request.url);
  const targetLogin = url.searchParams.get("user");
  if (!targetLogin) return textRes("Missing user parameter", 400);

  const before = url.searchParams.get("before");

  try {
    const row = await env.better_intra_d1
      .prepare(
        "SELECT days_json, updated_at FROM logtime_history WHERE login = ?",
      )
      .bind(targetLogin)
      .first<{ days_json: string; updated_at: number } | null>();

    const now = Date.now();
    const isStale = !row || now - row.updated_at > REFRESH_INTERVAL_MS;

    if (isStale) {
      const existing: Record<string, number> = row
        ? JSON.parse(row.days_json)
        : {};
      const existingDates = Object.keys(existing);
      const maxDate =
        existingDates.length > 0 ? existingDates.sort().slice(-1)[0] : null;

      const rangeStart = maxDate
        ? new Date(
            new Date(maxDate).getTime() + 24 * 60 * 60 * 1000,
          ).toISOString()
        : "2020-01-01T00:00:00Z";

      const rangeEnd = before
        ? `${before}T00:00:00Z`
        : new Date(now + 24 * 60 * 60 * 1000).toISOString();

      if (rangeStart < rangeEnd) {
        const token = await getUserToken(
          env,
          existingData,
          loginParam,
          request.headers.get("CF-IPCountry"),
        );

        const pageSize = 100;
        const sessions: LocationEntry[] = [];
        let page = 1;

        while (true) {
          const data = await fetchLocationsPage(
            token,
            targetLogin,
            page,
            pageSize,
            rangeStart,
            rangeEnd,
          );

          if (data.length === 0) break;

          sessions.push(...data);

          if (data.length < pageSize) break;
          page++;
        }

        for (const session of sessions) {
          const date = session.begin_at.slice(0, 10);
          const begin = new Date(session.begin_at).getTime();
          const end = new Date(session.end_at).getTime();
          const seconds = Math.round((end - begin) / 1000);
          if (seconds > 0) {
            existing[date] = (existing[date] || 0) + seconds;
          }
        }
      }

      await env.better_intra_d1
        .prepare(
          "INSERT OR REPLACE INTO logtime_history (login, days_json, updated_at) VALUES (?, ?, ?)",
        )
        .bind(targetLogin, JSON.stringify(existing), now)
        .run();

      return jsonRes({ days: existing });
    }

    return jsonRes({ days: JSON.parse(row!.days_json) });
  } catch {
    return jsonRes({ days: {} });
  }
}
