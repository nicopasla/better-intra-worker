import { Env } from "../types";
import { textRes } from "../utils";
import {
  handleMainCron,
  handleRevealCatchup,
  handleTokenRefreshSweep,
} from "./cron";

/**
 * Cron-job.org source IPs (https://api.cron-job.org/executor-nodes.json).
 * The secret is the primary guard; this is an extra layer.
 */
const ALLOWED_IPS = new Set([
  "116.203.134.67",
  "116.203.129.16",
  "23.88.105.37",
  "128.140.8.200",
  "91.99.23.109",
]);

export async function handleCronTrigger(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  if (
    !env.CRON_SECRET ||
    request.headers.get("X-Cron-Key") !== env.CRON_SECRET
  ) {
    return textRes("Unauthorized", 401);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ALLOWED_IPS.has(ip)) return textRes("Unauthorized", 401);

  let job = "";
  try {
    const body = (await request.json()) as { job?: unknown };
    job = typeof body?.job === "string" ? body.job : "";
  } catch {
    return textRes("Invalid JSON", 400);
  }

  ctx.waitUntil(
    (async () => {
      try {
        if (job === "tick") {
          await handleRevealCatchup(env, ctx);
          await handleTokenRefreshSweep(env);
        } else if (job === "main") {
          await handleMainCron(env, ctx);
        } else {
          console.warn(`[cron-trigger] unknown job: ${job}`);
        }
      } catch (e) {
        console.warn(`[cron-trigger] job=${job} error: ${e}`);
      }
    })(),
  );

  return textRes("OK");
}
