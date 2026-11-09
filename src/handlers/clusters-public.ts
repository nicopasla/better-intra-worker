import { Env } from "../types";
import { corsHeaders } from "../utils";
import { SEAT_REPORT_CAMPUS } from "./seat-reports";

/**
 * Public cluster API.
 *
 * - `GET /api/v1/public/clusters/belgium` returns the maps, the current issues
 *   per seat and links to every render variant.
 * - `GET /api/v1/public/clusters/belgium/{shi|fu|mi}.svg?view=` returns the map
 *   with the requested markers baked in, so it works as a plain `<img>`.
 *
 * Only the Belgium room maps are exposed. `seat_components` is queried without
 * ever writing a reporter login into the response.
 */

const CAMPUS = "belgium";
const MAP_IDS = ["shi", "fu", "mi"] as const;
type MapId = (typeof MAP_IDS)[number];
const MAP_NAMES: Record<MapId, string> = { shi: "SHI", fu: "FU", mi: "MI" };
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const CACHE_HEADER = "public, max-age=60, stale-while-revalidate=300";
/** Same upstreams as the `/gh/` proxy, used when the R2 copy is missing. */
const SVG_SOURCES = [
  "https://raw.githubusercontent.com/nicopasla/better-intra/main",
  "https://cdn.jsdelivr.net/gh/nicopasla/better-intra@main",
];

/** Self-describing component catalog returned by the discovery endpoint. */
const COMPONENT_CATALOG = [
  { key: "boot", label: "Power", severity: "blocking", kind: "defect" },
  { key: "network", label: "Network", severity: "blocking", kind: "defect" },
  { key: "keyboard", label: "Keyboard", severity: "minor", kind: "defect" },
  {
    key: "mouse_scroll",
    label: "Mouse scroll",
    severity: "minor",
    kind: "defect",
  },
  { key: "audio", label: "Audio", severity: "minor", kind: "defect" },
  { key: "usbc", label: "USB-C", kind: "presence" },
] as const;

/** Matches the extension's catalog (`src/features/clusters/map-dialog/components.ts`). */
const SEVERITY: Record<string, "blocking" | "minor" | "presence"> = {
  boot: "blocking",
  network: "blocking",
  keyboard: "minor",
  mouse_scroll: "minor",
  audio: "minor",
  usbc: "presence",
};

const LABELS: Record<string, string> = {
  boot: "Power",
  network: "Network",
  keyboard: "Keyboard",
  mouse_scroll: "Mouse scroll",
  audio: "Audio",
};

const LABEL_ORDER = ["boot", "network", "keyboard", "mouse_scroll", "audio"];

export type MapView = "default" | "issues" | "broken" | "usbc" | "plain";
export const MAP_VIEWS: readonly MapView[] = [
  "default",
  "issues",
  "broken",
  "usbc",
  "plain",
];

interface ViewLayers {
  crosses: boolean;
  warnings: boolean;
  usbc: boolean;
}

const VIEW_LAYERS: Record<MapView, ViewLayers> = {
  default: { crosses: true, warnings: true, usbc: true },
  issues: { crosses: true, warnings: true, usbc: false },
  broken: { crosses: true, warnings: false, usbc: false },
  usbc: { crosses: false, warnings: false, usbc: true },
  plain: { crosses: false, warnings: false, usbc: false },
};

/** Parses `?view=`; omitted means `default`, anything unknown returns null. */
export function parseView(raw: string | null): MapView | null {
  if (raw === null) return "default";
  const value = raw.trim().toLowerCase();
  return (MAP_VIEWS as readonly string[]).includes(value)
    ? (value as MapView)
    : null;
}

interface SeatIssueRow {
  host: string;
  component: string;
  status: string;
  reporter: string | null;
  updatedAt: number;
}

export interface SeatMarkers {
  blocking: string[];
  minor: string[];
  /** A report said this seat has a USB-C port. */
  usbc: boolean;
}

