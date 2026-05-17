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

async function hashLogin(login: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(login.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
        const rawLogin = userData.login;

        if (!rawLogin)
          return new Response("Invalid 42 session", {
            status: 400,
            headers: corsHeaders,
          });

        const hashedLogin = await hashLogin(rawLogin);
        const newSessionToken = crypto.randomUUID();

        const existing = ((await env.BETTER_INTRA_KV.get(hashedLogin, {
          type: "json",
        })) as any) || { settings: {} };

        let activeTokens: string[] = Array.isArray(existing.sessionTokens)
          ? existing.sessionTokens
          : typeof existing.sessionToken === "string"
            ? [existing.sessionToken]
            : [];

        activeTokens.push(newSessionToken);
        if (activeTokens.length > 3) activeTokens.shift();

        await env.BETTER_INTRA_KV.put(
          hashedLogin,
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
                  login: "${rawLogin}"
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
      return new Response("Username hash required", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const existingData = (await env.BETTER_INTRA_KV.get(loginParam, {
      type: "json",
    })) as any;

    if (url.pathname === "/api/v1/public/visuals") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: corsHeaders,
        });
      }

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

      const publicVisuals = {
        avatar: existingData?.settings?.PROFILE_IMAGE_URL || "",
        banner: existingData?.settings?.PROFILE_BANNER_URL || "",
        background: existingData?.settings?.PROFILE_BACKGROUND_URL || "",
      };

      return new Response(JSON.stringify({ settings: publicVisuals }), {
        headers: dynamicCorsHeaders,
      });
    }

    if (url.pathname === "/api/v1/private/settings") {
      const authHeader = request.headers
        .get("Authorization")
        ?.replace("Bearer ", "");

      const data = existingData || { sessionTokens: [], settings: {} };

      const tokensList = Array.isArray(data.sessionTokens)
        ? data.sessionTokens
        : typeof data.sessionToken === "string"
          ? [data.sessionToken]
          : [];

      if (!authHeader) {
        return new Response("Missing Authorization Token", {
          status: 401,
          headers: corsHeaders,
        });
      }

      if (existingData && !tokensList.includes(authHeader)) {
        return new Response("Unauthorized: Invalid Session Token", {
          status: 401,
          headers: corsHeaders,
        });
      }

      if (request.method === "GET") {
        return new Response(
          JSON.stringify({
            settings: data.settings || {},
            activeSessions: tokensList.length || 1,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;
        let settingsToSave = body.settings || {};
        settingsToSave = {
          ...(data.settings || {}),
          ...settingsToSave,
        };

        const updatedTokens = tokensList.length > 0 ? tokensList : [authHeader];

        await env.BETTER_INTRA_KV.put(
          loginParam,
          JSON.stringify({
            sessionTokens: updatedTokens,
            settings: settingsToSave,
          }),
        );

        return new Response("Saved", { status: 200, headers: corsHeaders });
      }

      if (request.method === "DELETE") {
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
              settings: data.settings || {},
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
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
