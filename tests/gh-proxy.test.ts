import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGhProxy, isBadPath } from "../src/handlers/gh-proxy";

function jsonResponse(
  body: string,
  status = 200,
  contentType = "application/json",
): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("handleGhProxy", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("raw.githubusercontent.com")) {
        return jsonResponse("raw");
      }
      return jsonResponse("cdn");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves from the raw GitHub source first", async () => {
    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("raw");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(calls[0]).toContain("raw.githubusercontent.com");
    expect(calls).toHaveLength(1);
  });

  it("falls back to jsDelivr when raw returns an error", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("raw.githubusercontent.com")) {
        return jsonResponse("raw unavailable", 500);
      }
      return jsonResponse("cdn");
    }) as unknown as typeof fetch;

    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cdn");
    expect(calls).toHaveLength(2);
  });

  it("returns 502 when all sources fail", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      return jsonResponse("unavailable", 500);
    }) as unknown as typeof fetch;

    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Failed to fetch upstream");
    expect(calls).toHaveLength(2);
  });

  it("returns 400 for a missing path", async () => {
    const request = new Request("https://api.betterintra.com/gh/");
    const res = await handleGhProxy(request);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing path");
    expect(calls).toHaveLength(0);
  });

  it("rejects path traversal", () => {
    expect(isBadPath("../secrets")).toBe(true);
    expect(isBadPath("%2e%2e/secrets")).toBe(true);
    expect(isBadPath("%zz")).toBe(true);
    expect(isBadPath("campuses/campuses.json")).toBe(false);
  });

  it("guesses content type when upstream omits it", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(new TextEncoder().encode("{}"), { status: 200 }),
    ) as unknown as typeof fetch;

    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
