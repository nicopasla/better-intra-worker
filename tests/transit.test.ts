import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCatalog,
  distanceMeters,
  handleTransitBoard,
  normalizeBoard,
} from "../src/handlers/transit";
import type { CatalogStop } from "../src/handlers/transit";
import type { Env } from "../src/types";

const ORIGIN = "https://api.betterintra.com";
const BOARD_KEY = "TRANSIT_GARE_CENTRALE";
const CATALOG_KEY = "TRANSIT_STOPS";
const GTFS_KEY = "STIB_GTFS_LINES";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const iso = (minutes: number) =>
  new Date(NOW + minutes * 60_000).toISOString();

interface FakeKV {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function gtfsCache() {
  return {
    updatedAt: NOW,
    source: "test",
    feedVersion: "2026-11",
    feedStartDate: "20261101",
    feedEndDate: "20261231",
    lines: CATALOGUE,
  };
}

function makeKV(seed: Record<string, unknown> = {}): FakeKV {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries({
    [GTFS_KEY]: gtfsCache(),
    ...seed,
  })) {
    store.set(key, JSON.stringify(value));
  }
  return {
    store,
    get: vi.fn(async (key: string, options?: { type?: string }) => {
      const raw = store.get(key);
      if (raw == null) return null;
      return options?.type === "json" ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeEnv(kv: FakeKV, token = "mt-token"): Env {
  return {
    MOBILITYTWIN_TOKEN: token,
    CLIENT_ID: "client-id",
    CLIENT_SECRET: "client-secret",
    BETTER_INTRA_KV: kv as unknown as Env["BETTER_INTRA_KV"],
    better_intra_d1: {} as never,
    better_intra_images: {} as never,
  };
}

const STOP_ID = "1502";

function catalogCache() {
  return { radiusM: 400, stops: catalog() };
}

function catalog(): CatalogStop[] {
  return [
    {
      id: STOP_ID,
      name: "Gare Centrale",
      lat: 50.8457,
      lon: 4.3569,
      distanceM: 3,
      lines: ["38", "71"],
    },
  ];
}

const CATALOGUE = {
  "38": {
    lineId: "38",
    mode: "bus" as const,
    routeType: 3,
    name: "Gare Centrale - Héros",
    color: "#f0a500",
    textColor: "#000000",
  },
  "71": {
    lineId: "71",
    mode: "bus" as const,
    routeType: 3,
    name: null,
    color: null,
    textColor: null,
  },
};

const stopsPayload = {
  type: "FeatureCollection",
  features: [
    {
      properties: {
        stop_id: Number(STOP_ID),
        stop_name: "Gare Centrale",
        stop_lat: 50.8457,
        stop_lon: 4.3569,
        route_short_name: "38",
      },
    },
    {
      properties: {
        stop_id: Number(STOP_ID),
        stop_name: "Gare Centrale",
        stop_lat: 50.8457,
        stop_lon: 4.3569,
        route_short_name: "71",
      },
    },
    {
      properties: {
        stop_id: 9999,
        stop_name: "Louise",
        stop_lat: 50.8359,
        stop_lon: 4.3556,
        route_short_name: "93",
      },
    },
    {
      properties: {
        stop_id: 7777,
        stop_name: "BOZAR",
        stop_lat: 50.8441,
        stop_lon: 4.3576,
        route_short_name: "71",
      },
    },
  ],
};

const waitingPayload = {
  results: [
    {
      pointid: STOP_ID,
      lineid: "38",
      passingtimes: JSON.stringify([
        { destination: { fr: "Héros", nl: "Helden" }, expectedArrivalTime: iso(3) },
        { destination: { fr: "Héros", nl: "Helden" }, expectedArrivalTime: iso(13) },
        { destination: { fr: "Héros", nl: "Helden" }, expectedArrivalTime: iso(23) },
        { destination: { fr: "Héros", nl: "Helden" }, expectedArrivalTime: iso(-5) },
      ]),
    },
    {
      pointid: STOP_ID,
      lineid: "71",
      passingtimes: JSON.stringify([
        { message: { fr: "Dernier départ" }, expectedArrivalTime: iso(8) },
      ]),
    },
    {
      pointid: "9999",
      lineid: "93",
      passingtimes: JSON.stringify([
        { destination: { fr: "Stade" }, expectedArrivalTime: iso(2) },
      ]),
    },
  ],
};

describe("transit helpers", () => {
  it("computes distances in meters", () => {
    expect(distanceMeters({ lat: 50.8457, lon: 4.3569 }, { lat: 50.8457, lon: 4.3569 })).toBe(0);
    const degree = distanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(degree).toBeGreaterThan(111_000);
    expect(degree).toBeLessThan(112_000);
  });

  it("keeps every walkable platform, merging lines per stop", () => {
    const built = buildCatalog(stopsPayload);
    expect(built.map((stop) => stop.name)).toEqual(["Gare Centrale", "BOZAR"]);
    expect(built[0]).toMatchObject({
      id: STOP_ID,
      name: "Gare Centrale",
      lines: ["38", "71"],
    });
    expect(built[0].distanceM).toBeLessThan(10);
    expect(built[1]).toMatchObject({ name: "BOZAR", lines: ["71"] });
  });

  it("drops platform points outside the walking radius", () => {
    const built = buildCatalog({
      features: [
        {
          properties: {
            stop_id: 12,
            stop_name: "CENTRAAL STATION",
            stop_lat: 50.8457,
            stop_lon: 4.3569,
            route_short_name: "1",
          },
        },
        {
          properties: {
            stop_id: 13,
            stop_name: "ROYALE",
            stop_lat: 50.8440,
            stop_lon: 4.3570,
            route_short_name: "92",
          },
        },
        {
          properties: {
            stop_id: 14,
            stop_name: "PARC",
            stop_lat: 50.8497,
            stop_lon: 4.3650,
            route_short_name: "92",
          },
        },
      ],
    });
    expect(built.map((stop) => stop.id)).toEqual(["12", "13"]);
  });

  it("builds the board from future arrivals, two per line", () => {
    const board = normalizeBoard(catalog(), waitingPayload, "2026-11-13T10:00:00Z", CATALOGUE, NOW);
    expect(board.stops).toHaveLength(1);
    const departures = board.stops[0].departures;
    expect(departures.map((d) => `${d.lineId}:${d.destination}`)).toEqual([
      "38:Héros",
      "71:Dernier départ",
      "38:Héros",
    ]);
    expect(departures.filter((d) => d.lineId === "38")).toHaveLength(2);
    expect(departures[0]).toMatchObject({
      mode: "bus",
      color: "#f0a500",
      textColor: "#000000",
    });
    expect(departures[1]).toMatchObject({
      lineId: "71",
      mode: "bus",
      color: null,
    });
    expect(board.meta).toMatchObject({
      nearbyStops: 1,
      stops: 1,
      departures: 3,
      upstreamRows: 3,
    });
    expect(board.sourceUpdatedAt).toBe("2026-11-13T10:00:00Z");
  });

  it("drops departures too far in the past and unknown stops", () => {
    const board = normalizeBoard(
      catalog(),
      {
        results: [
          {
            pointid: "4242",
            lineid: "38",
            passingtimes: JSON.stringify([
              { destination: { fr: "Héro" }, expectedArrivalTime: iso(4) },
            ]),
          },
          {
            pointid: STOP_ID,
            lineid: "38",
            passingtimes: JSON.stringify([
              { destination: { fr: "Héros" }, expectedArrivalTime: iso(-5) },
            ]),
          },
        ],
      },
      null,
      CATALOGUE,
      NOW,
    );
    expect(board.stops).toHaveLength(0);
    expect(board.meta.departures).toBe(0);
  });
});

describe("GET /api/v1/public/transit/gare-centrale", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const request = () =>
    new Request(`${ORIGIN}/api/v1/public/transit/gare-centrale`);

  it("returns 503 when the token is not configured", async () => {
    const res = await handleTransitBoard(request(), makeEnv(makeKV(), ""));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a fresh board from KV without calling upstream", async () => {
    const board = normalizeBoard(catalog(), waitingPayload, null, CATALOGUE, NOW);
    const kv = makeKV({ [BOARD_KEY]: { ...board, updatedAt: NOW - 10_000 } });
    const res = await handleTransitBoard(request(), makeEnv(kv));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stale?: boolean; stops: unknown[] };
    expect(body.stale).toBeUndefined();
    expect(body.stops).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a stale board synchronously", async () => {
    const board = normalizeBoard(catalog(), waitingPayload, null, CATALOGUE, NOW);
    const kv = makeKV({
      [BOARD_KEY]: { ...board, updatedAt: NOW - 5 * 60_000 },
      [CATALOG_KEY]: catalogCache(),
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/stib/stops")) {
        return new Response(JSON.stringify(stopsPayload));
      }
      return new Response(JSON.stringify(waitingPayload), {
        headers: { "X-Data-Timestamp": "2026-11-13T10:00:00Z" },
      });
    });

    const res = await handleTransitBoard(request(), makeEnv(kv));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updatedAt: number; stale?: boolean };
    expect(body.stale).toBeUndefined();
    expect(body.updatedAt).toBe(NOW);
    // The catalog is still cached: only the waiting times are fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(kv.store.get(BOARD_KEY) as string);
    expect(stored.sourceUpdatedAt).toBe("2026-11-13T10:00:00Z");
    expect(stored.stops[0].departures).toHaveLength(3);
  });

  it("keeps serving the last board when the upstream fails", async () => {
    const board = normalizeBoard(catalog(), waitingPayload, null, CATALOGUE, NOW);
    const kv = makeKV({
      [BOARD_KEY]: { ...board, updatedAt: NOW - 10 * 60_000 },
      [CATALOG_KEY]: catalogCache(),
    });
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const res = await handleTransitBoard(request(), makeEnv(kv));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updatedAt: NOW - 10 * 60_000 });
  });

  it("refreshes on a cold cache", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/stib/stops")) {
        return new Response(JSON.stringify(stopsPayload));
      }
      return new Response(JSON.stringify(waitingPayload));
    });
    const kv = makeKV();
    const res = await handleTransitBoard(request(), makeEnv(kv));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stops: { departures: unknown[] }[] };
    expect(body.stops[0].departures).toHaveLength(3);
    expect(kv.store.has(BOARD_KEY)).toBe(true);
    expect(kv.store.has(CATALOG_KEY)).toBe(true);
  });

  it("reports upstream failures on a cold cache", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const res = await handleTransitBoard(request(), makeEnv(makeKV()));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "upstream_unavailable" });
  });

  it("sends the token upstream and answers HEAD without a body", async () => {
    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer mt-token",
        );
        if (url.endsWith("/stib/stops")) {
          return new Response(JSON.stringify(stopsPayload));
        }
        return new Response(JSON.stringify(waitingPayload));
      },
    );
    const res = await handleTransitBoard(
      new Request(`${ORIGIN}/api/v1/public/transit/gare-centrale`, {
        method: "HEAD",
      }),
      makeEnv(makeKV()),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
