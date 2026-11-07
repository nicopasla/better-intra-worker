import { Env } from "../types";
import { corsHeaders, textRes } from "../utils";

const VALIDATOR_HEADERS = ["if-none-match", "if-modified-since"] as const;
const MAX_REDIRECTS = 3;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
/** Hosts this proxy may fetch maps from. */
const ALLOWED_DOMAINS = ["intra.42.fr", "betterintra.com"];
/** Better Intra assets live under /gh/; never let the proxy call the API. */
const BETTER_INTRA_GH_PREFIX = "/gh/";

function isAllowedDomain(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * Only HTTPS URLs on 42 / Better Intra hosts are allowed. Better Intra targets
 * must stay under /gh/ so the proxy cannot call the API or itself.
 */
export function isAllowedTarget(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  if (!isAllowedDomain(url.hostname)) return false;
  if (/(^|\.)betterintra\.com$/i.test(url.hostname)) {
    if (!url.pathname.startsWith(BETTER_INTRA_GH_PREFIX)) return false;
  }
  return true;
}

function headersWithValidators(source: Headers, origin: string | null) {
  const headers = new Headers({
    ...corsHeaders,
    "Access-Control-Allow-Origin": origin || "*",
    "Cache-Control": "public, max-age=604800",
  });
  const etag = source.get("etag");
  const lastModified = source.get("last-modified");
  if (etag) headers.set("ETag", etag);
  if (lastModified) headers.set("Last-Modified", lastModified);
  return headers;
}

/** Stable strong validator for SVGs whose upstream sends none. */
async function contentEtag(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as BufferSource);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag);
}

export async function handleClusterSvg(
  request: Request,
  _env: Env,
  origin: string | null,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textRes("Method not allowed", 405);
  }

  const rawUrl = new URL(request.url).searchParams.get("url");
  if (!rawUrl) return textRes("Missing url", 400);

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return textRes("Invalid url", 400);
  }
  if (!isAllowedTarget(target)) return textRes("Forbidden url", 403);

  // Forward the client's validators so an unchanged map costs a 304.
  const conditional = new Headers();
  for (const name of VALIDATOR_HEADERS) {
    const value = request.headers.get(name);
    if (value) conditional.set(name, value);
  }
  const ifNoneMatch = request.headers.get("if-none-match");

  // Follow redirects by hand so every hop is checked against the allowlist.
  let svgRes: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    svgRes = await fetch(target, {
      headers: conditional,
      redirect: "manual",
    });
    if (
      svgRes.status === 304 ||
      svgRes.status < 300 ||
      svgRes.status >= 400
    )
      break;
    const location = svgRes.headers.get("location");
    if (!location) return textRes("Bad redirect", 502);
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return textRes("Bad redirect", 502);
    }
    if (!isAllowedTarget(next)) return textRes("Forbidden redirect", 403);
    target = next;
  }
  if (!svgRes) return textRes("Fetch failed", 502);
  if (svgRes.status >= 300 && svgRes.status < 400 && svgRes.status !== 304) {
    return textRes("Too many redirects", 502);
  }

  if (svgRes.status === 304) {
    return new Response(null, {
      status: 304,
      headers: headersWithValidators(svgRes.headers, origin),
    });
  }
  if (!svgRes.ok) return textRes("Fetch failed", 502);

  const declaredLength = Number(svgRes.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SVG_BYTES) {
    return textRes("Map too large", 413);
  }

  // Buffer so the response gets a validator even when the upstream has none:
  // the extension revalidates these maps every 10 minutes.
  const bytes = new Uint8Array(await svgRes.arrayBuffer());
  if (bytes.byteLength > MAX_SVG_BYTES) return textRes("Map too large", 413);

  // This endpoint is a map proxy, not a general web proxy: only SVG bodies pass.
  const contentType = (svgRes.headers.get("content-type") ?? "").toLowerCase();
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 1024))
    .toLowerCase();
  if (!contentType.includes("image/svg+xml") && !head.includes("<svg")) {
    return textRes("Not an SVG", 415);
  }

  const etag = svgRes.headers.get("etag") ?? (await contentEtag(bytes));
  const headers = headersWithValidators(svgRes.headers, origin);
  headers.set("ETag", etag);
  if (matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

export async function handleClusterSvgs(
  env: Env,
  origin: string | null,
): Promise<Response> {
  const data = await env.BETTER_INTRA_KV.get("CLUSTER_SVG_URLS", {
    type: "json",
  });
  return new Response(JSON.stringify(data || {}), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin || "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