function round2(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function isMapId(value: string): value is MapId {
  return (MAP_IDS as readonly string[]).includes(value);
}

/**
 * Groups the flat rows per seat. Both lists are kept even when a seat is
 * crossed, so the discovery endpoint can report every broken component; the
 * SVG renderer suppresses the triangle on a crossed seat itself.
 *
 * A legacy anonymous Power/Network row is ignored when a signed-in user
 * confirmed the USB-C port on that seat (the stale test rows), exactly like the
 * extension.
 */
export function markersByHost(rows: SeatIssueRow[]): Map<string, SeatMarkers> {
  const byHost = new Map<string, SeatIssueRow[]>();
  for (const row of rows ?? []) {
    if (!row || typeof row.host !== "string") continue;
    const host = normalizeHost(row.host);
    if (!host) continue;
    const list = byHost.get(host);
    if (list) list.push(row);
    else byHost.set(host, [row]);
  }

  const markers = new Map<string, SeatMarkers>();
  for (const [host, components] of byHost) {
    const attributedUsbcWorks = components.some(
      (row) =>
        row.component === "usbc" &&
        row.status === "works" &&
        typeof row.reporter === "string" &&
        row.reporter.trim() !== "",
    );
    const crossing = (row: SeatIssueRow): boolean =>
      row.status === "broken" &&
      (typeof row.reporter === "string" && row.reporter.trim() !== ""
        ? true
        : !attributedUsbcWorks);

    const blocking: string[] = [];
    const minor: string[] = [];
    for (const key of LABEL_ORDER) {
      const row = components.find((entry) => entry.component === key);
      if (!row || !crossing(row)) continue;
      const label = LABELS[key] ?? key;
      if (SEVERITY[key] === "blocking") blocking.push(label);
      else if (SEVERITY[key] === "minor") minor.push(label);
    }
    // Presence answer, not a defect: it never crosses a seat.
    const usbc = components.some(
      (row) => row.component === "usbc" && row.status === "works",
    );
    if (blocking.length || minor.length || usbc) {
      markers.set(host, { blocking, minor, usbc });
    }
  }
  return markers;
}

/** Applies the requested view's overlays to the seat `<image id>` placeholders. */
export function decorateMapSvg(
  svg: string,
  markers: Map<string, SeatMarkers>,
  view: MapView = "default",
): string {
  if (markers.size === 0) return svg;

  const layers = VIEW_LAYERS[view];
  if (!layers.crosses && !layers.warnings && !layers.usbc) return svg;

  const groups: string[] = [];
  let usedCross = false;
  let usedWarning = false;
  let usedUsbc = false;
  const imageTag = /<image\b[^>]*>/gi;
  for (const match of svg.matchAll(imageTag)) {
    const attributes = new Map<string, string>();
    for (const attr of match[0].matchAll(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g,
    )) {
      attributes.set(attr[1].toLowerCase(), attr[2]);
    }
    const rawId = attributes.get("id");
    if (!rawId) continue;
    const host = normalizeHost(rawId);
    const issues = markers.get(host);
    if (!issues) continue;

    const crossed = issues.blocking.length > 0;
    const drawCross = layers.crosses && crossed;
    const drawWarning =
      layers.warnings && !crossed && issues.minor.length > 0;
    const drawUsbc = layers.usbc && issues.usbc;
    if (!drawCross && !drawWarning && !drawUsbc) continue;

    const x = Number(attributes.get("x"));
    const y = Number(attributes.get("y"));
    const w = Number(attributes.get("width"));
    const h = Number(attributes.get("height"));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;

    const transform = attributes.get("transform");
    const transformAttr = transform ? ` transform="${transform}"` : "";
    const minSide = Math.min(w, h);
    const titleParts: string[] = [];
    if (layers.crosses) titleParts.push(...issues.blocking);
    if (layers.warnings && !crossed) titleParts.push(...issues.minor);
    if (drawUsbc) titleParts.push("USB-C");
    const parts: string[] = [
      `<title>${escapeXml(host)} — ${escapeXml(titleParts.join(", "))}</title>`,
    ];

    if (drawCross) {
      usedCross = true;
      // Same inset and stroke as the app's report cross.
      const inset = minSide * 0.18;
      const x1 = round2(x + inset);
      const y1 = round2(y + inset);
      const x2 = round2(x + w - inset);
      const y2 = round2(y + h - inset);
      parts.push(
        `<path class="ft-issue-cross" d="M ${x1} ${y1} L ${x2} ${y2} M ${x2} ${y1} L ${x1} ${y2}" stroke-width="2.2"/>`,
      );
    }

    if (drawWarning) {
      usedWarning = true;
      // Lucide `triangle-exclamation`, bottom-left like the app's warning glyph.
      const size = Math.max(8, Math.min(16, minSide * 0.35));
      const inset = Math.max(1, minSide * 0.1);
      const glyphX = round2(x + inset);
      const glyphY = round2(y + h - size - inset + size * 0.15);
      const scale = round2(size / 24);
      parts.push(
        `<g class="ft-issue-warning" transform="translate(${glyphX} ${glyphY}) scale(${scale})" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></g>`,
      );
    }

    if (drawUsbc) {
      usedUsbc = true;
      // Same glyph and position as the app, bottom-right of the seat.
      const size = Math.max(8, Math.min(16, minSide * 0.35));
      const inset = Math.max(1, minSide * 0.1);
      const glyphX = round2(x + w - size - inset);
      const glyphY = round2(y + h - size / 2 - inset);
      const scale = round2(size / 96);
      parts.push(
        `<g class="ft-issue-usbc" transform="translate(${glyphX} ${glyphY}) scale(${scale})" fill="none"><rect x="4" y="4" width="88" height="40" rx="20" stroke="currentColor" stroke-width="8"/><rect x="20" y="20" width="56" height="8" rx="4" fill="currentColor"/></g>`,
      );
    }

    groups.push(
      `<g${transformAttr} data-seat="${escapeXml(host)}">${parts.join("")}</g>`,
    );
  }

  if (groups.length === 0) return svg;

  const styles =
    (usedCross
      ? ".ft-issue-cross{fill:none;stroke:#d9453f;stroke-linecap:round}"
      : "") +
    (usedWarning ? ".ft-issue-warning{color:#df9539}" : "") +
    (usedUsbc ? ".ft-issue-usbc{color:#38bdf8}" : "");
  const block = `${styles ? `<style>${styles}</style>` : ""}<g id="ft-issue-markers">${groups.join("")}</g>`;
  const closing = svg.lastIndexOf("</svg>");
  if (closing === -1) return svg + block;
  return svg.slice(0, closing) + block + svg.slice(closing);
}

async function loadBaseSvg(env: Env, id: MapId): Promise<string | null> {
  try {
    const object = await env.better_intra_images.get(
      `campus-maps/${CAMPUS}/${id}.svg`,
    );
    if (object) {
      const text = await object.text();
      if (text) return text;
    }
  } catch {
    /* fall through to the repo copies */
  }

  for (const base of SVG_SOURCES) {
    try {
      const res = await fetch(`${base}/campuses/maps/${CAMPUS}/${id}.svg`);
      if (!res.ok) continue;
      const text = await res.text();
      if (text) return text;
    } catch {
      /* try the next mirror */
    }
  }
  return null;
}

/** Seat ids are the map's `<image id>` attributes. */
function seatIdsFromSvg(svg: string): Set<string> {
  const ids = new Set<string>();
  for (const match of svg.matchAll(/<image\b[^>]*\sid="([^"]+)"/gi)) {
    const id = normalizeHost(match[1] ?? "");
    if (id) ids.add(id);
  }
  return ids;
}

