import { Env } from "../types";

let tableReady: Promise<void> | null = null;

/** Lazily creates the tiny login → custom-avatar URL table. */
export function ensureCustomAvatarsTable(env: Env): Promise<void> {
  if (!tableReady) {
    tableReady = env.better_intra_d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS custom_avatars (login TEXT PRIMARY KEY, url TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
      )
      .run()
      .then(() => undefined)
      .catch(() => {
        tableReady = null;
      });
  }
  return tableReady;
}

export function isAvatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function getCustomAvatarMap(
  env: Env,
): Promise<Map<string, string>> {
  try {
    await ensureCustomAvatarsTable(env);
    const { results } = await env.better_intra_d1
      .prepare("SELECT login, url FROM custom_avatars")
      .all<{ login: string; url: string }>();
    return new Map(
      (results || [])
        .filter((row) => row.login && row.url)
        .map((row) => [row.login.toLowerCase(), row.url]),
    );
  } catch {
    return new Map();
  }
}

export async function setCustomAvatar(
  env: Env,
  login: string,
  url: string,
): Promise<void> {
  if (!login || !url) return;
  try {
    await ensureCustomAvatarsTable(env);
    await env.better_intra_d1
      .prepare(
        "INSERT INTO custom_avatars (login, url, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(login) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at",
      )
      .bind(login.toLowerCase(), url)
      .run();
  } catch {
    /* custom avatars are decorative; never fail settings */
  }
}

export async function deleteCustomAvatar(
  env: Env,
  login: string,
): Promise<void> {
  if (!login) return;
  try {
    await ensureCustomAvatarsTable(env);
    await env.better_intra_d1
      .prepare("DELETE FROM custom_avatars WHERE login = ?")
      .bind(login.toLowerCase())
      .run();
  } catch {
    /* ignore */
  }
}
