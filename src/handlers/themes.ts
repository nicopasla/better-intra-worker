import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";

const THEMES_MAX = 200;

type Theme = {
  id: string;
  name: string;
  author: string;
  mode: "dark" | "light";
  colors: { dark: Record<string, string>; light: Record<string, string> };
  createdAt?: number;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizePalette(p: unknown): Record<string, string> | null {
  if (!p || typeof p !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (typeof v === "string" && HEX_RE.test(v)) out[k] = v.toLowerCase();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function sanitizeTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const name = typeof t.name === "string" ? t.name.trim().slice(0, 40) : "";
  const author =
    typeof t.author === "string" ? t.author.trim().slice(0, 24) : "";
  if (!name || !author) return null;

  const colors = t.colors as Record<string, unknown> | undefined;
  const dark = sanitizePalette(colors?.dark);
  const light = sanitizePalette(colors?.light);
  if (!dark && !light) return null;

  const id =
    typeof t.id === "string" && t.id.trim()
      ? t.id.trim().slice(0, 64)
      : `${slug(name)}-${Date.now().toString(36)}`;

  return {
    id,
    name,
    author,
    mode: t.mode === "light" ? "light" : "dark",
    colors: { dark: dark ?? {}, light: light ?? {} },
  };
}

function rowToTheme(row: {
  id: string;
  name: string;
  author: string;
  mode: string;
  colors_json: string;
  created_at: number;
}): Theme | null {
  let colors: Theme["colors"] | null = null;
  try {
    colors = JSON.parse(row.colors_json) as Theme["colors"];
  } catch {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    mode: row.mode === "light" ? "light" : "dark",
    colors: colors ?? { dark: {}, light: {} },
    createdAt: row.created_at * 1000,
  };
}

export async function handleListThemes(env: Env): Promise<Response> {
  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT id, name, author, mode, colors_json, created_at FROM themes ORDER BY created_at DESC LIMIT ?",
    )
    .bind(THEMES_MAX)
    .all();
  const themes = (results as {
    id: string;
    name: string;
    author: string;
    mode: string;
    colors_json: string;
    created_at: number;
  }[])
    .map(rowToTheme)
    .filter((t): t is Theme => !!t);
  return jsonRes({ themes });
}

export async function handleUploadTheme(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }

  const theme = sanitizeTheme(body);
  if (!theme) return textRes("Invalid theme", 400);

  await env.better_intra_d1
    .prepare(
      "INSERT INTO themes (id, name, author, mode, colors_json) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, author = excluded.author, mode = excluded.mode, colors_json = excluded.colors_json",
    )
    .bind(
      theme.id,
      theme.name,
      theme.author,
      theme.mode,
      JSON.stringify(theme.colors),
    )
    .run();

  return jsonRes({ ok: true, theme }, 201);
}