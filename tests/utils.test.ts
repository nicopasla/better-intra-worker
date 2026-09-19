import { describe, it, expect } from "vitest";
import {
  decryptBytes,
  encryptBytes,
  hashLogin,
  getTokens,
  getBearerToken,
  isOriginAllowed,
} from "../src/utils";
import type { Env } from "../src/types";

const testEnv = {
  TOKEN_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
} as unknown as Env;

describe("encryptBytes / decryptBytes", () => {
  it("round-trips a string", async () => {
    const plaintext = JSON.stringify({ "2026-01-01": 3600 });
    const encrypted = await encryptBytes(testEnv, plaintext);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(await decryptBytes(testEnv, encrypted)).toBe(plaintext);
  });

  it("accepts an ArrayBuffer (D1 BLOB read)", async () => {
    const plaintext = "hello blob";
    const encrypted = await encryptBytes(testEnv, plaintext);
    expect(await decryptBytes(testEnv, encrypted.buffer as ArrayBuffer)).toBe(
      plaintext,
    );
  });

  it("does not leak the plaintext in the ciphertext", async () => {
    const plaintext = "super-secret-roster";
    const encrypted = await encryptBytes(testEnv, plaintext);
    const asText = new TextDecoder().decode(encrypted);
    expect(asText.includes(plaintext)).toBe(false);
  });

  it("uses a fresh IV per value", async () => {
    const a = await encryptBytes(testEnv, "same");
    const b = await encryptBytes(testEnv, "same");
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("passes legacy plaintext strings through untouched", async () => {
    expect(await decryptBytes(testEnv, "legacy-plaintext")).toBe(
      "legacy-plaintext",
    );
  });

  it("returns null for null/undefined/empty", async () => {
    expect(await decryptBytes(testEnv, null)).toBeNull();
    expect(await decryptBytes(testEnv, undefined)).toBeNull();
    expect(await decryptBytes(testEnv, new Uint8Array(0))).toBeNull();
    expect(await decryptBytes(testEnv, new Uint8Array(5))).toBeNull();
  });

  it("returns null when the ciphertext cannot be decrypted", async () => {
    const encrypted = await encryptBytes(testEnv, "value");
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(await decryptBytes(testEnv, encrypted)).toBeNull();
  });
});

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
    expect(getTokens({ sessionTokens: ["new"], sessionToken: "old" })).toEqual([
      "new",
    ]);
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

describe("isOriginAllowed", () => {
  it("allows any intra.42.fr subdomain", () => {
    expect(isOriginAllowed("https://profile.intra.42.fr")).toBe(true);
    expect(isOriginAllowed("https://profile-v3.intra.42.fr")).toBe(true);
    expect(isOriginAllowed("https://meta.intra.42.fr")).toBe(true);
    expect(isOriginAllowed("https://projects.intra.42.fr")).toBe(true);
  });

  it("allows extension origins", () => {
    expect(isOriginAllowed("chrome-extension://abc123")).toBe(true);
    expect(isOriginAllowed("moz-extension://abc123")).toBe(true);
  });

  it("rejects foreign origins", () => {
    expect(isOriginAllowed("https://example.com")).toBe(false);
    expect(isOriginAllowed("https://intra.42.fr.evil.com")).toBe(false);
    expect(isOriginAllowed("https://evilintra.42.fr")).toBe(false);
    expect(isOriginAllowed("https://intra.42.fr.evil")).toBe(false);
  });
});
