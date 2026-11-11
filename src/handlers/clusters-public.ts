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
  { key: "computer", label: "Computer", kind: "presence" },
  { key: "boot", label: "Power", severity: "blocking", kind: "defect" },
  { key: "network", label: "Network", severity: "blocking", kind: "defect" },
  { key: "keyboard", label: "Keyboard", severity: "minor", kind: "defect" },
  {
    key: "mouse_scroll",
    label: "Mouse scroll",
    severity: "minor",
    kind: "defect",
  },
  { key: "usbc", label: "USB-C", kind: "presence" },
] as const;

/** Matches the extension's catalog (`src/features/clusters/map-dialog/components.ts`). */
const SEVERITY: Record<string, "blocking" | "minor" | "presence"> = {
  computer: "presence",
  boot: "blocking",
  network: "blocking",
  keyboard: "minor",
  mouse_scroll: "minor",
  usbc: "presence",
};

const LABELS: Record<string, string> = {
  computer: "Computer",
  boot: "Power",
  network: "Network",
  keyboard: "Keyboard",
  mouse_scroll: "Mouse scroll",
};

const LABEL_ORDER = ["boot", "network", "keyboard", "mouse_scroll"];

export type MapView = "default" | "issues" | "broken" | "usbc" | "plain";
export const MAP_VIEWS: readonly MapView[] = [
  "default",
  "issues",
  "broken",
  "usbc",
  "plain",
];

/** Views with a dedicated JSON feed (`/clusters/belgium/{view}`). */
export const DATA_VIEWS = ["issues", "broken", "usbc"] as const;
export type DataView = (typeof DATA_VIEWS)[number];

interface ViewLayers {
  crosses: boolean;
  warnings: boolean;
  usbc: boolean;
  /** Red tint on seats whose computer is broken (Power/Network). */
  tint: boolean;
}

const VIEW_LAYERS: Record<MapView, ViewLayers> = {
  default: { crosses: true, warnings: true, usbc: true, tint: true },
  issues: { crosses: true, warnings: true, usbc: false, tint: true },
  broken: { crosses: true, warnings: false, usbc: false, tint: false },
  usbc: { crosses: false, warnings: false, usbc: true, tint: false },
  plain: { crosses: false, warnings: false, usbc: false, tint: false },
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
  /** A report said this seat has no computer at all. */
  noComputer: boolean;
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

function isDataView(value: string): value is DataView {
  return (DATA_VIEWS as readonly string[]).includes(value);
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
    // A seat with no computer is crossed out: it cannot be used at all.
    const noComputer = components.some(
      (row) => row.component === "computer" && crossing(row),
    );
    if (blocking.length || minor.length || usbc || noComputer) {
      markers.set(host, { blocking, minor, noComputer, usbc });
    }
  }
  return markers;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Seat id, when the box comes from a rect/image with an id. */
  id?: string;
}

/** Compact legend geometry: same block on every map, whatever the view. */
const LEGEND_WIDTH = 142;
const LEGEND_ROW_HEIGHT = 16;
const LEGEND_PADDING = 8;
const LEGEND_MAX_ROWS = 5;
const LEGEND_HEIGHT =
  LEGEND_PADDING * 2 + LEGEND_MAX_ROWS * LEGEND_ROW_HEIGHT;
const LEGEND_GAP = 12;

/** `viewBox` of the map, with a sane fallback when it is missing. */
function svgViewBox(svg: string): ViewBox {
  const match = svg.match(/viewBox="([^"]+)"/i);
  if (match) {
    const [x, y, w, h] = (match[1] ?? "").trim().split(/[\s,]+/).map(Number);
    if ([x, y, w, h].every(Number.isFinite) && w! > 0 && h! > 0) {
      return { x: x!, y: y!, w: w!, h: h! };
    }
  }
  return { x: 0, y: 0, w: 1200, h: 800 };
}

/**
 * Boxes of what the map draws: rects, seat placeholders and text labels.
 * Labels matter because zone names sit outside the rooms, and the legend must
 * not cover them. Paths are ignored (walls/decoration stay inside the rooms).
 */
