import { Env, UserData } from "../types";
import { getBearerToken, jsonRes, textRes, validateSession } from "../utils";
import { pushTransition } from "../push-send";
import { buildSubjectPush } from "../push-payloads";

/**
 * Subject versions come from the extension, which reads the real PDF date with
 * the user's intra session. The worker only stores the shared version and fans
 * out push notifications to PWA users doing that project.
 */

const MAX_ITEMS_PER_REPORT = 20;
const MAX_URL_LENGTH = 2048;
const MAX_SLUG_LENGTH = 120;
const MAX_SUBJECTS_PER_RUN = 10;
const CONCURRENCY = 4;
const PUSH_URL = "https://mobile.betterintra.com/#/profile?tab=projects";

/**
 * Master switch for subject-update Web Push (PWA recipients). Reports keep
 * being stored while this is off, so rows recorded in the meantime stay pending
 * and are delivered once it's turned back on.
 */
export const SUBJECT_NOTIFICATIONS_ENABLED = true;

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Stored version of a project subject. */
export interface SubjectVersionRow {
  slug: string;
  name: string | null;
  url: string;
  modified_at: number | null;
  changed_at: number | null;
  notified_at: number | null;
}

export type SubjectChange = "first" | "known" | "changed";

export interface StoredSubjectVersion {
  url: string;
  modified_at: number | null;
  name?: string | null;
  changed_at?: number | null;
  notified_at?: number | null;
}

export interface SubjectDecision {
  status: SubjectChange;
  url: string;
  modifiedAt: number | null;
}

/** Only intra-hosted PDF links are accepted, so a client can't point the
 *  registry (and other users' notifications) at an arbitrary URL. */
export function isSubjectPdfUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      /(^|\.)intra\.42\.fr$/i.test(url.hostname) &&
      /\.pdf$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Keeps reports from storing nonsense dates (epoch 0, far future, NaN). */
export function clampModifiedAt(
  value: unknown,
  now: number = Date.now(),
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < Date.UTC(2000, 0, 1)) return null;
  if (value > now + 24 * 60 * 60 * 1000) return null;
  return Math.floor(value);
}

/** Stable form for comparisons; strips fragments and normalises the origin. */
export function normalizeSubjectUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/**
 * Decides whether a report introduces a new subject version, is a no-op, or is
 * the first observation (which only establishes a baseline).
 *
 * A new version always ships as a new PDF link, so the link is the signal. A
 * date moving on the same link is a metadata artifact (the CDN `Last-Modified`
 * header versus the PDF's own date, which differ per visit) and must never
 * notify, or old versions get announced as if they had just changed. A
 * different link carrying the same date is a language variant: also quiet.
 */
export function decideSubjectVersion(
  stored: StoredSubjectVersion | null,
  incoming: { url: string; modifiedAt: number | null },
  now: number = Date.now(),
): SubjectDecision {
  const url = normalizeSubjectUrl(incoming.url);
  const modifiedAt = clampModifiedAt(incoming.modifiedAt, now);

  if (!stored) {
    return { status: "first", url, modifiedAt };
  }

  const previous = stored.modified_at;
  const storedUrl = normalizeSubjectUrl(stored.url);
  const dateOlder =
    modifiedAt != null && previous != null && modifiedAt < previous;
  const sameDate =
    modifiedAt != null && previous != null && modifiedAt === previous;

  if (url !== storedUrl && !dateOlder && !sameDate) {
    return { status: "changed", url, modifiedAt };
  }

  return {
    status: "known",
    // Never take an older link or date: stale reports (cached pages, old
    // variants) must not regress the registry. A newer date on the same link
    // is adopted quietly so later comparisons use the real baseline.
    url: dateOlder ? stored.url : url,
    modifiedAt: dateOlder ? previous : (modifiedAt ?? previous),
  };
}

/** Projects are stored as `[{ slug, name }]`; malformed rows are ignored. */
export function ongoingProjectSlugs(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry.slug === "string" ? entry.slug : null,
      )
      .filter((slug): slug is string => Boolean(slug));
  } catch {
    return [];
  }
}

/** A user is eligible when push is on and they haven't opted out. */
export function wantsSubjectNotification(userData: UserData): boolean {
  if (userData.settings?.PUSH_ENABLED === false) return false;
  if (userData.settings?.SUBJECT_NOTIFY_UPDATED === false) return false;
  return (userData.pushSubscriptions?.length ?? 0) > 0;
}

export function subjectRecipients(
  rows: { hash: string; projects: string }[],
  slug: string,
): string[] {
  return rows
    .filter((row) => ongoingProjectSlugs(row.projects).includes(slug))
    .map((row) => row.hash);
}

async function loadSubject(
  env: Env,
  slug: string,
): Promise<SubjectVersionRow | null> {
  return (
    (await env.better_intra_d1
      .prepare(
        "SELECT slug, name, url, modified_at, changed_at, notified_at FROM subject_versions WHERE slug = ?",
      )
      .bind(slug)
      .first<SubjectVersionRow>()) ?? null
  );
}

async function loadProjectName(env: Env, slug: string): Promise<string | null> {
  const row = await env.better_intra_d1
    .prepare("SELECT name FROM projects WHERE slug = ?")
    .bind(slug)
    .first<{ name: string }>();
  return row?.name ?? null;
}

