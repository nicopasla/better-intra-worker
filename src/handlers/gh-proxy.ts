import { corsHeaders, textRes } from "../utils";

const GH_RAW = "https://raw.githubusercontent.com/nicopasla/better-intra/main";

export async function handleGhProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/gh\//, "");
  if (!path) return textRes("Missing path", 400);

  const ghRes = await fetch(`${GH_RAW}/${path}`);

  return new Response(await ghRes.text(), {
    status: ghRes.status,
    headers: {
      ...corsHeaders,
      "Content-Type": ghRes.headers.get("content-type") || "text/plain",
    },
  });
}
