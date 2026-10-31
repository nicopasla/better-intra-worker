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
import { mintAvatarUrl } from "./avatar";
import { upcomingEvents } from "../ics";

const API_BASE = "https://api.intra.42.fr";

/** Max subscribers returned per event, to bound a single worker request. */
const MAX_SUBSCRIBERS = 300;
const PAGE_SIZE = 100;

/**
 * Returns the user's subscribed events (parsed from the ICS the extension
 * synced into D1). Read-only; upcoming events only, sorted by start.
 * `syncedAt` is when the extension last wrote the ICS (ms, null when never).
 */
export async function handleEvents(
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

  const row = await env.better_intra_d1
    .prepare(
      "SELECT ics_body, updated_at FROM calendar_ics WHERE login_hash = ?",
    )
    .bind(loginParam)
    .first<{ ics_body: string; updated_at: number | null }>();

  const now = Date.now();
  const events = row?.ics_body ? upcomingEvents(row.ics_body, now) : [];
  // D1 stores unix seconds; the app wants milliseconds.
  const syncedAt = row?.updated_at ? row.updated_at * 1000 : null;

  return jsonRes({ events, syncedAt });
}

interface ApiUser {
  login?: string;
  displayname?: string;
  usual_full_name?: string;
  image?: { link?: string; versions?: { small?: string } };
  location?: string | null;
}

/**
 * Returns the users subscribed to a 42 event, fetched live from
 * `GET /v2/events/:id/users`. Paginated and capped at {@link MAX_SUBSCRIBERS}.
 */
export async function handleEventSubscribers(
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

  const eventId = new URL(request.url).searchParams.get("event");
  if (!eventId || !/^\d+$/.test(eventId)) {
    return textRes("Invalid event parameter", 400);
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

  const users: {
    login: string;
    displayName: string;
    avatar: string | null;
    avatarUrl?: string | null;
    location: string | null;
  }[] = [];
  let truncated = false;

  const maxPages = Math.ceil(MAX_SUBSCRIBERS / PAGE_SIZE);
  const selfOrigin = new URL(request.url).origin;
  for (let page = 1; page <= maxPages; page++) {
    const res = await intraFetch(
      env,
      tokenResult.token,
      `${API_BASE}/v2/events/${eventId}/users?page[size]=${PAGE_SIZE}&page[number]=${page}`,
    );
    if (res.status === 404) return textRes("Event not found", 404);
    if (!res.ok) return textRes(`42 API error: ${res.status}`, 502);

    const rows = (await res.json()) as ApiUser[];
    for (const u of rows) {
      if (!u.login) continue;
      const photo = u.image?.versions?.small ?? u.image?.link ?? null;
      users.push({
        login: u.login,
        displayName: u.usual_full_name ?? u.displayname ?? u.login,
        avatar: photo || `https://cdn.intra.42.fr/users/${u.login}.jpg`,
        avatarUrl: await mintAvatarUrl(env, u.login, selfOrigin, photo),
        location: u.location ?? null,
      });
    }

    if (rows.length < PAGE_SIZE) break;
    if (users.length >= MAX_SUBSCRIBERS) {
      truncated = true;
      break;
    }
  }

  return jsonRes({ users, truncated });
}
