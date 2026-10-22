/**
 * Canonical UTC ISO string. D1 stores this form so the dashboard, cron and push
 * payloads all agree. The 42 API returns UTC (`Z`) values, but normalizing here
 * also keeps older rows with explicit offsets consistent.
 */
export function normalizeIsoUtc(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
