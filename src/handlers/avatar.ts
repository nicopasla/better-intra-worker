import { Env } from "../types";
import { corsHeaders, textRes } from "../utils";
import { fetchIntra } from "../rate";

const CDN_BASE = "https://cdn.intra.42.fr/users";
const LOGIN_RE = /^[a-z0-9_-]{1,32}$/;

const CACHE_TTL = 60 * 60 * 24; // 24h

/** Requests per minute per IP before the proxy starts rejecting. */
const RL_LIMIT = 600;
const RL_WINDOW_SECONDS = 60;

/** Validates a 42 login before it is used to build the upstream CDN URL. */
export function isValidAvatarLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

/**
 * Fixed-window per-IP limiter backed by KV. Best-effort (KV is eventually
 * consistent) — enough to stop a runaway client from hammering the proxy.
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
    /* ignore — a failed counter write must not break image serving */
  }
  return false;
}

/**
 * Public avatar proxy: fetches the 42 CDN avatar with browser-like headers
 * (bypassing the browser-side rate/bot issues) and serves it same-origin,
 * cached at the edge.
 */
export async function handleAvatarProxy(
  request: Request,
  env: Env,
  login: string,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const normalized = login.trim().toLowerCase();
  if (!isValidAvatarLogin(normalized)) return textRes("Invalid login", 400);

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(env, ip)) return textRes("Too many requests", 429);

  let upstream: Response;
  try {
    upstream = await fetchIntra(env, `${CDN_BASE}/${normalized}.jpg`, {
      headers: { Accept: "image/*" },
    });
  } catch {
    return textRes("Upstream error", 502);
  }

  if (!upstream.ok) {
    return textRes("Avatar not found", upstream.status === 404 ? 404 : 502);
  }

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
    "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}, immutable`,
  };

  const response = new Response(upstream.body, { status: 200, headers });
  try {
    await cache.put(request, response.clone());
  } catch {
    /* ignore cache write failures */
  }
  return response;
}
