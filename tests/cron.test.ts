import { describe, it, expect } from "vitest";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

describe("formatTime", () => {
  it("formats a valid ISO string to HH:MM", () => {
    const result = formatTime("2024-06-15T14:30:00Z");
    const d = new Date("2024-06-15T14:30:00Z");
    const expected = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    expect(result).toBe(expected);
  });

  it("always produces two-digit hours and minutes", () => {
    const result = formatTime("2024-01-01T09:05:00Z");
    expect(/^\d{2}:\d{2}$/.test(result)).toBe(true);
  });

  it("handles midnight", () => {
    const result = formatTime("2024-01-01T00:00:00Z");
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});