function occupiedBoxes(svg: string): ViewBox[] {
  const boxes: ViewBox[] = [];
  for (const match of svg.matchAll(/<(?:rect|image)\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of match[0].matchAll(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g,
    )) {
      attributes.set(attr[1].toLowerCase(), attr[2]);
    }
    let x = Number(attributes.get("x"));
    let y = Number(attributes.get("y"));
    const w = Number(attributes.get("width"));
    const h = Number(attributes.get("height"));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const translate = attributes
      .get("transform")
      ?.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
    if (translate) {
      x += Number(translate[1]);
      y += Number(translate[2]);
    }
    boxes.push({ x, y, w, h, id: attributes.get("id") ?? undefined });
  }
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of (match[1] ?? "").matchAll(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g,
    )) {
      attributes.set(attr[1].toLowerCase(), attr[2]);
    }
    const x = Number(attributes.get("x"));
    const y = Number(attributes.get("y"));
    if (![x, y].every(Number.isFinite)) continue;
    const size = Number(attributes.get("font-size")) || 14;
    const label = (match[2] ?? "").replace(/<[^>]*>/g, "").trim();
    const anchor = attributes.get("text-anchor") ?? "start";
    const width = Math.max(size, label.length * size * 0.56);
    const left =
      anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    // Text y is the baseline; approximate the box around the glyphs.
    boxes.push({ x: left, y: y - size, w: width, h: size * 1.25 });
  }
  return boxes;
}

/** Legend rows for the layers a view actually draws. */
function legendRows(
  layers: ViewLayers,
  svg: string,
): { icon: string; label: string }[] {
  // All swatches are drawn in the same 24×24 box so they line up.
  const rows: { icon: string; label: string }[] = [];
  if (layers.crosses) {
    rows.push({
      icon: '<path d="M5 5 19 19 M19 5 5 19" fill="none" stroke="#d9453f" stroke-width="2.4" stroke-linecap="round"/>',
      label: "No computer",
    });
  }
  if (layers.tint) {
    rows.push({
      icon: '<rect x="3" y="3" width="18" height="18" rx="3" fill="#d9453f" fill-opacity=".22" stroke="#d9453f" stroke-width="1.5"/>',
      label: "Broken computer",
    });
  }
  if (layers.warnings) {
    rows.push({
      icon: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" fill="none" stroke="#df9539" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9v4" stroke="#df9539" stroke-width="2" stroke-linecap="round"/><path d="M12 17h.01" stroke="#df9539" stroke-width="2" stroke-linecap="round"/>',
      label: "Keyboard / scroll",
    });
  }
  if (layers.usbc) {
    rows.push({
      icon: '<rect x="2" y="7" width="20" height="10" rx="5" fill="none" stroke="#38bdf8" stroke-width="1.6"/><rect x="7" y="11" width="10" height="2" rx="1" fill="#38bdf8"/>',
      label: "USB-C port",
    });
  }
  // Newer computers are baked into the base map, not a report layer.
  if (/seat-newer/.test(svg)) {
    rows.push({
      icon: '<rect x="3" y="3" width="18" height="18" rx="3" fill="#22c55e" fill-opacity=".3" stroke="#22c55e" stroke-width="1.5"/>',
      label: "Newer computer",
    });
  }
  return rows;
}

/** Leftmost/topmost empty rectangle inside the canvas, if any. */
function findFreeSpot(
  view: ViewBox,
  boxes: ViewBox[],
  width: number,
  height: number,
): { x: number; y: number } | null {
  const margin = 8;
  const step = 12;
  const pad = 4;
  const overlaps = (x: number, y: number): boolean =>
    boxes.some(
      (box) =>
        !(
          x + width + pad < box.x ||
          x > box.x + box.w + pad ||
          y + height + pad < box.y ||
          y > box.y + box.h + pad
        ),
    );
  let best: { x: number; y: number } | null = null;
  for (let y = view.y + margin; y + height <= view.y + view.h; y += step) {
    for (let x = view.x + margin; x + width <= view.x + view.w; x += step) {
      if (overlaps(x, y)) continue;
      if (!best || x < best.x || (x === best.x && y < best.y)) {
        best = { x, y };
      }
    }
  }
  return best;
}

