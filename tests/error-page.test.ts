import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { errorPage, maybeErrorPage } from "../src/utils";
import type { Env } from "../src/types";

const testEnv = {
  BETTER_INTRA_KV: { get: async () => null },
} as unknown as Env;
const testCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function navRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.betterintra.com/api/v1/private/profile", {
    headers: { "Sec-Fetch-Dest": "document", ...headers },
  });
}

function textError(
  message = "User not found",
  status = 404,
  headers: Record<string, string> = {},
): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

describe("errorPage", () => {
  it("renders the http.cat image and status title", async () => {
    const res = errorPage(404, "Nothing here");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("https://http.cat/404");
    expect(body).toContain("404 Not Found");
    expect(body).toContain("Nothing here");
  });

  it("escapes HTML in the message", async () => {
    const body = await errorPage(400, `<script>alert("x")</script>`).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("maybeErrorPage", () => {
  it("converts a text error for a document navigation", async () => {
    const res = await maybeErrorPage(navRequest(), textError());
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("User not found");
  });

  it("keeps the plain-text error for fetch() clients", async () => {
    const request = new Request("https://api.betterintra.com/x", {
      headers: { "Sec-Fetch-Dest": "empty", Accept: "*/*" },
    });
    const res = await maybeErrorPage(request, textError());
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("User not found");
  });

  it("keeps the plain-text error for image requests", async () => {
    const request = new Request("https://api.betterintra.com/avatar/x", {
      headers: { "Sec-Fetch-Dest": "image", Accept: "image/avif,image/webp" },
    });
    const res = await maybeErrorPage(
      request,
      textError("Avatar unavailable", 502),
    );
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("does not convert JSON error bodies", async () => {
    const response = new Response(JSON.stringify({ error: "nope" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    const res = await maybeErrorPage(navRequest(), response);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("ignores successful responses", async () => {
    const response = new Response("ok", {
      headers: { "Content-Type": "text/plain" },
    });
    const res = await maybeErrorPage(navRequest(), response);
    expect(await res.text()).toBe("ok");
  });

  it("ignores OPTIONS preflights", async () => {
    const request = new Request("https://api.betterintra.com/x", {
      method: "OPTIONS",
      headers: { "Sec-Fetch-Dest": "document" },
    });
    const res = await maybeErrorPage(request, textError("", 403));
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("falls back to Accept: text/html when Sec-Fetch-Dest is missing", async () => {
    const request = new Request("https://api.betterintra.com/x", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const res = await maybeErrorPage(request, textError());
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("does not use the Accept fallback for API clients", async () => {
    const request = new Request("https://api.betterintra.com/x", {
      headers: { Accept: "*/*" },
    });
    const res = await maybeErrorPage(request, textError());
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("preserves Retry-After on a 429", async () => {
    const res = await maybeErrorPage(
      navRequest(),
      textError("Too many requests", 429, { "Retry-After": "60" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("provides a fallback message for empty bodies", async () => {
    const body = await (
      await maybeErrorPage(navRequest(), textError("", 500))
    ).text();
    expect(body).toContain("Something went wrong.");
  });
});

describe("worker.fetch error pages", () => {
  it("returns a 404 for unknown public API paths", async () => {
    const res = await worker.fetch(
      new Request(
        "https://api.betterintra.com/api/v1/public/clusters/belgium/shi",
      ),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("This endpoint doesn't exist.");
  });

  it("shows the 404 cat with the real message for an unknown public path", async () => {
    const res = await worker.fetch(
      new Request(
        "https://api.betterintra.com/api/v1/public/clusters/belgium/shi",
        { headers: { "Sec-Fetch-Dest": "document" } },
      ),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("https://http.cat/404");
    expect(body).toContain("This endpoint doesn&#39;t exist.");
  });

  it("shows the cat page for a document navigation to an unknown route", async () => {
    const res = await worker.fetch(
      new Request("https://api.betterintra.com/nope?login=abc", {
        headers: { "Sec-Fetch-Dest": "document", Accept: "text/html" },
      }),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("https://http.cat/404");
    expect(body).toContain("This endpoint doesn&#39;t exist.");
  });

  it("shows the cat page for a missing login hash", async () => {
    const res = await worker.fetch(
      new Request("https://api.betterintra.com/", {
        headers: { "Sec-Fetch-Dest": "document" },
      }),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(444);
    expect(await res.text()).toContain("https://http.cat/444");
  });

  it("shows the cat page for an unauthenticated private route in a tab", async () => {
    const res = await worker.fetch(
      new Request(
        "https://api.betterintra.com/api/v1/private/profile?login=abc&target=bob",
        {
          headers: { "Sec-Fetch-Dest": "document" },
        },
      ),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Missing Authorization Token");
  });

  it("keeps plain text for extension/PWA fetches", async () => {
    const res = await worker.fetch(
      new Request(
        "https://api.betterintra.com/api/v1/private/profile?login=abc&target=bob",
        {
          headers: { Accept: "*/*" },
        },
      ),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("keeps plain text for calendar clients", async () => {
    const res = await worker.fetch(
      new Request("https://api.betterintra.com/calendar/short.ics", {
        headers: { Accept: "text/calendar, text/plain" },
      }),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });
});
