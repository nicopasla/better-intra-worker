import { Env, UserData, PushSubscription } from "./types";
import { serializeUserData } from "./utils";
import { sendWebPush, PushPayload } from "./handlers/push";

export type PushPayloadBuilder = (timeZone: string | undefined) => PushPayload;

/**
 * Sends one payload per subscription, grouping by device timezone so the
 * instant is rendered in local time here rather than in the service worker
 * (whose own timezone is UTC on Android). Dead endpoints (404/410) are pruned
 * from the user blob.
 *
 * Shared by the eval cron and the calendar-reminder cron.
 */
export async function pushTransition(
  env: Env,
  hash: string,
  subs: PushSubscription[],
  build: PushPayloadBuilder,
  meta: { url: string; tag: string },
  fallbackTimeZone?: string | null,
): Promise<void> {
  if (!subs || subs.length === 0) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  const groups = new Map<string, PushSubscription[]>();
  for (const sub of subs) {
    const tz = sub.timeZone || fallbackTimeZone || "";
    const group = groups.get(tz);
    if (group) group.push(sub);
    else groups.set(tz, [sub]);
  }

  const sends: Promise<{ endpoint: string; status: number }>[] = [];
  for (const [tz, group] of groups) {
    const payload: PushPayload = {
      ...build(tz || undefined),
      url: meta.url,
      tag: meta.tag,
    };
    for (const sub of group) {
      sends.push(
        sendWebPush(env, sub, payload).then((res) => ({
          endpoint: sub.endpoint,
          status: res.status,
        })),
      );
    }
  }

  const results = await Promise.allSettled(sends);

  const stale = new Set<string>();
  for (const r of results) {
    if (
      r.status === "fulfilled" &&
      (r.value.status === 404 || r.value.status === 410)
    ) {
      stale.add(r.value.endpoint);
    }
  }
  if (stale.size === 0) return;

  const remaining = subs.filter((s) => !stale.has(s.endpoint));
  const fresh = await env.BETTER_INTRA_KV.get<UserData>(hash, { type: "json" });
  if (fresh) {
    await env.BETTER_INTRA_KV.put(
      hash,
      serializeUserData({ ...fresh, pushSubscriptions: remaining }),
    );
    console.log(`[push] ${hash.slice(0, 6)} pruned ${stale.size} stale sub(s)`);
  }
}
