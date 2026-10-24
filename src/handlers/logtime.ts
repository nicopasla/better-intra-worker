import { Env, UserData } from "../types";
import {
  decryptBytes,
  encryptBytes,
  getBearerToken,
  hashLogin,
  jsonRes,
  textRes,
  validateSession,
  getUserToken,
} from "../utils";
import { intraFetch } from "../rate";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Keeps a single request under Workers' subrequest budget; later calls resume. */
const MAX_SYNC_PAGES = 30;
const PAGE_SIZE = 100;

interface LocationEntry {
  id: number;
  begin_at: string;
  end_at: string;
}

async function fetchLocationsPage(
  env: Env,
  token: string,
  targetLogin: string,
  page: number,
  rangeStart: string,
  rangeEnd: string,
  sort: "begin_at" | "-begin_at",
): Promise<LocationEntry[]> {
  const qs =
    `?range%5Bbegin_at%5D=${encodeURIComponent(rangeStart)},${encodeURIComponent(rangeEnd)}` +
    `&sort=${sort}` +
    `&page%5Bsize%5D=${PAGE_SIZE}&page%5Bnumber%5D=${page}`;

  const res = await intraFetch(
    env,
    token,
    `https://api.intra.42.fr/v2/users/${targetLogin}/locations${qs}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as LocationEntry[];
  return Array.isArray(data) ? data : [];
}

interface FetchedRange {
  sessions: LocationEntry[];
  pages: number;
  /** The page budget ran out before the range was exhausted. */
  capped: boolean;
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
    if (pages >= maxPages) return { sessions, pages, capped: true };

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

    if (data.length === 0) break;
    sessions.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  return { sessions, pages, capped: false };
}

/** Adds sessions to a per-day seconds map (keyed by the UTC start date). */
function accumulate(
  days: Record<string, number>,
  sessions: LocationEntry[],
): void {
  for (const session of sessions) {
    const date = session.begin_at.slice(0, 10);
    const begin = new Date(session.begin_at).getTime();
    const end = new Date(session.end_at).getTime();
    const seconds = Math.round((end - begin) / 1000);
    if (seconds > 0) days[date] = (days[date] || 0) + seconds;
  }
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
  // `back=1` loads the most recent days first (PWA overview) and backfills
  // older months on each call — the calendar is usually read newest-first.
  const back = url.searchParams.get("back") === "1";
  // Lower bound for a sync: never fetch older than this.
  const sinceParam = url.searchParams.get("since");
  const sinceFloor =
    sinceParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam)
      ? `${sinceParam}T00:00:00Z`
      : "2020-01-01T00:00:00Z";

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
    const maxDate = dates.length > 0 ? dates[dates.length - 1] : null;
    const minDate = dates.length > 0 ? dates[0] : null;
    const rangeEnd = before
      ? `${before}T00:00:00Z`
      : new Date(now + DAY_MS).toISOString();

    const token = await getUserToken(
      env,
      existingData,
      loginParam,
      request.headers.get("CF-IPCountry"),
    );

    const save = async (days: Record<string, number>): Promise<void> => {
      await env.better_intra_d1
        .prepare(
          "INSERT OR REPLACE INTO logtime_history (login_hash, days_json, updated_at) VALUES (?, ?, ?)",
        )
        .bind(loginHash, await encryptBytes(env, JSON.stringify(days)), now)
        .run();
    };

    if (!token) {
      await save(existing);
      return jsonRes({ days: existing });
    }

    if (!back) {
      // Incremental forward sync from the newest stored day (extension path).
      const rangeStart = maxDate
        ? new Date(new Date(maxDate).getTime() + DAY_MS).toISOString()
        : sinceFloor;
      if (rangeStart >= rangeEnd) return jsonRes({ days: existing });

      const { sessions, capped } = await fetchRange(
        env,
        token,
        targetLogin,
        rangeStart,
        rangeEnd,
        "begin_at",
        MAX_SYNC_PAGES,
      );
      accumulate(existing, sessions);
      await save(existing);
      return jsonRes(
        capped ? { days: existing, partial: true } : { days: existing },
      );
    }

    // Newest-first mode: close the forward gap, then extend history backwards.
    let budget = MAX_SYNC_PAGES;
    let partial = false;

    const forwardStart = maxDate
      ? new Date(new Date(maxDate).getTime() + DAY_MS).toISOString()
      : null;
    if (!forwardStart || forwardStart < rangeEnd) {
      const start = forwardStart ?? rangeEnd;
      if (start < rangeEnd) {
        const forward = await fetchRange(
          env,
          token,
          targetLogin,
          start,
          rangeEnd,
          "begin_at",
          budget,
        );
        budget -= forward.pages;
        accumulate(existing, forward.sessions);
      }
    }

    // Sessions on the oldest stored day were fully counted already; stop just
    // before it so the day isn't added twice.
    const olderEnd = minDate ? `${minDate}T00:00:00Z` : rangeEnd;
    if (budget > 0 && sinceFloor < olderEnd) {
      const older = await fetchRange(
        env,
        token,
        targetLogin,
        sinceFloor,
        olderEnd,
        "-begin_at",
        budget,
      );
      accumulate(existing, older.sessions);
      partial = older.capped;
    } else if (budget <= 0) {
      partial = true;
    }

    await save(existing);
    return jsonRes(
      partial ? { days: existing, partial: true } : { days: existing },
    );
  } catch {
    return jsonRes({ days: {} });
  }
}
