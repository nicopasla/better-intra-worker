import { Env, UserData } from "../types";
import { getTokens, jsonRes, textRes } from "../utils";

export async function handlePublicVisuals(
  request: Request,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  return jsonRes({
    avatar: existingData?.settings?.PROFILE_IMAGE_URL || "",
    banner: existingData?.settings?.PROFILE_BANNER_URL || "",
    bannerMode: existingData?.settings?.PROFILE_BANNER_MODE || "fill",
    background: existingData?.settings?.PROFILE_BACKGROUND_URL || "",
    backgroundMode: existingData?.settings?.PROFILE_BACKGROUND_MODE || "fill",
  });
}

export async function handlePrivateSettings(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const authHeader = request.headers
    .get("Authorization")
    ?.replace("Bearer ", "");
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  const data = existingData || { settings: {} };
  const tokensList = getTokens(data);

  if (existingData && !tokensList.includes(authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  if (request.method === "GET") {
    return jsonRes({
      settings: data.settings || {},
      activeSessions: tokensList.length,
    });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const settingsToSave = {
      ...(data.settings || {}),
      ...(body.settings || {}),
    };
    const updatedTokens = tokensList.length > 0 ? tokensList : [authHeader];

    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: updatedTokens,
        settings: settingsToSave,
      }),
    );
    return textRes("Saved");
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      await env.BETTER_INTRA_KV.delete(loginParam);
      return textRes("All cloud data deleted");
    }
    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: tokensList.filter((t) => t !== authHeader),
        settings: data.settings || {},
      }),
    );
    return textRes("Session removed");
  }

  return textRes("Method not allowed", 405);
}
