/**
 * Adaptive, header-driven rate limiter for the 42 API.
 *
 * 42 enforces limits per access token (secondly + hourly) and returns them in
 * the `x-secondly-ratelimit-*` / `x-hourly-ratelimit-*` response headers. We
 * space requests per token just enough to stay under the secondly limit and
 * adapt from the headers, so the worker self-tunes if the quota changes.
 */

const DEFAULT_SECONDLY_LIMIT = 4;
const HOURLY_FLOOR = 100; // remaining below this → slow down to protect the hourly cap
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 2000;
const MAX_429_RETRIES = 2;

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
 * `fetch` against the 42 API with `Authorization: Bearer <token>`, gated by the
 * per-token limiter and retrying up to {@link MAX_429_RETRIES} times on 429.
 */
export async function intraFetch(
  token: string,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const run = async (): Promise<Response> => {
    await gate(token);
    const res = await fetch(input, {
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
    attempt < MAX_429_RETRIES && res.status === 429;
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
