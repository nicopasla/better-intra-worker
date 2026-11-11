# Public cluster API

`clusters-public.ts` exposes the Belgium room maps and their current reports as
a small public API. It needs no authentication, no session and no extension, so
the rendered maps work as plain images while the discovery endpoint lets clients
build their own UI.

Markers are composed from the same `seat_components` reports the extension and
the PWA use. Reporter logins are never written into any response.

## Resources

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/v1/public/clusters/belgium` | `application/json` discovery document |
| `GET` | `/api/v1/public/clusters/belgium/{issues\|broken\|usbc}` | `application/json` feed of the matching seats |
| `GET` | `/api/v1/public/clusters/belgium/{shi\|fu\|mi}.svg` | rendered map (`image/svg+xml`) |
| `HEAD` | any | headers only |

- `Access-Control-Allow-Origin: *`
- No auth, no 42 API call
- The campus `plan` map is not part of this API: it has no seat avatars to
  anchor markers to. Use `/api/v1/public/campus-map/belgium/plan.svg` for the
  floor plan.

## Discovery

```
GET https://api.betterintra.com/api/v1/public/clusters/belgium
```

```json
{
  "campus": "belgium",
  "updatedAt": 1762700000000,
  "views": ["default", "issues", "broken", "usbc", "plain"],
  "components": [
    { "key": "computer", "label": "Computer", "kind": "presence" },
    { "key": "boot", "label": "Power", "severity": "blocking", "kind": "defect" },
    { "key": "network", "label": "Network", "severity": "blocking", "kind": "defect" },
    { "key": "keyboard", "label": "Keyboard", "severity": "minor", "kind": "defect" },
    { "key": "mouse_scroll", "label": "Mouse scroll", "severity": "minor", "kind": "defect" },
    { "key": "usbc", "label": "USB-C", "kind": "presence" }
  ],
  "maps": [
    {
      "id": "shi",
      "name": "SHI",
      "counts": { "broken": 1, "issues": 2, "usbc": 1 },
      "views": {
        "default": "https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg",
        "issues": "https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg?view=issues",
        "broken": "https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg?view=broken",
        "usbc": "https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg?view=usbc",
        "plain": "https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg?view=plain"
      },
      "seats": [
        { "host": "shi-r1-p1", "severity": "blocking", "issues": ["Power"], "usbc": true },
        { "host": "shi-r1-p2", "severity": "minor", "issues": ["Keyboard"], "noComputer": true }
      ]
    }
  ]
}
```

- `updatedAt` is the newest report time in milliseconds (`0` when there are no
  reports).
- `seats` lists every seat with at least one report, limited to the map's real
  seat ids, sorted by host.
- `severity` is `blocking`, `minor`, or `null` for USB-C-only seats.
- `issues` are the broken defect components (Power, Network, Keyboard, Mouse
  scroll). They are reported even on crossed seats, where the SVG
  deliberately does not draw the warning triangle.
- `noComputer: true` when someone reported the seat has no computer at all; the
  key is omitted otherwise.
- `usbc: true` only when the port was reported present; the key is omitted
  otherwise.
- `counts.broken` = crossed seats (no computer), `counts.issues` = seats with
  any defect, `counts.usbc` = seats with the port.
- `views` and `components` make the document self-describing.

## Per-view feeds

```
GET https://api.betterintra.com/api/v1/public/clusters/belgium/issues
GET https://api.betterintra.com/api/v1/public/clusters/belgium/broken
GET https://api.betterintra.com/api/v1/public/clusters/belgium/usbc
```

A flat list of the seats matching one view, across all three maps:

```json
{
  "campus": "belgium",
  "view": "broken",
  "updatedAt": 1762700000000,
  "count": 2,
  "seats": [
    { "map": "shi", "host": "shi-r1-p1", "severity": "blocking", "issues": ["Power"], "usbc": true },
    { "map": "fu", "host": "fu-c2-p3", "severity": null, "issues": [], "noComputer": true }
  ]
}
```

- `issues` → seats with a blocking or minor issue.
- `broken` → crossed seats (no computer reported).
- `usbc` → seats reported to have a USB-C port; they may have `"severity": null`
  and `"issues": []`.
- Each seat carries its `map`, and the list is sorted by map (`shi`, `fu`, `mi`)
  then host.
- `count` is `seats.length`; `updatedAt` is the newest report time in ms.
- Same caching, ETag/304 and error contract as the discovery endpoint (`503`
  when reports are unavailable).

## Rendered map

```
GET https://api.betterintra.com/api/v1/public/clusters/belgium/{shi|fu|mi}.svg?view=default
```

| `view` | Layers |
| --- | --- |
| `default` (implicit when omitted) | Crosses, red tints, triangles and USB-C glyphs |
| `issues` | Crosses, red tints and triangles |
| `broken` | Crosses only |
| `usbc` | USB-C glyphs only |
| `plain` | Base map, no overlays |

- One value, case-insensitive and trimmed.
- Empty, combined or unknown values return `400 invalid_view`.
- `plain` does not query D1 at all.
- Query strings are part of the cache key, so every view caches independently.
- Each rendered map carries a legend (`<g id="ft-legend">`) with one row per
  marker the view draws. Its position is **manual** per map in
  `LEGEND_PLACEMENT` (SVG/viewBox units), its width follows the longest label and
  its height the row count. The `viewBox` grows only enough to keep it visible.

### Legend

| Marker | Meaning |
| --- | --- |
| Red cross | The seat has no computer at all |
| Red tint | Power or network is reported broken |
| Amber triangle | Keyboard or mouse scroll is reported broken. Never drawn on a crossed or red-tinted seat. |
| Blue USB-C glyph | Someone reported a USB-C port on that seat. It means the port exists, not that the seat is free; occupancy is not used. |

Each marked seat also carries a `<title>` with its hostname and reasons, e.g.
`shi-r1-p2 — Power, USB-C`. Browsers show it as a native tooltip when the SVG is
inlined or embedded with `<object>`/`<iframe>`; `<img>` ignores it.

## Embedding

```html
<!-- Default: issues + USB-C -->
<img
  src="https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg"
  alt="SHI cluster map with current issues"
