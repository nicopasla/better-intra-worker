import type { Env } from "./types";

/**
 * Workers Analytics Engine instrumentation for the 42 API budget.
 *
 * Dataset `better_intra_42_api` (binding `API_METRICS`). Two point shapes share
 * it; `indexes[0]` tells them apart:
 *
 * API call — `indexes: [op]` (e.g. `cron.scale_teams`, `me`, `token_refresh`)
 *   blob1  outcome   ok | rate_limited | challenge | error
 *   blob2  scope     user | app
 *   blob3  hash8     first 8 chars of the login hash (user scope only)
 *   blob4  retry     "retry" once this point is a retry, "" otherwise
 *   double1 count    1
 *   double2 status   HTTP status
 *   double3 ms       wall time
 *   double4 hourly   x-hourly-ratelimit-remaining (-1 when absent)
 *   double5 secondly x-secondly-ratelimit-remaining (-1 when absent)
 *   double6 attempt  0-based attempt index
 *
 * Served request — `indexes: ["req"]`
 *   blob1 route     normalized template: no tokens, logins or raw ids
 *   blob2 method
 *   blob3 cache     hit | miss | stale | n/a
 *   double1 count   1
 *   double2 status  HTTP status
 *   double3 ms      wall time
 *
 * Everything here is best effort: a missing binding or a throwing dataset must
 * never change how a request is handled.
 */

export interface ApiMeta {
  /** Call site label, e.g. `cron.scale_teams`. Keep the set small and stable. */
  op: string;
  /** Login hash (already SHA-256). Only the first 8 chars are recorded. */
  hash?: string;
}

export interface ApiCallMetric extends ApiMeta {
  scope: "user" | "app";
  status: number;
  ms: number;
  /** 0-based attempt index; > 0 means this call was a retry. */
  attempt?: number;
  hourlyRemaining?: number;
  secondlyRemaining?: number;
}

export type CacheState = "hit" | "miss" | "stale" | "n/a";

/**
 * Why a cache lookup did or didn't produce a value. Written as its own point
 * shape so a persistent `undecryptable`/`empty` shows up immediately instead of
 * looking like ordinary cache churn.
 */
export type CacheOutcome =
  | "hit"
  | "stale"
  | "empty"
  | "undecryptable"
  | "parse_error"
  | "forced";

const HASH_PREFIX_LENGTH = 8;

/** Path segments that are route names, not ids/logins/tokens. */
const STATIC_SEGMENTS = new Set([
  "api",
  "v1",
  "public",
  "private",
  "login",
  "callback",
  "gh",
  "calendar",
  "images",
  "avatar",
  "asset",
  "announcement",
  "cron",
  "stats",
  "auth",
  "exchange",
  "push",
  "key",
  "themes",
  "like",
  "hide",
  "campus",
  "students",
  "pisciners",
  "piscines",
  "settings",
  "history",
  "restore",
  "sessions",
  "friends",
  "data",
  "proxy",
  "evaluations",
  "me",
  "cluster",
  "occupancy",
  "reports",
  "event-subscribers",
  "subscribe",
  "unsubscribe",
  "test",
  "outstanding",
  "profile-stats",
  "user",
  "profile",
  "subjects",
  "report",
  "custom-badges",
  "token",
  "update",
  "logtime",
  "week",
  "image-upload",
  "visuals",
  "future-students",
  "projects",
  "refresh",
  "svg",
  "svgs",
]);

const ROUTE_RULES: Array<[RegExp, string]> = [
  [/^\/calendar\/[^/]+\.ics$/, "/calendar/:token.ics"],
  [/^\/api\/v1\/public\/images\/[^/]+$/, "/api/v1/public/images/:id"],
  [/^\/api\/v1\/public\/avatar\/[^/]+$/, "/api/v1/public/avatar/:login"],
  [/^\/api\/v1\/public\/campus\/[^/]+$/, "/api/v1/public/campus/:campus"],
  [/^\/api\/v1\/themes\/[^/]+\/(?:like|hide)$/, "/api/v1/themes/:id/:action"],
];

/** Routes that carry secrets or assets and would drown the signal. */
const SKIP_ROUTE_PREFIXES = [
  "/gh/",
  "/calendar/",
  "/api/v1/public/images/",
  "/api/v1/public/avatar/",
  "/api/v1/public/asset",
];

const routeTemplateCache = new Map<string, string>();
const MAX_TEMPLATE_CACHE = 200;

