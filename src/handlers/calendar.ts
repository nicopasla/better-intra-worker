import { Env, UserData } from "../types";
import {
  getBearerToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

export async function handleCalendarToken(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization header", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) return textRes("Invalid session", 401);

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON body", 400);
  }

  if (!body.token || typeof body.token !== "string" || body.token.length < 8) {
    return textRes("Invalid token", 400);
  }

  await env.BETTER_INTRA_KV.put(`CALENDAR_TOKEN_${body.token}`, loginParam);
  return jsonRes({ ok: true });
}

export async function handleCalendarUpdate(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization header", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) return textRes("Invalid session", 401);

  let body: { ics?: string };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON body", 400);
  }

  if (!body.ics || typeof body.ics !== "string" || body.ics.length < 50) {
    return textRes("Invalid ics body", 400);
  }

  await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO calendar_ics (login_hash, ics_body, updated_at) VALUES (?, ?, unixepoch())",
    )
    .bind(loginParam, body.ics)
    .run();

  return jsonRes({ ok: true });
}

export async function handleCalendarIcs(
  token: string,
  env: Env,
): Promise<Response> {
  if (!token || token.length < 8) return textRes("Invalid token", 404);

  const raw = await env.BETTER_INTRA_KV.get(`CALENDAR_TOKEN_${token}`);
  if (!raw) return textRes("Not found", 404);

  let login: string;
  try {
    const parsed = JSON.parse(raw);
    login = parsed.login || parsed;
  } catch {
    login = raw;
  }

  const row = await env.better_intra_d1
    .prepare("SELECT ics_body FROM calendar_ics WHERE login_hash = ?")
    .bind(login)
    .first<{ ics_body: string }>();

  if (!row) {
    const emptyIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//BetterIntra//Events//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "END:VCALENDAR",
    ].join("\r\n");
    return new Response(emptyIcs, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return new Response(row.ics_body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