const seatIdCache = new Map<MapId, Set<string>>();

/** Parsed once per isolate; the maps do not change at runtime. */
async function seatIdsForMap(env: Env, id: MapId): Promise<Set<string>> {
  const cached = seatIdCache.get(id);
  if (cached) return cached;
  const svg = await loadBaseSvg(env, id);
  const ids = svg ? seatIdsFromSvg(svg) : new Set<string>();
  if (ids.size > 0) seatIdCache.set(id, ids);
  return ids;
}

function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag);
}

async function contentEtag(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(value) as BufferSource,
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function jsonError(
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonRes({ error, message, ...extra }, status, headers);
}

async function loadRows(env: Env): Promise<SeatIssueRow[]> {
  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT host, component, status, reporter, updated_at AS updatedAt
       FROM seat_components
       WHERE campus = ?`,
    )
    .bind(SEAT_REPORT_CAMPUS)
    .all<SeatIssueRow>();
  return results ?? [];
}

function viewUrls(origin: string, id: MapId): Record<MapView, string> {
  const base = `${origin}/api/v1/public/clusters/${CAMPUS}/${id}.svg`;
  return {
    default: base,
    issues: `${base}?view=issues`,
    broken: `${base}?view=broken`,
    usbc: `${base}?view=usbc`,
    plain: `${base}?view=plain`,
  };
}

export async function handleClusterMapView(
  request: Request,
  env: Env,
  campus: string,
  id: string,
): Promise<Response> {
  const methodAllowed = request.method === "GET" || request.method === "HEAD";
  if (!methodAllowed) {
    return jsonError(405, "method_not_allowed", "Only GET and HEAD.", {}, {
      Allow: "GET, HEAD",
    });
  }
  if (campus !== CAMPUS) {
    return jsonError(404, "campus_not_found", `Unknown campus: ${campus}.`);
  }
  if (!isMapId(id)) {
    return jsonError(404, "map_not_found", `Unknown map: ${id}.`);
  }
  const view = parseView(new URL(request.url).searchParams.get("view"));
  if (!view) {
    return jsonError(400, "invalid_view", "Unknown view.", {
      allowed: MAP_VIEWS,
    });
  }

  const svg = await loadBaseSvg(env, id);
  if (svg === null) return jsonError(404, "map_not_found", "Map unavailable.");
  if (svg.length > MAX_SVG_BYTES) {
    return jsonError(413, "map_too_large", "Map exceeds the size limit.");
  }
  if (!svg.toLowerCase().includes("<svg")) {
    return jsonError(502, "invalid_map", "Upstream body is not an SVG.");
  }

  let markers = new Map<string, SeatMarkers>();
  let version = "none";
  let maxAge = 60;
  // The plain map has no reports to load; skip D1 entirely.
  if (view !== "plain") {
    try {
      const rows = await loadRows(env);
      markers = markersByHost(rows);
      const newest = rows.reduce(
        (latest, row) => Math.max(latest, Number(row.updatedAt) || 0),
        0,
      );
      version = `${rows.length}-${newest}`;
    } catch {
      // Keep the map usable (unmarked) and let the next request retry soon.
      maxAge = 15;
    }
  }

  const body = decorateMapSvg(svg, markers, view);
  const etag = await contentEtag(`${version}\n${body}`);
  const headers = new Headers({
    ...corsHeaders,
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 5}`,
    ETag: etag,
  });

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === "HEAD" ? null : body, { headers });
}

