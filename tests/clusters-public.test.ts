import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decorateMapSvg,
  handleClusterMapView,
  handleClustersIndex,
  handleClusterView,
  markersByHost,
  parseView,
  MAP_VIEWS,
} from "../src/handlers/clusters-public";
import type { Env } from "../src/types";

const svgFor = (id: string, seats = [`${id}-r1-p1`]) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
  seats
    .map(
      (seat, index) =>
        `<image id="${seat}" x="${index * 50}" y="0" width="40" height="40"/>`,
    )
    .join("") +
  "</svg>";

const MAP_SVGS: Record<string, string | null> = {
  shi: svgFor("shi", ["shi-r1-p1", "shi-r1-p2"]),
  fu: svgFor("fu"),
  mi: svgFor("mi"),
};

const ORIGIN = "https://api.betterintra.com";
const VIEW_URL = `${ORIGIN}/api/v1/public/clusters/belgium/shi.svg`;
const INDEX_URL = `${ORIGIN}/api/v1/public/clusters/belgium`;

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
  svgs: Record<string, string | null> = MAP_SVGS,
  d1Fails = false,
) {
  return {
    better_intra_images: {
      get: vi.fn(async (key: string) => {
        const id = key.slice(key.lastIndexOf("/") + 1).replace(/\.svg$/, "");
        return stored(svgs[id] ?? null);
      }),
    },
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

function viewRequest(
  query = "",
  method = "GET",
  headers?: Record<string, string>,
): Request {
  return new Request(VIEW_URL + query, { method, headers });
}

function indexRequest(
  method = "GET",
  headers?: Record<string, string>,
): Request {
  return new Request(INDEX_URL, { method, headers });
}

function seat(
  partial: Partial<{ blocking: string[]; minor: string[]; usbc: boolean }> = {},
) {
  return { blocking: [], minor: [], usbc: false, ...partial };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseView", () => {
  it("defaults to default", () => {
    expect(parseView(null)).toBe("default");
  });

  it("accepts every documented view", () => {
    for (const view of MAP_VIEWS) {
      expect(parseView(view)).toBe(view);
      expect(parseView(` ${view.toUpperCase()} `)).toBe(view);
    }
  });

  it("rejects empty, combined and unknown values", () => {
    expect(parseView("")).toBeNull();
    expect(parseView("issues,usbc")).toBeNull();
    expect(parseView("bogus")).toBeNull();
  });
});

describe("markersByHost", () => {
  it("keeps both lists even when the seat is crossed", () => {
    const markers = markersByHost(
      rows([
        { host: "shi-r1-p1", component: "boot", status: "broken" },
        { host: "shi-r1-p1", component: "keyboard", status: "broken" },
        // Retired component: rows can linger in D1 and must be ignored.
        { host: "shi-r1-p1", component: "audio", status: "broken" },
      ]),
    );

    expect(markers.get("shi-r1-p1")).toEqual(
      seat({ blocking: ["Power"], minor: ["Keyboard"] }),
    );
  });

  it("reports USB-C presence without marking the seat broken", () => {
    const markers = markersByHost(
      rows([{ host: "shi-r1-p1", component: "usbc", status: "works" }]),
    );
    expect(markers.get("shi-r1-p1")).toEqual(seat({ usbc: true }));
  });

  it("does not report a missing USB-C port", () => {
    const markers = markersByHost(
      rows([{ host: "shi-r1-p1", component: "usbc", status: "broken" }]),
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
    expect(markers.get("shi-r1-p1")).toEqual(seat({ usbc: true }));
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
    expect(markers.get("shi-r1-p1")).toEqual(
      seat({ blocking: ["Power"], usbc: true }),
    );
  });
});

describe("decorateMapSvg", () => {
  it("draws both overlays by default", () => {
    const svg = decorateMapSvg(
      MAP_SVGS.shi!,
      new Map([
        ["shi-r1-p1", seat({ blocking: ["Power"], usbc: true })],
        ["shi-r1-p2", seat({ minor: ["Keyboard"] })],
      ]),
    );

    expect(svg).toContain(
      '<path class="ft-issue-cross" d="M 7.2 7.2 L 32.8 32.8 M 32.8 7.2 L 7.2 32.8" stroke-width="2.2"/>',
    );
    expect(svg).toContain('class="ft-issue-warning"');
    expect(svg).toContain('class="ft-issue-usbc"');
    expect(svg).toContain("<title>shi-r1-p1 — Power, USB-C</title>");
  });

  it("never draws the triangle on a crossed seat", () => {
    const svg = decorateMapSvg(
      MAP_SVGS.shi!,
      new Map([
        [
          "shi-r1-p1",
          seat({ blocking: ["Power"], minor: ["Keyboard"], usbc: false }),
        ],
      ]),
    );

    expect(svg).toContain('class="ft-issue-cross"');
    expect(svg).not.toContain("ft-issue-warning");
    expect(svg).toContain("<title>shi-r1-p1 — Power</title>");
  });

  it("issues omits USB-C", () => {
    const svg = decorateMapSvg(
      MAP_SVGS.shi!,
      new Map([["shi-r1-p1", seat({ blocking: ["Power"], usbc: true })]]),
      "issues",
    );

    expect(svg).toContain('class="ft-issue-cross"');
    expect(svg).not.toContain("ft-issue-usbc");
  });

  it("broken draws crosses only", () => {
    const svg = decorateMapSvg(
      MAP_SVGS.shi!,
      new Map([
        ["shi-r1-p1", seat({ blocking: ["Power"] })],
        ["shi-r1-p2", seat({ minor: ["Keyboard"] })],
      ]),
      "broken",
    );

    expect(svg).toContain('data-seat="shi-r1-p1"');
    expect(svg).not.toContain('data-seat="shi-r1-p2"');
    expect(svg).not.toContain("ft-issue-warning");
  });

  it("usbc draws only the port glyph", () => {
    const svg = decorateMapSvg(
      MAP_SVGS.shi!,
      new Map([
        [
          "shi-r1-p1",
          seat({ blocking: ["Power"], minor: ["Keyboard"], usbc: true }),
        ],
      ]),
      "usbc",
    );

    expect(svg).toContain('class="ft-issue-usbc"');
    expect(svg).not.toContain("ft-issue-cross");
    expect(svg).not.toContain("ft-issue-warning");
    expect(svg).toContain("<title>shi-r1-p1 — USB-C</title>");
  });

  it("plain leaves the map untouched", () => {
    const markers = new Map([["shi-r1-p1", seat({ blocking: ["Power"] })]]);
    expect(decorateMapSvg(MAP_SVGS.shi!, markers, "plain")).toBe(MAP_SVGS.shi);
  });

  it("copies the seat transform onto the marker group", () => {
    const svg = decorateMapSvg(
      svgFor("mi"),
      new Map([["mi-r1-p1", seat({ blocking: ["Network"] })]]),
    );
    expect(svg).toContain('data-seat="mi-r1-p1"');
  });
});

describe("handleClusterMapView", () => {
  it("serves the default view with cache headers", async () => {
    const res = await handleClusterMapView(
      viewRequest(),
      makeEnv([{ host: "shi-r1-p1", component: "boot", status: "broken" }]),
      "belgium",
      "shi",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    const body = await res.text();
    expect(body).toContain("ft-issue-cross");
    expect(body).toContain('data-seat="shi-r1-p1"');
  });

  it("answers 304 when the client's validator matches", async () => {
    const env = makeEnv([
      { host: "shi-r1-p1", component: "boot", status: "broken" },
    ]);
    const first = await handleClusterMapView(
      viewRequest(),
      env,
      "belgium",
      "shi",
    );
    const etag = first.headers.get("etag")!;

    const second = await handleClusterMapView(
      viewRequest("", "GET", { "If-None-Match": etag }),
      env,
      "belgium",
      "shi",
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("omits the body for HEAD", async () => {
    const res = await handleClusterMapView(
      viewRequest("", "HEAD"),
      makeEnv(),
      "belgium",
      "shi",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("rejects unknown views with JSON", async () => {
    const res = await handleClusterMapView(
      viewRequest("?view=bogus"),
      makeEnv(),
      "belgium",
      "shi",
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as {
      error: string;
      allowed: string[];
    };
    expect(body.error).toBe("invalid_view");
    expect(body.allowed).toEqual([...MAP_VIEWS]);
  });

  it("404s unknown campuses and maps with JSON", async () => {
    const campus = await handleClusterMapView(
      viewRequest(),
      makeEnv(),
      "paris",
      "shi",
    );
    expect(campus.status).toBe(404);
    expect(((await campus.json()) as { error: string }).error).toBe(
      "campus_not_found",
    );

    const env = makeEnv();
    const map = await handleClusterMapView(
      viewRequest(),
      env,
      "belgium",
      "plan",
    );
    expect(map.status).toBe(404);
    expect(((await map.json()) as { error: string }).error).toBe(
      "map_not_found",
    );
    expect(env.better_intra_images.get).not.toHaveBeenCalled();
  });

  it("only accepts GET and HEAD", async () => {
    const res = await handleClusterMapView(
      viewRequest("", "POST"),
      makeEnv(),
      "belgium",
      "shi",
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("skips D1 for the plain view", async () => {
    const env = makeEnv([
      { host: "shi-r1-p1", component: "boot", status: "broken" },
    ]);
    const res = await handleClusterMapView(
      viewRequest("?view=plain"),
      env,
      "belgium",
      "shi",
    );
    expect(await res.text()).toBe(MAP_SVGS.shi);
    expect(env.better_intra_d1.prepare).not.toHaveBeenCalled();
  });

  it("serves the map unmarked with a short cache when D1 fails", async () => {
    const env = makeEnv([], MAP_SVGS, true);
    const res = await handleClusterMapView(
      viewRequest("?view=issues"),
      env,
      "belgium",
      "shi",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=15");
    expect(await res.text()).toBe(MAP_SVGS.shi);
  });

  it("falls back to the repo copies when R2 has no map", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(MAP_SVGS.shi, {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    ) as unknown as typeof fetch;

    const res = await handleClusterMapView(
      viewRequest(),
      makeEnv([{ host: "shi-r1-p1", component: "boot", status: "broken" }], {
        shi: null,
      }),
      "belgium",
      "shi",
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-seat="shi-r1-p1"');
  });

  it("404s when neither R2 nor the repo has the map", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;

    const res = await handleClusterMapView(
      viewRequest(),
      makeEnv([], { shi: null }),
      "belgium",
      "shi",
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "map_not_found",
    );
  });
});

describe("handleClustersIndex", () => {  const list: Row[] = [
    {
      host: "shi-r1-p1",
      component: "boot",
      status: "broken",
      reporter: "alice",
      updatedAt: 1_700_000_100,
    },
    {
      host: "shi-r1-p1",
      component: "usbc",
      status: "works",
      reporter: "bob",
      updatedAt: 1_700_000_050,
    },
    {
      host: "shi-r1-p2",
      component: "keyboard",
      status: "broken",
      reporter: "carol",
      updatedAt: 1_700_000_000,
    },
    {
      host: "fu-r1-p1",
      component: "usbc",
      status: "works",
      reporter: "dave",
      updatedAt: 1_700_000_000,
    },
    // Not a seat of any map: must not leak into the counts.
    {
      host: "shi-r9-p9",
      component: "boot",
      status: "broken",
      reporter: "eve",
      updatedAt: 1_700_000_000,
    },
  ];

  it("returns maps, counts, seats, views and catalog", async () => {
    const res = await handleClustersIndex(
      indexRequest(),
      makeEnv(list),
      "belgium",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as {
      campus: string;
      updatedAt: number;
      views: string[];
      components: { key: string }[];
      maps: {
        id: string;
        name: string;
        counts: { broken: number; issues: number; usbc: number };
        views: Record<string, string>;
        seats: {
          host: string;
          severity: string | null;
          issues: string[];
          usbc?: boolean;
        }[];
      }[];
    };

    expect(body.campus).toBe("belgium");
    expect(body.updatedAt).toBe(1_700_000_100_000);
    expect(body.views).toEqual([...MAP_VIEWS]);
    expect(body.components.map((component) => component.key)).toContain(
      "mouse_scroll",
    );

    expect(body.maps.map((map) => map.id)).toEqual(["shi", "fu", "mi"]);

    const shi = body.maps[0]!;
    expect(shi.name).toBe("SHI");
    expect(shi.counts).toEqual({ broken: 1, issues: 2, usbc: 1 });
    expect(shi.seats).toEqual([
      {
        host: "shi-r1-p1",
        severity: "blocking",
        issues: ["Power"],
        usbc: true,
      },
      {
        host: "shi-r1-p2",
        severity: "minor",
        issues: ["Keyboard"],
      },
    ]);
    expect(shi.views.default).toBe(
      `${ORIGIN}/api/v1/public/clusters/belgium/shi.svg`,
    );
    expect(shi.views.broken).toBe(
      `${ORIGIN}/api/v1/public/clusters/belgium/shi.svg?view=broken`,
    );

    const fu = body.maps[1]!;
    expect(fu.counts).toEqual({ broken: 0, issues: 0, usbc: 1 });
    expect(fu.seats).toEqual([
      { host: "fu-r1-p1", severity: null, issues: [], usbc: true },
    ]);

    const mi = body.maps[2]!;
    expect(mi.counts).toEqual({ broken: 0, issues: 0, usbc: 0 });
    expect(mi.seats).toEqual([]);
  });

  it("answers 304 when the client's validator matches", async () => {
    const env = makeEnv(list);
    const first = await handleClustersIndex(indexRequest(), env, "belgium");
    const etag = first.headers.get("etag")!;

    const second = await handleClustersIndex(
      indexRequest("GET", { "If-None-Match": etag }),
      env,
      "belgium",
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("omits the body for HEAD", async () => {
    const res = await handleClustersIndex(
      indexRequest("HEAD"),
      makeEnv(list),
      "belgium",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("returns 503 with Retry-After when reports are unavailable", async () => {
    const res = await handleClustersIndex(
      indexRequest(),
      makeEnv([], MAP_SVGS, true),
      "belgium",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe(
      "reports_unavailable",
    );
  });

  it("404s unknown campuses and rejects other methods", async () => {
    const campus = await handleClustersIndex(
      indexRequest(),
      makeEnv(list),
      "paris",
    );
    expect(campus.status).toBe(404);

    const method = await handleClustersIndex(
      indexRequest("POST"),
      makeEnv(list),
      "belgium",
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("handleClusterView", () => {
  const list: Row[] = [
    {
      host: "shi-r1-p1",
      component: "boot",
      status: "broken",
      reporter: "alice",
      updatedAt: 1_700_000_100,
    },
    {
      host: "shi-r1-p1",
      component: "usbc",
      status: "works",
      reporter: "bob",
      updatedAt: 1_700_000_050,
    },
    {
      host: "shi-r1-p2",
      component: "keyboard",
      status: "broken",
      reporter: "carol",
      updatedAt: 1_700_000_000,
    },
    {
      host: "fu-r1-p1",
      component: "usbc",
      status: "works",
      reporter: "dave",
      updatedAt: 1_700_000_000,
    },
    // Not a seat of any map: must not leak into a feed.
    {
      host: "shi-r9-p9",
      component: "boot",
      status: "broken",
      reporter: "eve",
      updatedAt: 1_700_000_000,
    },
  ];

  const viewRequest = (
    view: string,
    method = "GET",
    headers?: Record<string, string>,
  ) =>
    new Request(
      `${ORIGIN}/api/v1/public/clusters/belgium/${view}`,
      { method, headers },
    );

  it("issues returns every seat with a blocking or minor issue", async () => {
    const res = await handleClusterView(
      viewRequest("issues"),
      makeEnv(list),
      "belgium",
      "issues",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as {
      campus: string;
      view: string;
      updatedAt: number;
      count: number;
      seats: unknown[];
    };
    expect(body.campus).toBe("belgium");
    expect(body.view).toBe("issues");
    expect(body.updatedAt).toBe(1_700_000_100_000);
    expect(body.count).toBe(2);
    expect(body.seats).toEqual([
      {
        map: "shi",
        host: "shi-r1-p1",
        severity: "blocking",
        issues: ["Power"],
        usbc: true,
      },
      {
        map: "shi",
        host: "shi-r1-p2",
        severity: "minor",
        issues: ["Keyboard"],
      },
    ]);
  });

  it("broken returns only crossed seats", async () => {
    const res = await handleClusterView(
      viewRequest("broken"),
      makeEnv(list),
      "belgium",
      "broken",
    );
    const body = (await res.json()) as { count: number; seats: unknown[] };
    expect(body.count).toBe(1);
    expect(body.seats).toEqual([
      {
        map: "shi",
        host: "shi-r1-p1",
        severity: "blocking",
        issues: ["Power"],
        usbc: true,
      },
    ]);
  });

  it("usbc returns only seats reported to have a port", async () => {
    const res = await handleClusterView(
      viewRequest("usbc"),
      makeEnv(list),
      "belgium",
      "usbc",
    );
    const body = (await res.json()) as { count: number; seats: unknown[] };
    expect(body.count).toBe(2);
    expect(body.seats).toEqual([
      {
        map: "shi",
        host: "shi-r1-p1",
        severity: "blocking",
        issues: ["Power"],
        usbc: true,
      },
      {
        map: "fu",
        host: "fu-r1-p1",
        severity: null,
        issues: [],
        usbc: true,
      },
    ]);
  });

  it("answers 304 and omits the body for HEAD", async () => {
    const env = makeEnv(list);
    const first = await handleClusterView(
      viewRequest("broken"),
      env,
      "belgium",
      "broken",
    );
    const etag = first.headers.get("etag")!;

    const second = await handleClusterView(
      viewRequest("broken", "GET", { "If-None-Match": etag }),
      env,
      "belgium",
      "broken",
    );
    expect(second.status).toBe(304);

    const head = await handleClusterView(
      viewRequest("broken", "HEAD"),
      env,
      "belgium",
      "broken",
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("validates the campus, view and method", async () => {
    const campus = await handleClusterView(
      viewRequest("issues"),
      makeEnv(list),
      "paris",
      "issues",
    );
    expect(campus.status).toBe(404);
    expect(((await campus.json()) as { error: string }).error).toBe(
      "campus_not_found",
    );

    const view = await handleClusterView(
      viewRequest("issues"),
      makeEnv(list),
      "belgium",
      "foo",
    );
    expect(view.status).toBe(404);
    expect(((await view.json()) as { error: string }).error).toBe(
      "view_not_found",
    );

    const method = await handleClusterView(
      viewRequest("issues", "POST"),
      makeEnv(list),
      "belgium",
      "issues",
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns 503 when reports are unavailable", async () => {
    const res = await handleClusterView(
      viewRequest("broken"),
      makeEnv([], MAP_SVGS, true),
      "belgium",
      "broken",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(((await res.json()) as { error: string }).error).toBe(
      "reports_unavailable",
    );
  });
});
