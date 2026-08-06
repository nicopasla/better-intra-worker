import { Env } from "../types";
import { jsonRes, textRes } from "../utils";

const ANNOUNCEMENT_KEY = "ANNOUNCEMENT";
const MAX_MESSAGE_LENGTH = 500;

type Announcement = { message: string; updatedAt: number };

export async function handleAnnouncement(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") {
    const stored = await env.BETTER_INTRA_KV.get<Announcement>(
      ANNOUNCEMENT_KEY,
      { type: "json" },
    );
    return jsonRes({
      message: stored?.message ?? null,
      updatedAt: stored?.updatedAt ?? null,
    });
  }

  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return textRes("Invalid JSON", 400);
    }
    if (typeof body?.secret !== "string" || body.secret !== env.ANNOUNCEMENT_SECRET) {
      return textRes("Forbidden", 403);
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length > MAX_MESSAGE_LENGTH) {
      return textRes(`Message too long (max ${MAX_MESSAGE_LENGTH})`, 400);
    }

    if (message === "") {
      await env.BETTER_INTRA_KV.delete(ANNOUNCEMENT_KEY);
      return jsonRes({ message: null });
    }

    await env.BETTER_INTRA_KV.put(
      ANNOUNCEMENT_KEY,
      JSON.stringify({ message, updatedAt: Date.now() }),
    );
    return jsonRes({ message });
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    if (url.searchParams.get("secret") !== env.ANNOUNCEMENT_SECRET) {
      return textRes("Forbidden", 403);
    }
    await env.BETTER_INTRA_KV.delete(ANNOUNCEMENT_KEY);
    return jsonRes({ message: null });
  }

  return textRes("Method not allowed", 405);
}
