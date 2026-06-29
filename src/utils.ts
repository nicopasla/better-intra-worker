import { Env, UserData, TokenResponse, ProjectResponse } from "./types";
import { APP_TOKEN_CACHE } from "./constants";

export function getCallbackUrl(env?: { CALLBACK_URL?: string }): string {
  const base = env?.CALLBACK_URL?.replace(/\/+$/, "");
  return base
    ? `${base}/callback`
    : "https://better-intra-worker.nicopasla.workers.dev/callback";
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
  return (
    request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
  );
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
  const cached = await env.BETTER_INTRA_KV.get<{
    token: string;
    expires: number;
  }>(APP_TOKEN_CACHE, { type: "json" });

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

    const data = (await res.json()) as TokenResponse;
    const token = data.access_token;
    if (!token) throw new Error("Missing access_token in app token response");
    const expiresIn = Math.max(60, (data.expires_in ?? 7200) - 60);
    const expires = Date.now() + expiresIn * 1000;

    await env.BETTER_INTRA_KV.put(
      APP_TOKEN_CACHE,
      JSON.stringify({ token, expires }),
      { expirationTtl: expiresIn },
    );

    return token;
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

    const projects = (await res.json()) as ProjectResponse[];
    if (projects.length === 0) break;

    allProjects = allProjects.concat(projects);
    page++;
  }

  const batchSize = 100;
  for (let i = 0; i < allProjects.length; i += batchSize) {
    const batch = allProjects
      .slice(i, i + batchSize)
      .map((p) =>
        env.better_intra_d1
          .prepare(
            "INSERT OR REPLACE INTO projects (id, name, slug) VALUES (?, ?, ?)",
          )
          .bind(p.id, p.name, p.slug),
      );
    await env.better_intra_d1.batch(batch);
  }
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

export async function decryptTokenData<T = Record<string, unknown>>(
  env: Env,
  encrypted: string,
): Promise<T> {
  const key = await getEncryptionKey(env);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function getUserToken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<string> {
  const d1Token = await getTokenFromD1(env, loginParam);
  const encryptedToken = d1Token ?? userData?.fortyTwoToken;

  if (encryptedToken && !d1Token && userData?.fortyTwoToken) {
    await saveTokenToD1(env, loginParam, userData.fortyTwoToken);
  }

  if (!encryptedToken) {
    console.log(
      `[getUserToken] ${loginParam}: no fortyTwoToken, using app token`,
    );
    await markTokenBroken(env, userData, loginParam);
    return getAppToken(env);
  }

  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  try {
    tokenData = await decryptTokenData<typeof tokenData>(env, encryptedToken);
  } catch {
    console.log(
      `[getUserToken] ${loginParam}: decryption failed, using app token`,
    );
    await markTokenBroken(env, userData, loginParam);
    return getAppToken(env);
  }

  if (Date.now() < tokenData.expires_at - 60000) {
    console.log(`[getUserToken] ${loginParam}: using cached user token`);
    await clearTokenBroken(env, userData, loginParam);
    return tokenData.access_token;
  }

  if (tokenData.refresh_token) {
    try {
      console.log(`[getUserToken] ${loginParam}: refreshing user token`);
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
        const data = (await res.json()) as TokenResponse;
        const newAccessToken = data.access_token;
        if (!newAccessToken) {
          console.log(
            `[getUserToken] ${loginParam}: refresh response missing access_token`,
          );
          await markTokenBroken(env, userData, loginParam);
          return getAppToken(env);
        }
        const newTokenData = {
          access_token: newAccessToken,
          refresh_token: data.refresh_token ?? tokenData.refresh_token,
          expires_at: Date.now() + (data.expires_in ?? 7200) * 1000,
        };
        const encrypted = await encryptTokenData(env, newTokenData);
        await saveTokenToD1(env, loginParam, encrypted);
        await clearTokenBroken(env, userData, loginParam);
        console.log(
          `[getUserToken] ${loginParam}: refreshed and stored new user token to D1`,
        );
        return newAccessToken;
      }

      console.log(
        `[getUserToken] ${loginParam}: refresh failed (${res.status}), using app token`,
      );
    } catch {
      console.log(
        `[getUserToken] ${loginParam}: refresh error, using app token`,
      );
    }
  } else {
    console.log(
      `[getUserToken] ${loginParam}: no refresh_token, using app token`,
    );
  }

  await markTokenBroken(env, userData, loginParam);
  return getAppToken(env);
}

export async function markTokenBroken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<void> {
  if (!userData) return;
  if (userData.tokenBroken) return;
  userData.tokenBroken = true;
  try {
    await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
  } catch {}
}

async function clearTokenBroken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<void> {
  if (!userData) return;
  if (!userData.tokenBroken) return;
  userData.tokenBroken = false;
  try {
    await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
  } catch {}
}

async function getTokenFromD1(env: Env, hash: string): Promise<string | null> {
  try {
    const row = await env.better_intra_d1
      .prepare("SELECT forty_two_token FROM users WHERE hash = ?")
      .bind(hash)
      .first<{ forty_two_token: string | null }>();
    return row?.forty_two_token ?? null;
  } catch {
    return null;
  }
}

async function saveTokenToD1(
  env: Env,
  hash: string,
  encryptedToken: string,
): Promise<void> {
  try {
    await env.better_intra_d1
      .prepare(
        "INSERT INTO users (hash, forty_two_token) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET forty_two_token = ?",
      )
      .bind(hash, encryptedToken, encryptedToken)
      .run();
  } catch (e) {
    console.warn(`[saveTokenToD1] failed for ${hash.slice(0, 6)}: ${e}`);
  }
}
