import { Env, UserData } from "../types";
import {
  getBearerToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

/**
 * Broken-computer reports for the cluster maps.
 *
 * Reports are scoped to the Belgium campus for now. Every write stores the
 * reporter's 42 login (from the session blob, so it cannot be spoofed by the
 * client) on the seat row and in the history log. A short-lived KV lock keyed
 * by the login hash still de-duplicates repeat taps.
 */
export const SEAT_REPORT_CAMPUS = "12";

export const SEAT_COMPONENTS = [
  "computer",
  "boot",
  "network",
  "keyboard",
  "mouse_scroll",
  "usbc",
] as const;

export type SeatComponent = (typeof SEAT_COMPONENTS)[number];

export const SEAT_STATUSES = ["broken", "works"] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

const COMPONENT_SET = new Set<string>(SEAT_COMPONENTS);
const STATUS_SET = new Set<string>(SEAT_STATUSES);
const HOST_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
/** A batch may cover the whole catalog, but nothing bigger. */
const MAX_REPORTS = SEAT_COMPONENTS.length;
/** Cheap abuse guard per reporter hash, per hour. */
const MAX_ACTIONS_PER_HOUR = 60;
/** Repeat taps within this window don't increase the confirmation count.
 *  Cloudflare KV rejects expiration TTLs below 60 seconds. */
const CONFIRM_TTL_SECONDS = 60;

export interface SeatEntryInput {
  component: SeatComponent;
  status: SeatStatus;
}

export interface SeatComponentRow {
  host: string;
  cluster: string | null;
  component: SeatComponent;
  status: SeatStatus;
  updatedAt: number;
  confirmations: number;
  reporter?: string | null;
}

export interface SeatEventRow {
  component: SeatComponent;
  status: SeatStatus;
  created_at: number;
  reporter?: string | null;
}

export interface SeatRow {
  host: string;
  cluster: string | null;
  components: {
    component: SeatComponent;
    status: SeatStatus;
    updatedAt: number;
    confirmations: number;
    reporter: string | null;
  }[];
}

export function isValidSeatHost(value: unknown): value is string {
  return typeof value === "string" && HOST_RE.test(value.trim().toLowerCase());
}

function normalizeSeatComponent(value: unknown): SeatComponent | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return COMPONENT_SET.has(key) ? (key as SeatComponent) : null;
}

function normalizeSeatStatus(value: unknown): SeatStatus | null {
  if (typeof value !== "string") return null;
  const status = value.trim().toLowerCase();
  return STATUS_SET.has(status) ? (status as SeatStatus) : null;
}

/** Validates and de-duplicates a report batch (last entry per component wins). */
export function parseSeatReports(raw: unknown): SeatEntryInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REPORTS) {
    return null;
  }
  const entries = new Map<SeatComponent, SeatStatus>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const component = normalizeSeatComponent(record.component);
    const status = normalizeSeatStatus(record.status);
    if (!component || !status) return null;
    entries.set(component, status);
  }
  return [...entries].map(([component, status]) => ({ component, status }));
}

/** Groups flat D1 rows into one object per seat, dropping malformed rows. */
export function groupSeatRows(rows: SeatComponentRow[] | null): SeatRow[] {
  const seats = new Map<string, SeatRow>();
  for (const row of rows ?? []) {
    if (!row || !isValidSeatHost(row.host)) continue;
    const component = normalizeSeatComponent(row.component);
    const status = normalizeSeatStatus(row.status);
    if (!component || !status) continue;
    const host = row.host.trim().toLowerCase();
    let seat = seats.get(host);
    if (!seat) {
      seat = { host, cluster: row.cluster ?? null, components: [] };
      seats.set(host, seat);
    }
    seat.components.push({
      component,
      status,
      updatedAt: Number(row.updatedAt) || 0,
      confirmations: Math.max(1, Number(row.confirmations) || 1),
      reporter: row.reporter ?? null,
    });
  }
  return [...seats.values()];
}

function authorized(
  request: Request,
  existingData: UserData | null,
): Response | null {
  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }
  return null;
}

const SEAT_COLUMNS =
  "host, cluster, component, status, updated_at AS updatedAt, confirmations, reporter";

