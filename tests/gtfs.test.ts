import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildLines,
  handleStibLines,
  modeFromRouteType,
  parseCsv,
  readZipEntry,
  loadStibLines,
} from "../src/handlers/gtfs";
import type { Env } from "../src/types";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const LINES_KEY = "STIB_GTFS_LINES";
const ORIGIN = "https://api.betterintra.com";

const ROUTES_CSV = `route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color
1,STIB,1,Stockel - Gare de l'Ouest,1,E3051B,FFFFFF
38,STIB,38,Gare Centrale - Héros,3,F0A500,000000
93,STIB,93,"Stade, via Royale",0,00A0DF,FFFFFF
N04,STIB,,Night bus,3,,,
`;

const FEED_CSV = `feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version
STIB,https://www.stib-mivb.be,fr,20261101,20261231,2026-11
`;

function makeKV(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(seed)) {
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

function makeEnv(kv = makeKV(), token = "mt-token"): Env {
  return {
    MOBILITYTWIN_TOKEN: token,
    CLIENT_ID: "client-id",
    CLIENT_SECRET: "client-secret",
    BETTER_INTRA_KV: kv as unknown as Env["BETTER_INTRA_KV"],
    better_intra_d1: {} as never,
    better_intra_images: {} as never,
  };
}

/** Minimal ZIP writer: stored entries plus optional pre-compressed ones. */
function buildZip(
  files: {
    name: string;
    data: Uint8Array;
    method?: 0 | 8;
    compressed?: Uint8Array;
  }[],
): ArrayBuffer {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const method = file.method ?? 0;
    const payload = file.compressed ?? file.data;

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, payload);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(10, method, true);
    entryView.setUint32(20, payload.length, true);
    entryView.setUint32(24, file.data.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}

function gtfsZip(deflateRoutes = false): ArrayBuffer {
  const encoder = new TextEncoder();
  return buildZip([
    { name: "routes.txt", data: encoder.encode(ROUTES_CSV) },
    { name: "feed_info.txt", data: encoder.encode(FEED_CSV) },
    { name: "stops.txt", data: encoder.encode("stop_id,stop_name\n1,Gare Centrale\n") },
  ]);
}

async function deflateRaw(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("GTFS catalogue", () => {
  it("maps route types to the PWA modes", () => {
    expect(modeFromRouteType(1)).toBe("metro");
    expect(modeFromRouteType(0)).toBe("tram");
    expect(modeFromRouteType(3)).toBe("bus");
    expect(modeFromRouteType(11)).toBe("bus");
  });

  it("parses quoted CSV fields", () => {
    const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
  });

  it("builds lines from routes.txt and feed_info.txt", () => {
    const catalogue = buildLines(ROUTES_CSV, FEED_CSV, NOW);
    expect(catalogue.feedVersion).toBe("2026-11");
    expect(catalogue.feedStartDate).toBe("20261101");
    expect(catalogue.lines["1"]).toMatchObject({
      lineId: "1",
      mode: "metro",
      routeType: 1,
      color: "#e3051b",
      textColor: "#ffffff",
      name: "Stockel - Gare de l'Ouest",
    });
    expect(catalogue.lines["38"]).toMatchObject({ mode: "bus", color: "#f0a500" });
    expect(catalogue.lines["93"]).toMatchObject({
      mode: "tram",
      name: "Stade, via Royale",
    });
    // No short name: the line id falls back to route_id.
    expect(catalogue.lines["N04"]).toMatchObject({
      lineId: "N04",
      mode: "bus",
      name: "Night bus",
      color: null,
    });
  });

  it("reads one file out of a zip archive", async () => {
    const zip = gtfsZip();
    const routes = await readZipEntry(zip, "routes.txt");
    expect(routes).not.toBeNull();
    expect(new TextDecoder().decode(routes!)).toBe(ROUTES_CSV);
    expect(await readZipEntry(zip, "agency.txt")).toBeNull();
  });

  it("inflates deflated zip entries", async () => {
    const encoder = new TextEncoder();
    const compressed = await deflateRaw(ROUTES_CSV);
    const zip = buildZip([
      {
        name: "routes.txt",
        data: encoder.encode(ROUTES_CSV),
        method: 8,
        compressed,
      },
    ]);
    const routes = await readZipEntry(zip, "routes.txt");
    expect(new TextDecoder().decode(routes!)).toBe(ROUTES_CSV);
  });
});

describe("loadStibLines", () => {
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

  it("uses the KV copy while it is fresh", async () => {
    const kv = makeKV({
      [LINES_KEY]: buildLines(ROUTES_CSV, FEED_CSV, NOW - 1000),
    });
    const lines = await loadStibLines(makeEnv(kv));
    expect(lines.lines["1"].mode).toBe("metro");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads and stores the GTFS archive when the cache is empty", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.mobilitytwin.brussels/stib/gtfs");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer mt-token",
      );
      return new Response(gtfsZip());
    });
    const kv = makeKV();
    const lines = await loadStibLines(makeEnv(kv));
    expect(lines.lines["93"].mode).toBe("tram");
    expect(lines.feedVersion).toBe("2026-11");
    expect(kv.store.has(LINES_KEY)).toBe(true);
    const stored = JSON.parse(kv.store.get(LINES_KEY) as string);
    expect(stored.lines["38"].color).toBe("#f0a500");
  });

  it("keeps the cached catalogue when the download fails", async () => {
    const cached = buildLines(ROUTES_CSV, FEED_CSV, NOW - 30 * 24 * 3600 * 1000);
    const kv = makeKV({ [LINES_KEY]: cached });
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const lines = await loadStibLines(makeEnv(kv));
    expect(lines.lines["1"].mode).toBe("metro");
    expect(lines.updatedAt).toBe(cached.updatedAt);
  });
});

describe("GET /api/v1/public/transit/lines", () => {
  it("returns the sorted catalogue", async () => {
    const kv = makeKV({
      [LINES_KEY]: buildLines(ROUTES_CSV, FEED_CSV, NOW),
    });
    const res = await handleStibLines(
      new Request(`${ORIGIN}/api/v1/public/transit/lines`),
      makeEnv(kv),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feed: { version: string };
      lines: { lineId: string; mode: string }[];
    };
    expect(body.feed.version).toBe("2026-11");
    expect(body.lines.map((line) => line.lineId)).toEqual([
      "1",
      "93",
      "38",
      "N04",
    ]);
  });

  it("answers HEAD without a body", async () => {
    const kv = makeKV({ [LINES_KEY]: buildLines(ROUTES_CSV, FEED_CSV, NOW) });
    const res = await handleStibLines(
      new Request(`${ORIGIN}/api/v1/public/transit/lines`, { method: "HEAD" }),
      makeEnv(kv),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
