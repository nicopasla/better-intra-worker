import { handleCallback, handleLogin } from "./handlers/auth";
import {
  handlePrivateEvaluations,
  handlePrivateSettings,
  handlePublicVisuals,
} from "./handlers/settings";
import { Env, UserData } from "./types";
import { corsHeaders, textRes } from "./utils";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/callback") {
      return handleCallback(request, env);
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

    if (url.pathname === "/api/v1/private/evaluations") {
      return handlePrivateEvaluations(request, env, loginParam, existingData);
    }

    return textRes("Not found", 404);
  },
};