/**
 * Collapses a worker pathname into a groupable template, dropping ids, logins
 * and calendar tokens so the dataset never stores anything identifying.
 */
export function routeTemplate(pathname: string): string {
  const cached = routeTemplateCache.get(pathname);
  if (cached) return cached;

  let template: string;
  const rule = ROUTE_RULES.find(([pattern]) => pattern.test(pathname));
  if (rule) {
    template = rule[1];
  } else {
    template =
      pathname
        .split("/")
        .map((segment) =>
          segment === "" || STATIC_SEGMENTS.has(segment) ? segment : ":_",
        )
        .join("/") || "/";
  }

  if (routeTemplateCache.size >= MAX_TEMPLATE_CACHE) routeTemplateCache.clear();
  routeTemplateCache.set(pathname, template);
  return template;
}

export function outcomeOf(status: number, headers?: Headers): string {
  if (status === 429) return "rate_limited";
  if (
    status === 403 &&
    (headers?.get("content-type") || "").includes("text/html")
  ) {
    return "challenge";
  }
  return status >= 400 ? "error" : "ok";
}

/** 42 sends its quota in headers; missing values become -1 at write time. */
export function rateLimits(headers: Headers): {
  hourlyRemaining?: number;
  secondlyRemaining?: number;
} {
  const hourlyHeader = headers.get("x-hourly-ratelimit-remaining");
  const secondlyHeader = headers.get("x-secondly-ratelimit-remaining");
  const hourly = hourlyHeader === null ? NaN : Number(hourlyHeader);
  const secondly = secondlyHeader === null ? NaN : Number(secondlyHeader);
  return {
    hourlyRemaining: Number.isFinite(hourly) ? hourly : undefined,
    secondlyRemaining: Number.isFinite(secondly) ? secondly : undefined,
  };
}

export function recordApiCall(env: Env, metric: ApiCallMetric): void {
  const dataset = env.API_METRICS;
  if (!dataset) return;
  // Unlabeled call sites are skipped on purpose: `fetchIntra` also serves
  // cdn.intra.42.fr photo fetches, which are not API calls and would skew the
  // quota picture. Label an op when you want it counted.
  if (!metric.op || metric.op === "unknown") return;

  try {
    dataset.writeDataPoint({
      indexes: [metric.op],
      blobs: [
        outcomeOf(metric.status),
        metric.scope,
        metric.hash ? metric.hash.slice(0, HASH_PREFIX_LENGTH) : "",
        metric.attempt && metric.attempt > 0 ? "retry" : "",
      ],
      doubles: [
        1,
        metric.status,
        metric.ms,
        metric.hourlyRemaining ?? -1,
        metric.secondlyRemaining ?? -1,
        metric.attempt ?? 0,
      ],
    });
  } catch {
    /* metrics must never break a request */
  }
}

export function recordRequest(
  env: Env,
  request: Request,
  response: Response,
  ms: number,
): void {
  const dataset = env.API_METRICS;
  if (!dataset) return;
  if (request.method === "OPTIONS") return;

  try {
    const pathname = new URL(request.url).pathname;
    if (SKIP_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return;
    }
    dataset.writeDataPoint({
      indexes: ["req"],
      blobs: [
        routeTemplate(pathname),
        request.method,
        response.headers.get("x-bi-cache") ?? "n/a",
      ],
      doubles: [1, response.status, ms],
    });
  } catch {
    /* metrics must never break a request */
  }
}

/**
 * Cache lookup point — `indexes: ["cache"]`
 *   blob1 op       profile_stats | students | …
 *   blob2 outcome  hit | stale | empty | undecryptable | parse_error | forced
 *   double1 count  1
 *   double2 age    seconds since the row was written (-1 when unknown)
 */
export function recordCacheLookup(
  env: Env,
  op: string,
  outcome: CacheOutcome,
  ageSeconds = -1,
): void {
  const dataset = env.API_METRICS;
  if (!dataset) return;

  try {
    dataset.writeDataPoint({
      indexes: ["cache"],
      blobs: [op, outcome],
      doubles: [1, ageSeconds],
    });
  } catch {
    /* metrics must never break a request */
  }
}

/**
 * Tags a response with what the handler actually did, so request points can be
 * compared against API-call points: `miss` means 42 was (or should have been)
 * called, `hit`/`stale` means the cache absorbed it.
 */
export function markCache<T extends Response>(res: T, state: CacheState): T {
  try {
    res.headers.set("x-bi-cache", state);
  } catch {
    /* headers are mutable on responses we construct; ignore otherwise */
  }
  return res;
}
