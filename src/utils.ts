import { Env, UserData } from "./types";

export function getCallbackUrl(env?: { CALLBACK_URL?: string }): string {
  const base = env?.CALLBACK_URL?.replace(/\/+$/, "");
  return base ? `${base}/callback` : "https://better-intra-worker.nicopasla.workers.dev/callback";
}

const ALLOWED_ORIGINS = [
  "https://profile-v3.intra.42.fr",
  "https://meta.intra.42.fr",
];

export function isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("moz-extension://")) return true;
  return false;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const textRes = (
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
) =>
  new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });

export function getBearerToken(request: Request): string | null {
  return request.headers
    .get("Authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export function validateSession(
  existingData: { sessionTokens?: string[]; sessionToken?: string },
  token: string,
): boolean {
  const tokens = getTokens(existingData);
  return tokens.includes(token);
}

export const getTokens = (data: any): string[] =>
  Array.isArray(data?.sessionTokens)
    ? data.sessionTokens
    : typeof data?.sessionToken === "string"
      ? [data.sessionToken]
      : [];

export async function hashLogin(login: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(login.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const pendingTokens = new WeakMap<Env, Promise<string>>();

export async function getAppToken(env: Env): Promise<string> {
  const KV_KEY = "APP_TOKEN_CACHE";
  const cached = await env.BETTER_INTRA_KV.get<{
    token: string;
    expires: number;
  }>(KV_KEY, { type: "json" });

  if (cached && Date.now() < cached.expires) {
    return cached.token;
  }

  if (pendingTokens.has(env)) {
    return pendingTokens.get(env)!;
  }

  const promise = (async () => {
    const res = await fetch("https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
      }),
    });

    if (!res.ok) throw new Error("Failed to get app token");

    const data = (await res.json()) as any;
    const expiresIn = (data.expires_in ?? 7200) - 60;
    const expires = Date.now() + expiresIn * 1000;

    await env.BETTER_INTRA_KV.put(
      KV_KEY,
      JSON.stringify({ token: data.access_token, expires }),
      { expirationTtl: expiresIn },
    );

    return data.access_token;
  })();

  pendingTokens.set(env, promise);
  try {
    return await promise;
  } finally {
    pendingTokens.delete(env);
  }
}

export async function updateProjectMap(env: Env, appToken: string) {
  let allProjects: any[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.intra.42.fr/v2/projects?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${appToken}` },
      },
    );

    if (!res.ok) return;

    const projects = (await res.json()) as any[];
    if (projects.length === 0) break;

    allProjects = allProjects.concat(projects);
    page++;
  }

  const map = allProjects.reduce((acc: Record<number, string>, p: any) => {
    acc[p.id] = p.name;
    return acc;
  }, {});

  await env.BETTER_INTRA_KV.put("PROJECT_MAP", JSON.stringify(map));
}

const keyCache = new WeakMap<Env, CryptoKey>();

async function getEncryptionKey(env: Env): Promise<CryptoKey> {
  const cached = keyCache.get(env);
  if (cached) return cached;

  const keyBase64 = env.TOKEN_ENCRYPTION_KEY;
  if (!keyBase64) throw new Error("TOKEN_ENCRYPTION_KEY not set");

  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  keyCache.set(env, key);
  return key;
}

export async function encryptTokenData(
  env: Env,
  data: object,
): Promise<string> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTokenData(
  env: Env,
  encrypted: string,
): Promise<any> {
  const key = await getEncryptionKey(env);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function getUserToken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<string> {
  if (!userData?.fortyTwoToken) return getAppToken(env);

  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  try {
    tokenData = await decryptTokenData(env, userData.fortyTwoToken);
  } catch {
    return getAppToken(env);
  }

  if (Date.now() < tokenData.expires_at - 60000) {
    return tokenData.access_token;
  }

  if (tokenData.refresh_token) {
    try {
      const res = await fetch("https://api.intra.42.fr/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
          refresh_token: tokenData.refresh_token,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const newTokenData = {
          access_token: data.access_token,
          refresh_token: data.refresh_token ?? tokenData.refresh_token,
          expires_at: Date.now() + (data.expires_in * 1000),
        };
        const encrypted = await encryptTokenData(env, newTokenData);
        userData.fortyTwoToken = encrypted;
        await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
        return data.access_token;
      }
    } catch {
      // fall through to app token
    }
  }

  return getAppToken(env);
}
