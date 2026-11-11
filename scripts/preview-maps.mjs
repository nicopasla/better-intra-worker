#!/usr/bin/env node
/**
 * Live preview for the public cluster maps.
 *
 *   cd better-intra-worker && npm run preview
 *   (or: npm run preview:clusters from the repo root)
 *
 * - Serves http://localhost:7474
 * - Renders every Belgium map for the selected `?view=`
 * - Re-bundles the handler on each request, so edits to the SVG sources *and*
 *   to `clusters-public.ts` show up within ~1.5s
 * - Markers are simulated (one seat per marker type) so the legend and the
 *   overlays are always visible.
 *
 * In VS Code: Cmd/Ctrl+Shift+P → "Simple Browser: Show" → http://localhost:7474
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "..");
const mapsDir = join(workerDir, "..", "campuses", "maps", "belgium");
const entry = join(workerDir, "src", "handlers", "clusters-public.ts");
const PORT = Number(process.env.PORT ?? 7474);
const MAP_IDS = ["shi", "fu", "mi"];
const VIEWS = ["default", "issues", "broken", "usbc", "plain"];

const outDir = await mkdtemp(join(tmpdir(), "bi-map-preview-"));
let bundleVersion = 0;

/** Bundles the worker handler and imports it fresh (picks up every edit). */
async function loadHandler() {
  const outfile = join(outDir, `clusters-public-${bundleVersion++}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  return import(`${pathToFileURL(outfile).href}?v=${bundleVersion}`);
}

/** A few example markers per map, one of each kind, on real seats. */
function sampleMarkers(svg) {
  const seats = [...svg.matchAll(/<image\b[^>]*\sid="([^"]+)"/gi)].map(
    (match) => match[1],
  );
  const markers = new Map();
  const pick = (index) => seats[index % Math.max(seats.length, 1)];
  if (seats.length) {
    markers.set(pick(0), {
      blocking: [],
      minor: [],
      noComputer: true,
      usbc: false,
    });
    markers.set(pick(1), {
      blocking: ["Power"],
      minor: [],
      noComputer: false,
      usbc: true,
    });
    markers.set(pick(2), {
      blocking: [],
      minor: ["Keyboard"],
      noComputer: false,
      usbc: true,
    });
    markers.set(pick(3), {
      blocking: [],
      minor: ["Mouse scroll"],
      noComputer: false,
      usbc: false,
    });
  }
  return markers;
}

async function renderMaps(view) {
  const { decorateMapSvg, LEGEND_PLACEMENT } = await loadHandler();
  const blocks = [];
  for (const id of MAP_IDS) {
    const svg = await readFile(join(mapsDir, `${id}.svg`), "utf8");
    const spot = LEGEND_PLACEMENT?.[id] ?? { placement: "auto" };
    const decorated = decorateMapSvg(
      svg,
      sampleMarkers(svg),
      view,
      spot.placement,
      spot.below,
    );
    blocks.push(`
      <section class="map">
        <h2>${id.toUpperCase()} <span>view=${view}</span></h2>
        <div class="canvas">${decorated}</div>
      </section>`);
  }
  return blocks.join("\n");
}

function page(view) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Cluster maps preview</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; padding: 16px; font: 13px system-ui, sans-serif; background: #f5f6f7; color: #1f2937; }
      header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
      header a { padding: 4px 10px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: inherit; text-decoration: none; }
      header a.active { background: #1f2937; border-color: #1f2937; color: #fff; }
      .maps { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
      .map { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; }
      .map h2 { margin: 0 0 8px; font-size: 13px; display: flex; justify-content: space-between; }
      .map h2 span { font-weight: 400; color: #6b7280; }
      .canvas { display: flex; justify-content: center; }
      .canvas svg { width: 100%; height: auto; max-height: 78vh; }
    </style>
  </head>
  <body>
    <header>
      <strong>Belgium cluster maps</strong>
      ${VIEWS.map(
        (item) =>
          `<a href="/?view=${item}" class="${item === view ? "active" : ""}">${item}</a>`,
      ).join("")}
      <span id="status">live</span>
    </header>
    <div class="maps" id="maps"></div>
    <script>
      const view = ${JSON.stringify(view)};
      const maps = document.getElementById("maps");
      const status = document.getElementById("status");
      async function refresh() {
        try {
          const res = await fetch("/maps?view=" + encodeURIComponent(view));
          maps.innerHTML = await res.text();
          status.textContent = "live · " + new Date().toLocaleTimeString();
        } catch {
          status.textContent = "waiting for the preview server…";
        }
      }
      refresh();
      setInterval(refresh, 1500);
    </script>
  </body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const view = VIEWS.includes(url.searchParams.get("view") ?? "")
    ? url.searchParams.get("view")
    : "default";
  try {
    if (url.pathname === "/maps") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await renderMaps(view));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(view));
      return;
    }
    res.writeHead(404).end("not found");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(error?.stack ?? error));
  }
});

server.listen(PORT, () => {
  console.log(`Cluster map preview → http://localhost:${PORT}`);
  console.log("Edits to the maps or clusters-public.ts reload automatically.");
});
