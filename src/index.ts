import {
  handleCallback,
  handleLogin,
  handleAuthExchange,
} from "./handlers/auth";
import {
  handlePrivateSettings,
  handlePublicVisuals,
  handleSettingsHistory,
  handleSettingsRestore,
} from "./handlers/settings";
import { handleFriendsData } from "./handlers/friends";
import { handleSessions } from "./handlers/sessions";
import { handleProxy } from "./handlers/proxy";
import { handleGhProxy } from "./handlers/gh-proxy";
import { handleEvaluations } from "./handlers/evaluations";
import { handleMe } from "./handlers/me";
import { handleEvents, handleEventSubscribers } from "./handlers/events";
import {
  handleHideTheme,
  handleLikeTheme,
  handleListThemes,
  handleUploadTheme,
} from "./handlers/themes";
import { handleCampusLocation } from "./handlers/campus";
import { handleOutstanding } from "./handlers/outstanding";
import { handleProfileStats } from "./handlers/profile-stats";
import { handleUserLookup } from "./handlers/user";
import { handleProfile } from "./handlers/profile";
import {
  handleCalendarToken,
  handleCalendarUpdate,
  handleCalendarIcs,
} from "./handlers/calendar";
import { handleClusterSvg, handleClusterSvgs } from "./handlers/clusters";
import { handleClusterOccupancy } from "./handlers/cluster-occupancy";
import {
  handleStudentsList,
  handlePiscinersList,
  handlePiscinesList,
  handleFutureStudentsList,
  handleFutureStudentsRefresh,
} from "./handlers/students";
import { handleCronTrigger } from "./handlers/cron-trigger";
import {
  handlePushPublicKey,
  handlePushSubscribe,
  handlePushUnsubscribe,
  handlePushTest,
} from "./handlers/push";
import { handleLogtimeHistory } from "./handlers/logtime";
import { handleEventReminders } from "./handlers/event-notify";
import { handleAnnouncement } from "./handlers/announcement";
import { handleStats } from "./handlers/stats";
import { handleImageUpload } from "./handlers/image-upload";
import { handleImageServe } from "./handlers/image-serve";
import { Env, UserData } from "./types";
import {
  isOriginAllowed,
  textRes,
  errorPage,
  getAppToken,
  updateProjectMap,
  jsonRes,
  getBearerToken,
  touchSession,
} from "./utils";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !isOriginAllowed(origin, env.ALLOW_LOCAL_DEV === "true")) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      const acao = origin || "*";
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": acao,
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, If-None-Match, If-Modified-Since",
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

    if (url.pathname === "/api/v1/future-students/refresh") {
      return handleFutureStudentsRefresh(request, env);
    }

    const calMatch = url.pathname.match(/^\/calendar\/([^\/]+)\.ics$/);
    if (calMatch) {
      return handleCalendarIcs(calMatch[1], env);
    }

    const imgMatch = url.pathname.match(
      /^\/api\/v1\/public\/images\/([a-f0-9-]+)$/,
    );
    if (imgMatch) {
      return handleImageServe(request, env, imgMatch[1]);
    }

    if (url.pathname === "/api/v1/public/announcement") {
      return handleAnnouncement(request, env);
    }

    if (url.pathname === "/api/v1/public/cron") {
      return handleCronTrigger(request, env, ctx);
    }

    if (url.pathname === "/api/v1/public/stats") {
      return handleStats(request, env);
    }

    if (url.pathname === "/api/v1/public/auth/exchange") {
      return handleAuthExchange(request, env);
    }

    if (url.pathname === "/api/v1/public/push/key") {
      return handlePushPublicKey(env);
    }

    if (url.pathname === "/api/v1/public/themes") {
      return handleListThemes(request, env);
    }

    const likeMatch = url.pathname.match(/^\/api\/v1\/themes\/([^/]+)\/like$/);
    if (likeMatch) {
      return handleLikeTheme(request, env, likeMatch[1]);
    }

    const campusMatch = url.pathname.match(
      /^\/api\/v1\/public\/campus\/([^/]+)$/,
    );
    if (campusMatch) {
      return handleCampusLocation(request, env, campusMatch[1]);
    }

    const loginParam = url.searchParams.get("login");
    if (!loginParam) {
      return errorPage(444, "Username hash required.");
    }

    const existingData: UserData | null = await env.BETTER_INTRA_KV.get(
      loginParam,
      { type: "json" },
    );

    // Best-effort "last used" refresh for authenticated private routes.
    if (url.pathname.startsWith("/api/v1/private/")) {
      const bearer = getBearerToken(request);
      if (bearer) {
        ctx.waitUntil(touchSession(env, loginParam, existingData, bearer));
      }
    }

    if (url.pathname === "/api/v1/public/visuals") {
      return handlePublicVisuals(request, existingData);
    }

    if (url.pathname === "/api/v1/students") {
      return handleStudentsList(request, env, origin, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/future-students") {
      return handleFutureStudentsList(
        request,
        env,
        origin,
        loginParam,
        existingData,
      );
    }

    if (url.pathname === "/api/v1/pisciners") {
      return handlePiscinersList(
        request,
        env,
        origin,
        loginParam,
        existingData,
      );
    }

    if (url.pathname === "/api/v1/piscines") {
      return handlePiscinesList(request, env, origin, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/settings") {
      return handlePrivateSettings(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/settings/history") {
      return handleSettingsHistory(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/settings/restore") {
      return handleSettingsRestore(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/sessions") {
      return handleSessions(request, env, loginParam, existingData);
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

    if (url.pathname === "/api/v1/private/me") {
      return handleMe(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/cluster/occupancy") {
      return handleClusterOccupancy(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/events") {
      return handleEvents(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/event-subscribers") {
      return handleEventSubscribers(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/push/subscribe") {
      return handlePushSubscribe(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/push/unsubscribe") {
      return handlePushUnsubscribe(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/push/test") {
      return handlePushTest(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/themes") {
      return handleUploadTheme(request, env, loginParam, existingData);
    }

    const themeHideMatch = url.pathname.match(
      /^\/api\/v1\/themes\/([^/]+)\/hide$/,
    );
    if (themeHideMatch) {
      return handleHideTheme(
        request,
        env,
        themeHideMatch[1],
        loginParam,
        existingData,
      );
    }

    if (url.pathname === "/api/v1/private/outstanding") {
      return handleOutstanding(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/profile-stats") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      const target = url.searchParams.get("target");
      if (!target) return textRes("Missing target parameter", 400);
      return handleProfileStats(request, env, loginParam, existingData, target);
    }

    if (url.pathname === "/api/v1/private/user") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      const target = url.searchParams.get("target");
      if (!target) return textRes("Missing target parameter", 400);
      return handleUserLookup(request, env, loginParam, existingData, target);
    }

    if (url.pathname === "/api/v1/private/profile") {
      if (request.method !== "GET") return textRes("Method not allowed", 405);
      const target = url.searchParams.get("target");
      if (!target) return textRes("Missing target parameter", 400);
      return handleProfile(request, env, loginParam, existingData, target);
    }

    if (url.pathname === "/api/v1/private/calendar/token") {
      return handleCalendarToken(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/calendar/update") {
      return handleCalendarUpdate(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/logtime/history") {
      return handleLogtimeHistory(request, env, loginParam, existingData);
    }

    if (url.pathname === "/api/v1/private/image-upload") {
      return handleImageUpload(request, env, loginParam, existingData);
    }

    return errorPage(404, "This endpoint doesn't exist.");
  },
  // Event reminders are the only cron work that makes no 42 API calls (they
  // read the ICS in D1 and send Web Push), so they're safe from the scheduled
  // context, which 42 challenges. Everything that talks to 42 still runs from
  // the external cron (POST /api/v1/public/cron).
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleEventReminders(env));
  },
};
