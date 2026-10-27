import { corsHeaders, textRes } from "../utils";

const SOURCES = [
  "https://raw.githubusercontent.com/nicopasla/better-intra/main",
  "https://cdn.jsdelivr.net/gh/nicopasla/better-intra@main",
];

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/** Validators forwarded upstream so a revalidation can end in a cheap 304. */
const VALIDATORS = ["if-none-match", "if-modified-since"] as const;

const CACHE_CONTROL = "public, max-age=3600";

function guessContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
}

export function isBadPath(rawPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.includes("..");
}

export async function handleGhProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/gh\//, "");
  if (!path) return textRes("Missing path", 400);
  if (isBadPath(path)) return textRes("Bad path", 400);

  // Clients revalidate (e.g. the PWA's cluster maps): pass their validators to
  // GitHub so an unchanged file costs a 304 instead of a body transfer.
  const conditional = new Headers();
  for (const name of VALIDATORS) {
    const value = request.headers.get(name);
    if (value) conditional.set(name, value);
  }

  let lastStatus = 502;
  for (const base of SOURCES) {
    const res = await fetch(`${base}/${path}`, { headers: conditional });
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");

    if (res.status === 304) {
      const headers = new Headers({
        ...corsHeaders,
        "Cache-Control": CACHE_CONTROL,
      });
      if (etag) headers.set("ETag", etag);
      if (lastModified) headers.set("Last-Modified", lastModified);
      return new Response(null, { status: 304, headers });
    }

    if (res.ok) {
      const headers = new Headers({
        ...corsHeaders,
        "Content-Type":
          res.headers.get("content-type") || guessContentType(path),
        "Cache-Control": CACHE_CONTROL,
      });
      if (etag) headers.set("ETag", etag);
      if (lastModified) headers.set("Last-Modified", lastModified);
      return new Response(await res.text(), { status: res.status, headers });
    }
    lastStatus = res.status;
  }

  return new Response("Failed to fetch upstream", {
    status: lastStatus,
    headers: corsHeaders,
  });
}
