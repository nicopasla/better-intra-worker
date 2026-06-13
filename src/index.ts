import { handleCallback, handleLogin } from "./handlers/auth";
import {
  handlePrivateSettings,
  handlePublicVisuals,
} from "./handlers/settings";
import { handleFriendsData } from "./handlers/friends";
import { handleProxy } from "./handlers/proxy";
import { handleEvaluations } from "./handlers/evaluations";
import { handleDiscordLink, handleDiscordUnlink, handleDiscordTest } from "./handlers/discord";
import { handleCron } from "./handlers/cron";
import { Env, UserData } from "./types";
import { isOriginAllowed, textRes } from "./utils";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !isOriginAllowed(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      const acao = origin || "*";
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": acao,
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/login") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      return handleLogin(request, env);
    }

    if (url.pathname === "/callback") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      return handleCallback(request, env);
    }

    if (url.pathname === "/api/v1/private/discord/test") {
      return handleDiscordTest(request, env);
    }

    const loginParam = url.searchParams.get("login");
    if (!loginParam) {
      return textRes("Username hash required", 400);
    }

    const existingData: UserData | null = await env.BETTER_INTRA_KV.get(
      loginParam,
      { type: "json" },
    );

    if (url.pathname === "/api/v1/public/visuals") {
      return handlePublicVisuals(request, existingData);
    }

    if (url.pathname === "/api/v1/private/settings") {
      return handlePrivateSettings(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/friends/data") {
      return handleFriendsData(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/proxy") {
      return handleProxy(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/evaluations") {
      return handleEvaluations(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/discord/link") {
      return handleDiscordLink(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/discord/unlink") {
      return handleDiscordUnlink(request, env, loginParam, existingData);
    }

    return textRes("Not found", 404);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/5 * * * *") {
      await handleCron(env, ctx);
    }
  },
};
