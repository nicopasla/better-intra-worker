import type { PushPayload } from "./push";

export function formatPushTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    });
  } catch {
    return "";
  }
}

export interface EvalPushInput {
  kind: "booked" | "revealed";
  project: string | null;
  beginAt: string;
  correcteds?: string[];
}

/** Builds an eval push. The body is a UTC-formatted fallback; clients that
 *  support it render `beginAt` in the device's local timezone instead.
 *  Shared by the cron and the test endpoint so previews match production. */
export function buildEvalPush(input: EvalPushInput): PushPayload {
  const project = input.project ?? "Evaluation";
  const names = input.correcteds ?? [];
  const time = formatPushTime(input.beginAt);

  if (input.kind === "revealed") {
    return {
      title: "Evaluation in 15 min",
      body: names.length
        ? `Correcting ${names.join(", ")} · ${project} · ${time}`
        : `${project} · ${time}`,
      beginAt: input.beginAt,
      project,
      correcteds: names,
    };
  }

  return {
    title: "Evaluation Booked",
    body: `${project} · ${time}`,
    beginAt: input.beginAt,
    project,
    correcteds: [],
  };
}
