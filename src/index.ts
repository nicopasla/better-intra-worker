export interface Env {
  BETTER_INTRA_KV: KVNamespace;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const login = url.searchParams.get("login");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!login) {
      return new Response("Username required", {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      if (request.method === "GET") {
        const data = await env.BETTER_INTRA_KV.get(login, { type: "json" });
        if (!data)
          return new Response("Not Found", {
            status: 404,
            headers: corsHeaders,
          });

        const { password, ...publicSettings } = data as any;
        return Response.json(publicSettings, { headers: corsHeaders });
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;

        const existing = (await env.BETTER_INTRA_KV.get(login, {
          type: "json",
        })) as any;

        if (existing && existing.password !== body.password) {
          return new Response("Unauthorized", {
            status: 401,
            headers: corsHeaders,
          });
        }

        await env.BETTER_INTRA_KV.put(
          login,
          JSON.stringify({
            password: body.password,
            settings: body.settings,
          }),
        );

        return new Response("Saved", { status: 200, headers: corsHeaders });
      }

      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders,
      });
    } catch (e) {
      return new Response("Server Error", {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
