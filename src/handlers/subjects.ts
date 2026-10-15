import { Env, UserData } from "../types";
import {
  getAppToken,
  getBearerToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";
import { intraFetch } from "../rate";

const API_BASE = "https://api.intra.42.fr";

interface SubjectRow {
  url: string;
  created_at: number | null;
  modified_at: number | null;
  last_changed_at: number | null;
}

interface ProjectDates {
  createdAt: number | null;
  modifiedAt: number | null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reads a project's timestamps from the 42 API. The PDF itself lives behind an
 * authenticated CDN, so the shared registry uses the project record instead.
 */
async function fetchProjectDates(
  env: Env,
  slug: string,
): Promise<ProjectDates | null> {
  try {
    const token = await getAppToken(env);
    const res = await intraFetch(
      env,
      token,
      `${API_BASE}/v2/projects/${encodeURIComponent(slug)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      created_at?: unknown;
      updated_at?: unknown;
    };
    return {
      createdAt: toEpochMs(data?.created_at),
      modifiedAt: toEpochMs(data?.updated_at),
    };
  } catch {
    return null;
  }
}

async function loadSubject(env: Env, slug: string): Promise<SubjectRow | null> {
  return (
    (await env.better_intra_d1
      .prepare(
        "SELECT url, created_at, modified_at, last_changed_at FROM subjects WHERE slug = ?",
      )
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
    .prepare("INSERT INTO subjects (slug, url) VALUES (?, ?)")
    .bind(slug, url)
    .run();
}

async function updateSubject(
  env: Env,
  slug: string,
  url: string,
  createdAt: number | null,
  modifiedAt: number | null,
  lastChangedAt: number | null,
): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "UPDATE subjects SET url = ?, created_at = ?, modified_at = ?, last_changed_at = ? WHERE slug = ?",
    )
    .bind(url, createdAt, modifiedAt, lastChangedAt, slug)
    .run();
}

/**
 * Rows seeded before the projects-API lookup exist without any dates. Fill them
 * in lazily on the next read, without touching `last_changed_at` (a backfill is
 * not a detected change).
 */
async function backfillDates(
  env: Env,
  slug: string,
  row: SubjectRow,
): Promise<SubjectRow> {
  if (row.created_at != null || row.modified_at != null) return row;
  const dates = await fetchProjectDates(env, slug);
  if (!dates) return row;
  await updateSubject(
    env,
    slug,
    row.url,
    dates.createdAt,
    dates.modifiedAt,
    row.last_changed_at,
  );
  return { ...row, created_at: dates.createdAt, modified_at: dates.modifiedAt };
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
      results.push({
        slug,
        status: "first",
        name,
        createdAt: null,
        modifiedAt: null,
        lastChangedAt: null,
      });
      continue;
    }

    if (current.url === url) {
      // Same link → nothing changed, return the recorded state.
      results.push({
        slug,
        status: "known",
        name,
        createdAt: current.created_at,
        modifiedAt: current.modified_at,
        lastChangedAt: current.last_changed_at,
      });
      continue;
    }

    const dates = await fetchProjectDates(env, slug);
    const newer =
      dates?.modifiedAt != null &&
      (current.modified_at == null || dates.modifiedAt > current.modified_at);

    if (dates && newer) {
      // The project itself was updated → record the change and its date.
      await updateSubject(
        env,
        slug,
        url,
        dates.createdAt,
        dates.modifiedAt,
        now,
      );
      results.push({
        slug,
        status: "changed",
        name,
        createdAt: dates.createdAt,
        modifiedAt: dates.modifiedAt,
        lastChangedAt: now,
      });
      continue;
    }

    if (dates) {
      // URL differs but the project wasn't updated (e.g. a language variant)
      // → adopt the link quietly, keeping the recorded dates.
      await updateSubject(
        env,
        slug,
        url,
        current.created_at,
        current.modified_at,
        current.last_changed_at,
      );
    }

    // API unavailable (or dates not newer) → keep the stored state; a later
    // visit retries the lookup without showing a badge.
    results.push({
      slug,
      status: "known",
      name,
      createdAt: current.created_at,
      modifiedAt: current.modified_at,
      lastChangedAt: current.last_changed_at,
    });
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
    let row = await loadSubject(env, slug);
    if (row) row = await backfillDates(env, slug, row);
    const name = await loadProjectName(env, slug);
    results.push({
      slug,
      tracked: !!row,
      name,
      url: row?.url ?? null,
      createdAt: row?.created_at ?? null,
      modifiedAt: row?.modified_at ?? null,
      lastChangedAt: row?.last_changed_at ?? null,
    });
  }

  return jsonRes({ subjects: results });
}
