export interface Env {
  BETTER_INTRA_KV: KVNamespace;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function nativeWorkerHash(
  password: string,
  saltString: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const saltBuffer = encoder.encode(saltString);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  const exportedKey = await crypto.subtle.exportKey("raw", derivedKey);
  return Array.from(new Uint8Array(exportedKey))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

        const { password, passwordHash, ...publicSettings } = data as any;
        return Response.json(publicSettings, { headers: corsHeaders });
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;

        if (!body.password) {
          return new Response("Password required", {
            status: 400,
            headers: corsHeaders,
          });
        }

        const incomingPasswordHash = await nativeWorkerHash(
          body.password,
          login,
        );

        const existing = (await env.BETTER_INTRA_KV.get(login, {
          type: "json",
        })) as any;

        if (existing) {
          const storedHash = existing.passwordHash || existing.password;
          if (storedHash !== incomingPasswordHash) {
            return new Response("Unauthorized", {
              status: 401,
              headers: corsHeaders,
            });
          }
        }

        const isConnectionTest =
          existing &&
          (!body.settings || Object.keys(body.settings).length === 0);

        const settingsToSave = isConnectionTest
          ? existing.settings
          : body.settings || {};

        await env.BETTER_INTRA_KV.put(
          login,
          JSON.stringify({
            passwordHash: incomingPasswordHash,
            settings: settingsToSave,
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
