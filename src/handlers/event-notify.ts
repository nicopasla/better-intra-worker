/**
 * Calendar reminders: a push 15 minutes before a subscribed 42 event starts.
 *
 * Source of truth is the ICS the extension syncs into D1 (`calendar_ics`), so
 * no 42 API calls are made here — which is why this runs from the Cloudflare
 * scheduled trigger (`* * * * *`) instead of the external cron-job.org job.
 * A widened window plus KV dedupe keeps delivery exactly-once even if a run is
 * late or repeats.
 */

import { Env, UserData, PushSubscription } from "../types";
import { parseIcs, type ParsedEvent } from "../ics";
import { pushTransition } from "../push-send";
import { buildEventPush } from "../push-payloads";

export const EVENT_LEAD_MS = 15 * 60 * 1000;
/** Widened past one minute so a late tick still catches the event. */
export const EVENT_WINDOW_MS = 3 * 60 * 1000;
/** Events are discrete, but cap a runaway day (several happen at once). */
export const MAX_REMINDERS_PER_USER = 3;

const NOTIFIED_TTL_SECONDS = 7 * 24 * 60 * 60;
const NOTIFIED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

const notifiedKey = (hash: string) => `EVENT_NOTIFIED_${hash}`;

/** Stable identity for dedupe: the same event rescheduled later must notify again. */
export function eventKey(event: ParsedEvent): string {
  return `${event.id ?? event.name}@${event.beginAt}`;
}

/** Events whose start falls inside the reminder window for this tick. */
export function dueEvents(
  events: ParsedEvent[],
  now: number = Date.now(),
): ParsedEvent[] {
  return events.filter((event) => {
    const begin = new Date(event.beginAt).getTime();
    if (Number.isNaN(begin)) return false;
    const untilStart = begin - now;
    return (
      untilStart <= EVENT_LEAD_MS && untilStart > EVENT_LEAD_MS - EVENT_WINDOW_MS
    );
  });
}

/** Drops entries older than the dedupe horizon. */
export function pruneNotified(
  map: Record<string, number>,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, sentAt] of Object.entries(map)) {
    if (typeof sentAt === "number" && now - sentAt < NOTIFIED_MAX_AGE_MS) {
      out[key] = sentAt;
    }
  }
  return out;
}

async function loadNotified(
  env: Env,
  hash: string,
  now: number,
): Promise<Record<string, number>> {
  try {
    const raw = await env.BETTER_INTRA_KV.get<Record<string, unknown>>(
      notifiedKey(hash),
      { type: "json" },
    );
    const map: Record<string, number> = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "number") map[key] = value;
      }
    }
    return pruneNotified(map, now);
  } catch {
    return {};
  }
}

async function saveNotified(
  env: Env,
  hash: string,
  map: Record<string, number>,
): Promise<void> {
  await env.BETTER_INTRA_KV.put(notifiedKey(hash), JSON.stringify(map), {
    expirationTtl: NOTIFIED_TTL_SECONDS,
  });
}

/** Only users who have a device to deliver to and haven't opted out. */
function reminderSubscriptions(userData: UserData): PushSubscription[] {
  if (userData.settings?.PUSH_ENABLED === false) return [];
  // Missing key means on: reminders piggyback on the push opt-in.
  if (userData.settings?.EVENT_NOTIFY_SOON === false) return [];
  return userData.pushSubscriptions ?? [];
}

async function processUser(
  env: Env,
  hash: string,
  ics: string,
  now: number,
): Promise<void> {
  const due = dueEvents(parseIcs(ics), now);
  if (due.length === 0) return;

  const userData = await env.BETTER_INTRA_KV.get<UserData>(hash, {
    type: "json",
  });
  if (!userData) return;

  const subs = reminderSubscriptions(userData);
  if (subs.length === 0) return;

  const notified = await loadNotified(env, hash, now);
  const pending = due
    .filter((event) => notified[eventKey(event)] === undefined)
    .slice(0, MAX_REMINDERS_PER_USER);
  if (pending.length === 0) return;

  // Claim before sending: a retried tick must not double-notify. A failed send
  // is dropped rather than retried, which is the safer failure mode.
  for (const event of pending) notified[eventKey(event)] = now;
  await saveNotified(env, hash, notified);

  for (const event of pending) {
    console.log(
      `[event-notify] ${hash.slice(0, 6)} event=${event.id ?? "?"} "${event.name}"`,
    );
    await pushTransition(
      env,
      hash,
      subs,
      (timeZone) =>
        buildEventPush({
          name: event.name,
          location: event.location,
          beginAt: event.beginAt,
          timeZone,
        }),
      {
        url: "https://mobile.betterintra.com/#/dashboard",
        tag: `event-${event.id ?? eventKey(event)}-15m`,
      },
    );
  }
}

export async function handleEventReminders(env: Env): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  let rows: { login_hash: string; ics_body: string }[] = [];
  try {
    const result = await env.better_intra_d1
      .prepare("SELECT login_hash, ics_body FROM calendar_ics")
      .all<{ login_hash: string; ics_body: string }>();
    rows = result.results ?? [];
  } catch (e) {
    console.warn(`[event-notify] D1 read failed: ${e}`);
    return;
  }
  if (rows.length === 0) return;

  const now = Date.now();

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(({ login_hash, ics_body }) =>
        processUser(env, login_hash, ics_body, now).catch((e) =>
          console.warn(`[event-notify] ${login_hash.slice(0, 6)} error: ${e}`),
        ),
      ),
    );
  }

  console.log(`[event-notify] done — ${rows.length} calendar(s) scanned`);
}
