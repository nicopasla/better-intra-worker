import { corsHeaders, textRes } from "../utils";

const GH_RAW = "https://raw.githubusercontent.com/nicopasla/better-intra/main";

export async function handleGhProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/gh\//, "");
  if (!path) return textRes("Missing path", 400);

  const ghRes = await fetch(`${GH_RAW}/${path}`);
  const status = ghRes.status;

  return new Response(await ghRes.text(), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": ghRes.headers.get("content-type") || "text/plain",
      "Cache-Control":
        status >= 400 ? "public, max-age=300" : "public, max-age=3600",
    },
  });
}
