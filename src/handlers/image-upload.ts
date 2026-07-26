import { Env, UserData } from "../types";
import { getBearerToken, validateSession, textRes, jsonRes } from "../utils";

export async function handleImageUpload(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return textRes("Invalid form data", 400);
  }

  const file = formData.get("image");
  if (!file || !(file instanceof File)) {
    return textRes("Missing image file", 400);
  }

  const uuid = crypto.randomUUID();
  const key = `images/${uuid}`;
  const buffer = await file.arrayBuffer();

  try {
    await env.better_intra_images.put(key, buffer, {
      httpMetadata: { contentType: file.type || "image/png" },
    });
  } catch {
    return textRes("Failed to store image", 500);
  }

  const url = `${new URL(request.url).origin}/api/v1/public/images/${uuid}`;
  return jsonRes({ url });
}
