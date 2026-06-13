import { describe, it, expect } from "vitest";
import { hashLogin, getTokens, getBearerToken } from "../src/utils";

describe("hashLogin", () => {
  it("produces a 64-char hex string", async () => {
    const hash = await hashLogin("nicopasla");
    expect(hash).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });

  it("is case-insensitive", async () => {
    const a = await hashLogin("NicoPasla");
    const b = await hashLogin("nicopasla");
    expect(a).toBe(b);
  });

  it("trims whitespace", async () => {
    const a = await hashLogin("  nicopasla  ");
    const b = await hashLogin("nicopasla");
    expect(a).toBe(b);
  });

  it("is deterministic", async () => {
    const a = await hashLogin("nicopasla");
    const b = await hashLogin("nicopasla");
    expect(a).toBe(b);
  });

  it("produces different hashes for different logins", async () => {
    const a = await hashLogin("alice");
    const b = await hashLogin("bob");
    expect(a).not.toBe(b);
  });
});

describe("getTokens", () => {
  it("returns sessionTokens array if present", () => {
    expect(getTokens({ sessionTokens: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("returns legacy sessionToken wrapped in array", () => {
    expect(getTokens({ sessionToken: "legacy" })).toEqual(["legacy"]);
  });

  it("returns empty array for null/undefined", () => {
    expect(getTokens(null)).toEqual([]);
    expect(getTokens(undefined)).toEqual([]);
    expect(getTokens({})).toEqual([]);
  });

  it("prefers sessionTokens over sessionToken", () => {
    expect(getTokens({ sessionTokens: ["new"], sessionToken: "old" })).toEqual(["new"]);
  });
});

describe("getBearerToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(getBearerToken(req)).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "bearer xyz" },
    });
    expect(getBearerToken(req)).toBe("xyz");
  });

  it("returns null when no Authorization header", () => {
    const req = new Request("https://example.com");
    expect(getBearerToken(req)).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Basic abc" },
    });
    expect(getBearerToken(req)).toBeNull();
  });
});
