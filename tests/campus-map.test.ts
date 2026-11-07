import { describe, it, expect, vi } from "vitest";
import { handleCampusMap } from "../src/handlers/campus-map";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

function makeEnv(object: unknown) {
  return {
    better_intra_images: { get: vi.fn(async () => object) },
  };
}

const request = (method = "GET", headers?: Record<string, string>) =>
  new Request(
    "https://api.betterintra.com/api/v1/public/campus-map/belgium/plan.svg",
    { method, headers },
  );

const stored = {
  body: SVG,
  httpEtag: '"abc-123"',
  httpMetadata: { contentType: "image/svg+xml" },
};

describe("handleCampusMap", () => {
  it("serves the floor plan from R2", async () => {
    const res = await handleCampusMap(
      request(),
      makeEnv(stored) as never,
      "belgium",
      "plan",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("etag")).toBe('"abc-123"');
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    expect(await res.text()).toBe(SVG);
  });

  it("answers 304 when the client's validator matches", async () => {
    const res = await handleCampusMap(
      request("GET", { "If-None-Match": '"abc-123"' }),
      makeEnv(stored) as never,
      "belgium",
      "plan",
    );

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe('"abc-123"');
  });

  it("accepts weak validators", async () => {
    const res = await handleCampusMap(
      request("GET", { "If-None-Match": 'W/"abc-123"' }),
      makeEnv(stored) as never,
      "belgium",
      "plan",
    );

    expect(res.status).toBe(304);
  });

  it("404s for an unknown map id", async () => {
    const env = makeEnv(stored);
    const res = await handleCampusMap(
      request(),
      env as never,
      "belgium",
      "nope",
    );

    expect(res.status).toBe(404);
    expect(env.better_intra_images.get).not.toHaveBeenCalled();
  });

  it("404s when the object is missing", async () => {
    const res = await handleCampusMap(
      request(),
      makeEnv(null) as never,
      "belgium",
      "plan",
    );

    expect(res.status).toBe(404);
  });

  it("only accepts GET and HEAD", async () => {
    const res = await handleCampusMap(
      request("POST"),
      makeEnv(stored) as never,
      "belgium",
      "plan",
    );

    expect(res.status).toBe(405);
  });

  it("omits the body for HEAD", async () => {
    const res = await handleCampusMap(
      request("HEAD"),
      makeEnv(stored) as never,
      "belgium",
      "plan",
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
