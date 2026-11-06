import { Env, UserData } from "../types";
import {
  decryptBytes,
  encryptBytes,
  getBearerToken,
  hashLogin,
  jsonRes,
  resolveUserToken,
  textRes,
  tokenFailureResponse,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Keeps a single request under Workers' subrequest budget; later calls resume. */
const MAX_SYNC_PAGES = 30;
const PAGE_SIZE = 100;
/**
 * A stored history refreshed this recently is served as-is: opening the
 * logtime card twice in a row must not spend two 42 API round trips.
 */
const FRESH_MS = 60 * 1000;
/** Lower bound for a sync: never fetch older than this. */
const DEFAULT_SINCE_DAY = "2020-01-01";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A week view only needs a few pages; a longer gap resumes on the next call. */
const MAX_WEEK_PAGES = 10;
/** Even after a long absence, never walk back further than this. */
const MAX_BACKFILL_DAYS = 45;
/** Day key of the session still running, so an overnight session keeps its
 *  start day live across requests. */
const OPEN_DAY_PREFIX = "LOGTIME_OPEN_";
const OPEN_DAY_TTL = 3 * 24 * 60 * 60;

interface LocationEntry {
  id: number;
  begin_at: string;
  end_at: string | null;
}

interface FetchedRange {
  sessions: LocationEntry[];
  pages: number;
  /** The page budget ran out before the range was exhausted. */
  capped: boolean;
  /** A request failed: the range must not overwrite what is already stored. */
  failed: boolean;
}

const startOfDay = (day: string): string => `${day}T00:00:00.000Z`;

const nextDay = (day: string): string =>
  new Date(new Date(startOfDay(day)).getTime() + DAY_MS)
    .toISOString()
    .slice(0, 10);

async function fetchLocationsPage(
  env: Env,
  token: string,
  targetLogin: string,
  page: number,
  rangeStart: string,
  rangeEnd: string,
  sort: "begin_at" | "-begin_at",
): Promise<LocationEntry[] | null> {
  const qs =
    `?range%5Bbegin_at%5D=${encodeURIComponent(rangeStart)},${encodeURIComponent(rangeEnd)}` +
    `&sort=${sort}` +
    `&page%5Bsize%5D=${PAGE_SIZE}&page%5Bnumber%5D=${page}`;

  const res = await intraFetch(
    env,
    token,
    `https://api.intra.42.fr/v2/users/${targetLogin}/locations${qs}`,
    {},
    { op: "logtime" },
  );
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as LocationEntry[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function fetchRange(
  env: Env,
  token: string,
  targetLogin: string,
  rangeStart: string,
  rangeEnd: string,
  sort: "begin_at" | "-begin_at",
  maxPages: number,
): Promise<FetchedRange> {
  const sessions: LocationEntry[] = [];
  let page = 1;
  let pages = 0;

  while (true) {
    if (pages >= maxPages) {
      return { sessions, pages, capped: true, failed: false };
    }

    const data = await fetchLocationsPage(
      env,
      token,
      targetLogin,
      page,
      rangeStart,
      rangeEnd,
      sort,
    );
    pages++;

    // Never let a failed page look like "no more sessions": the caller would
    // then replace real stored days with a truncated total.
    if (data === null) return { sessions, pages, capped: false, failed: true };
    if (data.length === 0) break;
    sessions.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  return { sessions, pages, capped: false, failed: false };
}

/**
 * Adds sessions to a per-day seconds map (keyed by the UTC start date). The
 * session still running (`end_at` null) counts up to `now`, so today's total
 * keeps growing instead of staying at the value of the first sync of the day.
 */
export function accumulate(
  days: Record<string, number>,
  sessions: LocationEntry[],
  now: number = Date.now(),
): void {
  for (const session of sessions) {
    const date = session.begin_at.slice(0, 10);
    const begin = new Date(session.begin_at).getTime();
    const end = session.end_at
      ? Math.min(new Date(session.end_at).getTime(), now)
      : now;
    const seconds = Math.round((end - begin) / 1000);
    if (seconds > 0) days[date] = (days[date] || 0) + seconds;
  }
}

/**
 * Drops the days a sync is about to recompute. Without this an incremental
 * sync would add a day's sessions to its own previous total every time (and
 * re-count the running session on each poll).
 */
export function replaceDays(
  days: Record<string, number>,
  fromDay: string,
  toDayExclusive: string,
): void {
  for (const day of Object.keys(days)) {
    if (day >= fromDay && day < toDayExclusive) delete days[day];
  }
}

/** Recomputes the days covered by a range from the freshly fetched sessions. */
function applyRange(
  days: Record<string, number>,
  range: FetchedRange,
  fromDay: string,
  toDayExclusive: string,
  now: number,
): void {
  replaceDays(days, fromDay, toDayExclusive);
  accumulate(days, range.sessions, now);
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

  const beforeParam = url.searchParams.get("before");
  const before = beforeParam && DAY_RE.test(beforeParam) ? beforeParam : null;
  // `back=1` loads the most recent days first (PWA and extension) and backfills
  // older months on each call — the calendar is usually read newest-first.
  const back = url.searchParams.get("back") === "1";
  const sinceParam = url.searchParams.get("since");
  const sinceDay =
    sinceParam && DAY_RE.test(sinceParam) ? sinceParam : DEFAULT_SINCE_DAY;
  const rangeEnd = before
    ? startOfDay(before)
    : new Date(Date.now() + DAY_MS).toISOString();
  const rangeEndDay = rangeEnd.slice(0, 10);

  try {
    const loginHash = await hashLogin(targetLogin);
    const row = await env.better_intra_d1
      .prepare(
        "SELECT days_json, updated_at FROM logtime_history WHERE login_hash = ?",
      )
      .bind(loginHash)
      .first<{ days_json: ArrayBuffer | string; updated_at: number } | null>();

    const now = Date.now();
    const decoded = row ? await decryptBytes(env, row.days_json) : null;
    const existing: Record<string, number> = decoded ? JSON.parse(decoded) : {};
    const dates = Object.keys(existing).sort();
    const maxDay = dates.length > 0 ? dates[dates.length - 1] : null;
    const minDay = dates.length > 0 ? dates[0] : null;
    const updatedAt = row?.updated_at ?? null;

    if (!back) {
      // Extension path: only close the gap between the newest stored day and
      // `rangeEnd`, but re-read that newest day so today's partial total is
      // recomputed instead of frozen at the first sync of the day.
      const fromDay = maxDay ?? sinceDay;
      if (fromDay >= rangeEndDay) {
        return jsonRes({ days: existing, updatedAt });
      }
      if (!before && updatedAt !== null && now - updatedAt < FRESH_MS) {
        return jsonRes({ days: existing, updatedAt });
      }
    }

    const tokenResult = await resolveUserToken(
      env,
      existingData,
      loginParam,
      request.headers.get("CF-IPCountry"),
    );
    if (!("token" in tokenResult)) {
      // Keep serving the last snapshot, but say so: the UI must not present
      // stale days as if they had just been refreshed.
      if (dates.length === 0) return tokenFailureResponse(tokenResult.failure);
      return jsonRes({ days: existing, updatedAt, stale: true });
    }

    const save = async (days: Record<string, number>): Promise<void> => {
      await env.better_intra_d1
        .prepare(
          "INSERT OR REPLACE INTO logtime_history (login_hash, days_json, updated_at) VALUES (?, ?, ?)",
        )
        .bind(loginHash, await encryptBytes(env, JSON.stringify(days)), now)
        .run();
    };

    let partial = false;
    let failed = false;
    let changed = false;

    if (!back) {
      const fromDay = maxDay ?? sinceDay;
      const range = await fetchRange(
        env,
        tokenResult.token,
        targetLogin,
        startOfDay(fromDay),
        rangeEnd,
        "begin_at",
        MAX_SYNC_PAGES,
      );
      if (range.failed) {
        failed = true;
      } else {
        applyRange(existing, range, fromDay, rangeEndDay, now);
        changed = true;
        partial = range.capped;
      }
    } else {
      let budget = MAX_SYNC_PAGES;

      // Close the forward gap, re-reading the newest stored day (which may
      // have been stored while the day was still in progress).
      if (maxDay) {
        const forwardStart = startOfDay(maxDay);
        if (forwardStart < rangeEnd) {
          const forward = await fetchRange(
            env,
            tokenResult.token,
            targetLogin,
            forwardStart,
            rangeEnd,
            "begin_at",
            budget,
          );
          budget -= forward.pages;
          if (forward.failed) {
            failed = true;
          } else {
            applyRange(existing, forward, maxDay, rangeEndDay, now);
            changed = true;
            if (forward.capped) partial = true;
          }
        }
      }

      // Extend the history backwards, re-reading the oldest stored day: a
      // capped backfill leaves that boundary day undercounted, and the next
      // call must be able to complete it.
      const olderEndDay = minDay ? nextDay(minDay) : rangeEndDay;
      if (!failed && budget > 0 && sinceDay < olderEndDay) {
        const older = await fetchRange(
          env,
          tokenResult.token,
          targetLogin,
          startOfDay(sinceDay),
          startOfDay(olderEndDay),
          "-begin_at",
          budget,
        );
        if (older.failed) {
          failed = true;
        } else {
          applyRange(existing, older, sinceDay, olderEndDay, now);
          changed = true;
          if (older.capped) partial = true;
        }
      } else if (budget <= 0) {
        partial = true;
      }
    }

    if (changed || !failed) await save(existing);

    return jsonRes({
      days: existing,
      updatedAt: changed ? now : updatedAt,
      ...(partial ? { partial: true } : {}),
      ...(failed ? { stale: true } : {}),
    });
  } catch {
    return textRes("Failed to load logtime history", 500);
  }
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const shiftDay = (day: string, days: number): string =>
  new Date(new Date(startOfDay(day)).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** Monday of the UTC week containing `day`. */
const mondayOf = (day: string): string =>
  shiftDay(day, -((new Date(startOfDay(day)).getUTCDay() + 6) % 7));

function weekSlice(
  days: Record<string, number>,
  start: string,
): { days: Record<string, number>; total: number } {
  const out: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const day = shiftDay(start, i);
    const secs = days[day] ?? 0;
    out[day] = secs;
    total += secs;
  }
  return { days: out, total };
}

/**
 * The current week's days only (seconds per day), for the home heat card.
 *
 * Every call re-reads the days that can still move: today, the start day of a
 * session that is still running (overnight sessions), yesterday once when the
 * first call of a new day arrives, and the gap since the last successful sync
 * (opening the app after a few days away backfills the missing days). Days
 * older than that are never fetched again: their cached total is final.
 */
export async function handleLogtimeWeek(
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

  const startParam = url.searchParams.get("start");
  if (startParam && !DAY_RE.test(startParam)) {
    return textRes("Invalid start parameter", 400);
  }

  const now = Date.now();
  const today = utcDay(now);
  const yesterday = shiftDay(today, -1);
  const floorDay = shiftDay(today, -MAX_BACKFILL_DAYS);
  // Clamp rather than fail: a client's local Monday can be slightly ahead of
  // the UTC date, and an old `start` must never trigger an unbounded fetch.
  const requested = startParam ?? mondayOf(today);
  const start =
    requested > shiftDay(today, 7)
      ? mondayOf(today)
      : requested < floorDay
        ? floorDay
        : requested;

  try {
    const loginHash = await hashLogin(targetLogin);
    const row = await env.better_intra_d1
      .prepare(
        "SELECT days_json, updated_at FROM logtime_history WHERE login_hash = ?",
      )
      .bind(loginHash)
      .first<{ days_json: ArrayBuffer | string; updated_at: number } | null>();

    const decoded = row ? await decryptBytes(env, row.days_json) : null;
    const existing: Record<string, number> = decoded ? JSON.parse(decoded) : {};
    const updatedAt = row?.updated_at ?? null;

    const openKey = `${OPEN_DAY_PREFIX}${loginHash}`;
    let openDay: string | null = null;
    try {
      const stored = await env.BETTER_INTRA_KV.get(openKey);
      if (stored && DAY_RE.test(stored) && stored <= today) openDay = stored;
    } catch {
      /* best effort */
    }

    // Earliest day whose value can still change.
    let fromDay = today;
    if (openDay && openDay < fromDay) fromDay = openDay;
    const syncedDay = updatedAt !== null ? utcDay(updatedAt) : null;
    if (syncedDay === null) {
      // Never synced: seed the requested week (bounded by the floor).
      if (start < fromDay) fromDay = start;
    } else if (syncedDay < today) {
      // Fill the gap since the last sync; yesterday needs one final read even
      // when the gap is just one day.
      const gap = nextDay(syncedDay);
      if (gap < fromDay) fromDay = gap;
      if (yesterday < fromDay) fromDay = yesterday;
    }
    if (fromDay < floorDay) fromDay = floorDay;

    const tokenResult = await resolveUserToken(
      env,
      existingData,
      loginParam,
      request.headers.get("CF-IPCountry"),
    );
    if (!("token" in tokenResult)) {
      if (!row) return tokenFailureResponse(tokenResult.failure);
      return jsonRes({
        start,
        ...weekSlice(existing, start),
        updatedAt,
        stale: true,
      });
    }

    const range = await fetchRange(
      env,
      tokenResult.token,
      targetLogin,
      startOfDay(fromDay),
      new Date(now).toISOString(),
      "begin_at",
      MAX_WEEK_PAGES,
    );

    if (range.failed) {
      return jsonRes({
        start,
        ...weekSlice(existing, start),
        updatedAt,
        stale: true,
      });
    }

    applyRange(existing, range, fromDay, nextDay(today), now);

    await env.better_intra_d1
      .prepare(
        "INSERT OR REPLACE INTO logtime_history (login_hash, days_json, updated_at) VALUES (?, ?, ?)",
      )
      .bind(loginHash, await encryptBytes(env, JSON.stringify(existing)), now)
      .run();

    // Remember which day the running session began on, so the next call keeps
    // that day live even though it is no longer "today".
    if (!range.capped) {
      const open = range.sessions.find((session) => session.end_at === null);
      const nextOpen = open ? open.begin_at.slice(0, 10) : null;
      try {
        if (nextOpen && nextOpen !== openDay) {
          await env.BETTER_INTRA_KV.put(openKey, nextOpen, {
            expirationTtl: OPEN_DAY_TTL,
          });
        } else if (!nextOpen && openDay) {
          await env.BETTER_INTRA_KV.delete(openKey);
        }
      } catch {
        /* best effort */
      }
    }

    return jsonRes({
      start,
      ...weekSlice(existing, start),
      updatedAt: now,
    });
  } catch {
    return textRes("Failed to load logtime week", 500);
  }
}