async function loadSeats(env: Env): Promise<SeatRow[]> {
  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT ${SEAT_COLUMNS}
       FROM seat_components
       WHERE campus = ?
       ORDER BY host ASC, component ASC`,
    )
    .bind(SEAT_REPORT_CAMPUS)
    .all<SeatComponentRow>();
  return groupSeatRows(results);
}

const UPSERT_SQL = `
  INSERT INTO seat_components
    (campus, host, cluster, component, status, updated_at, confirmations, reporter)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(campus, host, component) DO UPDATE SET
    cluster = excluded.cluster,
    status = excluded.status,
    updated_at = excluded.updated_at,
    reporter = excluded.reporter,
    confirmations = CASE
      WHEN seat_components.status = excluded.status
        THEN seat_components.confirmations + ?
      ELSE 1
    END
`;

export async function handleSeatReports(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return textRes("Method not allowed", 405);
  }
  const denied = authorized(request, existingData);
  if (denied) return denied;

  if (request.method === "GET") {
    return jsonRes({ seats: await loadSeats(env), updatedAt: Date.now() });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return textRes("Invalid JSON body", 400);
  }

  // Belgium only, even if a client sends another campus explicitly.
  if (body.campus != null && String(body.campus) !== SEAT_REPORT_CAMPUS) {
    return textRes(
      `Reports are only available for campus ${SEAT_REPORT_CAMPUS}`,
      400,
    );
  }

  const host = typeof body.host === "string" ? body.host.trim().toLowerCase() : "";
  if (!isValidSeatHost(host)) return textRes("Invalid seat host", 400);

  const cluster =
    typeof body.cluster === "string" && body.cluster.trim()
      ? body.cluster.trim().toLowerCase().slice(0, 32)
      : null;

  const entries = parseSeatReports(body.reports);
  if (!entries) return textRes("Invalid reports", 400);

  /** From the session blob, so it cannot be spoofed by the request body. */
  const reporter = existingData?.fortyTwoLogin ?? null;

  const rateKey = `SEAT_REPORT_RATE_${loginParam}`;
  const used = Number((await env.BETTER_INTRA_KV.get(rateKey)) ?? "0");
  if (used >= MAX_ACTIONS_PER_HOUR) {
    return textRes("Too many reports, try again later", 429);
  }
  await env.BETTER_INTRA_KV.put(rateKey, String(used + 1), {
    expirationTtl: 3600,
  });

  const now = Math.floor(Date.now() / 1000);
  const increments = await Promise.all(
    entries.map(async ({ component }) => {
      const lockKey = `SEAT_REPORT_LOCK_${loginParam}_${host}_${component}`;
      const locked = (await env.BETTER_INTRA_KV.get(lockKey)) !== null;
      if (!locked) {
        await env.BETTER_INTRA_KV.put(lockKey, "1", {
          expirationTtl: CONFIRM_TTL_SECONDS,
        });
      }
      return locked ? 0 : 1;
    }),
  );

  const { results: currentRows } = await env.better_intra_d1
    .prepare(
      "SELECT component, status FROM seat_components WHERE campus = ? AND host = ?",
    )
    .bind(SEAT_REPORT_CAMPUS, host)
    .all<{ component: SeatComponent; status: SeatStatus }>();
  const previous = new Map(
    (currentRows ?? []).map((row) => [row.component, row.status]),
  );

  const statements: D1PreparedStatement[] = [];
  entries.forEach((entry, index) => {
    statements.push(
      env.better_intra_d1
        .prepare(UPSERT_SQL)
        .bind(
          SEAT_REPORT_CAMPUS,
          host,
          cluster,
          entry.component,
          entry.status,
          now,
          reporter,
          increments[index],
        ),
    );
    // The history logs distinct reports and every status flip, but not the
    // same person double-tapping the same value.
    if (increments[index] > 0 || previous.get(entry.component) !== entry.status) {
      statements.push(
        env.better_intra_d1
          .prepare(
            `INSERT INTO seat_component_events
               (campus, host, cluster, component, status, created_at, reporter)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            SEAT_REPORT_CAMPUS,
            host,
            cluster,
            entry.component,
            entry.status,
            now,
            reporter,
          ),
      );
    }
  });
  await env.better_intra_d1.batch(statements);

  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT ${SEAT_COLUMNS}
       FROM seat_components
       WHERE campus = ? AND host = ?`,
    )
    .bind(SEAT_REPORT_CAMPUS, host)
    .all<SeatComponentRow>();

  return jsonRes({ seat: groupSeatRows(results)[0] ?? null });
}

/** Status-change history for one seat, newest first, with the reporter login. */
export async function handleSeatHistory(
  request: Request,
  env: Env,
  _loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  const denied = authorized(request, existingData);
  if (denied) return denied;

  const host = (new URL(request.url).searchParams.get("host") ?? "")
    .trim()
    .toLowerCase();
  if (!isValidSeatHost(host)) return textRes("Invalid seat host", 400);

  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT component, status, created_at, reporter
       FROM seat_component_events
       WHERE campus = ? AND host = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
    )
    .bind(SEAT_REPORT_CAMPUS, host)
    .all<SeatEventRow>();

  const events = (results ?? [])
    .map((row) => {
      const component = normalizeSeatComponent(row.component);
      const status = normalizeSeatStatus(row.status);
      if (!component || !status) return null;
      return {
        component,
        status,
        createdAt: Number(row.created_at) * 1000,
        reporter: row.reporter ?? null,
      };
    })
    .filter((event): event is NonNullable<typeof event> => event !== null);

  return jsonRes({ events });
}
