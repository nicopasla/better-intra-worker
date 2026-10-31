import { Env } from "../types";
import { corsHeaders, getAppToken, textRes } from "../utils";
import { fetchIntra } from "../rate";

const CDN_ORIGIN = "https://cdn.intra.42.fr";
const LOGIN_RE = /^[a-z0-9_-]{1,32}$/;

/** 42 serves avatars from a per-photo path (it changes when the photo does). */
const PHOTO_PATH_RE =
  /^\/users\/[a-f0-9]{32}\/[A-Za-z0-9_.-]{1,100}\.(?:jpe?g|png|gif|webp)$/;

/** Edge/browser cache lifetime for the image bytes. */
const IMAGE_CACHE_TTL = 60 * 60 * 24;
const IMAGE_MAX_AGE = 30 * 60;

/** Signatures are bucketed per hour and valid for 1–2 hours. */
const SIGN_WINDOW_SECONDS = 60 * 60;

/** Requests per minute per IP before the proxy starts rejecting. */
const RL_LIMIT = 600;
const RL_WINDOW_SECONDS = 60;

/** Validates a 42 login before it is used to build an upstream CDN URL. */
export function isValidAvatarLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

/** Extracts the validated CDN path from an `image.versions.*` / `image.link` URL. */
export function photoPathFromUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "cdn.intra.42.fr" ||
      url.search
    ) {
      return null;
    }
    return PHOTO_PATH_RE.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
  }
  return cachedKey.key;
}

async function sign(
  secret: string,
  login: string,
  path: string,
  exp: number,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`${login}:${path}:${exp}`),
  );
  return toHex(mac);
}

async function verify(
  secret: string,
  login: string,
  path: string,
  exp: number,
  sig: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(sig)) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromHex(sig),
      new TextEncoder().encode(`${login}:${path}:${exp}`),
    );
  } catch {
    return false;
  }
}

/**
 * Signed proxy URL for a 42 avatar. `photoUrl` is the CDN URL returned by the
 * 42 API (`image.versions.*` / `image.link`). Returns null when there is no
 * valid photo or the signing secret is not configured.
 */
export async function mintAvatarUrl(
  env: Env,
  login: string,
  origin: string,
  photoUrl?: string | null,
): Promise<string | null> {
  const normalized = (login || "").trim().toLowerCase();
  if (!env.AVATAR_URL_SECRET || !isValidAvatarLogin(normalized)) return null;
  const path = photoPathFromUrl(photoUrl);
  if (!path) return null;
  const exp =
    (Math.floor(Date.now() / 1000 / SIGN_WINDOW_SECONDS) + 2) *
    SIGN_WINDOW_SECONDS;
  const sig = await sign(env.AVATAR_URL_SECRET, normalized, path, exp);
  return `${origin}/api/v1/public/avatar/${normalized}?p=${encodeURIComponent(path)}&exp=${exp}&sig=${sig}`;
}

/**
 * Fixed-window per-IP limiter backed by KV. Best-effort (KV is eventually
 * consistent) — enough to stop a leaked URL from being hammered.
 */
async function isRateLimited(env: Env, ip: string): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (RL_WINDOW_SECONDS * 1000));
  const key = `avrl:${ip}:${bucket}`;
  const current = Number(await env.BETTER_INTRA_KV.get(key)) || 0;
  if (current >= RL_LIMIT) return true;
  try {
    await env.BETTER_INTRA_KV.put(key, String(current + 1), {
      expirationTtl: RL_WINDOW_SECONDS * 2,
    });
  } catch {
    /* a failed counter write must not break image serving */
  }
  return false;
}

/**
 * Signature-gated avatar proxy. Downloads the 42 CDN image server-side with
 * the application token (CDN reads are not API calls and don't count against
 * the API rate limit) and serves it same-origin, edge-cached.
 */
export async function handleAvatarProxy(
  request: Request,
  env: Env,
  login: string,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const normalized = login.trim().toLowerCase();
  if (!isValidAvatarLogin(normalized)) return textRes("Invalid login", 400);

  const secret = env.AVATAR_URL_SECRET;
  if (!secret) return textRes("Avatar proxy unavailable", 503);

  const url = new URL(request.url);
  const path = url.searchParams.get("p") || "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!PHOTO_PATH_RE.test(path)) return textRes("Invalid photo", 400);
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) {
    return textRes("Link expired", 403);
  }
  if (!(await verify(secret, normalized, path, exp, sig))) {
    return textRes("Forbidden", 403);
  }

  // The signature is per-request, so the cache key must not include it. The
  // photo path is part of the key: a new photo is a new URL.
  const cacheKey = new Request(`${url.origin}/__avatar${path}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return hit;

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(env, ip)) return textRes("Too many requests", 429);

  let upstream: Response;
  try {
    const token = await getAppToken(env);
    if (!token) return textRes("Upstream error", 502);
    upstream = await fetchIntra(env, `${CDN_ORIGIN}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "image/*",
      },
      redirect: "error",
    });
  } catch {
    return textRes("Upstream error", 502);
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !contentType.startsWith("image/")) {
    console.warn(
      "[avatar] upstream rejected",
      normalized,
      upstream.status,
      contentType,
      upstream.headers.get("cf-mitigated") || "",
    );
    return textRes("Avatar not found", upstream.status === 404 ? 404 : 502);
  }

  const response = new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${IMAGE_MAX_AGE}, s-maxage=${IMAGE_CACHE_TTL}, immutable`,
    },
  });
  try {
    await cache?.put(cacheKey, response.clone());
  } catch {
    /* ignore cache write failures */
  }
  return response;
}
