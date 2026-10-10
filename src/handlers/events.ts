import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";

interface ParsedEvent {
  id: number | null;
  name: string;
  beginAt: string;
  endAt: string;
  location: string | null;
  description: string | null;
  subscribers: number | null;
  maxSubscribers: number | null;
  url: string | null;
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function icsDateToIso(value: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return value;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? "Z"}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function parseIcs(ics: string): ParsedEvent[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const events: ParsedEvent[] = [];
  for (const rawBlock of unfolded.split("BEGIN:VEVENT").slice(1)) {
    // Drop the VALARM sub-block so its DESCRIPTION doesn't shadow the event's.
    const block = rawBlock.replace(/BEGIN:VALARM[\s\S]*?END:VALARM/g, "");
    const get = (key: string): string | null => {
      const m = block.match(
        new RegExp(`(?:^|\\r?\\n)${key}[^:\\r\\n]*:([^\\r\\n]*)`),
      );
      return m ? m[1].trim() : null;
    };
    const dtstart = get("DTSTART");
    const summary = get("SUMMARY");
    if (!dtstart || !summary) continue;
    const dtend = get("DTEND");
    const uid = get("UID");
    const location = get("LOCATION");
    const description = get("DESCRIPTION");
    const subscribers = get("X-SUBSCRIBERS");
    const maxSubscribers = get("X-MAX-SUBSCRIBERS");
    const url = get("URL");
    const idMatch = uid?.match(/^(\d+)@/);
    const toNum = (v: string | null): number | null =>
      v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;
    events.push({
      id: idMatch ? Number(idMatch[1]) : null,
      name: unescapeIcs(summary),
      beginAt: icsDateToIso(dtstart),
      endAt: dtend ? icsDateToIso(dtend) : icsDateToIso(dtstart),
      location: location ? unescapeIcs(location) : null,
      description: description ? unescapeIcs(description) : null,
      subscribers: toNum(subscribers),
      maxSubscribers: toNum(maxSubscribers),
      url: url ?? null,
    });
  }
  return events;
}

/**
 * Returns the user's subscribed events (parsed from the ICS the extension
 * synced into D1). Read-only; upcoming events only, sorted by start.
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
    .prepare("SELECT ics_body FROM calendar_ics WHERE login_hash = ?")
    .bind(loginParam)
    .first<{ ics_body: string }>();

  const all = row?.ics_body ? parseIcs(row.ics_body) : [];
  const now = Date.now();
  const events = all
    .filter((e) => new Date(e.endAt).getTime() >= now)
    .sort((a, b) => a.beginAt.localeCompare(b.beginAt));

  return jsonRes({ events });
}
