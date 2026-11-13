import { Env } from "../types";
import { corsHeaders } from "../utils";

/**
 * STIB/MIVB GTFS catalogue, cached in KV.
 *
 * The waiting-times feed only publishes line ids ("1", "38", …), so the mode
 * of a line (metro / tram / bus) and its official colour have to come from the
 * realtime operator feed's timetable. `routes.txt` carries both: `route_type`
 * and `route_color`, which is the only source that stays right when the
 * network changes.
 *
 * `GET /api/v1/public/transit/lines` exposes the parsed catalogue.
 */

const UPSTREAM = "https://api.mobilitytwin.brussels";
const ZIP_PATH = "/stib/gtfs";
const LINES_KEY = "STIB_GTFS_LINES";
/** The GTFS archive is republished daily but the network changes weekly. */
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const LINES_TTL_SECS = 30 * 24 * 60 * 60;
const ZIP_TIMEOUT_MS = 20_000;
const CACHE_HEADER = "public, max-age=3600, stale-while-revalidate=86400";

export interface StibLine {
  lineId: string;
  mode: "metro" | "tram" | "bus";
  /** GTFS `route_type`, kept verbatim for clients that need the raw value. */
  routeType: number;
  name: string | null;
  /** `#rrggbb`, when the feed provides one. */
  color: string | null;
  textColor: string | null;
}

export interface StibLines {
  updatedAt: number;
  source: string;
  feedVersion: string | null;
  feedStartDate: string | null;
  feedEndDate: string | null;
  /** Keyed by line id (`route_short_name`). */
  lines: Record<string, StibLine>;
}

/** GTFS `route_type` → the three modes the PWA draws. */
export function modeFromRouteType(
  routeType: number,
): "metro" | "tram" | "bus" {
  // GTFS core types used by STIB: 0 = tram, 1 = subway, 3 = bus.
  if (routeType === 0) return "tram";
  if (routeType === 1) return "metro";
  return "bus";
}

/** Minimal CSV reader: quoted fields, `""` escapes and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function color(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null;
}

/** Builds the line catalogue from `routes.txt` (+ `feed_info.txt` when present). */
export function buildLines(
  routesCsv: string,
  feedInfoCsv: string | null,
  updatedAt = Date.now(),
): StibLines {
  const [header, ...rows] = parseCsv(routesCsv);
  const index = new Map<string, number>();
  (header ?? []).forEach((name, position) => {
    index.set(name.trim().toLowerCase(), position);
  });
  const cell = (row: string[], name: string): string => {
    const position = index.get(name);
    return position == null ? "" : (row[position] ?? "").trim();
  };

  const lines: Record<string, StibLine> = {};
  for (const row of rows) {
    if (row.length === 0) continue;
    const lineId = cell(row, "route_short_name") || cell(row, "route_id");
    if (!lineId) continue;
    const routeType = Number(cell(row, "route_type"));
    if (!Number.isFinite(routeType)) continue;
    if (lines[lineId]) continue;
    lines[lineId] = {
      lineId,
      mode: modeFromRouteType(routeType),
      routeType,
      name: cell(row, "route_long_name") || null,
      color: color(cell(row, "route_color")),
      textColor: color(cell(row, "route_text_color")),
    };
  }

  let feedVersion: string | null = null;
  let feedStartDate: string | null = null;
  let feedEndDate: string | null = null;
  if (feedInfoCsv) {
    const [feedHeader, ...feedRows] = parseCsv(feedInfoCsv);
    const position = new Map<string, number>();
    (feedHeader ?? []).forEach((name, index) => {
      position.set(name.trim().toLowerCase(), index);
    });
    const feed = feedRows[0] ?? [];
    const field = (name: string): string | null => {
      const at = position.get(name);
      const value = at == null ? "" : (feed[at] ?? "").trim();
      return value || null;
    };
    feedVersion = field("feed_version");
    feedStartDate = field("feed_start_date");
    feedEndDate = field("feed_end_date");
  }

  return {
    updatedAt,
    source: "mobilitytwin.brussels /stib/gtfs",
    feedVersion,
    feedStartDate,
    feedEndDate,
    lines,
  };
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("gtfs zip: end of central directory not found");
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads one file out of a ZIP archive (central directory + deflate/stored). */
export async function readZipEntry(
  buffer: ArrayBuffer,
  wanted: string,
): Promise<Uint8Array | null> {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const end = findEndOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      new Uint8Array(buffer, offset + 46, nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = new Uint8Array(buffer, dataStart, compressedSize);
    if (method === 0) return data;
    if (method === 8) return inflate(data);
    throw new Error(`gtfs zip: unsupported compression method ${method}`);
  }
  return null;
}

async function downloadLines(env: Env): Promise<StibLines> {
  const token = env.MOBILITYTWIN_TOKEN;
  if (!token) throw new Error("MOBILITYTWIN_TOKEN is not set");
  const res = await fetch(`${UPSTREAM}${ZIP_PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(ZIP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mobilitytwin ${ZIP_PATH}: HTTP ${res.status}`);

  const buffer = await res.arrayBuffer();
  const routes = await readZipEntry(buffer, "routes.txt");
  if (!routes) throw new Error("gtfs zip: routes.txt not found");
  const feedInfo = await readZipEntry(buffer, "feed_info.txt");
  const decoder = new TextDecoder();
  return buildLines(
    decoder.decode(routes),
    feedInfo ? decoder.decode(feedInfo) : null,
  );
}

/** KV-backed catalogue; refreshed after a week, stale copies survive failures. */
export async function loadStibLines(env: Env): Promise<StibLines> {
  const cached = await env.BETTER_INTRA_KV.get<StibLines>(LINES_KEY, {
    type: "json",
    cacheTtl: 60,
  });
  if (cached?.lines && Date.now() - cached.updatedAt < REFRESH_MS) {
    return cached;
  }

  try {
    const lines = await downloadLines(env);
    if (Object.keys(lines.lines).length === 0) return cached ?? lines;
    await env.BETTER_INTRA_KV.put(LINES_KEY, JSON.stringify(lines), {
      expirationTtl: LINES_TTL_SECS,
    });
    return lines;
  } catch (e) {
    if (cached?.lines) return cached;
    throw e;
  }
}

export async function handleStibLines(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const catalogue = await loadStibLines(env);
    const lines = Object.values(catalogue.lines).sort((a, b) => {
      const order = { metro: 0, tram: 1, bus: 2 };
      const mode = order[a.mode] - order[b.mode];
      return mode !== 0
        ? mode
        : a.lineId.localeCompare(b.lineId, undefined, { numeric: true });
    });
    const body = JSON.stringify({
      updatedAt: catalogue.updatedAt,
      source: catalogue.source,
      feed: {
        version: catalogue.feedVersion,
        startDate: catalogue.feedStartDate,
        endDate: catalogue.feedEndDate,
      },
      lines,
    });
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": CACHE_HEADER,
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: "gtfs_unavailable",
        message: e instanceof Error ? e.message : String(e),
      }),
      {
        status: 503,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
