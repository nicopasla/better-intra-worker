import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decorateMapSvg,
  handleClusterMap,
  markersByHost,
  parseLayers,
} from "../src/handlers/cluster-map";
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

function seat(
  partial: Partial<{ blocking: string[]; minor: string[]; usbc: boolean }> = {},
) {
  return { blocking: [], minor: [], usbc: false, ...partial };
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

function request(
  method = "GET",
  headers?: Record<string, string>,
  query = "",
): Request {
  return new Request(URL_BASE + query, { method, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseLayers", () => {
  it("defaults to issues + USB-C", () => {
    expect(parseLayers(null)).toEqual({ issues: true, broken: false, usbc: true });
  });

  it("treats seats and none as the plain map", () => {
    expect(parseLayers("seats")).toEqual({ issues: false, broken: false, usbc: false });
    expect(parseLayers("none")).toEqual({ issues: false, broken: false, usbc: false });
    expect(parseLayers("")).toEqual({ issues: false, broken: false, usbc: false });
  });

  it("accepts every combination, case and spaces", () => {
    expect(parseLayers("issues")).toEqual({ issues: true, broken: false, usbc: false });
    expect(parseLayers("broken")).toEqual({ issues: false, broken: true, usbc: false });
    expect(parseLayers("usbc")).toEqual({ issues: false, broken: false, usbc: true });
    expect(parseLayers(" issues , broken , usbc ")).toEqual({
      issues: true,
      broken: true,
      usbc: true,
    });
  });

  it("rejects unknown tokens", () => {
    expect(parseLayers("bogus")).toBeNull();
    expect(parseLayers("issues,nope")).toBeNull();
    expect(parseLayers("USB-C")).toBeNull();
  });
});

describe("markersByHost", () => {
  it("groups blocking and minor components per seat", () => {
    const markers = markersByHost(
      rows([
        { host: "shi-r1-p1", component: "keyboard", status: "broken" },
        {
          host: "shi-r1-p1",
          component: "audio",
          status: "works",
          reporter: "alice",
        },
        { host: "shi-r1-p2", component: "keyboard", status: "broken" },
        { host: "shi-r1-p2", component: "mouse_scroll", status: "broken" },
      ]),
    );

    expect(markers.get("shi-r1-p1")).toEqual(
      seat({ minor: ["Keyboard"] }),
    );
    expect(markers.get("shi-r1-p2")).toEqual(
      seat({ minor: ["Keyboard", "Mouse scroll"] }),
    );
  });

  it("drops the warning when the seat is already crossed", () => {
    const markers = markersByHost(
      rows([
        { host: "shi-r1-p1", component: "boot", status: "broken" },
        { host: "shi-r1-p1", component: "keyboard", status: "broken" },
        { host: "shi-r1-p1", component: "audio", status: "broken" },
      ]),
    );

    expect(markers.get("shi-r1-p1")).toEqual(
      seat({ blocking: ["Power"] }),
    );
  });

  it("reports USB-C presence without marking the seat broken", () => {
    const markers = markersByHost(
      rows([{ host: "shi-r1-p1", component: "usbc", status: "works" }]),
    );
    expect(markers.get("shi-r1-p1")).toEqual(seat({ usbc: true }));
  });

  it("does not draw USB-C when the port is reported missing", () => {
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
  it("draws the cross with the app's inset and stroke", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([["shi-r1-p1", seat({ blocking: ["Power"] })]]),
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
      new Map([["shi-r1-p1", seat({ minor: ["Keyboard"] })]]),
    );

    expect(svg).toContain('class="ft-issue-warning"');
    expect(svg).not.toContain('class="ft-issue-cross"');
    expect(svg).toContain("<title>shi-r1-p1 — Keyboard</title>");
  });

  it("never draws the triangle on a crossed seat", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([["shi-r1-p1", seat({ blocking: ["Power"] })]]),
    );

    expect(svg).toContain('class="ft-issue-cross"');
    expect(svg).not.toContain("ft-issue-warning");
    expect(svg).toContain("<title>shi-r1-p1 — Power</title>");
  });

  it("draws the USB-C glyph, even alongside a cross", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([
        ["shi-r1-p1", seat({ blocking: ["Power"], usbc: true })],
      ]),
    );

    expect(svg).toContain('class="ft-issue-usbc"');
    expect(svg).toContain('class="ft-issue-cross"');
    expect(svg).toContain("<title>shi-r1-p1 — Power, USB-C</title>");
    expect(svg).toContain(".ft-issue-usbc{color:#38bdf8}");
  });

  it("copies the seat transform onto the marker group", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([["mi-c4-p1", seat({ blocking: ["Network"] })]]),
    );

    expect(svg).toContain(
      '<g transform="rotate(20 120 20)" data-seat="mi-c4-p1">',
    );
  });

  it("draws only USB-C when the usbc layer is selected", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([
        [
          "shi-r1-p1",
          seat({ blocking: ["Power"], minor: ["Keyboard"], usbc: true }),
        ],
      ]),
      { issues: false, broken: false, usbc: true },
    );

    expect(svg).toContain('class="ft-issue-usbc"');
    expect(svg).not.toContain("ft-issue-cross");
    expect(svg).not.toContain("ft-issue-warning");
    expect(svg).toContain("<title>shi-r1-p1 — USB-C</title>");
  });

  it("draws crosses but not triangles when the broken layer is selected", () => {
    const svg = decorateMapSvg(
      BASE,
      new Map([
        ["shi-r1-p1", seat({ blocking: ["Power"] })],
        ["mi-c4-p1", seat({ minor: ["Keyboard"], usbc: true })],
      ]),
      { issues: false, broken: true, usbc: false },
    );

    expect(svg).toContain('data-seat="shi-r1-p1"');
    expect(svg).toContain('class="ft-issue-cross"');
    expect(svg).not.toContain("ft-issue-warning");
    expect(svg).not.toContain("ft-issue-usbc");
    expect(svg).not.toContain('data-seat="mi-c4-p1"');
  });

  it("leaves the map untouched when nothing is reported", () => {
    expect(decorateMapSvg(BASE, new Map())).toBe(BASE);
  });
});

