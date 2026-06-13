import { Env, UserData, TokenResponse, UserResponse } from "../types";
import { encryptTokenData, getTokens, hashLogin, textRes, getCallbackUrl } from "../utils";

export async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const extUri = url.searchParams.get("redirect_uri");
  if (!extUri) return textRes("Missing redirect_uri from extension", 400);

  let parsed: URL;
  try { parsed = new URL(extUri); }
  catch { return textRes("Invalid redirect_uri", 400); }

  const { hostname, protocol } = parsed;

  const isExtension = protocol === "chrome-extension:" || protocol === "moz-extension:";
  const parts = hostname.split(".");
  const isIntra =
    hostname === "profile-v3.intra.42.fr" ||
    (hostname.endsWith(".42.fr") && (parts.length === 3 || parts.length === 4));

  if (!isExtension && !isIntra) {
    return textRes("Invalid redirect_uri", 400);
  }

  const cbUrl = getCallbackUrl(env);
  return Response.redirect(
    `https://api.intra.42.fr/oauth/authorize?client_id=${
      env.CLIENT_ID
    }&redirect_uri=${encodeURIComponent(
      cbUrl,
    )}&response_type=code&scope=public&state=${encodeURIComponent(extUri)}`,
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

  let redirectTarget: URL;
  try { redirectTarget = new URL(extUri); }
  catch { return textRes("Invalid state", 400); }

  const { hostname: cbHostname, protocol: cbProtocol } = redirectTarget;
  const cbParts = cbHostname.split(".");
  const cbIsExtension = cbProtocol === "chrome-extension:" || cbProtocol === "moz-extension:";
  const cbIsIntra = cbHostname === "profile-v3.intra.42.fr" || (cbHostname.endsWith(".42.fr") && (cbParts.length === 3 || cbParts.length === 4));
  if (!cbIsExtension && !cbIsIntra) {
    return textRes("Invalid state", 400);
  }

  try {
    const cbUrl = getCallbackUrl(env);
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      code,
      redirect_uri: cbUrl,
    });

    const tokenResponse = await fetch("https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    if (!tokenResponse.ok) {
      return textRes("42 OAuth token exchange failed", 502);
    }
    const tokenData = (await tokenResponse.json()) as TokenResponse;
    if (tokenData.error)
      return textRes(
        `42 OAuth Error: ${tokenData.error_description || tokenData.error}`,
        400,
      );

    const userResponse = await fetch("https://api.intra.42.fr/v2/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userResponse.ok) {
      return textRes("Failed to fetch user info from 42", 502);
    }
    const rawLogin = ((await userResponse.json()) as UserResponse).login;
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

    const encryptedTokens = await encryptTokenData(env, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? "",
      expires_at: Date.now() + ((tokenData.expires_in ?? 7200) * 1000),
    });

    await env.BETTER_INTRA_KV.put(
      hashedLogin,
      JSON.stringify({
        sessionTokens: activeTokens,
        settings: existing.settings || {},
        fortyTwoToken: encryptedTokens,
      }),
    );

    if (cbIsExtension) {
      return Response.redirect(
        `https://profile-v3.intra.42.fr/?token=${encodeURIComponent(newSessionToken)}&login=${encodeURIComponent(rawLogin)}`,
        302,
      );
    }

    return textRes(
      `
      <!DOCTYPE html>
      <html lang="en"><head><meta charset="UTF-8"><title>Successful Authentication</title><style>body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f5f5f7; }</style></head>
      <body><div style="text-align: center; padding: 30px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);"><h2>Login Successful!</h2><p>Transferring credentials...</p></div>
      <script>if (window.opener) { window.opener.postMessage({ type: "42_AUTH_SUCCESS", token: "${newSessionToken}", login: "${rawLogin}" }, "${redirectTarget.origin}"); }</script></body></html>
    `,
      200,
      "text/html; charset=utf-8",
    );
  } catch (e) {
    console.error("Auth callback error:", e);
    return textRes(`Auth Server Error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}