/** The extension reports the version it just read from a project page. */
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

  let body: { items?: unknown };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }

  const items = Array.isArray(body?.items)
    ? body.items.slice(0, MAX_ITEMS_PER_REPORT)
    : [];
  if (items.length === 0) return jsonRes({ subjects: [] });

  const nowSec = Math.floor(Date.now() / 1000);
  const results: { slug: string; status: SubjectChange | "unknown" }[] = [];

  for (const raw of items) {
    const item = raw as {
      slug?: unknown;
      url?: unknown;
      modifiedAt?: unknown;
    };
    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    const url = typeof item?.url === "string" ? item.url.trim() : "";

    if (
      !slug ||
      slug.length > MAX_SLUG_LENGTH ||
      !SLUG_RE.test(slug) ||
      !isSubjectPdfUrl(url)
    ) {
      results.push({ slug, status: "unknown" });
      continue;
    }

    try {
      const stored = await loadSubject(env, slug);
      const name = (await loadProjectName(env, slug)) ?? slug;
      const decision = decideSubjectVersion(
        stored,
        { url, modifiedAt: clampModifiedAt(item.modifiedAt) },
        Date.now(),
      );

      if (decision.status === "first") {
        await env.better_intra_d1
          .prepare(
            "INSERT INTO subject_versions (slug, name, url, modified_at, changed_at, notified_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(slug, name, decision.url, decision.modifiedAt, nowSec, nowSec)
          .run();
      } else if (decision.status === "changed") {
        await env.better_intra_d1
          .prepare(
            "UPDATE subject_versions SET name = ?, url = ?, modified_at = ?, changed_at = ?, notified_at = NULL WHERE slug = ?",
          )
          .bind(name, decision.url, decision.modifiedAt, nowSec, slug)
          .run();
      } else if (
        stored &&
        (stored.url !== decision.url ||
          stored.modified_at !== decision.modifiedAt ||
          stored.name !== name)
      ) {
        // Adopt a variant link / backfilled date without notifying.
        await env.better_intra_d1
          .prepare(
            "UPDATE subject_versions SET name = ?, url = ?, modified_at = ? WHERE slug = ?",
          )
          .bind(name, decision.url, decision.modifiedAt, slug)
          .run();
      }

      results.push({ slug, status: decision.status });
    } catch (e) {
      console.warn(`[subjects] report failed slug=${slug}: ${e}`);
      results.push({ slug, status: "unknown" });
    }
  }

  return jsonRes({ subjects: results });
}

/**
 * Sends pending subject updates. Runs from the Cloudflare scheduled trigger
 * because it only reads D1 + KV and sends Web Push (no 42 API calls).
 */
export async function handleSubjectNotifications(env: Env): Promise<void> {
  if (!SUBJECT_NOTIFICATIONS_ENABLED) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  let pending: SubjectVersionRow[] = [];
  try {
    const result = await env.better_intra_d1
      .prepare(
        "SELECT slug, name, url, modified_at, changed_at, notified_at FROM subject_versions WHERE notified_at IS NULL ORDER BY changed_at ASC LIMIT ?",
      )
      .bind(MAX_SUBJECTS_PER_RUN)
      .all<SubjectVersionRow>();
    pending = result.results ?? [];
  } catch (e) {
    console.warn(`[subjects] D1 read failed: ${e}`);
    return;
  }
  if (pending.length === 0) return;

  let rows: { hash: string; projects: string }[] = [];
  try {
    const result = await env.better_intra_d1
      .prepare("SELECT hash, projects FROM user_ongoing_projects")
      .all<{ hash: string; projects: string }>();
    rows = result.results ?? [];
  } catch (e) {
    console.warn(`[subjects] recipients read failed: ${e}`);
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  for (const subject of pending) {
    // Claim before sending: a retried tick must not double-notify.
    try {
      const claim = await env.better_intra_d1
        .prepare(
          "UPDATE subject_versions SET notified_at = ? WHERE slug = ? AND notified_at IS NULL",
        )
        .bind(nowSec, subject.slug)
        .run();
      const changes = (claim.meta as { changes?: number } | undefined)?.changes;
      if (changes === 0) continue;
    } catch (e) {
      console.warn(`[subjects] claim failed slug=${subject.slug}: ${e}`);
      continue;
    }

    const recipients = subjectRecipients(rows, subject.slug);
    const project = subject.name || subject.slug;

    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      await Promise.all(
        recipients.slice(i, i + CONCURRENCY).map(async (hash) => {
          try {
            const userData = await env.BETTER_INTRA_KV.get<UserData>(hash, {
              type: "json",
            });
            if (!userData || !wantsSubjectNotification(userData)) return;

            await pushTransition(
              env,
              hash,
              userData.pushSubscriptions ?? [],
              () =>
                buildSubjectPush({
                  project,
                  modifiedAt: subject.modified_at,
                }),
              {
                url: PUSH_URL,
                tag: `subject-${subject.slug}-${subject.modified_at ?? subject.changed_at ?? nowSec}`,
              },
            );
          } catch (e) {
            console.warn(
              `[subjects] push failed slug=${subject.slug} hash=${hash.slice(0, 6)}: ${e}`,
            );
          }
        }),
      );
    }

    console.log(
      `[subjects] notified ${subject.slug} to ${recipients.length} user(s)`,
    );
  }
}