/** Leftmost occupied x in a horizontal band (view right when the band is free). */
function bandFreeLeft(
  view: ViewBox,
  boxes: ViewBox[],
  height: number,
  y: number,
): number {
  let freeLeft = Infinity;
  for (const box of boxes) {
    if (box.y < y + height && box.y + box.h > y) {
      freeLeft = Math.min(freeLeft, box.x);
    }
  }
  // Empty band: it can host the legend at the left margin without growth.
  return Number.isFinite(freeLeft)
    ? freeLeft
    : view.x + 8 + LEGEND_GAP + LEGEND_WIDTH;
}

/**
 * Places the legend in free space around the drawn content: an empty rectangle
 * inside the canvas when one exists (leftmost first), otherwise on the left of
 * the content in the band with the most free room — growing the canvas to the
 * left if needed. It never covers seats or labels.
 */
function appendLegend(
  svg: string,
  rows: { icon: string; label: string }[],
  view: ViewBox,
  placement: LegendPlacement = "auto",
  boxes: ViewBox[] = occupiedBoxes(svg),
  anchorSeat?: string,
): string {
  const items = rows
    .map((row, index) => {
      const rowY = LEGEND_PADDING + index * LEGEND_ROW_HEIGHT;
      return (
        `<g transform="translate(${LEGEND_PADDING} ${rowY})">` +
        `<svg x="0" y="0" width="14" height="14" viewBox="0 0 24 24">${row.icon}</svg>` +
        `<text class="ft-legend-text" x="20" y="8" dominant-baseline="middle">${escapeXml(row.label)}</text>` +
        `</g>`
      );
    })
    .join("");

  const width = LEGEND_WIDTH;
  const height = LEGEND_HEIGHT;
  const gap = LEGEND_GAP;

  const canvas = { ...view };
  const seat = anchorSeat
    ? boxes.find((box) => box.id === anchorSeat)
    : undefined;
  const inside = findFreeSpot(view, boxes, width, height);
  let chosen: { x: number; y: number };
  if (seat) {
    // Explicit anchor: right under that seat, per the plan's free area.
    chosen = { x: seat.x, y: seat.y + seat.h + gap };
  } else if (inside && placement === "auto") {
    chosen = inside;
  } else if (placement === "right") {
    chosen = { x: view.x + view.w + gap, y: view.y };
  } else {
    const topY = view.y;
    const bottomY = view.y + view.h - height;
    const topLeft = bandFreeLeft(view, boxes, height, topY);
    const bottomLeft = bandFreeLeft(view, boxes, height, bottomY);
    const useTop =
      placement === "top-left" ||
      (placement === "auto" && topLeft >= bottomLeft);
    chosen = {
      x: Math.min(
        (useTop ? topLeft : bottomLeft) - gap - width,
        view.x + view.w - width,
      ),
      y: useTop ? topY : bottomY,
    };
  }
  if (chosen.x < view.x) {
    canvas.x = chosen.x;
    canvas.w = view.x + view.w - chosen.x;
  } else if (chosen.x + width > view.x + view.w) {
    canvas.w = chosen.x + width + gap - view.x;
  }
  if (chosen.y < view.y) {
    canvas.y = chosen.y;
    canvas.h = view.y + view.h - chosen.y;
  } else if (chosen.y + height > view.y + view.h) {
    canvas.h = chosen.y + height + gap - view.y;
  }

  const legend =
    `<g id="ft-legend" transform="translate(${round2(chosen.x)} ${round2(chosen.y)})">` +
    `<rect class="ft-legend-bg" width="${width}" height="${height}" rx="8"/>${items}</g>`;

  let out = svg.replace(
    /viewBox="[^"]*"/i,
    `viewBox="${round2(canvas.x)} ${round2(canvas.y)} ${round2(canvas.w)} ${round2(canvas.h)}"`,
  );

  // Keep explicit pixel dimensions in proportion to the new canvas.
  const root = out.match(/<svg\b[^>]*>/i)?.[0];
  if (root) {
    let tag = root;
    const width = root.match(/\bwidth="([\d.]+)"/i);
    if (width) {
      const value = Number(width[1]);
      if (Number.isFinite(value) && value > 0 && view.w > 0) {
        const scaled = Math.round(value * (canvas.w / view.w));
        tag = tag.replace(width[0], `width="${scaled}"`);
      }
    }
    const height = root.match(/\bheight="([\d.]+)"/i);
    if (height) {
      const value = Number(height[1]);
      if (Number.isFinite(value) && value > 0 && view.h > 0) {
        const scaled = Math.round(value * (canvas.h / view.h));
        tag = tag.replace(height[0], `height="${scaled}"`);
      }
    }
    out = out.replace(root, tag);
  }

  const closing = out.lastIndexOf("</svg>");
  return closing === -1
    ? out + legend
    : out.slice(0, closing) + legend + out.slice(closing);
}