export async function handleClustersIndex(
  request: Request,
  env: Env,
  campus: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method_not_allowed", "Only GET and HEAD.", {}, {
      Allow: "GET, HEAD",
    });
  }
  if (campus !== CAMPUS) {
    return jsonError(404, "campus_not_found", `Unknown campus: ${campus}.`);
  }

  let rows: SeatIssueRow[];
  try {
    rows = await loadRows(env);
  } catch {
    return jsonError(
      503,
      "reports_unavailable",
      "Seat reports are temporarily unavailable.",
      {},
      { "Retry-After": "15", "Cache-Control": "no-store" },
    );
  }

  const markers = markersByHost(rows);
  const newest = rows.reduce(
    (latest, row) => Math.max(latest, Number(row.updatedAt) || 0),
    0,
  );
  const origin = new URL(request.url).origin;

  const maps = [];
  for (const id of MAP_IDS) {
    const seats = await seatIdsForMap(env, id);
    const entries = [...markers.entries()]
      .filter(([host]) =>
        seats.size > 0 ? seats.has(host) : host.startsWith(`${id}-`),
      )
      .sort(([a], [b]) => a.localeCompare(b));

    let broken = 0;
    let issues = 0;
    let usbc = 0;
    const reported = entries.map(([host, marker]) => {
      const hasIssues = marker.blocking.length > 0 || marker.minor.length > 0;
      if (marker.blocking.length > 0) broken++;
      if (hasIssues) issues++;
      if (marker.usbc) usbc++;
      return {
        host,
        severity: marker.blocking.length
          ? "blocking"
          : marker.minor.length
            ? "minor"
            : null,
        issues: [...marker.blocking, ...marker.minor],
        ...(marker.usbc ? { usbc: true } : {}),
      };
    });

    maps.push({
      id,
      name: MAP_NAMES[id],
      counts: { broken, issues, usbc },
      views: viewUrls(origin, id),
      seats: reported,
    });
  }

  const body = {
    campus: CAMPUS,
    updatedAt: newest * 1000,
    views: MAP_VIEWS,
    components: COMPONENT_CATALOG,
    maps,
  };
  const serialized = JSON.stringify(body);
  const etag = await contentEtag(serialized);
  const headers = new Headers({
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_HEADER,
    ETag: etag,
  });

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === "HEAD" ? null : serialized, {
    headers,
  });
}
