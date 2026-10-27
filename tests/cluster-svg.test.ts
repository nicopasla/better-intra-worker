import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleClusterSvg } from "../src/handlers/clusters";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="shi-r1-p1"/></svg>';

function svgResponse(headers: Record<string, string> = {}): Response {
  return new Response(SVG, {
    status: 200,
    headers: { "Content-Type": "image/svg+xml", ...headers },
  });
}

describe("handleClusterSvg", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => svgResponse()) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires a url parameter", async () => {
    const res = await handleClusterSvg(
      new Request("https://api.betterintra.com/api/v1/cluster/svg"),
      {} as never,
      null,
    );
    expect(res.status).toBe(400);
  });

  it("adds an ETag when the upstream has none", async () => {
    const res = await handleClusterSvg(
      new Request(
        `https://api.betterintra.com/api/v1/cluster/svg?url=${encodeURIComponent("https://meta.intra.42.fr/map.svg")}`,
      ),
      {} as never,
      null,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SVG);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("answers 304 when the client's validator matches the content", async () => {
    const url = `https://api.betterintra.com/api/v1/cluster/svg?url=${encodeURIComponent("https://meta.intra.42.fr/map.svg")}`;
    const first = await handleClusterSvg(
      new Request(url),
      {} as never,
      null,
    );
    const etag = first.headers.get("etag")!;

    const second = await handleClusterSvg(
      new Request(url, { headers: { "If-None-Match": etag } }),
      {} as never,
      null,
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("forwards the validator upstream and keeps a 304 cheap", async () => {
    let sent: Headers | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(null, { status: 304, headers: { ETag: '"up"' } });
    }) as unknown as typeof fetch;

    const res = await handleClusterSvg(
      new Request(
        `https://api.betterintra.com/api/v1/cluster/svg?url=${encodeURIComponent("https://meta.intra.42.fr/map.svg")}`,
        { headers: { "If-None-Match": '"up"' } },
      ),
      {} as never,
      null,
    );

    expect(sent?.get("if-none-match")).toBe('"up"');
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"up"');
  });

  it("returns 502 when the upstream fails", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;

    const res = await handleClusterSvg(
      new Request(
        `https://api.betterintra.com/api/v1/cluster/svg?url=${encodeURIComponent("https://meta.intra.42.fr/map.svg")}`,
      ),
      {} as never,
      null,
    );

    expect(res.status).toBe(502);
  });
});
