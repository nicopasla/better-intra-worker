import { Env } from "../types";
import { textRes } from "../utils";

export async function handleClusterSvg(
  request: Request,
  _env: Env,
  origin: string | null,
): Promise<Response> {
  const svgUrl = new URL(request.url).searchParams.get("url");
  if (!svgUrl) return textRes("Missing url", 400);

  const svgRes = await fetch(svgUrl);
  if (!svgRes.ok) return textRes("Fetch failed", 502);

  return new Response(svgRes.body, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Access-Control-Allow-Origin": origin || "*",
      "Cache-Control": "public, max-age=604800",
    },
  });
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
