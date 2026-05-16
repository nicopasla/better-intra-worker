export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const REDIRECT_URI = `${url.origin}/callback`;

    if (url.pathname === "/login") {
      const authUrl = `https://api.intra.42.fr/oauth/authorize?client_id=${env.CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=public`;
      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response("Configuration Error: Missing API Credentials.", {
          status: 500,
        });
      }

      try {
        const formData = new FormData();
        formData.append("grant_type", "authorization_code");
        formData.append("client_id", env.CLIENT_ID);
        formData.append("client_secret", env.CLIENT_SECRET);
        formData.append("code", code);
        formData.append("redirect_uri", REDIRECT_URI);

        const tokenResponse = await fetch(
          "https://api.intra.42.fr/oauth/token",
          {
            method: "POST",
            body: formData,
          },
        );
        const tokenData = (await tokenResponse.json()) as any;

        if (tokenData.error) {
          return new Response(
            `42 OAuth Error: ${tokenData.error_description || tokenData.error}`,
            { status: 400 },
          );
        }

        const userResponse = await fetch("https://api.intra.42.fr/v2/me", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = (await userResponse.json()) as any;
        const login = userData.login;

        if (!login) return new Response("Invalid 42 session", { status: 400 });

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

        const html = `
          <!DOCTYPE html>
          <html>
          <head><title>Better Intra Auth</title></head>
          <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h2>Login Successful!</h2>
            <p>Synchronizing, this window will close automatically...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: "42_AUTH_SUCCESS", token: "${newSessionToken}", login: "${login}" }, "*");
                window.close();
              } else {
                document.body.innerHTML = "<h2>Error: Parent window not found.</h2>";
              }
            </script>
          </body>
          </html>
        `;
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        return new Response("Auth Server Error", { status: 500 });
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
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://");

      if (!isAuthorized) {
        return new Response("Unauthorized platform", { status: 403 });
      }

      const dynamicCorsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
      };

      if (!existingData) {
        return new Response(JSON.stringify({ settings: {} }), {
          headers: dynamicCorsHeaders,
        });
      }

      const publicData = {
        settings: existingData.settings || {},
      };

      return new Response(JSON.stringify(publicData), {
        headers: dynamicCorsHeaders,
      });
    }

    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  },
};
