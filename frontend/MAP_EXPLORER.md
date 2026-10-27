# GHAT ISHARA Map Explorer

The public explorer is available at **`/explore-map`**, with **`/map`** preserved as a working alias for existing navigation and the landing-page CTA. The landing page, official portal, permissions, Edge Functions and migrations are unchanged. No server, Supabase storage bucket or raster-processing API is needed for this milestone.

## How it works

MapLibre GL JS renders the key-free **OpenFreeMap Liberty vector basemap** (OpenMapTiles / OpenStreetMap data) plus the existing generated, georeferenced PNG susceptibility tiles. Direct `tile.openstreetmap.org` raster requests are no longer made. Only tiles in the current viewport are fetched; the browser never downloads source GeoTIFFs. Controls select one district or all four, toggle susceptibility, change opacity, zoom and reset the view. Arrow keys pan the focused map; plus/minus zoom. Touch pan/pinch, native form labels, visible focus, responsive layouts and reduced-motion camera transitions are supported. Browsers without WebGL show a clear fallback with accessible controls, metadata and legend.

The existing public persistence hook saves selected district, susceptibility visibility, opacity and camera position in localStorage for 30 days. There is one basemap, so no extra basemap preference is required. Restored coordinates are validated by the existing schema and constrained to the study region. Legacy layer names in that shared schema do not enable nonexistent terrain/boundary layers. No official information or authentication state is added to persistence.

Layer availability is determined by a validated generated manifest. The checked-in small raster catalog supplies actual geographic bounds even if tiles are absent. Source hashes, CRS, XYZ scheme, tile size, zoom limits and the common color scale must agree. Missing, invalid or partial manifests produce explicit unavailable states; failed tile/basemap requests have friendly messages and an explicit retry action. A small MapLibre tile protocol adapter fetches only approved public PNG paths without credentials, validates PNG signatures/MIME types, and turns 404/HTML SPA fallbacks into visible failures (MapLibre otherwise treats 404 as an empty tile). Blank failed tiles must not be interpreted as low susceptibility.

## Verified source data

All inputs are read only, under `ml/data/district_susceptibility/`:

| District | Source filename | Dimensions | Valid pixels in raster rectangle | Score range | PNG tiles | PNG size |
|---|---|---:|---:|---:|---:|---:|
| Pune | `PRAHARI_PUNE_250m_22pred_score.tif` | 6474 × 5548 | 45.24% | 0–0.975831 | 607 | 2.58 MiB |
| Raigad | `PRAHARI_RAIGAD_250m_22pred_score.tif` | 2989 × 4740 | 50.77% | 0.006333–0.962360 | 253 | 2.72 MiB |
| Ratnagiri | `PRAHARI_RATNAGIRI_250m_22pred_score.tif` | 2920 × 5826 | 52.60% | 0.010352–0.957177 | 330 | 3.50 MiB |
| Satara | `PRAHARI_SATARA_250m_22pred_score.tif` | 4851 × 4033 | 57.51% | 0–0.972670 | 345 | 1.91 MiB |

Sources total approximately 136 MiB. All are single-band Float32, **EPSG:32643 (UTM 43N), 30 m × 30 m**, NoData **−9999**. All unmasked values are finite and inside [0,1]. The `250m` suffix describes the ML sampling/exclusion configuration, **not pixel resolution**. The `_TEST_*` files are deliberately not inputs.

WGS84 raster footprint bounds `[west, south, east, north]`, transformed with densified edges:

- Pune: `[73.314594, 17.887755, 75.164101, 19.399209]`
- Raigad: `[72.806614, 17.844541, 73.668816, 19.137022]`
- Ratnagiri: `[73.027276, 16.490004, 73.864513, 18.075641]`
- Satara: `[73.529934, 17.086981, 74.906477, 18.185850]`

Exact metadata, source SHA-256 hashes, tags and native UTM extents are in `src/map/raster-catalog.json`. These rectangles are raster footprints, **not surveyed district boundaries**. Valid percentages describe those rectangles; they are not estimates of the fraction of each administrative district that is safe or covered.

## Geospatial preparation

Node dependencies: `npm install` (MapLibre GL JS is the only newly introduced package). Python requires Rasterio/GDAL, NumPy and Pillow. The launcher uses the existing root `.venv/bin/python` if present; override `GHAT_GEO_PYTHON` for another isolated interpreter. No system package installation is necessary.

