import type { PushPayload } from "./push";

/** UTC fallback stamp: "HH:MM" when today, else "DD/MM/YY HH:MM".
 *  Clients that support it render `beginAt` in the device's local timezone. */
export function formatPushTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return sameDay
    ? time
    : `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${String(
        d.getUTCFullYear(),
      ).slice(2)} ${time}`;
}

export interface EvalPushInput {
  kind: "booked" | "revealed";
  project: string | null;
  beginAt: string;
  correcteds?: string[];
}

/** Builds an eval push. Title is always "Better Intra"; the status and details
 *  live in the body (two lines). The body is a UTC-formatted fallback; clients
 *  that support it render `beginAt` in the device's local timezone instead.
 *  Shared by the cron and the test endpoint so previews match production. */
export function buildEvalPush(input: EvalPushInput): PushPayload {
  const project = input.project ?? null;
  const names = input.correcteds ?? [];
  const stamp = formatPushTime(input.beginAt);
  const status =
    input.kind === "revealed" ? "Evaluation in 15 min" : "Evaluation Booked";

  const detail: string[] = [];
  if (input.kind === "revealed") {
    if (names.length) detail.push(`Correcting ${names.join(", ")}`);
    if (project) detail.push(project);
  } else {
    detail.push("Evaluating someone");
  }
  if (stamp) detail.push(`at ${stamp}`);

  return {
    title: "Better Intra",
    body: `${status}\n${detail.join(" ")}`,
    kind: input.kind,
    beginAt: input.beginAt,
    project,
    correcteds: input.kind === "revealed" ? names : [],
  };
}