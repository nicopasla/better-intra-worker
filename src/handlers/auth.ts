import { Env, UserData } from "../types";
import { getTokens, hashLogin, textRes, WORKER_CALLBACK_URL } from "../utils";

export async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const extUri = url.searchParams.get("redirect_uri");
  if (!extUri) return textRes("Missing redirect_uri from extension", 400);

  const isAllowedOrigin =
    extUri.startsWith("chrome-extension://") ||
    extUri.startsWith("moz-extension://") ||
    extUri.startsWith("https://profile-v3.intra.42.fr") ||
    new URL(extUri).hostname.endsWith(".42.fr");

  if (!isAllowedOrigin) {
    return textRes("Invalid redirect_uri", 400);
  }

  return Response.redirect(
    `https://api.intra.42.fr/oauth/authorize?client_id=${
      env.CLIENT_ID
    }&redirect_uri=${encodeURIComponent(
      WORKER_CALLBACK_URL,
    )}&response_type=code&scope=public%20projects%20profile&state=${encodeURIComponent(extUri)}`,
    302,
  );
}

export async function handleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const extUri = url.searchParams.get("state");
  if (!code || !extUri) return textRes("Missing code or state", 400);

  try {
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      code,
      redirect_uri: WORKER_CALLBACK_URL,
    });

    const tokenResponse = await fetch("https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    const tokenData = (await tokenResponse.json()) as any;
    if (tokenData.error)
      return textRes(
        `42 OAuth Error: ${tokenData.error_description || tokenData.error}`,
        400,
      );

    const userResponse = await fetch("https://api.intra.42.fr/v2/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const rawLogin = ((await userResponse.json()) as any).login;
    if (!rawLogin) return textRes("Invalid 42 session", 400);

    const hashedLogin = await hashLogin(rawLogin);
    const newSessionToken = crypto.randomUUID();
    const existing: UserData =
      (await env.BETTER_INTRA_KV.get(hashedLogin, {
        type: "json",
      })) || {};

    const activeTokens = getTokens(existing);
    activeTokens.push(newSessionToken);
    if (activeTokens.length > 10) activeTokens.shift();

    await env.BETTER_INTRA_KV.put(
      hashedLogin,
      JSON.stringify({
        sessionTokens: activeTokens,
        settings: existing.settings || {},
      }),
    );

    return textRes(
      `
      <!DOCTYPE html>
      <html lang="en"><head><meta charset="UTF-8"><title>Successful Authentication</title><style>body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f5f5f7; }</style></head>
      <body><div style="text-align: center; padding: 30px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);"><h2>Login Successful!</h2><p>Transferring credentials...</p></div>
      <script>if (window.opener) { window.opener.postMessage({ type: "42_AUTH_SUCCESS", token: "${newSessionToken}", login: "${rawLogin}" }, "${
        new URL(extUri).origin
      }"); }</script></body></html>
    `,
      200,
      "text/html; charset=utf-8",
    );
  } catch {
    return textRes("Auth Server Error", 500);
  }
}
