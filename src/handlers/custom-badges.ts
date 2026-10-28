import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";

/**
 * Admin-granted profile badges ("role-style" chips).
 *
 * One D1 row per badge, holding the logins that own it:
 *
 *   badge   | label   | color   | icon | tooltip        | sort | logins
 *   example | Example | #3366cc | ★    | Fixture badge  | 10   | user-one,user-two
 *
 * Rows are written only by hand (`wrangler d1 execute --remote`), so there is
 * no write endpoint and no admin UI: every client can read, nobody can grant
 * through the API. Badges render next to the 42 role badges on a profile.
 */

export interface CustomBadge {
  id: string;
  label: string;
  color: string | null;
  icon: string | null;
  tooltip: string | null;
}

interface BadgeRow {
  badge: string;
  label: string;
  color: string | null;
  icon: string | null;
  tooltip: string | null;
  logins: string | null;
}

interface BadgeWithOwners extends CustomBadge {
  logins: string[];
}

const CACHE_KEY = "CUSTOM_BADGES_TABLE";
const CACHE_TTL_SECONDS = 60;
const MAX_LABEL_LENGTH = 32;
const MAX_TOOLTIP_LENGTH = 160;
const MAX_LOGINS = 2000;

/** Splits the `logins` column: a JSON array, or comma/space separated logins. */
export function parseLogins(raw: string | null | undefined): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];

  let parts: string[] = [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) parts = parsed.map((v) => String(v));
    } catch {
      return [];
    }
  } else {
    parts = value.split(/[\s,;]+/);
  }

  const seen = new Set<string>();
  for (const part of parts) {
    const login = part.trim().toLowerCase();
    if (login) seen.add(login);
    if (seen.size >= MAX_LOGINS) break;
  }
  return [...seen];
}

/** Trims a D1 row into a badge, dropping rows without a usable label. */
export function normalizeBadgeRow(row: BadgeRow): BadgeWithOwners | null {
  const id = String(row.badge ?? "").trim();
  const label = String(row.label ?? "").trim();
  if (!id || !label) return null;

  const color = String(row.color ?? "").trim();
  const icon = String(row.icon ?? "").trim();
  const tooltip = String(row.tooltip ?? "").trim();

  return {
    id,
    label: label.slice(0, MAX_LABEL_LENGTH),
    // Only hex colours reach the client; anything else falls back to the theme.
    color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
    icon: icon || null,
    tooltip: tooltip ? tooltip.slice(0, MAX_TOOLTIP_LENGTH) : null,
    logins: parseLogins(row.logins),
  };
}

export function normalizeBadges(
  rows: BadgeRow[] | null | undefined,
): BadgeWithOwners[] {
  const badges: BadgeWithOwners[] = [];
  for (const row of rows ?? []) {
    const badge = normalizeBadgeRow(row);
    if (badge) badges.push(badge);
  }
  return badges;
}

/** Every badge and its owners, cached for a minute (the table is tiny). */
async function readBadgeTable(env: Env): Promise<BadgeWithOwners[]> {
  try {
    const cached = await env.BETTER_INTRA_KV.get<BadgeWithOwners[]>(CACHE_KEY, {
      type: "json",
    });
    if (Array.isArray(cached)) return cached;
  } catch {
    /* fall through to D1 */
  }

  try {
    const { results } = await env.better_intra_d1
      .prepare(
        "SELECT badge, label, color, icon, tooltip, logins FROM custom_badges ORDER BY sort, label",
      )
      .all<BadgeRow>();
    const badges = normalizeBadges(results);
    await env.BETTER_INTRA_KV.put(CACHE_KEY, JSON.stringify(badges), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
    return badges;
  } catch {
    // Table missing (schema not applied yet) or D1 hiccup: badges are optional.
    return [];
  }
}

/** Badges granted to `login`, without leaking the other owners' logins. */
export async function readCustomBadges(
  env: Env,
  login: string,
): Promise<CustomBadge[]> {
  const target = login.trim().toLowerCase();
  if (!target) return [];

  const table = await readBadgeTable(env);
  return table
    .filter((badge) => badge.logins.includes(target))
    .map(({ logins: _logins, ...badge }) => badge);
}

export async function handleCustomBadges(
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

  const target = new URL(request.url).searchParams.get("target")?.trim();
  if (!target) return textRes("Missing target parameter", 400);

  return jsonRes({ badges: await readCustomBadges(env, target) });
}
