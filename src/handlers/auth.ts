import {
  Env,
  UserData,
  TokenResponse,
  UserResponse,
  SessionMeta,
} from "../types";
import {
  encryptTokenData,
  getTokens,
  hashLogin,
  jsonRes,
  textRes,
  getCallbackUrl,
  describeUserAgent,
  sanitizeDeviceName,
  serializeUserData,
  MAX_SESSION_TOKENS,
  sessionDeviceKey,
  writeSessionActivity,
} from "../utils";
import { AUTH_CODE_PREFIX } from "../constants";
import { fetchIntra } from "../rate";

const PWA_HOST = "mobile.betterintra.com";

export async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const extUri = url.searchParams.get("redirect_uri");
  if (!extUri) return textRes("Missing redirect_uri from extension", 400);

  let parsed: URL;
  try {
    parsed = new URL(extUri);
  } catch {
    return textRes("Invalid redirect_uri", 400);
  }

  const { hostname, protocol } = parsed;

  const isExtension =
    protocol === "chrome-extension:" || protocol === "moz-extension:";
  const parts = hostname.split(".");
  const isIntra =
    hostname === "profile-v3.intra.42.fr" ||
    (hostname.endsWith(".42.fr") && (parts.length === 3 || parts.length === 4));
  const isPwa = hostname === PWA_HOST;

  if (!isExtension && !isIntra && !isPwa) {
    return textRes("Invalid redirect_uri", 400);
  }

  const cbUrl = getCallbackUrl(request, env);
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
  try {
    redirectTarget = new URL(extUri);
  } catch {
    return textRes("Invalid state", 400);
  }

  const { hostname: cbHostname, protocol: cbProtocol } = redirectTarget;
  const cbParts = cbHostname.split(".");
  const cbIsExtension =
    cbProtocol === "chrome-extension:" || cbProtocol === "moz-extension:";
  const cbIsIntra =
    cbHostname === "profile-v3.intra.42.fr" ||
    (cbHostname.endsWith(".42.fr") &&
      (cbParts.length === 3 || cbParts.length === 4));
  const cbIsPwa = cbHostname === PWA_HOST;
  if (!cbIsExtension && !cbIsIntra && !cbIsPwa) {
    return textRes("Invalid state", 400);
  }

  try {
    const cbUrl = getCallbackUrl(request, env);
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      code,
      redirect_uri: cbUrl,
    });

    const tokenResponse = await fetchIntra(
      env,
      "https://api.intra.42.fr/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      },
    );
    if (!tokenResponse.ok) {
      return textRes("42 OAuth token exchange failed", 502);
    }
    const tokenData = (await tokenResponse.json()) as TokenResponse;
    if (tokenData.error)
      return textRes(
        `42 OAuth Error: ${tokenData.error_description || tokenData.error}`,
        400,
      );

    const userResponse = await fetchIntra(
      env,
      "https://api.intra.42.fr/v2/me",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );
    if (!userResponse.ok) {
      return textRes("Failed to fetch user info from 42", 502);
    }
    const rawUser = (await userResponse.json()) as UserResponse;
    const rawLogin = rawUser.login;
    const userId = rawUser.id;
    if (!rawLogin) return textRes("Invalid 42 session", 400);

    const campusId = rawUser.campus?.[0]?.id ?? null;
    const campusName = rawUser.campus?.[0]?.name ?? null;
    const poolLabel =
      rawUser.pool_month && rawUser.pool_year
        ? `${String(new Date(`${rawUser.pool_month} 1, 2000`).getMonth() + 1).padStart(2, "0")}/${rawUser.pool_year}`
        : null;

    const deviceName = sanitizeDeviceName(
      redirectTarget.searchParams.get("ft_device"),
    );

    const hashedLogin = await hashLogin(rawLogin);

    // The PWA is only available to people who already use Better Intra, i.e.
    // they have a row in D1 (created on any extension login). Strict check.
    if (cbIsPwa) {
      const known = await env.better_intra_d1
        .prepare("SELECT 1 AS ok FROM users WHERE hash = ?")
        .bind(hashedLogin)
        .first<{ ok: number }>();
      if (!known) {
        return Response.redirect(
          `${redirectTarget.origin}/?error=not_registered`,
          302,
        );
      }
    }

    const existing: UserData =
      (await env.BETTER_INTRA_KV.get(hashedLogin, {
        type: "json",
      })) || {};

    const label = describeUserAgent(request.headers.get("User-Agent"));
    const deviceKey = (deviceName || label).trim().toLowerCase();
    const now = Date.now();

    const activeTokens = getTokens(existing);
    const sessionMeta: Record<string, SessionMeta> = {
      ...(existing.sessionMeta || {}),
    };

    // Reuse the existing session for this device instead of appending a new
    // one, collapsing any duplicates left behind by earlier logins.
    let sessionToken: string | null = null;
    for (const token of activeTokens) {
      if (sessionDeviceKey(sessionMeta[token]) !== deviceKey) continue;
      if (
        !sessionToken ||
        (sessionMeta[token]?.createdAt ?? 0) >
          (sessionMeta[sessionToken]?.createdAt ?? 0)
      ) {
        sessionToken = token;
      }
    }

    if (sessionToken) {
      for (let i = activeTokens.length - 1; i >= 0; i--) {
        const token = activeTokens[i];
        if (
          token !== sessionToken &&
          sessionDeviceKey(sessionMeta[token]) === deviceKey
        ) {
          activeTokens.splice(i, 1);
          delete sessionMeta[token];
        }
      }
    } else {
      sessionToken = crypto.randomUUID();
      activeTokens.push(sessionToken);
    }

    while (activeTokens.length > MAX_SESSION_TOKENS) {
      const evicted = activeTokens.shift();
      if (evicted) delete sessionMeta[evicted];
    }

    sessionMeta[sessionToken] = {
      id: sessionMeta[sessionToken]?.id ?? crypto.randomUUID(),
      label,
      ...(deviceName ? { name: deviceName } : {}),
      country: (request.cf?.country as string | undefined) ?? undefined,
      createdAt: sessionMeta[sessionToken]?.createdAt ?? now,
      lastUsedAt: now,
    };

    const encryptedTokens = await encryptTokenData(env, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? "",
      expires_at: Date.now() + (tokenData.expires_in ?? 7200) * 1000,
    });

    await env.BETTER_INTRA_KV.put(
      hashedLogin,
      serializeUserData({
        ...existing,
        sessionTokens: activeTokens,
        sessionMeta,
        tokenBroken: false,
        tokenFailures: 0,
      }),
    );

    // Record activity only for the session that just logged in. Other sessions
    // keep their own timestamps (or fall back to createdAt) and refresh through
    // touchSession on their next request — never fabricate a time here.
    await writeSessionActivity(env, hashedLogin, { [sessionToken]: now });

    const country = request.cf?.country || null;
    await env.better_intra_d1
      .prepare(
        "INSERT INTO users (hash, forty_two_token, forty_two_user_id, country, campus_id, campus_name, pool) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET forty_two_token = ?, forty_two_user_id = ?, country = COALESCE(users.country, ?), campus_id = COALESCE(users.campus_id, ?), campus_name = COALESCE(users.campus_name, ?), pool = COALESCE(users.pool, ?)",
      )
      .bind(
        hashedLogin,
        encryptedTokens,
        userId,
        country,
        campusId,
        campusName,
        poolLabel,
        encryptedTokens,
        userId,
        country,
        campusId,
        campusName,
        poolLabel,
      )
      .run();

    if (cbIsPwa) {
      const code = crypto.randomUUID();
      await env.BETTER_INTRA_KV.put(
        `${AUTH_CODE_PREFIX}${code}`,
        JSON.stringify({
          token: sessionToken,
          login: rawLogin,
          hash: hashedLogin,
        }),
        { expirationTtl: 120 },
      );
      return Response.redirect(
        `${redirectTarget.origin}/?code=${encodeURIComponent(code)}`,
        302,
      );
    }

    if (cbIsExtension) {
      return Response.redirect(
        `https://profile-v3.intra.42.fr/?token=${encodeURIComponent(sessionToken)}&login=${encodeURIComponent(rawLogin)}`,
        302,
      );
    }

    return textRes(
      `
      <!DOCTYPE html>
      <html lang="en"><head><meta charset="UTF-8"><title>Successful Authentication</title><style>body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f5f5f7; }</style></head>
      <body><div style="text-align: center; padding: 30px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);"><h2>Login Successful!</h2><p>Transferring credentials...</p></div>
      <script>if (window.opener) { window.opener.postMessage({ type: "42_AUTH_SUCCESS", token: "${sessionToken}", login: "${rawLogin}" }, "${redirectTarget.origin}"); }</script></body></html>
    `,
      200,
      "text/html; charset=utf-8",
    );
  } catch (e) {
    console.error("Auth callback error:", e);
    return textRes(
      `Auth Server Error: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
}

interface AuthCodePayload {
  token: string;
  login: string;
  hash: string;
}

/**
 * Single-use exchange for the PWA: trades the short-lived code handed back by
 * the callback for the session token, so the token never rides in a URL.
 */
export async function handleAuthExchange(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return textRes("Invalid JSON", 400);
  }

  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^[a-f0-9-]{8,64}$/i.test(code)) return textRes("Invalid code", 400);

  const key = `${AUTH_CODE_PREFIX}${code}`;
  const payload = await env.BETTER_INTRA_KV.get<AuthCodePayload>(key, {
    type: "json",
  });
  if (!payload?.token || !payload?.login) {
    return textRes("Invalid or expired code", 401);
  }
  await env.BETTER_INTRA_KV.delete(key);

  return jsonRes({ token: payload.token, login: payload.login });
}
