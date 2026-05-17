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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/login") {
      const extensionRedirectUri = url.searchParams.get("redirect_uri");
      if (!extensionRedirectUri) {
        return new Response("Missing redirect_uri from extension", {
          status: 400,
          headers: corsHeaders,
        });
      }

      const authUrl = `https://api.intra.42.fr/oauth/authorize?client_id=${env.CLIENT_ID}&redirect_uri=${encodeURIComponent(WORKER_CALLBACK_URL)}&response_type=code&scope=public&state=${encodeURIComponent(extensionRedirectUri)}`;
      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const extensionRedirectUri = url.searchParams.get("state");

      if (!code || !extensionRedirectUri) {
        return new Response("Missing code or state", {
          status: 400,
          headers: corsHeaders,
        });
      }

      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response("Configuration Error: Missing API Credentials.", {
          status: 500,
          headers: corsHeaders,
        });
      }

      try {
        const tokenParams = new URLSearchParams();
        tokenParams.append("grant_type", "authorization_code");
        tokenParams.append("client_id", env.CLIENT_ID);
        tokenParams.append("client_secret", env.CLIENT_SECRET);
        tokenParams.append("code", code);
        tokenParams.append("redirect_uri", WORKER_CALLBACK_URL);

        const tokenResponse = await fetch(
          "https://api.intra.42.fr/oauth/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenParams.toString(),
          },
        );
        const tokenData = (await tokenResponse.json()) as any;

        if (tokenData.error) {
          return new Response(
            `42 OAuth Error: ${tokenData.error_description || tokenData.error}`,
            {
              status: 400,
              headers: corsHeaders,
            },
          );
        }

        const userResponse = await fetch("https://api.intra.42.fr/v2/me", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = (await userResponse.json()) as any;
        const login = userData.login;

        if (!login)
          return new Response("Invalid 42 session", {
            status: 400,
            headers: corsHeaders,
          });

        const newSessionToken = crypto.randomUUID();
        const existing = ((await env.BETTER_INTRA_KV.get(login, {
          type: "json",
        })) as any) || { settings: {} };

        let activeTokens: string[] = [];
        if (Array.isArray(existing.sessionTokens)) {
          activeTokens = existing.sessionTokens;
        } else if (typeof existing.sessionToken === "string") {
          activeTokens = [existing.sessionToken];
        }
        activeTokens.push(newSessionToken);

        if (activeTokens.length > 3) {
          activeTokens.shift();
        }

        await env.BETTER_INTRA_KV.put(
          login,
          JSON.stringify({
            sessionTokens: activeTokens,
            settings: existing.settings || {},
          }),
        );

        const htmlResponse = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Successful Authentication</title>
            <style>
              body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f5f5f7; color: #333; }
              .box { text-align: center; padding: 30px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            </style>
          </head>
          <body>
            <div class="box">
              <h2>Login Successful!</h2>
              <p>Transferring credentials to Better Intra...</p>
            </div>
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: "42_AUTH_SUCCESS",
                  token: "${newSessionToken}",
                  login: "${login}"
                }, "${new URL(extensionRedirectUri).origin}");
              }
            </script>
          </body>
          </html>
        `;

        return new Response(htmlResponse, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      } catch (e) {
        return new Response("Auth Server Error", {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    const loginParam = url.searchParams.get("login");
    if (!loginParam) {
      return new Response("Username required", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const existingData = (await env.BETTER_INTRA_KV.get(loginParam, {
      type: "json",
    })) as any;

    if (request.method === "POST") {
      const authHeader = request.headers
        .get("Authorization")
        ?.replace("Bearer ", "");
      const tokensList =
        existingData?.sessionTokens ||
        (existingData?.sessionToken ? [existingData.sessionToken] : []);

      if (!existingData || !tokensList.includes(authHeader)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body = (await request.json()) as any;
      let settingsToSave = body.settings || {};
      settingsToSave = { ...(existingData.settings || {}), ...settingsToSave };

      await env.BETTER_INTRA_KV.put(
        loginParam,
        JSON.stringify({
          sessionTokens: tokensList,
          settings: settingsToSave,
        }),
      );

      return new Response("Saved", { status: 200, headers: corsHeaders });
    }

    if (request.method === "GET") {
      const origin = request.headers.get("Origin") || "";
      const referer = request.headers.get("Referer") || "";

      const isAuthorized =
        origin.endsWith(".42.fr") ||
        referer.includes(".42.fr") ||
        origin.startsWith("moz-extension://");

      if (!isAuthorized) {
        return new Response("Unauthorized platform", { status: 403 });
      }

      const dynamicCorsHeaders = {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
      };

      if (!existingData) {
        return new Response(
          JSON.stringify({ settings: {}, activeSessions: 0 }),
          { headers: dynamicCorsHeaders },
        );
      }

      const tokensList =
        existingData.sessionTokens ||
        (existingData.sessionToken ? [existingData.sessionToken] : []);
      const publicData = {
        settings: existingData.settings || {},
        activeSessions: tokensList.length,
      };

      return new Response(JSON.stringify(publicData), {
        headers: dynamicCorsHeaders,
      });
    }

    if (request.method === "DELETE") {
      const authHeader = request.headers
        .get("Authorization")
        ?.replace("Bearer ", "");
      const tokensList =
        existingData?.sessionTokens ||
        (existingData?.sessionToken ? [existingData.sessionToken] : []);

      if (!existingData || !tokensList.includes(authHeader)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: corsHeaders,
        });
      }

      const deleteAll = url.searchParams.get("all") === "true";

      if (deleteAll) {
        await env.BETTER_INTRA_KV.delete(loginParam);
        return new Response("All cloud data deleted", {
          status: 200,
          headers: corsHeaders,
        });
      } else {
        const updatedTokens = tokensList.filter(
          (t: string) => t !== authHeader,
        );
        await env.BETTER_INTRA_KV.put(
          loginParam,
          JSON.stringify({
            sessionTokens: updatedTokens,
            settings: existingData.settings || {},
          }),
        );
        return new Response("Session removed", {
          status: 200,
          headers: corsHeaders,
        });
      }
    }

    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  },
};
