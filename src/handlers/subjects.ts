import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";

interface SubjectRow {
  url: string;
  last_changed_at: number | null;
}

async function loadSubject(env: Env, slug: string): Promise<SubjectRow | null> {
  return (
    (await env.better_intra_d1
      .prepare("SELECT url, last_changed_at FROM subjects WHERE slug = ?")
      .bind(slug)
      .first<SubjectRow>()) ?? null
  );
}

async function loadProjectName(env: Env, slug: string): Promise<string | null> {
  const row = await env.better_intra_d1
    .prepare("SELECT name FROM projects WHERE slug = ?")
    .bind(slug)
    .first<{ name: string }>();
  return row?.name ?? null;
}

async function insertSubject(
  env: Env,
  slug: string,
  url: string,
): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "INSERT INTO subjects (slug, url, last_changed_at) VALUES (?, ?, NULL)",
    )
    .bind(slug, url)
    .run();
}

async function updateSubject(
  env: Env,
  slug: string,
  url: string,
  at: number,
): Promise<void> {
  await env.better_intra_d1
    .prepare("UPDATE subjects SET url = ?, last_changed_at = ? WHERE slug = ?")
    .bind(url, at, slug)
    .run();
}

export async function handleSubjectsReport(
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

  let body: { items?: any[] };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }
  const items = Array.isArray(body?.items) ? body.items : [];

  const now = Date.now();
  const results: any[] = [];

  for (const item of items) {
    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    if (!slug || typeof item?.url !== "string" || !item.url.trim()) {
      results.push({ slug, status: "unknown", reason: "missing_slug_or_url" });
      continue;
    }

    const url = item.url.trim();
    const name = await loadProjectName(env, slug);

    const current = await loadSubject(env, slug);
    if (!current) {
      // First time this subject is seen → register the link, no badge yet.
      await insertSubject(env, slug, url);
      results.push({ slug, status: "first", name, lastChangedAt: null });
      continue;
    }

    if (current.url === url) {
      // Same link → nothing changed, return the recorded change date.
      results.push({
        slug,
        status: "known",
        name,
        lastChangedAt: current.last_changed_at,
      });
      continue;
    }

    // Different link → record when it changed.
    await updateSubject(env, slug, url, now);
    results.push({ slug, status: "changed", name, lastChangedAt: now });
  }

  return jsonRes({ subjects: results });
}

export async function handleSubjectsState(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const raw = new URL(request.url).searchParams.get("slugs") ?? "";
  const slugs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const results: any[] = [];
  for (const slug of slugs) {
    const row = await loadSubject(env, slug);
    const name = await loadProjectName(env, slug);
    results.push({
      slug,
      tracked: !!row,
      name,
      url: row?.url ?? null,
      lastChangedAt: row?.last_changed_at ?? null,
    });
  }

  return jsonRes({ subjects: results });
}
