import { describe, it, expect } from "vitest";
import { shouldResync } from "../src/handlers/outstanding";

const NOW = 1_800_000_000;

describe("shouldResync", () => {
  it("syncs when the user has never been synced", () => {
    expect(shouldResync(null, null, NOW)).toBe(true);
    expect(shouldResync(undefined, null, NOW)).toBe(true);
  });

  it("syncs when the stored row has no timestamp", () => {
    expect(shouldResync({ completed_count: 3, updated_at: null }, null, NOW)).toBe(
      true,
    );
  });

  it("serves the cache inside the five-minute window", () => {
    const state = { completed_count: 3, updated_at: NOW - 299 };
    expect(shouldResync(state, null, NOW)).toBe(false);
    expect(shouldResync(state, "3", NOW)).toBe(false);
  });

  it("resyncs once the cache window has elapsed", () => {
    const state = { completed_count: 3, updated_at: NOW - 300 };
    expect(shouldResync(state, null, NOW)).toBe(true);
  });

  it("resyncs early when the completed count changed, but not before a minute", () => {
    expect(
      shouldResync({ completed_count: 9, updated_at: NOW - 61 }, "10", NOW),
    ).toBe(true);
    expect(
      shouldResync({ completed_count: 9, updated_at: NOW - 59 }, "10", NOW),
    ).toBe(false);
  });

  it("ignores an unchanged count until the cache expires", () => {
    expect(
      shouldResync({ completed_count: 9, updated_at: NOW - 61 }, "9", NOW),
    ).toBe(false);
  });

  it("treats a missing stored count as a change", () => {
    expect(
      shouldResync({ completed_count: null, updated_at: NOW - 61 }, "4", NOW),
    ).toBe(true);
  });

  it("falls back to the cache window when the caller sends no count", () => {
    expect(
      shouldResync({ completed_count: 9, updated_at: NOW - 61 }, null, NOW),
    ).toBe(false);
  });

  it("treats the NOT NULL default zero count as a real value", () => {
    expect(
      shouldResync({ completed_count: 0, updated_at: NOW - 61 }, "0", NOW),
    ).toBe(false);
    expect(
      shouldResync({ completed_count: 0, updated_at: NOW - 61 }, "2", NOW),
    ).toBe(true);
  });

  it("accepts explicit thresholds", () => {
    const state = { completed_count: 1, updated_at: NOW - 30 };
    expect(shouldResync(state, null, NOW, 30)).toBe(true);
    expect(shouldResync(state, null, NOW, 31)).toBe(false);
  });
});
