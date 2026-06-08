import { Env, UserData } from "../types";
import { getBearerToken, getUserToken, textRes, validateSession, corsHeaders } from "../utils";

const API_BASE = "https://api.intra.42.fr";

export async function handleProxy(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) return textRes("Missing Authorization header", 401);
  if (!existingData) return textRes("User not found in KV", 401);
  if (!validateSession(existingData, token)) return textRes("Invalid session token", 401);

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path || !path.startsWith("/v2/")) {
    return textRes("Invalid path. Must start with /v2/", 400);
  }

  if (request.method !== "GET") {
    return textRes("Only GET is supported", 405);
  }

  const hasUserToken = !!existingData?.fortyTwoToken;
  const fortyTwoToken = await getUserToken(env, existingData, loginParam);
  const tokenPrefix = fortyTwoToken.substring(0, 8);

  const apiUrl = new URL(`${API_BASE}${path}`);
  url.searchParams.forEach((value, key) => {
    if (key !== "login" && key !== "path") {
      apiUrl.searchParams.set(key, value);
    }
  });

  const apiRes = await fetch(apiUrl.toString(), {
    headers: { Authorization: `Bearer ${fortyTwoToken}` },
  });

  const body = apiRes.headers
    .get("content-type")
    ?.includes("application/json")
    ? await apiRes.json()
    : await apiRes.text();

  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": apiRes.headers.get("content-type") || "application/json",
    "x-proxy-has-user-token": String(hasUserToken),
    "x-proxy-token-prefix": tokenPrefix,
    "x-proxy-api-status": String(apiRes.status),
  };

  for (const name of [
    "x-hourly-ratelimit-remaining",
    "x-secondly-ratelimit-remaining",
    "x-hourly-ratelimit-limit",
    "x-secondly-ratelimit-limit",
  ]) {
    const val = apiRes.headers.get(name);
    if (val) responseHeaders[name] = val;
  }

  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: apiRes.status,
    headers: responseHeaders,
  });
}
