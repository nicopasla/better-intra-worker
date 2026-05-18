export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
}

const WORKER_CALLBACK_URL =
  "https://better-intra-worker.nicopasla.workers.dev/callback";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const textRes = (
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
) =>
  new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });

const getTokens = (data: any): string[] =>
  Array.isArray(data?.sessionTokens)
    ? data.sessionTokens
    : typeof data?.sessionToken === "string"
      ? [data.sessionToken]
      : [];

async function hashLogin(login: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(login.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { headers: corsHeaders });

    if (url.pathname === "/login") {
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
        `https://api.intra.42.fr/oauth/authorize?client_id=${env.CLIENT_ID}&redirect_uri=${encodeURIComponent(WORKER_CALLBACK_URL)}&response_type=code&scope=public&state=${encodeURIComponent(extUri)}`,
        302,
      );
    }

    if (url.pathname === "/callback") {
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

        const tokenResponse = await fetch(
          "https://api.intra.42.fr/oauth/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenParams.toString(),
          },
        );
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
        const existing =
          ((await env.BETTER_INTRA_KV.get(hashedLogin, {
            type: "json",
          })) as any) || {};

        const activeTokens = getTokens(existing);
        activeTokens.push(newSessionToken);
        if (activeTokens.length > 3) activeTokens.shift();

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
          <script>if (window.opener) { window.opener.postMessage({ type: "42_AUTH_SUCCESS", token: "${newSessionToken}", login: "${rawLogin}" }, "${new URL(extUri).origin}"); }</script></body></html>
        `,
          200,
          "text/html; charset=utf-8",
        );
      } catch {
        return textRes("Auth Server Error", 500);
      }
    }

    const loginParam = url.searchParams.get("login");
    if (!loginParam) return textRes("Username hash required", 400);

    const existingData = (await env.BETTER_INTRA_KV.get(loginParam, {
      type: "json",
    })) as any;

    if (url.pathname === "/api/v1/public/visuals") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      return jsonRes({
        avatar: existingData?.settings?.PROFILE_IMAGE_URL || "",
        banner: existingData?.settings?.PROFILE_BANNER_URL || "",
        bannerMode: existingData?.settings?.PROFILE_BANNER_MODE || "fill",
        background: existingData?.settings?.PROFILE_BACKGROUND_URL || "",
        backgroundMode: existingData?.settings?.PROFILE_BACKGROUND_MODE || "fill",
      });
    }

    if (url.pathname === "/api/v1/private/settings") {
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

    return textRes("Not found", 404);
  },
};