describe("handleClusterMap", () => {
  it("serves the decorated map with cache headers", async () => {
    const res = await handleClusterMap(
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
    const first = await handleClusterMap(request(), env, "shi");
    const etag = first.headers.get("etag")!;

    const second = await handleClusterMap(
      request("GET", { "If-None-Match": etag }),
      env,
      "shi",
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("omits the body for HEAD", async () => {
    const res = await handleClusterMap(request("HEAD"), makeEnv(), "shi");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("404s for unknown maps without touching storage", async () => {
    const env = makeEnv();
    const res = await handleClusterMap(request(), env, "plan");
    expect(res.status).toBe(404);
    expect(env.better_intra_images.get).not.toHaveBeenCalled();
  });

  it("only accepts GET and HEAD", async () => {
    const res = await handleClusterMap(request("POST"), makeEnv(), "shi");
    expect(res.status).toBe(405);
  });

  it("rejects an unknown layer token", async () => {
    const env = makeEnv();
    const res = await handleClusterMap(
      request("GET", undefined, "?layers=bogus"),
      env,
      "shi",
    );
    expect(res.status).toBe(400);
    expect(env.better_intra_images.get).not.toHaveBeenCalled();
  });

  it("serves the plain map without querying D1 for layers=seats", async () => {
    const env = makeEnv([
      { host: "shi-r1-p1", component: "boot", status: "broken" },
    ]);
    const res = await handleClusterMap(
      request("GET", undefined, "?layers=seats"),
      env,
      "shi",
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BASE);
    expect(env.better_intra_d1.prepare).not.toHaveBeenCalled();
  });

  it("draws only crosses for layers=broken", async () => {
    const res = await handleClusterMap(
      request("GET", undefined, "?layers=broken"),
      makeEnv([
        { host: "shi-r1-p1", component: "boot", status: "broken" },
        { host: "shi-r1-p1", component: "keyboard", status: "broken" },
        { host: "shi-r1-p1", component: "usbc", status: "works" },
      ]),
      "shi",
    );

    const body = await res.text();
    expect(body).toContain('class="ft-issue-cross"');
    expect(body).not.toContain("ft-issue-warning");
    expect(body).not.toContain("ft-issue-usbc");
  });

  it("draws only USB-C for layers=usbc", async () => {
    const res = await handleClusterMap(
      request("GET", undefined, "?layers=usbc"),
      makeEnv([
        { host: "shi-r1-p1", component: "boot", status: "broken" },
        { host: "shi-r1-p1", component: "usbc", status: "works" },
      ]),
      "shi",
    );

    const body = await res.text();
    expect(body).toContain('class="ft-issue-usbc"');
    expect(body).not.toContain("ft-issue-cross");
    expect(body).not.toContain("ft-issue-warning");
  });

  it("serves the map unmarked with a short cache when D1 fails", async () => {
    const env = makeEnv([], BASE, true);

    const res = await handleClusterMap(request(), env, "shi");
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

    const res = await handleClusterMap(
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

    const res = await handleClusterMap(request(), makeEnv([], null), "shi");
    expect(res.status).toBe(404);
  });
});
