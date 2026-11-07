import { Env } from "../types";
import { corsHeaders, textRes } from "../utils";

/** Floor-plan maps served from R2. The clusters feature targets Belgium only. */
const CAMPUS = "belgium";
const MAPS = new Set(["shi", "fu", "mi", "plan"]);

function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalized = etag.replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === normalized);
}

export async function handleCampusMap(
  request: Request,
  env: Env,
  campus: string,
  id: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textRes("Method not allowed", 405);
  }
  if (campus !== CAMPUS || !MAPS.has(id)) {
    return textRes("Not found", 404);
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.better_intra_images.get(
      `campus-maps/${campus}/${id}.svg`,
    );
  } catch {
    return textRes("Error retrieving map", 500);
  }
  if (!object) return textRes("Not found", 404);

  const etag = object.httpEtag;
  const headers = new Headers({
    ...corsHeaders,
    "Content-Type": object.httpMetadata?.contentType || "image/svg+xml",
    "Cache-Control": "public, max-age=86400",
    ETag: etag,
  });

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === "HEAD" ? null : object.body, {
    headers,
  });
}
