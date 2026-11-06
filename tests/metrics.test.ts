import { describe, it, expect } from "vitest";
import {
  markCache,
  outcomeOf,
  rateLimits,
  recordApiCall,
  recordCacheLookup,
  recordRequest,
  routeTemplate,
} from "../src/metrics";
import type { Env } from "../src/types";

function envWith(record: (point: unknown) => void): Env {
  return {
    API_METRICS: {
      writeDataPoint: record,
    } as unknown as AnalyticsEngineDataset,
  } as Env;
}

describe("routeTemplate", () => {
  it("keeps static API routes as-is", () => {
    expect(routeTemplate("/api/v1/private/me")).toBe("/api/v1/private/me");
    expect(routeTemplate("/api/v1/students")).toBe("/api/v1/students");
    expect(routeTemplate("/api/v1/private/friends/data")).toBe(
      "/api/v1/private/friends/data",
    );
  });

  it("hides calendar tokens", () => {
    expect(routeTemplate("/calendar/deadbeefcafe.ics")).toBe(
      "/calendar/:token.ics",
    );
  });

  it("hides campus ids, image ids and logins", () => {
    expect(routeTemplate("/api/v1/public/campus/42")).toBe(
      "/api/v1/public/campus/:campus",
    );
    expect(routeTemplate("/api/v1/public/images/0f8fad5b-d9cb")).toBe(
      "/api/v1/public/images/:id",
    );
    expect(routeTemplate("/api/v1/public/avatar/someone")).toBe(
      "/api/v1/public/avatar/:login",
    );
  });

  it("collapses unknown segments so no user input leaks", () => {
    const template = routeTemplate("/api/v1/private/users/jdoe");
    expect(template).not.toContain("jdoe");
    expect(template).toBe("/api/v1/private/:_/:_");
  });

  it("memoizes repeated paths", () => {
    const first = routeTemplate("/api/v1/private/sessions");
    expect(routeTemplate("/api/v1/private/sessions")).toBe(first);
  });
});

describe("outcomeOf", () => {
  it("classifies success", () => {
    expect(outcomeOf(200)).toBe("ok");
  });

  it("classifies rate limiting", () => {
    expect(outcomeOf(429)).toBe("rate_limited");
  });

  it("classifies a Cloudflare challenge separately from a plain 403", () => {
    expect(
      outcomeOf(
        403,
        new Headers({ "content-type": "text/html; charset=utf-8" }),
      ),
    ).toBe("challenge");
    expect(outcomeOf(403, new Headers({ "content-type": "application/json" })))
      .toBe("error");
  });

  it("classifies other failures", () => {
    expect(outcomeOf(500)).toBe("error");
  });
});

describe("rateLimits", () => {
  it("returns undefined when the headers are absent", () => {
    expect(rateLimits(new Headers())).toEqual({
      hourlyRemaining: undefined,
      secondlyRemaining: undefined,
    });
  });

  it("reads the 42 quota headers", () => {
    expect(
      rateLimits(
        new Headers({
          "x-hourly-ratelimit-remaining": "1199",
          "x-secondly-ratelimit-remaining": "3",
        }),
      ),
    ).toEqual({ hourlyRemaining: 1199, secondlyRemaining: 3 });
  });
});

describe("recordApiCall", () => {
  it("is a no-op without the binding", () => {
    expect(() =>
      recordApiCall({} as Env, {
        op: "me",
        scope: "user",
        status: 200,
        ms: 12,
      }),
    ).not.toThrow();
  });

  it("writes the documented point shape and truncates the hash", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));

    recordApiCall(env, {
      op: "cron.scale_teams",
      hash: "0123456789abcdef",
      scope: "user",
      status: 429,
      ms: 42,
      attempt: 2,
      hourlyRemaining: 900,
      secondlyRemaining: 0,
    });

    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual(["cron.scale_teams"]);
    expect(points[0].blobs).toEqual(["rate_limited", "user", "01234567", "retry"]);
    expect(points[0].doubles).toEqual([1, 429, 42, 900, 0, 2]);
  });

  it("defaults missing quota headers to -1", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));

    recordApiCall(env, { op: "me", scope: "app", status: 200, ms: 5 });

    expect(points[0].blobs[2]).toBe("");
    expect(points[0].blobs[3]).toBe("");
    expect(points[0].doubles).toEqual([1, 200, 5, -1, -1, 0]);
  });

  it("skips unlabeled call sites (e.g. CDN photo fetches)", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));

    recordApiCall(env, { op: "unknown", scope: "app", status: 200, ms: 1 });

    expect(points).toHaveLength(0);
  });

  it("never throws when the dataset rejects the write", () => {
    const env = envWith(() => {
      throw new Error("boom");
    });
    expect(() =>
      recordApiCall(env, { op: "me", scope: "app", status: 200, ms: 1 }),
    ).not.toThrow();
  });
});

describe("recordCacheLookup", () => {
  it("writes the outcome and age", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));

    recordCacheLookup(env, "profile_stats", "undecryptable", 42);

    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual(["cache"]);
    expect(points[0].blobs).toEqual(["profile_stats", "undecryptable"]);
    expect(points[0].doubles).toEqual([1, 42]);
  });

  it("defaults the age to -1 and is a no-op without the binding", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));
    recordCacheLookup(env, "students", "empty");
    expect(points[0].doubles).toEqual([1, -1]);

    expect(() => recordCacheLookup({} as Env, "students", "hit")).not.toThrow();
  });
});

describe("recordRequest", () => {
  it("records the route, method and cache state", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));
    const request = new Request("https://api.betterintra.com/api/v1/private/me");
    const response = markCache(new Response("{}"), "hit");

    recordRequest(env, request, response, 8);

    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual(["req"]);
    expect(points[0].blobs).toEqual(["/api/v1/private/me", "GET", "hit"]);
    expect(points[0].doubles).toEqual([1, 200, 8]);
  });

  it("uses n/a when a handler sets no cache state", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));

    recordRequest(
      env,
      new Request("https://api.betterintra.com/api/v1/private/settings"),
      new Response("{}"),
      3,
    );

    expect(points[0].blobs[2]).toBe("n/a");
  });

  it("skips preflight requests and asset routes", () => {
    const points: any[] = [];
    const env = envWith((point) => points.push(point));

    recordRequest(
      env,
      new Request("https://api.betterintra.com/api/v1/private/me", {
        method: "OPTIONS",
      }),
      new Response(null, { status: 204 }),
      1,
    );
    recordRequest(
      env,
      new Request("https://api.betterintra.com/api/v1/public/images/abc"),
      new Response(""),
      1,
    );
    recordRequest(
      env,
      new Request("https://api.betterintra.com/calendar/token.ics"),
      new Response(""),
      1,
    );

    expect(points).toHaveLength(0);
  });

  it("is a no-op without the binding", () => {
    expect(() =>
      recordRequest(
        {} as Env,
        new Request("https://api.betterintra.com/api/v1/private/me"),
        new Response("{}"),
        1,
      ),
    ).not.toThrow();
  });
});

describe("markCache", () => {
  it("tags the response header", () => {
    expect(markCache(new Response("{}"), "miss").headers.get("x-bi-cache")).toBe(
      "miss",
    );
  });

  it("does not throw on immutable headers", () => {
    const res = Response.redirect("https://example.com", 302);
    expect(() => markCache(res, "hit")).not.toThrow();
  });
});
