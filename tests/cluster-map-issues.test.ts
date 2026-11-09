import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decorateMapSvg,
  handleClusterMapIssues,
  markersByHost,
} from "../src/handlers/cluster-map-issues";
import type { Env } from "../src/types";

const BASE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
  '<image id="shi-r1-p1" x="0" y="0" width="40" height="40"/>' +
  '<image id="mi-c4-p1" x="100" y="0" width="40" height="40" transform="rotate(20 120 20)"/>' +
  "</svg>";

const URL_BASE =
  "https://api.betterintra.com/api/v1/public/cluster-map/belgium/shi.svg";

interface Row {
  host: string;
  component: string;
  status: "broken" | "works";
  reporter?: string | null;
  updatedAt?: number;
}

function rows(list: Row[]) {
  return list.map((row) => ({
    reporter: null,
    updatedAt: 1_700_000_000,
    ...row,
  }));
}

function stored(svg: string | null) {
  return svg === null ? null : { text: async () => svg };
}

function makeEnv(
  list: Row[] = [],
  svg: string | null = BASE,
  d1Fails = false,
) {
  return {
    better_intra_images: { get: vi.fn(async () => stored(svg)) },
    better_intra_d1: {
      prepare: vi.fn(() => {
        if (d1Fails) throw new Error("d1 down");
        return {
          bind: vi.fn(() => ({
            all: vi.fn(async () => ({ results: rows(list) })),
          })),
        };
      }),
    },
  } as unknown as Env;
}

function request(method = "GET", headers?: Record<string, string>): Request {
  return new Request(URL_BASE, { method, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markersByHost", () => {
  it("groups blocking and minor components per seat", () => {
    const markers = markersByHost(
      rows([
        { host: "shi-r1-p1", component: "boot", status: "broken" },
        { host: "shi-r1-p1", component: "keyboard", status: "broken" },
        {
          host: "shi-r1-p1",
          component: "audio",
          status: "works",
          reporter: "alice",
        },
      ]),
    );

    expect(markers.get("shi-r1-p1")).toEqual({
      blocking: ["Power"],
      minor: ["Keyboard"],
    });
  });

  it("never marks a seat from a USB-C presence answer", () => {
    const markers = markersByHost(
      rows([{ host: "shi-r1-p1", component: "usbc", status: "works" }]),
    );
    expect(markers.size).toBe(0);
  });

  it("ignores legacy anonymous Power/Network rows when USB-C was confirmed", () => {
    const markers = markersByHost(
      rows([
        { host: "shi-r1-p1", component: "boot", status: "broken" },
        { host: "shi-r1-p1", component: "network", status: "broken" },
        {
          host: "shi-r1-p1",
          component: "usbc",
          status: "works",
          reporter: "alice",
        },
      ]),
    );
    expect(markers.size).toBe(0);
  });

  it("still crosses an attended broken seat on a USB-C-confirmed host", () => {
    const markers = markersByHost(
      rows([
        {
          host: "shi-r1-p1",
          component: "boot",
          status: "broken",
          reporter: "alice",
        },
        {
          host: "shi-r1-p1",
          component: "usbc",
          status: "works",
          reporter: "bob",
        },
      ]),
    );
    expect(markers.get("shi-r1-p1")?.blocking).toEqual(["Power"]);
  });
});

describe("decorateMapSvg", () => {
  it("draws the cross with the app's inset and stroke", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([["shi-r1-p1", { blocking: ["Power"], minor: [] }]]),
    );

    expect(svg).toContain('data-seat="shi-r1-p1"');
    expect(svg).toContain(
      '<path class="ft-issue-cross" d="M 7.2 7.2 L 32.8 32.8 M 32.8 7.2 L 7.2 32.8" stroke-width="2.2"/>',
    );
    expect(svg).toContain("<title>shi-r1-p1 — Power</title>");
  });

  it("draws the warning triangle for minor issues only", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([["shi-r1-p1", { blocking: [], minor: ["Keyboard"] }]]),
    );

    expect(svg).toContain('class="ft-issue-warning"');
    expect(svg).not.toContain("ft-issue-cross");
    expect(svg).toContain(
      '<title>shi-r1-p1 — Keyboard</title>',
    );
  });

  it("copies the seat transform onto the marker group", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([["mi-c4-p1", { blocking: ["Network"], minor: [] }]]),
    );

    expect(svg).toContain(
      '<g transform="rotate(20 120 20)" data-seat="mi-c4-p1">',
    );
  });

  it("leaves the map untouched when nothing is reported", () => {
    expect(decorateMapSvg(BASE, new Map())).toBe(BASE);
  });
});

describe("handleClusterMapIssues", () => {
  it("serves the decorated map with cache headers", async () => {
    const res = await handleClusterMapIssues(
      request(),
      makeEnv([{ host: "shi-r1-p1", component: "boot", status: "broken" }]),
      "shi",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    const body = await res.text();
    expect(body).toContain("ft-issue-markers");
    expect(body).toContain('data-seat="shi-r1-p1"');
  });

  it("answers 304 when the client's validator matches", async () => {
    const env = makeEnv([
      { host: "shi-r1-p1", component: "boot", status: "broken" },
    ]);
    const first = await handleClusterMapIssues(request(), env, "shi");
    const etag = first.headers.get("etag")!;

    const second = await handleClusterMapIssues(
      request("GET", { "If-None-Match": etag }),
      env,
      "shi",
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("omits the body for HEAD", async () => {
    const res = await handleClusterMapIssues(
      request("HEAD"),
      makeEnv(),
      "shi",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("404s for unknown maps without touching storage", async () => {
    const env = makeEnv();
    const res = await handleClusterMapIssues(request(), env, "plan");
    expect(res.status).toBe(404);
    expect(env.better_intra_images.get).not.toHaveBeenCalled();
  });

  it("only accepts GET and HEAD", async () => {
    const res = await handleClusterMapIssues(
      request("POST"),
      makeEnv(),
      "shi",
    );
    expect(res.status).toBe(405);
  });

  it("serves the map unmarked with a short cache when D1 fails", async () => {
    const env = makeEnv([], BASE, true);

    const res = await handleClusterMapIssues(request(), env, "shi");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=15");
    expect(await res.text()).toBe(BASE);
  });

  it("falls back to the repo copies when R2 has no map", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(BASE, {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    ) as unknown as typeof fetch;

    const res = await handleClusterMapIssues(
      request(),
      makeEnv(
        [{ host: "shi-r1-p1", component: "boot", status: "broken" }],
        null,
      ),
      "shi",
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-seat="shi-r1-p1"');
  });

  it("404s when neither R2 nor the repo has the map", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;

    const res = await handleClusterMapIssues(
      request(),
      makeEnv([], null),
      "shi",
    );
    expect(res.status).toBe(404);
  });
});
