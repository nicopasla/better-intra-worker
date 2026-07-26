import { Env } from "../types";
import { textRes, corsHeaders } from "../utils";

export async function handleImageServe(
  request: Request,
  env: Env,
  uuid: string,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const key = `images/${uuid}`;
  let object: R2ObjectBody | null;
  try {
    object = await env.better_intra_images.get(key);
  } catch {
    return textRes("Error retrieving image", 500);
  }

  if (!object) return textRes("Image not found", 404);

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  const contentType = object.httpMetadata?.contentType || "image/png";
  headers["Content-Type"] = contentType;

  return new Response(object.body, { headers });
}
