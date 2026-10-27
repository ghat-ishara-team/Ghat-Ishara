# Exact source-cell location inspection

The public Map Explorer now supports map click/tap, **Inspect map center**, and **Enter** while the map canvas has keyboard focus. A mint location marker moves to the latest selected position. Its native button is keyboard accessible and opens/focuses the location panel. Closing the panel clears the selection and returns focus to the map.

The panel reports WGS84 latitude/longitude, selected district, the actual source Float32 score, its shared legend band, dataset name, and zero-based native row/column. NoData or outside coverage explicitly says **No model score available**. Failed/missing/invalid numerical assets instead say **Numerical data unavailable**. It never derives scores from display PNG colors.

## Static architecture and precision

No backend was introduced. Native 256 × 256 source-grid chunks preserve all valid original IEEE-754 Float32 bits. They are not XYZ tiles, are never reprojected, and contain no interpolated, averaged, normalized or quantized predictions. Gzip is lossless. The browser:

1. Receives MapLibre's WGS84 `[longitude, latitude]` click position without rounding it for computation.
2. Uses **[Proj4js](https://proj4js.org/)** to transform WGS84 to **EPSG:32643 / UTM zone 43N**. This new dependency supplies established CRS math rather than an ad hoc projection implementation; no transformation grids, keys or network projection service are required.
3. Applies the inverse original affine transform using the [containing-pixel convention](https://rasterio.readthedocs.io/en/stable/api/rasterio.transform.html), flooring row and column to identify the containing 30 m source cell. Native grid edges use the normal top/left-inclusive and bottom/right-exclusive convention. Exact native-grid coordinates, not transformed footprint rectangles or administrative boundaries, decide whether a cell exists.
4. Reads at most one numerical chunk per candidate district, validates its header, dimensions, source association, uncompressed SHA-256 and score range, then reads the selected little-endian Float32 value. The JavaScript Number exactly represents that Float32 value.

Scores are displayed to **nine significant digits**, enough to round-trip every finite Float32 value; the panel states this explicitly. Coordinates display six decimal places for readability while lookup uses the full click precision. Tested Proj4js vs GDAL/PROJ residuals were at most **3.376 × 10⁻⁹ m** for 286 source-derived cases; the test tolerance is 0.0001 m. This is numerical consistency for the reviewed CRS, not a claim of model or geolocation accuracy. Points extremely close to a pixel edge remain subject to floating-point coordinate arithmetic. Mouse/touch screen pixels can span multiple ground cells at low zoom; Enter/Inspect map center inspect the exact camera center.

The source files are the same four `PRAHARI_<DISTRICT>_250m_22pred_score.tif` outputs described in [MAP_EXPLORER.md](MAP_EXPLORER.md). All are Float32, north-up UTM 43N, 30 m resolution, NoData −9999. The `250m` suffix is not pixel resolution. Original files, models and ML pipelines remain read-only.

With one district selected, only its source grid/mask is queried. With **All four districts**, every applicable source is checked; if multiple datasets have valid cells at the point, all are named separately. Values are never blended and bounding boxes are never used to assert administrative membership. If one candidate dataset fails, verified results from others can still appear with a conspicuous partial-unavailability message.

Visual tiles are independently generalized/reprojected in Web Mercator. At coarse zoom or mask/class edges their displayed color may differ from the exact source-cell band returned by a click. The numeric answer takes precedence for that source cell; there is no RGB inversion or inference from overlay opacity.

## Size and bounded generation

The preflight maximum was **1,380 chunks / 330.59 MiB uncompressed Float32**, with an estimated 80–150 MiB compressed. Actual output:

| Dataset | Nonempty files | Known-empty chunks | Compressed size |
|---|---:|---:|---:|
| Pune | 326 | 246 | 43.44 MiB |
| Raigad | 155 | 73 | 24.24 MiB |
| Ratnagiri | 180 | 96 | 30.07 MiB |
| Satara | 218 | 86 | 31.79 MiB |
| Total | **879** | **501** | **129.55 MiB** |

Generation took approximately **7.5 seconds** on this machine, one process. The generator permits at most 2,048 planned chunks / 512 MiB raw data, checks free disk against twice the raw size, limits generation to 180 seconds, and uses the existing bounded GDAL cache. It reads sources without writing sidecars and checks source hashes before/after. Every build uses a new timestamped directory, retains old builds, and publishes the manifest last via atomic replacement. No source or old output is deleted.

Generated assets live at **`frontend/public/generated-data/scores/`**, already excluded from Git by `public/generated-data/`. The manifest contains explicit `null` entries for known-empty chunks, so they are not fetched and a missing expected file cannot masquerade as NoData. Nonempty assets use `.sct.gz`; source masks are encoded using the declared NoData sentinel, and all valid bits are unchanged.

## Files

- `src/map/scoreLookup.ts`: validated catalog, CRS conversion, bounded tile decoding and numerical queries.
- `src/map/useLocationInspection.ts`, `LocationDetails.tsx`: cancellable selection state and accessible panel.
- `src/map/MapExplorer.tsx`, `map.css`: map clicks, keyboard/marker integration and responsive layout.
- `scripts/geospatial/prepare_scores.py`, `test_scores.py`, `query_reference.py`: reproducible generation and independent QA reference reads; `run.mjs` adds their command wiring.
- `scripts/verify-scores.mjs`, `verify-scores-browser.mjs`: numerical unit/integration/browser checks.
- `package.json`, `package-lock.json`: Proj4js dependency and test/generation scripts; `MAP_EXPLORER.md` links this guide.

## Reproduce and run

From `frontend/`, using the existing root Python environment or `GHAT_GEO_PYTHON` as documented in [MAP_EXPLORER.md](MAP_EXPLORER.md):

```sh
npm install
npm run map:scores:inspect  # read-only metadata/size plan
npm run map:scores          # generate numerical assets
npm run dev
```

Open **http://127.0.0.1:5173/explore-map**. Visual overlays still use `npm run map:tiles`; neither generation command changes the other's assets. After separately approved ML data changes, update the reviewed catalog and regenerate both layers so source hashes agree. This implementation refuses mismatched/stale numerical manifests.

Verification order:

```sh
npm run test:scores:geo     # verifies every numerical tile and writes ignored golden test points
npm run test:scores        # actual frontend lookup/CRS/decoder, using those real-source points
npm run test:scores-browser
npm run test:map
npm run test:map:geo
npm run test:map-browser
npm run test:persistence
npm run test:persistence-browser
npm run build
```

The numerical geospatial suite independently compares **every valid value's Float32 bits** and all masked cells against Rasterio reads of the originals, plus header/file counts, hashes and grid geometry. It exports real-source test points under ignored `qa-results/score-samples.json`. The JavaScript suite checks exact values/cells, zero, NoData, invalid coordinates, source edges and chunk seams, all-district querying, district restriction, malformed manifests, corruption, decompression bounds, aborts and retry. Browser tests use real visual and numerical assets with the existing offline vector basemap fixture and Supabase disabled. They check all four datasets, actual mouse-click results against an independent read-only Rasterio query, Enter/center/marker controls, new selection/district races, failure and retry, ephemeral results, desktop/mobile WCAG AA and overflow. Screenshots are under `qa-results/score-inspection-*.png`. The independent Python query helper is an **offline QA tool**, not a server/API.

## Format and hosting

Each gzip file expands to a 32-byte header and tightly packed row-major little-endian Float32 values (partial edge chunks use their actual width/height):

| Byte offset | Field |
|---|---|
| 0–7 | ASCII `GHATSCR1` |
| 8 | uint32 source start row |
| 12 | uint32 source start column |
| 16 | uint32 width |
| 20 | uint32 height |
| 24 | Float32 NoData |
| 28 | uint32 format version = 1 |
| 32 onward | Float32 values |

The small manifest binds each dataset to its checked-in source SHA-256 and exact dimensions/affine/CRS, and each chunk to its uncompressed SHA-256. Checks detect corrupt/misaligned files; they are not authorization or a signature protecting against a compromised host.

Serve immutable build directories from static hosting or an object store behind the same-origin `/generated-data/scores/` path. Prefer `application/octet-stream` or `application/gzip`; do not SPA-fallback missing chunks to HTML. Keep manifests revalidatable and timestamped chunks cacheable/immutable. The decoder accepts either raw gzip bytes or an already HTTP-decompressed body, accommodating hosts that set `Content-Encoding: gzip`. Vite copies public numerical assets into `dist/`, so deployment size grows by about 130 MiB. Old builds and QA build copies add disk usage; no automated cleanup was introduced.

The browser requests only the small manifest and needed chunks (≤ about 257 KiB decoded per chunk, up to four in overlapping source footprints). It uses bounded stream/decompression reads and a ten-second lookup deadline, with an eight-chunk in-memory LRU (~2 MiB). HTTPS or localhost, Web Crypto and browser gzip decompression are needed; missing capabilities produce a friendly unavailable state. No numerical values, selected locations or lookup results are put in autosave/localStorage/sessionStorage. Existing district/camera/visibility/opacity preferences remain unchanged.

## Backend trade-offs and limitations

Native static chunks were chosen because they preserve source precision without serving whole GeoTIFFs or installing a query server. Reprojecting numerical XYZ tiles would make source-cell identity harder to preserve; quantized RGB/16-bit encodings would lose Float32 precision. Browser COG range querying could also work, but would require range-aware hosting, a TIFF decoder and appropriate source overviews/indexing. A backend could reduce published asset size and support private data/dynamic sources, but would add hosting, authorization and operational maintenance that this public static requirement does not need.

All numerical assets are public and downloadable if hosted; they must never contain protected official records. A future private-data service needs trusted authorization/RLS. Current official permissions, Supabase policies and authentication are untouched.

Selection changes synchronously hide the previous result. Requests are cancelled on new points, district changes, close and unmount; a generation guard ignores late responses. Explicit retry retains the current point and never invents a fallback score. Reopening/reloading a page restores normal map preferences, not a stale inspected result. Unavailable data is distinguished from a verified masked cell/outside extent. Empty coverage never means safe.

These are experimental, uncalibrated static susceptibility scores, **not event probabilities or live warnings**. The source's rainfall units remain marked UNVERIFIED. Numeric fidelity does not establish predictive validity, spatial accuracy or suitability for emergency/engineering decisions. Administrative boundary determination, live hazards and model scientific validation remain outside this feature.
