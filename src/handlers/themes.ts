import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";

const THEMES_MAX = 200;
const THEMES_DEFAULT_LIMIT = 60;

type ThemeColors = {
  dark: Record<string, string>;
  light: Record<string, string>;
};

type Theme = {
  id: string;
  name: string;
  author: string;
  mode: "dark" | "light";
  colors: ThemeColors;
  likes: number;
  createdAt?: number;
};

type ThemeRow = {
  id: string;
  name: string;
  author: string;
  mode: string;
  colors_json: string;
  likes: number;
  created_at: number;
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

/** Author-scoped stable id so re-sharing the same theme updates in place. */
function stableId(author: string, name: string): string {
  return `${slug(author)}-${slug(name)}`.slice(0, 64);
}

type ParsedTheme = {
  name: string;
  author: string;
  mode: "dark" | "light";
  colors: ThemeColors;
};

function sanitizeTheme(raw: unknown): ParsedTheme | null {
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

  return {
    name,
    author,
    mode: t.mode === "light" ? "light" : "dark",
    colors: { dark: dark ?? {}, light: light ?? {} },
  };
}

function rowToTheme(row: ThemeRow): Theme | null {
  let colors: ThemeColors | null = null;
  try {
    colors = JSON.parse(row.colors_json) as ThemeColors;
  } catch {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    mode: row.mode === "light" ? "light" : "dark",
    colors: colors ?? { dark: {}, light: {} },
    likes: row.likes ?? 0,
    createdAt: row.created_at * 1000,
  };
}

function requireAuth(
  request: Request,
  existingData: UserData | null,
): Response | null {
  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }
  return null;
}

export async function handleListThemes(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const limit = Math.min(
    THEMES_MAX,
    Math.max(1, Number(url.searchParams.get("limit")) || THEMES_DEFAULT_LIMIT),
  );

  const where = ["hidden = 0"];
  const args: unknown[] = [];
  if (q) {
    where.push("(name LIKE ? OR author LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }

  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT id, name, author, mode, colors_json, likes, created_at
       FROM themes WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all();

  const themes = (results as ThemeRow[])
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
  const authError = requireAuth(request, existingData);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }

  const parsed = sanitizeTheme(body);
  if (!parsed) return textRes("Invalid theme", 400);

  const id = stableId(parsed.author, parsed.name);
  const existing = await env.better_intra_d1
    .prepare("SELECT author_hash FROM themes WHERE id = ?")
    .bind(id)
    .first<{ author_hash: string | null }>();

  if (existing && existing.author_hash && existing.author_hash !== loginParam) {
    return textRes("That theme name is already taken", 409);
  }

  await env.better_intra_d1
    .prepare(
      "INSERT INTO themes (id, name, author, author_hash, mode, colors_json, hidden, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0, unixepoch()) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, author = excluded.author, author_hash = excluded.author_hash, mode = excluded.mode, colors_json = excluded.colors_json, hidden = 0",
    )
    .bind(
      id,
      parsed.name,
      parsed.author,
      loginParam,
      parsed.mode,
      JSON.stringify(parsed.colors),
    )
    .run();

  return jsonRes({ ok: true, id }, existing ? 200 : 201);
}

export async function handleLikeTheme(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const delta =
    new URL(request.url).searchParams.get("delta") === "-1" ? -1 : 1;
  const theme = await env.better_intra_d1
    .prepare("SELECT likes, hidden FROM themes WHERE id = ?")
    .bind(id)
    .first<{ likes: number; hidden: number }>();
  if (!theme || theme.hidden) return textRes("Theme not found", 404);

  const next = Math.max(0, (theme.likes ?? 0) + delta);
  await env.better_intra_d1
    .prepare("UPDATE themes SET likes = ? WHERE id = ?")
    .bind(next, id)
    .run();
  return jsonRes({ likes: next });
}

export async function handleHideTheme(
  request: Request,
  env: Env,
  id: string,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);
  const authError = requireAuth(request, existingData);
  if (authError) return authError;

  const theme = await env.better_intra_d1
    .prepare("SELECT author_hash FROM themes WHERE id = ?")
    .bind(id)
    .first<{ author_hash: string | null }>();
  if (!theme) return textRes("Theme not found", 404);
  if (theme.author_hash !== loginParam) return textRes("Not your theme", 403);

  await env.better_intra_d1
    .prepare("UPDATE themes SET hidden = 1 WHERE id = ?")
    .bind(id)
    .run();
  return jsonRes({ ok: true });
}
