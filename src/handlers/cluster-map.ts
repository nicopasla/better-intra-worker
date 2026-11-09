import { Env } from "../types";
import { corsHeaders, textRes } from "../utils";
import { SEAT_REPORT_CAMPUS } from "./seat-reports";

/**
 * Public cluster maps with the current reports baked in.
 *
 * The extension and the PWA paint crosses/triangles/USB-C glyphs over the SVG
 * at runtime. This endpoint composes the same overlays server-side so a plain
 * `<img>` (a README, a dashboard, a TV in the cluster) shows them without any
 * JS. `?layers=` selects them; the base seats are always drawn.
 *
 * Only the Belgium room maps are handled: the campus plan has no seat avatars
 * to anchor to. `seat_components` is queried without exposing reporter logins.
 */

const CAMPUS = "belgium";
const MAPS = new Set(["shi", "fu", "mi"]);
const MAX_SVG_BYTES = 2 * 1024 * 1024;
/** Same upstreams as the `/gh/` proxy, used when the R2 copy is missing. */
const SVG_SOURCES = [
  "https://raw.githubusercontent.com/nicopasla/better-intra/main",
  "https://cdn.jsdelivr.net/gh/nicopasla/better-intra@main",
];

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

interface SeatIssueRow {
  host: string;
  component: string;
  status: string;
  reporter: string | null;
  updatedAt: number;
}

interface SeatMarkers {
  blocking: string[];
  minor: string[];
  /** A signed-in or legacy report said this seat has a USB-C port. */
  usbc: boolean;
}

/** Overlays drawn on top of the base map (see `parseLayers`). */
export interface MapLayers {
  /** Crosses and warning triangles. */
  issues: boolean;
  /** Crosses only, for seats whose Power/Network is broken. */
  broken: boolean;
  usbc: boolean;
}

const DEFAULT_LAYERS: MapLayers = { issues: true, broken: false, usbc: true };

/**
 * Parses `?layers=`, a comma-separated list of overlays. The base map is
 * always drawn; `seats`/`none` exist so `?layers=seats` reads naturally.
 * `broken` is the cross-only subset (`issues` also draws warning triangles).
 * An empty value means "no overlays". Unknown tokens return `null` (400).
 */
export function parseLayers(raw: string | null): MapLayers | null {
  if (raw === null) return { ...DEFAULT_LAYERS };
  const layers: MapLayers = { issues: false, broken: false, usbc: false };
  for (const value of raw.split(",")) {
    const token = value.trim().toLowerCase();
    if (!token) continue;
    if (token === "issues") layers.issues = true;
    else if (token === "broken") layers.broken = true;
    else if (token === "usbc") layers.usbc = true;
    else if (token !== "seats" && token !== "none") return null;
  }
  return layers;
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

/**
 * Turns the flat rows into the markers each seat should show. A legacy
 * anonymous Power/Network row is ignored when a signed-in user confirmed the
 * USB-C port on that seat (the stale test rows), exactly like the extension.
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
    // A crossed seat never keeps the warning glyph: the cross already says the
    // computer is unusable, so the minor peripheral issues are not surfaced
    // (same rule as the extension and the PWA).
    if (blocking.length > 0) minor.length = 0;
    // Presence answer, not a defect: it never crosses a seat and does not
    // depend on the issue severity. Shown regardless of occupancy.
    const usbc = components.some(
      (row) => row.component === "usbc" && row.status === "works",
    );
    if (blocking.length || minor.length || usbc) {
      markers.set(host, { blocking, minor, usbc });
    }
  }
  return markers;
}

/** Applies the requested overlays to the SVG's seat `<image id=...>` placeholders. */
export function decorateMapSvg(
  svg: string,
  markers: Map<string, SeatMarkers>,
  layers: MapLayers = DEFAULT_LAYERS,
): string {
  if (markers.size === 0) return svg;

  const showCrosses = layers.issues || layers.broken;
  const showWarnings = layers.issues;
  const showUsbc = layers.usbc;
  if (!showCrosses && !showWarnings && !showUsbc) return svg;

  const groups: string[] = [];
  let usedCross = false;
  let usedWarning = false;
  let usedUsbc = false;
  const imageTag = /<image\b[^>]*>/gi;
  for (const match of svg.matchAll(imageTag)) {
    const attributes = new Map<string, string>();
    for (const attr of match[0].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)) {
      attributes.set(attr[1].toLowerCase(), attr[2]);
    }
    const rawId = attributes.get("id");
    if (!rawId) continue;
    const host = normalizeHost(rawId);
    const issues = markers.get(host);
    if (!issues) continue;

    const drawCross = showCrosses && issues.blocking.length > 0;
    const drawWarning = showWarnings && issues.minor.length > 0;
    const drawUsbc = showUsbc && issues.usbc;
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
    if (showCrosses) titleParts.push(...issues.blocking);
    if (showWarnings) titleParts.push(...issues.minor);
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

async function loadBaseSvg(env: Env, id: string): Promise<string | null> {
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

export async function handleClusterMap(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textRes("Method not allowed", 405);
  }
  if (!MAPS.has(id)) return textRes("Not found", 404);

  const layers = parseLayers(new URL(request.url).searchParams.get("layers"));
  if (!layers) return textRes("Invalid layers parameter", 400);

  const svg = await loadBaseSvg(env, id);
  if (svg === null) return textRes("Map not found", 404);
  if (svg.length > MAX_SVG_BYTES) return textRes("Map too large", 413);
  if (!svg.toLowerCase().includes("<svg")) return textRes("Not an SVG", 502);

  let markers = new Map<string, SeatMarkers>();
  let version = "none";
  let maxAge = 60;
  // The plain map has no reports to load; skip D1 entirely.
  if (layers.issues || layers.broken || layers.usbc) {
    try {
      const { results } = await env.better_intra_d1
        .prepare(
          `SELECT host, component, status, reporter, updated_at AS updatedAt
           FROM seat_components
           WHERE campus = ?`,
        )
        .bind(SEAT_REPORT_CAMPUS)
        .all<SeatIssueRow>();
      const rows = results ?? [];
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

  const body = decorateMapSvg(svg, markers, layers);
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
