import { Env } from "./types";

export const WORKER_CALLBACK_URL =
  "https://better-intra-worker.nicopasla.workers.dev/callback";

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

let cachedAppToken: { token: string; expires: number } | null = null;

export async function getAppToken(env: {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
}): Promise<string> {
  if (cachedAppToken && Date.now() < cachedAppToken.expires) {
    return cachedAppToken.token;
  }

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
  cachedAppToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return cachedAppToken.token;
}

export async function updateProjectMap(env: Env, appToken: string) {
  let allProjects: any[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `https://api.intra.42.fr/v2/projects?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${appToken}` },
      },
    );

    if (!res.ok) break;

    const projects = (await res.json()) as any[];
    if (projects.length === 0) {
      hasMore = false;
    } else {
      allProjects = allProjects.concat(projects);
      page++;
    }
  }

  const map = allProjects.reduce((acc: Record<number, string>, p: any) => {
    acc[p.id] = p.name;
    return acc;
  }, {});

  await env.BETTER_INTRA_KV.put("PROJECT_MAP", JSON.stringify(map));
}