/>

<!-- Broken computers only -->
<img
  src="https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg?view=broken"
  alt="SHI cluster map with broken computers"
/>

<!-- USB-C ports only -->
<img
  src="https://api.betterintra.com/api/v1/public/clusters/belgium/fu.svg?view=usbc"
  alt="FU cluster map with USB-C ports"
/>

<!-- Plain floor plan -->
<img
  src="https://api.betterintra.com/api/v1/public/clusters/belgium/mi.svg?view=plain"
  alt="MI cluster floor plan"
/>

<!-- Inline/object embedding keeps the hover tooltips -->
<object
  type="image/svg+xml"
  data="https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg"
></object>
```

```md
![SHI cluster map](https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg)
```

Every map has its own `viewBox`; size it with CSS (`max-width: 100%; height:
auto`) instead of hardcoding pixel dimensions.

```bash
curl https://api.betterintra.com/api/v1/public/clusters/belgium
curl -I "https://api.betterintra.com/api/v1/public/clusters/belgium/shi.svg?view=broken"
```

## Caching

- Discovery and rendered maps: `Cache-Control: public, max-age=60, stale-while-revalidate=300`
- `ETag` on every response; `If-None-Match` gets a `304` with no body
- If the reports query fails, the rendered map is still served unmarked with
  `max-age=15`; the discovery endpoint returns `503` with `Retry-After: 15` and
  `Cache-Control: no-store`

## Errors

All errors are JSON:

```json
{ "error": "invalid_view", "message": "Unknown view.", "allowed": ["default", "issues", "broken", "usbc", "plain"] }
```

| Status | `error` | Reason |
| --- | --- | --- |
| `400` | `invalid_view` | Unknown or empty `view` |
| `404` | `campus_not_found` | Campus other than `belgium` |
| `404` | `map_not_found` | Unknown map id, or the base map is unavailable |
| `405` | `method_not_allowed` | Method other than GET/HEAD (with `Allow: GET, HEAD`) |
| `413` | `map_too_large` | Base map larger than 2 MiB |
| `502` | `invalid_map` | Upstream body is not an SVG |
| `503` | `reports_unavailable` | Discovery only: the reports query failed |

## Data

- Reports come from `seat_components` (Belgium, campus `12`).
- Severity split matches the app: `boot`/`network` are blocking,
  `keyboard`/`mouse_scroll` are minor, `computer` and `usbc` are presence
  answers and never mark a seat broken.
- Legacy anonymous Power/Network rows are ignored when a signed-in user
  confirmed the USB-C port on that seat.
- Maps are read from R2 (`campus-maps/belgium/<id>.svg`), falling back to the
  copies in the repository under `campuses/maps/belgium/`.
- Updates appear as soon as someone reports a component; the 60 s cache bounds
  the delay.