/** Hand-tuned spot per map: the plans have room there, beside the labels. */
export const LEGEND_PLACEMENT: Record<
  MapId,
  { placement: LegendPlacement; below?: string }
> = {
  shi: { placement: "right" },
  fu: { placement: "auto", below: "fu-c1-p1" },
  mi: { placement: "auto" },
};

export type LegendPlacement =
  | "top-left"
  | "bottom-left"
  | "right"
  | "auto";

/** Applies the requested view's overlays to the seat `<image id>` placeholders. */
export function decorateMapSvg(
  svg: string,
  markers: Map<string, SeatMarkers>,
  view: MapView = "default",
  placement: LegendPlacement = "auto",
  anchorSeat?: string,
): string {
  if (markers.size === 0) return svg;

  const layers = VIEW_LAYERS[view];
  if (!layers.crosses && !layers.warnings && !layers.usbc && !layers.tint) {
    return svg;
  }

  const groups: string[] = [];
  let usedCross = false;
  let usedWarning = false;
  let usedUsbc = false;
  let usedTint = false;
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

    const crossed = issues.noComputer;
    const drawCross = layers.crosses && crossed;
    const drawTint = layers.tint && issues.blocking.length > 0 && !crossed;
    // Crossed (no computer) and red-tinted (broken) seats only show that: the
    // triangle is reserved for seats with non-blocking defects.
    const drawWarning =
      layers.warnings && !crossed && issues.blocking.length === 0 && issues.minor.length > 0;
    const drawUsbc = layers.usbc && issues.usbc;
    if (!drawCross && !drawTint && !drawWarning && !drawUsbc) continue;

    const x = Number(attributes.get("x"));
    const y = Number(attributes.get("y"));
    const w = Number(attributes.get("width"));
    const h = Number(attributes.get("height"));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;

    const transform = attributes.get("transform");
    const transformAttr = transform ? ` transform="${transform}"` : "";
    const minSide = Math.min(w, h);
    const titleParts: string[] = [];
    if (drawCross) titleParts.push("No computer");
    if (drawTint) titleParts.push(...issues.blocking);
    if (drawWarning) titleParts.push(...issues.minor);
    if (drawUsbc) titleParts.push("USB-C");
    const parts: string[] = [
      `<title>${escapeXml(host)} — ${escapeXml(titleParts.join(", "))}</title>`,
    ];

    if (drawTint) {
      usedTint = true;
      // Quiet red wash over the seat, like the app's broken-computer tint.
      const rx = attributes.get("rx");
      parts.push(
        `<rect class="ft-issue-broken" x="${round2(x)}" y="${round2(y)}" width="${round2(w)}" height="${round2(h)}"${rx ? ` rx="${escapeXml(rx)}"` : ""}/>`,
      );
    }

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
    (usedTint
      ? ".ft-issue-broken{fill:#d9453f;fill-opacity:.22;stroke:#d9453f;stroke-width:1.5;pointer-events:none}"
      : "") +
    (usedWarning ? ".ft-issue-warning{color:#df9539}" : "") +
    (usedUsbc ? ".ft-issue-usbc{color:#38bdf8}" : "");
  const rows = legendRows(layers, svg);
  const legendStyles = rows.length
    ? ".ft-legend-bg{fill:#fff;fill-opacity:.94;stroke:#d1d5db;stroke-width:1}.ft-legend-text{fill:#1f2937;font:10px system-ui,-apple-system,\"Segoe UI\",sans-serif}"
    : "";
  const block = `${styles || legendStyles ? `<style>${styles}${legendStyles}</style>` : ""}<g id="ft-issue-markers">${groups.join("")}</g>`;
  const closing = svg.lastIndexOf("</svg>");
  const decorated =
    closing === -1 ? svg + block : svg.slice(0, closing) + block + svg.slice(closing);
  return rows.length
    ? appendLegend(
        decorated,
        rows,
        svgViewBox(svg),
        placement,
        occupiedBoxes(svg),
        anchorSeat,
      )
    : decorated;
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
function seatIdsFromSvg(svg: string): Set<string> {  const ids = new Set<string>();
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

/** Shared "reports are down" response for the JSON resources. */
function reportsUnavailable(): Response {
  return jsonError(
    503,
    "reports_unavailable",
    "Seat reports are temporarily unavailable.",
    {},
    { "Retry-After": "15", "Cache-Control": "no-store" },
  );
}

/** Short per-seat summary used by both the discovery and the view feeds. */
function seatSummary(host: string, marker: SeatMarkers) {
  return {
    host,
    severity: marker.blocking.length
      ? ("blocking" as const)
      : marker.minor.length
        ? ("minor" as const)
        : null,
    issues: [...marker.blocking, ...marker.minor],
    ...(marker.noComputer ? { noComputer: true } : {}),
    ...(marker.usbc ? { usbc: true } : {}),
  };
}

function belongsToMap(host: string, id: MapId, seats: Set<string>): boolean {
  return seats.size > 0 ? seats.has(host) : host.startsWith(`${id}-`);
}

function matchesDataView(marker: SeatMarkers, view: DataView): boolean {
  if (view === "issues") {
    return marker.blocking.length > 0 || marker.minor.length > 0;
  }
  // "broken" is the crossed-out feed: seats with no computer.
  if (view === "broken") return marker.noComputer;
  return marker.usbc;
}

async function etagJsonResponse(
  request: Request,
  body: unknown,
): Promise<Response> {
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

  const legend = LEGEND_PLACEMENT[id];
  const body = decorateMapSvg(
    svg,
    markers,
    view,
    legend.placement,
    legend.below,
  );
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
    return reportsUnavailable();
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
      // Crossed seats are the ones without a computer.
      if (marker.noComputer) broken++;
      if (hasIssues) issues++;
      if (marker.usbc) usbc++;
      return seatSummary(host, marker);
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
  return etagJsonResponse(request, body);
}

export async function handleClusterView(
  request: Request,
  env: Env,
  campus: string,
  view: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method_not_allowed", "Only GET and HEAD.", {}, {
      Allow: "GET, HEAD",
    });
  }
  if (campus !== CAMPUS) {
    return jsonError(404, "campus_not_found", `Unknown campus: ${campus}.`);
  }
  if (!isDataView(view)) {
    return jsonError(404, "view_not_found", `Unknown view: ${view}.`, {
      allowed: DATA_VIEWS,
    });
  }

  let rows: SeatIssueRow[];
  try {
    rows = await loadRows(env);
  } catch {
    return reportsUnavailable();
  }

  const markers = markersByHost(rows);
  const newest = rows.reduce(
    (latest, row) => Math.max(latest, Number(row.updatedAt) || 0),
    0,
  );

  const seats: ({ map: MapId } & ReturnType<typeof seatSummary>)[] = [];
  for (const id of MAP_IDS) {
    const mapSeats = await seatIdsForMap(env, id);
    const entries = [...markers.entries()]
      .filter(([host]) => belongsToMap(host, id, mapSeats))
      .filter(([, marker]) => matchesDataView(marker, view))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [host, marker] of entries) {
      seats.push({ map: id, ...seatSummary(host, marker) });
    }
  }

  return etagJsonResponse(request, {
    campus: CAMPUS,
    view,
    updatedAt: newest * 1000,
    count: seats.length,
    seats,
  });
}
