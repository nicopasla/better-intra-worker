import { UAParser } from "ua-parser-js";
import {
  Env,
  UserData,
  TokenResponse,
  ProjectResponse,
  SessionMeta,
  SessionActivity,
} from "./types";
import { APP_TOKEN_CACHE, SESSION_ACTIVITY_PREFIX } from "./constants";
import { fetchIntra } from "./rate";

export const MAX_SESSION_TOKENS = 20;

/** Minimum interval between activity writes for a session (5 minutes). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const SESSION_ACTIVITY_TTL = 90 * 24 * 60 * 60;

/** Consecutive token failures tolerated before a user is marked broken. */
export const MAX_TOKEN_FAILURES = 5;

export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const { browser, os } = new UAParser(ua).getResult();
  const major = browser.major || browser.version?.split(".")[0];
  const browserLabel = major ? `${browser.name} ${major}` : browser.name;
  return `${browserLabel || "Browser"} · ${os.name || "Unknown OS"}`.slice(
    0,
    40,
  );
}

export function sanitizeDeviceName(
  value: string | null | undefined,
): string | undefined {
  if (!value || !/^[A-Za-z ]{1,32}$/.test(value)) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

/**
 * Stable per-device identity for grouping/reusing sessions. Prefers the
 * user-chosen device name, falling back to the parsed User-Agent label so
 * entries created before device names existed still collapse together.
 */
export function sessionDeviceKey(meta: SessionMeta | undefined): string {
  if (!meta) return "";
  return (meta.name || meta.label || "").trim().toLowerCase();
}

export function getSessionActivityKey(hash: string): string {
  return `${SESSION_ACTIVITY_PREFIX}${hash}`;
}

export async function getSessionActivity(
  env: Env,
  hash: string,
): Promise<SessionActivity> {
  return (
    (await env.BETTER_INTRA_KV.get<SessionActivity>(
      getSessionActivityKey(hash),
      { type: "json" },
    )) || {}
  );
}

export function sessionLastUsed(
  activity: SessionActivity,
  token: string,
  meta: SessionMeta | undefined,
): number {
  return activity[token] ?? meta?.lastUsedAt ?? meta?.createdAt ?? 0;
}

export async function writeSessionActivity(
  env: Env,
  hash: string,
  activity: SessionActivity,
): Promise<void> {
  await env.BETTER_INTRA_KV.put(
    getSessionActivityKey(hash),
    JSON.stringify(activity),
    { expirationTtl: SESSION_ACTIVITY_TTL },
  );
}

/**
 * Best-effort refresh of a session's last-used timestamp. Throttled so we do
 * not write to KV on every request, and stored under its own key so it never
 * races a concurrent settings write on the main UserData blob.
 */
export async function touchSession(
  env: Env,
  hash: string,
  data: UserData | null,
  bearer: string,
): Promise<void> {
  if (!data || !bearer) return;
  if (!getTokens(data).includes(bearer)) return;
  const activity = await getSessionActivity(env, hash);
  const now = Date.now();
  if (activity[bearer] && now - activity[bearer] < SESSION_TOUCH_INTERVAL_MS) {
    return;
  }
  activity[bearer] = now;
  await writeSessionActivity(env, hash, activity);
}

export async function sessionIdForToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(`session:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function serializeUserData(data: UserData): string {
  const { sessionToken: _legacy, ...rest } = data;
  return JSON.stringify({
    ...rest,
    sessionTokens: getTokens(data),
    settings: data.settings || {},
  });
}

export function getCallbackUrl(
  request: Request,
  env?: { CALLBACK_URL?: string },
): string {
  const base = env?.CALLBACK_URL?.replace(/\/+$/, "");
  if (base) return `${base}/callback`;
  const url = new URL(request.url);
  return `${url.origin}/callback`;
}

const ALLOWED_ORIGINS = [
  "https://profile-v3.intra.42.fr",
  "https://meta.intra.42.fr",
  "https://mobile.betterintra.com",
];

export function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function isOriginAllowed(
  origin: string,
  allowLocalDev = false,
): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("moz-extension://")) return true;
  if (/^https:\/\/(?:[a-z0-9-]+\.)*intra\.42\.fr$/.test(origin)) return true;
  if (allowLocalDev && isLocalDevOrigin(origin)) return true;
  return false;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const textRes = (
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
) =>
  new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });

export function getBearerToken(request: Request): string | null {
  return (
    request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
  );
}

export function validateSession(
  existingData: { sessionTokens?: string[]; sessionToken?: string },
  token: string,
): boolean {
  const tokens = getTokens(existingData);
  return tokens.includes(token);
}

export const getTokens = (data: any): string[] =>
  Array.isArray(data?.sessionTokens)
    ? data.sessionTokens
    : typeof data?.sessionToken === "string"
      ? [data.sessionToken]
      : [];

export async function hashLogin(login: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(login.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const pendingTokens = new WeakMap<Env, Promise<string>>();

export async function getAppToken(env: Env): Promise<string> {
  const cached = await env.BETTER_INTRA_KV.get<{
    token: string;
    expires: number;
  }>(APP_TOKEN_CACHE, { type: "json" });

  if (cached && Date.now() < cached.expires) {
    return cached.token;
  }

  if (pendingTokens.has(env)) {
    return pendingTokens.get(env)!;
  }

  const promise = (async () => {
    const res = await fetchIntra(env, "https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
      }),
    });

    if (!res.ok) throw new Error("Failed to get app token");

    const data = (await res.json()) as TokenResponse;
    const token = data.access_token;
    if (!token) throw new Error("Missing access_token in app token response");
    const expiresIn = Math.max(60, (data.expires_in ?? 7200) - 60);
    const expires = Date.now() + expiresIn * 1000;

    await env.BETTER_INTRA_KV.put(
      APP_TOKEN_CACHE,
      JSON.stringify({ token, expires }),
      { expirationTtl: expiresIn },
    );

    return token;
  })();

  pendingTokens.set(env, promise);
  try {
    return await promise;
  } finally {
    pendingTokens.delete(env);
  }
}

export interface CursusInfo {
  name: string;
  slug: string;
  kind?: string;
}

const CURSUS_CACHE_TTL = 30 * 24 * 60 * 60;

export async function getCursusMap(
  env: Env,
): Promise<Record<number, CursusInfo>> {
  const { results } = await env.better_intra_d1
    .prepare("SELECT id, name, slug, kind, cached_at FROM cursus")
    .all<{
      id: number;
      name: string;
      slug: string;
      kind: string;
      cached_at: number;
    }>();

  const map: Record<number, CursusInfo> = {};
  for (const row of results) {
    map[row.id] = { name: row.name, slug: row.slug, kind: row.kind };
  }

  const newest = results.reduce((max, r) => Math.max(max, r.cached_at), 0);
  if (results.length > 0 && newest > Date.now() / 1000 - CURSUS_CACHE_TTL) {
    return map;
  }

  try {
    const token = await getAppToken(env);
    const stmts: D1PreparedStatement[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(
        `https://api.intra.42.fr/v2/cursus?page[size]=100&page[number]=${page}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) break;
      const rows = (await res.json()) as Array<{
        id: number;
        name: string;
        slug: string;
        kind?: string;
      }>;
      if (rows.length === 0) break;
      for (const c of rows) {
        map[c.id] = { name: c.name, slug: c.slug, kind: c.kind };
        stmts.push(
          env.better_intra_d1
            .prepare(
              "INSERT OR REPLACE INTO cursus (id, name, slug, kind) VALUES (?, ?, ?, ?)",
            )
            .bind(c.id, c.name, c.slug, c.kind ?? null),
        );
      }
      if (rows.length < 100) break;
    }
    if (stmts.length > 0) await env.better_intra_d1.batch(stmts);
  } catch (e) {
    console.warn("[getCursusMap] fetch failed:", e);
  }
  return map;
}

