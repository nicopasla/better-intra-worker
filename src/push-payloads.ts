import type { PushPayload } from "./handlers/push";

/**
 * Push payload builders shared by every notification type (evals, corrections,
 * calendar events). Times are rendered here in the receiving device's timezone
 * because a service worker's own timezone is UTC on Android.
 */

/** True when `value` is an IANA timezone `Intl` accepts. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface ZoneFormatters {
  clock: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  shortDate: Intl.DateTimeFormat;
}

const formatterCache = new Map<string, ZoneFormatters>();

function formattersFor(timeZone: string): ZoneFormatters {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const withZone = (options: Intl.DateTimeFormatOptions) => ({
    ...options,
    timeZone,
  });
  const built: ZoneFormatters = {
    clock: new Intl.DateTimeFormat(
      "en-GB",
      withZone({ hour: "2-digit", minute: "2-digit", hour12: false }),
    ),
    day: new Intl.DateTimeFormat(
      "en-GB",
      withZone({ year: "numeric", month: "2-digit", day: "2-digit" }),
    ),
    shortDate: new Intl.DateTimeFormat(
      "en-GB",
      withZone({ day: "2-digit", month: "2-digit", year: "2-digit" }),
    ),
  };
  formatterCache.set(timeZone, built);
  return built;
}

/** Renders an eval instant in the device's timezone: "HH:MM" when it is today
 *  there, else "DD/MM/YY HH:MM". Falls back to UTC when the zone is unknown.
 *  Times are formatted here (not in the service worker) because a background
 *  worker's own timezone is UTC on Android — see `PushPayload`. */
export function formatPushTime(
  iso: string,
  timeZone?: string | null,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const f = formattersFor(tz);
  const time = f.clock.format(date);
  const sameDay = f.day.format(date) === f.day.format(now);
  return sameDay ? time : `${f.shortDate.format(date)} ${time}`;
}

export interface EvalPushInput {
  kind: "booked" | "revealed";
  project: string | null;
  beginAt: string;
  correcteds?: string[];
  /** IANA timezone of the receiving device. UTC when unknown. */
  timeZone?: string | null;
}

/** Builds an eval push. Title is always the status; the details live in the
 *  body, already rendered in the device's timezone. Shared by the cron and the
 *  test endpoint so previews match production. */
export function buildEvalPush(input: EvalPushInput): PushPayload {
  const project = input.project ?? null;
  const names = input.correcteds ?? [];
  const stamp = formatPushTime(input.beginAt, input.timeZone);
  const status =
    input.kind === "revealed" ? "Evaluation in 15 min" : "Evaluation Booked";

  const detail: string[] = [];
  if (input.kind === "revealed") {
    if (names.length) detail.push(`Correcting ${names.join(", ")}`);
    if (project) detail.push(project);
  } else {
    detail.push("Evaluating someone");
  }
  if (stamp) detail.push(`at ${stamp}`);

  return {
    title: status,
    body: detail.join(" "),
    kind: input.kind,
    project,
    correcteds: input.kind === "revealed" ? names : [],
  };
}

export interface CorrectedPushInput {
  beginAt: string;
  corrector: string;
  /** IANA timezone of the receiving device. UTC when unknown. */
  timeZone?: string | null;
}

/** Push for when the user is being evaluated and their evaluator is revealed. */
export function buildCorrectedPush(input: CorrectedPushInput): PushPayload {
  const stamp = formatPushTime(input.beginAt, input.timeZone);
  const detail = [`Your evaluator: ${input.corrector}`];
  if (stamp) detail.push(`at ${stamp}`);
  return {
    title: "Evaluation in 15 min",
    body: detail.join(" "),
    kind: "corrected",
    corrector: input.corrector,
  };
}

export interface EventPushInput {
  name: string;
  location?: string | null;
  beginAt: string;
  /** IANA timezone of the receiving device. UTC when unknown. */
  timeZone?: string | null;
}

/** Push for a subscribed 42 event starting in 15 minutes. Event reminders use
 *  the same timezone rules as evals: the time is rendered here. */
export function buildEventPush(input: EventPushInput): PushPayload {
  const stamp = formatPushTime(input.beginAt, input.timeZone);
  const detail: string[] = [input.name.trim()];
  if (stamp) detail.push(`at ${stamp}`);
  const location = input.location?.trim();
  if (location) detail.push(`· ${location}`);
  return {
    title: "Event in 15 min",
    body: detail.join(" "),
    kind: "event",
  };
}