From `frontend/`, with the existing environment:

```sh
npm run map:inspect
npm run map:tiles
npm run test:map:geo
```

If geospatial dependencies are missing, create an isolated environment within the frontend:

```sh
python3 -m venv .venv-map
.venv-map/bin/pip install -r scripts/geospatial/requirements.txt
GHAT_GEO_PYTHON="$PWD/.venv-map/bin/python" npm run map:inspect
GHAT_GEO_PYTHON="$PWD/.venv-map/bin/python" npm run map:tiles
GHAT_GEO_PYTHON="$PWD/.venv-map/bin/python" npm run test:map:geo
```

`map:inspect` only inspects and estimates output. To deliberately refresh the small checked-in metadata catalog after a separately approved source-data change:

```sh
npm run map:inspect -- --write-catalog
```

The pipeline refuses absent sources, missing CRS/NoData, non-finite or out-of-range valid scores, empty sources, unexpected district/test tags and implausible study extents. It never clips bad predictions into valid scores. It opens sources in read-only mode with GDAL sidecar writing disabled, and checks hashes again after generation. It does not modify ML source data, models or pipelines.

Generation uses Rasterio WarpedVRTs aligned to the global **EPSG:3857 XYZ** grid, with 256 × 256 pixels and **zoom 6–12**. Nearest-neighbour resampling selects source scores without smoothing or interpolating new predictions. GDAL warp tolerance is 0.01 destination pixels (under about 0.4 m at zoom 12); the alignment tests independently transform tile pixel centers into original UTM source cells. At Maharashtra latitudes, zoom 12 is approximately 36 m per display pixel. Zooms 13–14 in the UI magnify existing tiles rather than fabricate finer predictions.

A shared configuration, `src/map/color-scale.json`, controls both Python coloring and the frontend legend. Five fixed bands use the exact same colors for every district:

| Original score | Color |
|---|---|
| 0 ≤ score < 0.2 | `#256d85` |
| 0.2 ≤ score < 0.4 | `#55aa91` |
| 0.4 ≤ score < 0.6 | `#e4cf75` |
| 0.6 ≤ score < 0.8 | `#e79b52` |
| 0.8 ≤ score ≤ 1 | `#ce605b` |

Zero is valid and colored. Masked NoData and exterior pixels are RGBA `[0,0,0,0]`. Lossless PNG preserves these categories and alpha. Fully transparent tiles inside the bounded tile rectangle are generated too, avoiding expected holes becoming misleading 404 errors. Low zooms sample/generalize small features; they are for regional interpretation, not precise site assessment. Category colors cannot recover exact floating-point scores. The public click inspector instead uses a separate lossless native-grid numerical layer; see [LOCATION_INSPECTION.md](LOCATION_INSPECTION.md). It never reads scores back from display colors.

The preflight plan was **1,535 tiles / 383.8 MiB raw RGBA**, with a conservative PNG estimate of 10–80 MiB. Actual generation produced **10.71 MiB of PNGs (approximately 15 MiB allocated on disk including small-file overhead and metadata) in approximately 11 seconds** on this machine. GDAL cache is bounded to 128 MiB and warping memory to 64 MiB, plus Python/GDAL working buffers. At most 3,000 planned tiles and zooms within 5–12 are allowed. Disk space is checked before conversion. A generation job has no network calls.

Output is under **`public/generated-data/susceptibility/`**, ignored by Git. Each run creates a new timestamped build directory and publishes `manifest.json` only after all districts finish successfully. Previous builds remain; the script does not clean up or overwrite previous tiles. An individual build JSON report is retained alongside the manifest. A failed run leaves the previous manifest and any partial derived build available for investigation. Regeneration uses `npm run map:tiles`; no source-file deletion or database reset is involved. Remember that retained builds and QA production copies consume additional disk space.

## Start and test

```sh
cd ~/GHAT_ISHARA_ML/frontend
npm install
npm run map:tiles       # visual overlays (derived assets are not committed)
npm run map:scores      # exact source-grid numerical inspection
npm run dev
```

Open **http://127.0.0.1:5173/explore-map**. For a production preview:

```sh
npm run build
npm run preview
```

