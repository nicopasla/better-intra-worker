import type { Env } from "../types";

/** Max logins per request; matches the previous GET cap. */
export const FRIEND_LIMIT = 50;

/**
 * Profile fields (level, wallet, points, avatar, display name) live in the
 * shared `friend_profiles` table for an hour, so they can be stale by up to 1 h.
 */
export const FRIEND_PROFILE_TTL_SECONDS = 60 * 60;

/**
 * Online status is the only volatile part: a friend who left 20 minutes ago
 * must not keep a green dot, so seats are refreshed at most this often. The
 * refresh is batched across every user viewing friends in that window.
 */
export const FRIEND_LOCATION_TTL_SECONDS = 90;

const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Lowercase, dedupe and validate a login list from a POST body or GET param. */
export function normalizeLogins(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const login = raw.trim().toLowerCase();
    if (!LOGIN_RE.test(login)) continue;
    seen.add(login);
    if (seen.size >= FRIEND_LIMIT) break;
  }
  return [...seen];
}

/** Static part of a friend, everything except the current seat. */
export interface CachedFriendProfile {
  login: string;
  displayName: string;
  avatar: string | null;
  level: number;
  grade: string | null;
  wallet: number;
  correctionPoints: number;
  poolMonth: string | null;
  poolYear: string | null;
}

export interface FriendProfileRow {
  profile: CachedFriendProfile;
  cachedAt: number;
  location: string | null;
  locationAt: number | null;
}

/** `07/2024`-style pool label, shared by the response builder and tests. */
export function poolLabel(
  poolMonth: string | null,
  poolYear: string | null,
): string | null {
  if (!poolMonth || !poolYear) return null;
  return `${String(new Date(`${poolMonth} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${poolYear}`;
}

/** Extracts the cached profile fields from a `cursus_users` entry. */
export function pickProfileFields(entry: any): CachedFriendProfile | null {
  const user = entry?.user;
  if (!user?.login) return null;
  return {
    login: user.login,
    displayName: user.displayname ?? user.login,
    avatar: user.image?.versions?.small ?? user.image?.link ?? null,
    level: entry.level ?? 0,
    grade: entry.grade ?? null,
    wallet: user.wallet ?? 0,
    correctionPoints: user.correction_point ?? 0,
    poolMonth: user.pool_month ?? null,
    poolYear: user.pool_year ?? null,
  };
}

export function needsProfileRefresh(
  row: FriendProfileRow | undefined,
  nowSeconds: number,
): boolean {
  if (!row) return true;
  return nowSeconds - row.cachedAt >= FRIEND_PROFILE_TTL_SECONDS;
}

export function needsLocationRefresh(
  row: FriendProfileRow | undefined,
  nowSeconds: number,
): boolean {
  if (!row) return true;
  if (row.locationAt == null) return true;
  return nowSeconds - row.locationAt >= FRIEND_LOCATION_TTL_SECONDS;
}

let tableReady = false;

/**
 * Creates the shared profile table on demand, so a fresh database works without
 * a manual migration (same approach as `students_cache`).
 */
export async function ensureFriendProfilesTable(env: Env): Promise<void> {
  if (tableReady) return;
  await env.better_intra_d1
    .prepare(
      "CREATE TABLE IF NOT EXISTS friend_profiles (login_hash TEXT PRIMARY KEY, payload BLOB NOT NULL, cached_at INTEGER NOT NULL, location TEXT, location_at INTEGER)",
    )
    .run();
  tableReady = true;
}
