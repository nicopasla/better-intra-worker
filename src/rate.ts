/**
 * Adaptive, header-driven rate limiter for the 42 API.
 *
 * 42 enforces limits per access token (secondly + hourly) and returns them in
 * the `x-secondly-ratelimit-*` / `x-hourly-ratelimit-*` response headers. We
 * space requests per token just enough to stay under the secondly limit and
 * adapt from the headers, so the worker self-tunes if the quota changes.
 */

import type { Env } from "./types";

const DEFAULT_SECONDLY_LIMIT = 4;
const HOURLY_FLOOR = 100; // remaining below this → slow down to protect the hourly cap
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 2000;
const MAX_RETRIES = 3;

/**
 * 42 sits behind Cloudflare bot management, which returns a "Just a moment…"
 * JS challenge (403) to requests that look like bots (no browser-ish headers,
 * e.g. from a Worker). A realistic User-Agent + Accept avoids the challenge.
 */
export const INTRA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const intraHeaders = (extra?: HeadersInit): Record<string, string> => ({
  "User-Agent": INTRA_USER_AGENT,
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  ...((extra as Record<string, string>) || {}),
});

/**
 * When going through the relay we do NOT impersonate a browser: a fake-Chrome
 * UA from a datacenter/TLS fingerprint that clearly isn't a browser can trigger
 * Cloudflare's Managed Challenge (notably on POST /oauth/token). A consistent,
 * descriptive non-browser identity tends to pass as a normal API client.
 */
export const RELAY_USER_AGENT = "BetterIntra/1.0 (+https://better-intra.com)";

export const relayHeaders = (
  extra?: HeadersInit,
): Record<string, string> => ({
  "User-Agent": RELAY_USER_AGENT,
  Accept: "application/json",
  ...((extra as Record<string, string>) || {}),
});

interface Bucket {
  nextAt: number;
  intervalMs: number;
}

const buckets = new Map<string, Bucket>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const clamp = (ms: number): number =>
  Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));

function bucketFor(token: string): Bucket {
  let bucket = buckets.get(token);
  if (!bucket) {
    bucket = {
      nextAt: 0,
      intervalMs: Math.ceil(1000 / DEFAULT_SECONDLY_LIMIT),
    };
    buckets.set(token, bucket);
  }
  return bucket;
}

/** Waits until this token's next request slot, then reserves it. */
export async function gate(token: string): Promise<void> {
  const bucket = bucketFor(token);
  const wait = bucket.nextAt - Date.now();
  if (wait > 0) await sleep(wait);
  bucket.nextAt = Date.now() + bucket.intervalMs;
}

function observe(token: string, res: Response): void {
  const bucket = bucketFor(token);
  const secondlyLimit = Number(res.headers.get("x-secondly-ratelimit-limit"));
  const secondlyRemaining = Number(
    res.headers.get("x-secondly-ratelimit-remaining"),
  );
  const hourlyRemaining = Number(
    res.headers.get("x-hourly-ratelimit-remaining"),
  );

  if (Number.isFinite(secondlyLimit) && secondlyLimit > 0) {
    bucket.intervalMs = clamp(Math.ceil(1000 / secondlyLimit));
  }
  if (secondlyRemaining === 0) {
    bucket.nextAt = Math.max(bucket.nextAt, Date.now() + bucket.intervalMs);
  }
  if (
    Number.isFinite(hourlyRemaining) &&
    hourlyRemaining > 0 &&
    hourlyRemaining < HOURLY_FLOOR
  ) {
    bucket.intervalMs = clamp(Math.max(bucket.intervalMs, 1000));
  }
}

/**
 * Cloudflare's challenge response is `403` + `text/html`; the real 42 API
 * returns `application/json`. Detected without consuming the body so callers
 * can still read it.
 */
export function isChallenge(res: Response): boolean {
  return (
    res.status === 403 &&
    (res.headers.get("content-type") || "").includes("text/html")
  );
}

/**
 * Fetch a 42 URL, optionally through a non-Cloudflare relay (`INTRA_RELAY_URL`).
 * Cloudflare in front of api.intra.42.fr challenges Worker egress; the relay
 * forwards from a different network. Falls back to a direct GET if the relay
 * errors (never for non-GET, to avoid double-submitting a token refresh).
 */
export async function fetchIntra(
  env: Env,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const relay = env.INTRA_RELAY_URL;
  const method = (init.method ?? "GET").toUpperCase();
  const target = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return url;
    }
  })();
  const log = (via: string, res: Response) =>
    console.log(
      `[${via}] ${method} ${target} -> ${res.status} ${res.headers.get("content-type") || ""}`,
    );

  if (relay) {
    try {
      const endpoint = new URL(relay);
      endpoint.searchParams.set("url", url);
      const res = await fetch(endpoint.toString(), {
        method,
        headers: relayHeaders({
          ...((init.headers as Record<string, string>) || {}),
          "X-Relay-Key": env.INTRA_RELAY_KEY || "",
        }),
        body: init.body,
      });
      log("relay", res);
      return res;
    } catch (e) {
      if (method !== "GET") throw e;
      console.warn(`[rate] relay failed, falling back to direct GET: ${e}`);
    }
  }

  const res = await fetch(url, {
    ...init,
    headers: intraHeaders((init.headers as Record<string, string>) || {}),
  });
  log("direct", res);
  return res;
}

/**
 * `fetch` against the 42 API with `Authorization: Bearer <token>`, gated by the
 * per-token limiter and retrying up to {@link MAX_RETRIES} times on 429 or a
 * Cloudflare challenge.
 */
export async function intraFetch(
  env: Env,
  token: string,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const run = async (): Promise<Response> => {
    await gate(token);
    const res = await fetchIntra(env, input, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    observe(token, res);
    return res;
  };

  let res = await run();
  for (
    let attempt = 0;
    attempt < MAX_RETRIES && (res.status === 429 || isChallenge(res));
    attempt++
  ) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : bucketFor(token).intervalMs * (attempt + 2);
    await sleep(wait);
    res = await run();
  }
  return res;
}