The MapLibre module and CSS are loaded only for the map routes. The MapLibre 6 worker is explicitly bundled with Vite’s `?worker&url` support so production worker paths remain valid. Vite reports a large map chunk (roughly 1 MiB minified / 300 KiB gzip) because it includes the map engine; it is not added to the landing-page initial bundle.

Automated checks:

```sh
npm run test:map
npm run test:map:geo
npm run test:scores:geo
npm run test:scores
npm run test:scores-browser
npm run test:map-browser
npm run test:basemap-live # opt-in: normal internet provider check
npm run test:persistence
npm run test:persistence-browser
npm run build
npm run check:edge
npm run test:permissions
npm run test:edge
npm run test:bootstrap
npm run test:public-env
```

`test:map` validates district IDs, actual metadata bounds, coordinates, basemap/overlay settings, attribution and malformed/stale/partial manifests. `test:map:geo` checks score-band boundaries, alpha, XYZ geometry, invalid/missing rasters, all generated files and source hashes. For each district it compares sampled high-zoom rendered colors and alpha against source values obtained using independent inverse CRS transforms; it requires >99.5% exact matches. Synthetic invalid rasters exist only in temporary test directories, never in production assets. Real-source integration tests explicitly skip if no derived manifest exists; run tile generation first for the full checks.

`test:map-browser` launches host Chromium (`/usr/bin/chromium`, overridable via `CHROMIUM_PATH`) with software WebGL if necessary. It uses real generated susceptibility tiles and an **offline vector provider fixture** for deterministic testing, with Supabase disabled. It tests controls, routes, camera framing, restoration, failure/retry, WebGL fallback, keyboard, responsive overflow and automated WCAG AA. Failure fixtures include HTTP 403 and image responses returned with HTTP 200, both as style metadata and at vector-tile endpoints. A failed provider is removed and replaced by an explicitly unavailable, empty geographic canvas; real model overlays remain functional. No CSS masking of warning imagery is used.

For actual network verification run **`npm run test:basemap-live`**. This opt-in test builds with Supabase disabled and opens four ordinary map views without request interception, header spoofing, proxies or cache bypass. It decodes real vector tile bodies with the map engine's existing PBF dependencies and checks road/place features, coverage of each district center, origin-only Referer, normal caching, no direct OSM requests, and all four real susceptibility overlays. Only provider sprite PNGs are accepted as basemap images; their signatures and a saved sample can be inspected. Screenshots and a verification summary are saved in ignored `qa-results/basemap-live/`. A detailed QGIS alignment audit and future provider availability remain separate from this check.

Manual review:

1. Visit `/explore-map` online; check OpenFreeMap geographic labels and visible OpenFreeMap / OpenMapTiles / OpenStreetMap attribution. Select each district, reset its view, and zoom to 11–12. Overlay coverage must remain attached to the same locations during pan/zoom.
2. For authoritative alignment inspection, open each source GeoTIFF in QGIS alongside OSM, then compare recognizable coastline/valley coverage and mask edges to the web map at the same coordinates. District footprint rectangles alone are not valid administrative-boundary comparisons. The browser shows generalized classified tiles, not raw float values.
3. Toggle visibility and move opacity through 0%, 40%, 100%. NoData must reveal the basemap, while valid zero scores must remain blue at 100% opacity. Check Raigad/Ratnagiri coastal exclusions and Pune/Satara's extensive low-score areas.
4. Pan/zoom, navigate to Districts and return, then refresh and reopen the browser. District, camera, opacity and visibility should restore. Verify landing-page animation, `/map`, official login and administrator drafts remain functional.
5. Use browser request blocking for `/generated-data/**` or `tile.openstreetmap.org` to see honest unavailable/error states; unblock and retry. Test keyboard controls and mobile widths.

## Hosting and service policies

Vite copies generated public assets into `dist/generated-data/` when present. A production static host can serve them directly. Alternatively, put immutable timestamped build directories in public object storage/CDN and reverse-proxy the same-origin `/generated-data/susceptibility/` path. Serve PNG MIME types, avoid HTML SPA fallbacks for missing tiles, support normal cache headers and publish `manifest.json` last. Cache timestamped tiles long-term/immutable; let the manifest revalidate. Preserve relative directory structure and existing builds while cached manifests may refer to them. No service-role key or Supabase backend is needed. This session does not deploy anything.

