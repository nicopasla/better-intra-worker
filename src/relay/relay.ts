// Deno Deploy relay for the 42 API.
//
// Cloudflare (in front of api.intra.42.fr) challenges Cloudflare Worker egress
// with a "Just a moment…" managed challenge. This relay runs on Deno's
// (non-Cloudflare) network and forwards requests so they aren't challenged.
//
// Deploy:  deployctl deploy --project=better-intra-relay relay/relay.ts
// Env:     RELAY_KEY=<long random secret>   (set in the Deno Deploy project)

const ALLOWED_HOST = "api.intra.42.fr";

const FORWARD_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
];

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "x-secondly-ratelimit-limit",
  "x-secondly-ratelimit-remaining",
  "x-hourly-ratelimit-limit",
  "x-hourly-ratelimit-remaining",
];

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const key = Deno.env.get("RELAY_KEY") ?? "";
  if (!key || req.headers.get("x-relay-key") !== key) {
    return text("Forbidden", 403);
  }

  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return text("Method not allowed", 405);
  }

  const target = new URL(req.url).searchParams.get("url");
  if (!target) return text("Missing url", 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return text("Bad url", 400);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST) {
    return text("URL not allowed", 400);
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(parsed.toString(), {
    method,
    headers,
    body: method === "POST" ? await req.arrayBuffer() : undefined,
    redirect: "manual",
  });

  const outHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
});
