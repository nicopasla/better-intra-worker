import { handleCallback, handleLogin } from "./handlers/auth";
import {
  handlePrivateSettings,
  handlePublicVisuals,
} from "./handlers/settings";
import { handleFriendsData } from "./handlers/friends";
import { handleProxy } from "./handlers/proxy";
import { handleGhProxy } from "./handlers/gh-proxy";
import { handleEvaluations } from "./handlers/evaluations";
import { handleOutstanding } from "./handlers/outstanding";
import { handleProfileStats } from "./handlers/profile-stats";
import {
  handleCalendarToken,
  handleCalendarUpdate,
  handleCalendarIcs,
} from "./handlers/calendar";
import { handleClusterSvg, handleClusterSvgs } from "./handlers/clusters";
import { handleRankings } from "./handlers/rankings";
import {
  handleDiscordLink,
  handleDiscordUnlink,
  handleDiscordQuiet,
  handleDiscordTest,
  handleDiscordAuth,
  handleDiscordCallback,
} from "./handlers/discord";
import { handleMainCron, handleRevealCatchup } from "./handlers/cron";
import { Env, UserData } from "./types";
import {
  isOriginAllowed,
  textRes,
  getAppToken,
  updateProjectMap,
  jsonRes,
} from "./utils";

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

    if (url.pathname.startsWith("/gh/")) {
      return handleGhProxy(request);
    }

    if (url.pathname === "/api/v1/private/discord/test") {
      return handleDiscordTest(request, env);
    }

    if (url.pathname === "/api/v1/private/projects/refresh") {
      if (request.method !== "POST") return textRes("Method not allowed", 405);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return textRes("Invalid JSON", 400);
      }
      if (!body?.secret || body.secret !== env.PROJECT_REFRESH_SECRET)
        return textRes("Forbidden", 403);
      try {
        const appToken = await getAppToken(env);
        await updateProjectMap(env, appToken);
        return jsonRes({ refreshed: true });
      } catch (e) {
        return textRes(`Refresh failed: ${e}`, 500);
      }
    }

    if (url.pathname === "/api/v1/cluster/svg") {
      return handleClusterSvg(request, env, origin);
    }

    if (url.pathname === "/api/v1/cluster/svgs") {
      return handleClusterSvgs(env, origin);
    }

    if (url.pathname === "/api/v1/rankings") {
      return handleRankings(request, env, origin);
    }

    if (url.pathname === "/discord/auth") {
      return handleDiscordAuth(request, env);
    }

    if (url.pathname === "/discord/callback") {
      return handleDiscordCallback(request, env);
    }

    const calMatch = url.pathname.match(/^\/calendar\/([^\/]+)\.ics$/);
    if (calMatch) {
      return handleCalendarIcs(calMatch[1], env);
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

    if (url.pathname === "/api/v1/private/outstanding") {
      return handleOutstanding(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/discord/link") {
      return handleDiscordLink(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/discord/unlink") {
      return handleDiscordUnlink(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/discord/quiet") {
      return handleDiscordQuiet(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/profile-stats") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      const target = url.searchParams.get("target");
      if (!target) return textRes("Missing target parameter", 400);
      return handleProfileStats(request, env, loginParam, existingData, target);
    }

    if (url.pathname === "/api/v1/private/calendar/token") {
      return handleCalendarToken(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/calendar/update") {
      return handleCalendarUpdate(request, env, loginParam, existingData);
    }

    return textRes("Not found", 404);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/10 * * * *") {
      await handleMainCron(env, ctx);
    }
    if (event.cron === "* * * * *") {
      await handleRevealCatchup(env, ctx);
    }
  },
};