The default geographic basemap uses [OpenFreeMap](https://openfreemap.org/) via its [documented MapLibre integration](https://openfreemap.org/quick_start/). The public instance requires **no API key, signup or private credentials**, allows public/commercial maps, and publishes its own [terms](https://openfreemap.org/tos/). It is a best-effort service without an SLA. Preserve the visible OpenFreeMap, OpenMapTiles and OpenStreetMap contributor credits on desktop and mobile. The provider style's optional low-zoom Natural Earth raster is omitted; all geographic map tiles are vector data. The ML overlays remain their original real raster tiles.

Public build-time settings (also in `.env.example`):

```dotenv
VITE_BASEMAP_PROVIDER=openfreemap
VITE_BASEMAP_STYLE=liberty
```

Both default to these values if absent. Supported styles are `liberty`, `positron`, and `dark`. Set `VITE_BASEMAP_PROVIDER=none` to intentionally disable geographic context. Unknown provider/style values produce an explicit unavailable state without sending requests to arbitrary providers. No key setting is needed or supported; never paste service credentials into frontend variables. Restart Vite after changing `.env.local`, or rebuild for production. A future keyed provider would need a separate reviewed adapter with a domain-restricted public browser key and an explicit missing-key state; arbitrary tile/style URLs are deliberately not accepted.

The baseline style is fetched over HTTPS using ordinary browser HTTP caching and no credentials. Provider style sources, glyphs and sprites must use the official OpenFreeMap origin. No direct OSM fallback, access-block proxy, artificial User-Agent/Referer, cache-busting query, or automatic provider rotation is used. On load/permission/decoding errors, remove only the failed basemap and show **The basemap could not load**; camera controls and real overlays continue working. Retry is explicit and retains the camera, district and opacity. A 15-second deadline prevents indefinite basemap loading. Missing or disabled configuration has explanatory text.

### Original blocking investigation

The previous URL template was correct HTTPS OSM Standard, attribution was visible, and browser diagnostics showed no outgoing `Cache-Control: no-cache` or `Pragma: no-cache` on tile requests. However, `index.html` had **`<meta name="referrer" content="no-referrer">`**, and real browser requests confirmed a missing Referer. That violates the [official OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/), which requires browser Referer identification and normal caching and permits blocks without notice. The separate `cache: 'no-cache'` in the local susceptibility-manifest request is unrelated to external basemap tiles.

The original 403 block was intermittent and was **not reproduced by this environment's diagnostic viewport**: returned HTTP 200 images were saved and inspected and contained actual geography. A missing Referer is a confirmed configuration defect and a plausible trigger, but the exact server-side decision affecting another browser/IP cannot be proved here. HTTP status alone is not sufficient because a warning image can also return 200. Diagnostics are under `qa-results/basemap-diagnostics/`.

The page now uses **`strict-origin`**: browser requests carry the real site origin while paths, query strings and invitation fragments are not sent as Referer. This is a real document policy correction, not header spoofing. Check production hosting/CDN response headers and browser privacy extensions as well; a stricter server policy or extension can override/remove Referer. Do not weaken privacy to send full invitation URLs. The site uses an independent, intended public map provider rather than trying to evade OSM restrictions.

MapLibre source behavior is documented in its [source specification](https://maplibre.org/maplibre-style-spec/sources/); ML reprojection follows [Rasterio virtual warping](https://rasterio.readthedocs.io/en/stable/topics/virtual-warping.html).

## Scientific limitations and remaining work

The source model is tagged **`rf_250m_controlled_22pred_EXPERIMENT`**, and **`RAINFALL_UNITS=UNVERIFIED`**. The source description explicitly calls scores uncalibrated and not operational warnings. This implementation validates data integrity, bounds and rendering, not model accuracy, rainfall units, calibration, sampling exclusions or training validity. Identical colors represent identical numeric bands, not validated hazard classes or calibrated cross-district probabilities. Regional and class distributions differ substantially between districts.

These are static susceptibility outputs, not real-time forecasts, observed events or emergency advisories. NoData can mean excluded, missing or outside coverage and never means safe. Pixel resolution is not prediction accuracy. There is no measured district-boundary vector layer in this milestone, no live incident/weather integration, no server-side pixel-score API and no new protected official functionality. Field validation, scientific review and a detailed QGIS comparison remain manual. Do not use this map alone for evacuation, travel or engineering decisions.
