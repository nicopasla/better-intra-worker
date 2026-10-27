import { Env } from "../types";
import { corsHeaders, textRes } from "../utils";

const VALIDATOR_HEADERS = ["if-none-match", "if-modified-since"] as const;

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
  const svgUrl = new URL(request.url).searchParams.get("url");
  if (!svgUrl) return textRes("Missing url", 400);

  // Forward the client's validators so an unchanged map costs a 304.
  const conditional = new Headers();
  for (const name of VALIDATOR_HEADERS) {
    const value = request.headers.get(name);
    if (value) conditional.set(name, value);
  }
  const ifNoneMatch = request.headers.get("if-none-match");

  const svgRes = await fetch(svgUrl, { headers: conditional });
  if (svgRes.status === 304) {
    return new Response(null, {
      status: 304,
      headers: headersWithValidators(svgRes.headers, origin),
    });
  }
  if (!svgRes.ok) return textRes("Fetch failed", 502);

  // Buffer so the response gets a validator even when the upstream has none:
  // the extension revalidates these maps every 10 minutes.
  const bytes = new Uint8Array(await svgRes.arrayBuffer());
  const etag = svgRes.headers.get("etag") ?? (await contentEtag(bytes));
  const headers = headersWithValidators(svgRes.headers, origin);
  headers.set("ETag", etag);
  if (matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(bytes, { headers });
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
