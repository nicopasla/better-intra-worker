import { Env } from "../types";
import { corsHeaders } from "../utils";
import { loadStibLines } from "./gtfs";
import type { StibLine } from "./gtfs";

/**
 * Public STIB/MIVB departure board around Brussels-Central (Gare Centrale).
 *
 * MobilityTwin.Brussels only serves whole-network snapshots, so the worker
 * keeps the token server-side, downloads the snapshot once per minute for
 * every user, filters it to the stops around the station and caches the small
 * result in KV. The PWA then polls a few kilobytes instead of several MB.
 *
 * `GET /api/v1/public/transit/gare-centrale`
 */

const UPSTREAM = "https://api.mobilitytwin.brussels";
const AREA = "gare-centrale";
const AREA_LABEL = "Gare Centrale";
/** Bruxelles-Central, in front of the main entrance on the Carrefour de l'Europe side. */
const CENTER = { lat: 50.84572, lon: 4.35694 };
/** Walking radius kept on the board. */
const RADIUS_METERS = 300;
const MAX_DEPARTURES_PER_LINE = 2;
/** Upper bound on stops in one response, nearest first. */
const MAX_STOPS = 12;
/** A board younger than this is served without touching the upstream. */
const FRESH_MS = 45_000;
const CATALOG_KEY = "TRANSIT_STOPS";
const BOARD_KEY = "TRANSIT_GARE_CENTRALE";
const CATALOG_TTL_SECS = 7 * 24 * 60 * 60;
const EMPTY_CATALOG_TTL_SECS = 10 * 60;
const BOARD_TTL_SECS = 60 * 60;
const UPSTREAM_TIMEOUT_MS = 8000;
const CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

export type TransitMode = "metro" | "tram" | "bus";

export interface TransitDeparture {
  lineId: string;
  mode: TransitMode;
  /** Official GTFS line colour (`#rrggbb`), when the feed provides one. */
  color: string | null;
  textColor: string | null;
  destination: string;
  /** ISO 8601 instant of the expected arrival. */
  at: string;
}

export interface TransitStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  departures: TransitDeparture[];
}

export interface TransitMeta {
  /** Platform points of the station, with or without departures. */
  nearbyStops: number;
  /** Stops that made it into the response. */
  stops: number;
  departures: number;
  /** Rows in the upstream waiting-times snapshot. */
  upstreamRows: number;
}

export interface TransitBoard {
  area: string;
  label: string;
  /** When the worker built this board, in ms since epoch. */
  updatedAt: number;
  /** Upstream `X-Data-Timestamp`, when the feed provides one. */
  sourceUpdatedAt: string | null;
  stops: TransitStop[];
  meta: TransitMeta;
}

/** Stop catalog built from the daily `/stib/stops` snapshot. */
export interface CatalogStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  lines: string[];
}

interface Named {
  fr?: string;
  nl?: string;
}

interface PassingTime {
  destination?: Named | string | null;
  expectedArrivalTime?: string;
  message?: Named | string | null;
}

interface UpstreamPayload {
  results?: unknown[];
  features?: unknown[];
}

export interface UpstreamResponse {
  data: UpstreamPayload;
  timestamp: string | null;
}

/** Great-circle distance in meters. */
export function distanceMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const earth = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? (raw as T) : null;
}

function named(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  const value = parseJson<Named>(raw);
  if (!value) return null;
  return (value.fr ?? value.nl ?? "").trim() || null;
}

/** Only the station's own platforms: neighbouring stops (Bozar, Arenberg…)
 *  belong to other boards. French and Dutch names are both accepted. */
const STATION_NAME = /gare\s+centrale|centraal\s+station/i;

/** Keeps the stops of the daily `/stib/stops` snapshot that are walkable from
 *  the station, merging the lines that serve each stop id. */
export function buildCatalog(payload: UpstreamPayload): CatalogStop[] {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const byId = new Map<string, CatalogStop>();

  for (const raw of features) {
    const feature = raw as {
      properties?: Record<string, unknown>;
    } | null;
    const props = feature?.properties;
    if (!props) continue;

    const name = String(props.stop_name ?? "").trim() || "";
    if (!STATION_NAME.test(name)) continue;

    const id = props.stop_id == null ? "" : String(props.stop_id).trim();
    if (!id) continue;
    const lat = Number(props.stop_lat);
    const lon = Number(props.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const distanceM = Math.round(distanceMeters(CENTER, { lat, lon }));
    if (distanceM > RADIUS_METERS) continue;

    const line = String(props.route_short_name ?? "").trim();
    const existing = byId.get(id);
    if (existing) {
      if (line && !existing.lines.includes(line)) existing.lines.push(line);
      continue;
    }
    byId.set(id, {
      id,
      name: name || id,
      lat,
      lon,
      distanceM,
      lines: line ? [line] : [],
    });
  }

  return [...byId.values()]
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_STOPS);
}