export async function updateProjectMap(env: Env, appToken: string) {
  let allProjects: any[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.intra.42.fr/v2/projects?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${appToken}` },
      },
    );

    if (!res.ok) return;

    const projects = (await res.json()) as ProjectResponse[];
    if (projects.length === 0) break;

    allProjects = allProjects.concat(projects);
    page++;
  }

  const batchSize = 100;
  for (let i = 0; i < allProjects.length; i += batchSize) {
    const batch = allProjects
      .slice(i, i + batchSize)
      .map((p) =>
        env.better_intra_d1
          .prepare(
            "INSERT OR REPLACE INTO projects (id, name, slug) VALUES (?, ?, ?)",
          )
          .bind(p.id, p.name, p.slug),
      );
    await env.better_intra_d1.batch(batch);
  }
}

const keyCache = new WeakMap<Env, CryptoKey>();

async function getEncryptionKey(env: Env): Promise<CryptoKey> {
  const cached = keyCache.get(env);
  if (cached) return cached;

  const keyBase64 = env.TOKEN_ENCRYPTION_KEY;
  if (!keyBase64) throw new Error("TOKEN_ENCRYPTION_KEY not set");

  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  keyCache.set(env, key);
  return key;
}

export async function encryptTokenData(
  env: Env,
  data: object,
): Promise<string> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTokenData<T = Record<string, unknown>>(
  env: Env,
  encrypted: string,
): Promise<T> {
  const key = await getEncryptionKey(env);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

/**
 * Encrypt a UTF-8 string and return the raw `iv || ciphertext` bytes, meant to
 * be stored in a D1 BLOB column. Unlike encryptTokenData this avoids the
 * base64 round-trip, so large payloads (e.g. the student roster cache) do not
 * inflate by ~33% or risk blowing the call stack in String.fromCharCode.
 */
export async function encryptBytes(
  env: Env,
  plaintext: string,
): Promise<Uint8Array> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return combined;
}

/**
 * Decrypt an `iv || ciphertext` BLOB back to a UTF-8 string. Legacy plaintext
 * rows (pre-migration) are returned untouched so reads keep working during a
 * lazy migration; null/undefined and undecryptable values return null.
 */
export async function decryptBytes(
  env: Env,
  value: ArrayBuffer | Uint8Array | string | null | undefined,
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;

  const combined = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (combined.byteLength <= 12) return null;

  const key = await getEncryptionKey(env);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

export type TokenFailureReason = "reconnect" | "transient";

export interface TokenFailure {
  reason: TokenFailureReason;
  detail: string;
}

export type TokenResult = { token: string } | { failure: TokenFailure };

const reconnect = (detail: string): TokenResult => ({
  failure: { reason: "reconnect", detail },
});
const transient = (detail: string): TokenResult => ({
  failure: { reason: "transient", detail },
});

const inflightRefreshes = new Map<string, Promise<TokenResult>>();

/**
 * Resolves a usable 42 user token, classifying failures so callers can respond
 * with the right HTTP status:
 *  - `reconnect` → the user's token is gone/invalid and they must re-auth (401)
 *  - `transient` → temporary (Cloudflare challenge, rate limit, 5xx, network) (503)
 *
 * Concurrent calls for the same login within an isolate share one resolution,
 * since 42 refresh tokens are single-use/rotating (racing them 401s).
 */
export interface ResolveTokenOptions {
  /** Refresh even if still valid, once fewer than this many ms remain. */
  refreshWithinMs?: number;
  /** Never hit the refresh endpoint — return cached, or transient if expired. */
  noRefresh?: boolean;
}

export function resolveUserToken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
  country?: string | null,
  opts?: ResolveTokenOptions,
): Promise<TokenResult> {
  const existing = inflightRefreshes.get(loginParam);
  if (existing) return existing;
  const promise = resolveUserTokenInner(
    env,
    userData,
    loginParam,
    country,
    opts,
  ).finally(() => inflightRefreshes.delete(loginParam));
  inflightRefreshes.set(loginParam, promise);
  return promise;
}

async function resolveUserTokenInner(
  env: Env,
  userData: UserData | null,
  loginParam: string,
  country?: string | null,
  opts?: ResolveTokenOptions,
): Promise<TokenResult> {
  const d1Row = await getTokenFromD1(env, loginParam);
  const d1Token = d1Row?.forty_two_token ?? null;
  const encryptedToken = d1Token ?? userData?.fortyTwoToken;

  if (encryptedToken && !d1Token && userData?.fortyTwoToken) {
    await saveTokenToD1(env, loginParam, userData.fortyTwoToken, country);
  }

  if (country && d1Row && d1Row.country === null) {
    await env.better_intra_d1
      .prepare(
        "UPDATE users SET country = ? WHERE hash = ? AND country IS NULL",
      )
      .bind(country, loginParam)
      .run();
  }

  if (!encryptedToken) {
    console.warn(
      `[getUserToken] ${loginParam}: no stored token (d1=${Boolean(d1Token)}, kv=${Boolean(userData?.fortyTwoToken)})`,
    );
    await markTokenBroken(env, userData, loginParam, "no_token");
    return reconnect("no_token");
  }

  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  try {
    tokenData = await decryptTokenData<typeof tokenData>(env, encryptedToken);
  } catch {
    console.warn(
      `[getUserToken] ${loginParam}: decrypt failed (source=${d1Token ? "d1" : "kv"})`,
    );
    await markTokenBroken(env, userData, loginParam, "decrypt_failed");
    return reconnect("decrypt_failed");
  }

  const msLeft = tokenData.expires_at - Date.now();
  const stillValid = msLeft > 60000;
  const wantsEarlyRefresh =
    opts?.refreshWithinMs != null && msLeft <= opts.refreshWithinMs;

  if (stillValid && !wantsEarlyRefresh) {
    await clearTokenBroken(env, userData, loginParam);
    return { token: tokenData.access_token };
  }

  // Callers that must not hit the refresh endpoint (e.g. the eval cron) skip
  // when the token isn't fresh; the proactive sweep refreshes it in the
  // background instead of clustering refreshes.
  if (opts?.noRefresh) {
    return transient("not_fresh");
  }

  if (!tokenData.refresh_token) {
    console.warn(
      `[getUserToken] ${loginParam}: token expired but no refresh_token stored`,
    );
    await markTokenBroken(env, userData, loginParam, "no_refresh_token");
    return reconnect("no_refresh_token");
  }

  let status = 0;
  let errBody = "";
  let challenge = false;
  try {
    // The Cloudflare challenge is intermittent (per egress IP), so retry it a
    // couple of times before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchIntra(env, "https://api.intra.42.fr/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
          refresh_token: tokenData.refresh_token,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as TokenResponse;
        const newAccessToken = data.access_token;
        if (!newAccessToken) {
          console.warn(
            `[getUserToken] ${loginParam}: refresh response missing access_token`,
          );
          return transient("refresh_no_access_token");
        }
        const returnedRefresh = data.refresh_token ?? "";
        const rotation = !returnedRefresh
          ? "absent(kept-old)"
          : returnedRefresh === tokenData.refresh_token
            ? "same"
            : "rotated";
        const newTokenData = {
          access_token: newAccessToken,
          refresh_token: returnedRefresh || tokenData.refresh_token,
          expires_at: Date.now() + (data.expires_in ?? 7200) * 1000,
        };
        const encrypted = await encryptTokenData(env, newTokenData);
        await saveTokenToD1(env, loginParam, encrypted);
        await clearTokenBroken(env, userData, loginParam);
        console.log(
          `[getUserToken] ${loginParam}: refreshed ok (expires_in=${data.expires_in ?? "?"}s, refresh_token=${rotation}, new refresh=${newTokenData.refresh_token.slice(0, 6)}…)`,
        );
        return { token: newAccessToken };
      }

      status = res.status;
      errBody = await res.text().catch(() => "");
      challenge =
        status === 403 &&
        /just a moment|cf-chl|<html|cloudflare/i.test(errBody);
      if (challenge) {
        const ct = res.headers.get("content-type") || "?";
        console.warn(
          `[getUserToken] ${loginParam}: CF challenge on refresh attempt ${attempt + 1}/3 (content-type=${ct})`,
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
      }
      console.log(
        `[getUserToken] ${loginParam}: refresh non-ok (status=${status}, content-type=${res.headers.get("content-type") || "?"})`,
      );
      break;
    }
  } catch {
    console.warn(`[getUserToken] ${loginParam}: refresh network error`);
    return transient("network");
  }

  // Cloudflare bot management in front of api.intra.42.fr can return a
  // "Just a moment…" JS challenge (403 HTML) to Worker egress. Not a token
  // problem and not fixable by the user reconnecting → transient.
  if (challenge) {
    console.warn(
      `[getUserToken] ${loginParam}: 42 blocked by Cloudflare challenge (403) — transient`,
    );
    return transient("cloudflare_challenge");
  }

  console.log(
    `[getUserToken] ${loginParam}: refresh failed (${status}) ${errBody.slice(0, 300)}`,
  );

  // Rate limiting / upstream errors are transient, not an auth problem.
  if (status === 429 || status >= 500) {
    return transient(`refresh_${status}`);
  }

  // Rotating refresh tokens are single-use: if another request refreshed
  // concurrently, our refresh fails with invalid_grant while D1 now holds a
  // brand-new valid token. Re-read it instead of forcing a reconnect.
  const freshRow = await getTokenFromD1(env, loginParam);
  if (
    freshRow?.forty_two_token &&
    freshRow.forty_two_token !== encryptedToken
  ) {
    try {
      const fresh = await decryptTokenData<{
        access_token: string;
        refresh_token: string;
        expires_at: number;
      }>(env, freshRow.forty_two_token);
      if (Date.now() < fresh.expires_at - 60000) {
        await clearTokenBroken(env, userData, loginParam);
        console.log(
          `[getUserToken] ${loginParam}: concurrent refresh detected, reusing fresh token`,
        );
        return { token: fresh.access_token };
      }
    } catch {
      /* fall through to reconnect */
    }
  }

  // 400 / 401 / 403 (non-challenge) ⇒ refresh token invalid or expired.
  await markTokenBroken(env, userData, loginParam, `refresh_${status}`);
  return reconnect(`refresh_${status}`);
}

export function tokenFailureResponse(failure: TokenFailure): Response {
  const status = failure.reason === "reconnect" ? 401 : 503;
  return textRes(
    failure.reason === "reconnect"
      ? "42 token unavailable — reconnect required"
      : "42 temporarily unavailable — try again later",
    status,
  );
}

export async function getUserToken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
  country?: string | null,
  opts?: { appTokenFallback?: boolean },
): Promise<string | null> {
  const result = await resolveUserToken(env, userData, loginParam, country);
  if ("token" in result) return result.token;
  if (opts?.appTokenFallback) return getAppToken(env);
  return null;
}

export async function markTokenBroken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
  reason?: string,
): Promise<void> {
  if (!userData) return;
  if (userData.tokenBroken) return;

  const failures = (userData.tokenFailures ?? 0) + 1;
  userData.tokenFailures = failures;

  if (failures >= MAX_TOKEN_FAILURES) {
    userData.tokenBroken = true;
  }

  try {
    await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
  } catch {}

  console.warn(
    `[token] ${loginParam.slice(0, 6)} failure ${failures}/${MAX_TOKEN_FAILURES}${reason ? ` (${reason})` : ""}${userData.tokenBroken ? " — marked broken" : ""}`,
  );
}

async function clearTokenBroken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<void> {
  if (!userData) return;
  if (!userData.tokenBroken && !userData.tokenFailures) return;
  userData.tokenBroken = false;
  userData.tokenFailures = 0;
  try {
    await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
  } catch {}
}

async function getTokenFromD1(
  env: Env,
  hash: string,
): Promise<{ forty_two_token: string | null; country: string | null } | null> {
  try {
    const row = await env.better_intra_d1
      .prepare("SELECT forty_two_token, country FROM users WHERE hash = ?")
      .bind(hash)
      .first<{ forty_two_token: string | null; country: string | null }>();
    return row ?? null;
  } catch {
    return null;
  }
}

async function saveTokenToD1(
  env: Env,
  hash: string,
  encryptedToken: string,
  country?: string | null,
): Promise<void> {
  try {
    await env.better_intra_d1
      .prepare(
        "INSERT INTO users (hash, forty_two_token, country) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET forty_two_token = ?, country = COALESCE(users.country, ?)",
      )
      .bind(
        hash,
        encryptedToken,
        country ?? null,
        encryptedToken,
        country ?? null,
      )
      .run();
  } catch (e) {
    console.warn(`[saveTokenToD1] failed for ${hash.slice(0, 6)}: ${e}`);
  }
}
