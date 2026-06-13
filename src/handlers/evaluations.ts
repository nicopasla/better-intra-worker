import { Env, UserData } from "../types";
import {
  getBearerToken,
  getUserToken,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

export async function handleEvaluations(
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

  if (!existingData.fortyTwoToken) {
    return textRes(
      "Cloud session expired — please log out and log back in via Better Intra settings",
      401,
    );
  }

  const fortyTwoToken = await getUserToken(env, existingData, loginParam);

  const apiRes = await fetch(
    "https://api.intra.42.fr/v2/me/scale_teams?page[size]=100",
    { headers: { Authorization: `Bearer ${fortyTwoToken}` } },
  );

  if (!apiRes.ok) {
    return textRes(`42 API error: ${apiRes.status}`, 502);
  }

  const rawData = (await apiRes.json()) as any[];

  const projectMap =
    (await env.BETTER_INTRA_KV.get<Record<string, string>>("PROJECT_MAP", {
      type: "json",
    })) ?? {};

  const asEvaluator: any[] = [];
  const asEvaluated: any[] = [];

  for (const item of rawData) {
    const id = item.id;
    const beginAt: string = item.begin_at;
    const duration: number = item.scale?.duration ?? 0;
    const endAt = new Date(
      new Date(beginAt).getTime() + duration * 1000,
    ).toISOString();

    const team = item.team ?? null;
    const projectId = team?.project_id ?? null;
    const projectName = projectId ? (projectMap[String(projectId)] ?? null) : null;
    const teamName = team?.name ?? null;

    const isInvisible = (v: any) => typeof v === "string" && v === "invisible";

    if (isInvisible(item.correcteds) || Array.isArray(item.correcteds)) {
      const correctedsVisible = Array.isArray(item.correcteds) && item.correcteds.length > 0;
      asEvaluator.push({
        id,
        beginAt,
        endAt,
        projectName,
        correcteds: correctedsVisible
          ? item.correcteds.map((c: any) => ({ id: c.id, login: c.login }))
          : null,
        teamName: correctedsVisible ? teamName : null,
      });
    }

    if (isInvisible(item.corrector) || (item.corrector && typeof item.corrector === "object")) {
      const correctorVisible = item.corrector && typeof item.corrector === "object";
      asEvaluated.push({
        id,
        beginAt,
        endAt,
        projectName,
        corrector: correctorVisible
          ? { id: item.corrector.id, login: item.corrector.login }
          : null,
        teamName,
      });
    }
  }

  return jsonRes({ asEvaluator, asEvaluated });
}