/** Turns the nearest waiting-times rows into a board sorted by arrival. */
export function normalizeBoard(
  catalog: CatalogStop[],
  payload: UpstreamPayload,
  sourceUpdatedAt: string | null,
  catalogue: Record<string, StibLine>,
  now = Date.now(),
): TransitBoard {
  const known = new Map(catalog.map((stop) => [stop.id, stop]));
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  /** per stop id → line+destination → departures */
  const grouped = new Map<string, Map<string, TransitDeparture[]>>();

  for (const raw of rows) {
    const row = raw as {
      pointid?: unknown;
      lineid?: unknown;
      passingtimes?: unknown;
    } | null;
    if (!row) continue;

    const stopId = row.pointid == null ? "" : String(row.pointid).trim();
    if (!known.has(stopId)) continue;
    const lineId = row.lineid == null ? "" : String(row.lineid).trim();
    if (!lineId) continue;

    const times = parseJson<PassingTime[]>(row.passingtimes);
    if (!Array.isArray(times)) continue;

    for (const time of times) {
      const at = typeof time?.expectedArrivalTime === "string"
        ? time.expectedArrivalTime
        : "";
      const instant = Date.parse(at);
      // A minute of slack tolerates clock skew and vehicles at the stop.
      if (!Number.isFinite(instant) || instant < now - 60_000) continue;

      const destination =
        named(time?.destination) ??
        named(time?.message) ??
        "";

      const lines = grouped.get(stopId) ?? new Map();
      grouped.set(stopId, lines);
      const key = `${lineId}\u0000${destination}`;
      const list = lines.get(key) ?? [];
      const meta = catalogue[lineId];
      list.push({
        lineId,
        mode: meta?.mode ?? "bus",
        color: meta?.color ?? null,
        textColor: meta?.textColor ?? null,
        destination,
        at: new Date(instant).toISOString(),
      });
      lines.set(key, list);
    }
  }

  const stops: TransitStop[] = [];
  for (const stop of catalog) {
    const lines = grouped.get(stop.id);
    if (!lines || lines.size === 0) continue;

    const departures: TransitDeparture[] = [];
    for (const list of lines.values()) {
      list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      departures.push(...list.slice(0, MAX_DEPARTURES_PER_LINE));
    }
    departures.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    stops.push({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      distanceM: stop.distanceM,
      departures,
    });
  }

  return {
    area: AREA,
    label: AREA_LABEL,
    updatedAt: now,
    sourceUpdatedAt,
    stops,
    meta: {
      nearbyStops: catalog.length,
      stops: stops.length,
      departures: stops.reduce((sum, stop) => sum + stop.departures.length, 0),
      upstreamRows: rows.length,
    },
  };
}

async function fetchUpstream(env: Env, path: string): Promise<UpstreamResponse> {
  const token = env.MOBILITYTWIN_TOKEN;
  if (!token) throw new Error("not_configured");

  const res = await fetch(`${UPSTREAM}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mobilitytwin ${res.status}`);
  return {
    data: (await res.json()) as UpstreamPayload,
    timestamp: res.headers.get("x-data-timestamp"),
  };
}

async function loadCatalog(env: Env): Promise<CatalogStop[]> {
  const cached = await env.BETTER_INTRA_KV.get<CatalogStop[]>(CATALOG_KEY, {
    type: "json",
    cacheTtl: 60,
  });
  if (Array.isArray(cached) && cached.length > 0) return cached;

  const { data } = await fetchUpstream(env, "/stib/stops");
  const catalog = buildCatalog(data);
  await env.BETTER_INTRA_KV.put(CATALOG_KEY, JSON.stringify(catalog), {
    expirationTtl: catalog.length > 0 ? CATALOG_TTL_SECS : EMPTY_CATALOG_TTL_SECS,
  });
  return catalog;
}

/** Downloads one waiting-times snapshot and stores the filtered board. */
export async function refreshBoard(env: Env): Promise<TransitBoard> {
  const [catalog, gtfs] = await Promise.all([
    loadCatalog(env),
    // Line modes and colours come from the GTFS catalogue; a board without
    // them still beats an error, so a GTFS outage does not hide the trains.
    loadStibLines(env).catch(() => null),
  ]);
  const { data, timestamp } = await fetchUpstream(env, "/stib/waiting-times");
  const board = normalizeBoard(
    catalog,
    data,
    timestamp,
    gtfs?.lines ?? {},
  );
  await env.BETTER_INTRA_KV.put(BOARD_KEY, JSON.stringify(board), {
    expirationTtl: BOARD_TTL_SECS,
  });
  return board;
}

/** Concurrent requests in the same isolate share one upstream refresh. */
let inflight: Promise<TransitBoard> | null = null;

function refreshOnce(env: Env): Promise<TransitBoard> {
  if (inflight) return inflight;
  inflight = refreshBoard(env).finally(() => {
    inflight = null;
  });
  return inflight;
}

function respond(board: TransitBoard, method: string): Response {
  const headers = new Headers({
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_CONTROL,
  });
  const body = JSON.stringify(board);
  return new Response(method === "HEAD" ? null : body, { headers });
}

function fail(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify({ error, ...(message ? { message } : {}) }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleTransitBoard(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail(405, "method_not_allowed");
  }
  if (!env.MOBILITYTWIN_TOKEN) {
    return fail(503, "not_configured", "MOBILITYTWIN_TOKEN is not set.");
  }

  const cached = await env.BETTER_INTRA_KV.get<TransitBoard>(BOARD_KEY, {
    type: "json",
    cacheTtl: 30,
  });
  const board =
    cached && Array.isArray(cached.stops) ? (cached as TransitBoard) : null;

  if (board && Date.now() - board.updatedAt < FRESH_MS) {
    return respond(board, request.method);
  }

  try {
    return respond(await refreshOnce(env), request.method);
  } catch (e) {
    // Keep the board usable: a minute-old departure list beats an error.
    if (board) return respond(board, request.method);
    return fail(
      503,
      "upstream_unavailable",
      e instanceof Error ? e.message : String(e),
    );
  }
}
