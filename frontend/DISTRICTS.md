# Districts

Public district pages share the existing forest-green shell, navigation, typography and decorative Tamhini photograph. No new imagery, simulated maps or generated geospatial datasets are included. The shared photograph is scenic context, not a district-specific satellite image; its credit and license are in `ASSETS.md`.

## Structure and URLs

- `/districts`: four district cards with source filenames, native cell spacing, valid-pixel shares and profile/map links.
- `/districts/pune`, `/districts/raigad`, `/districts/ratnagiri`, `/districts/satara`: individual introductions, source metadata, provenance, shared score bands, NoData and scientific limitations.
- Unknown identifiers display a district-unavailable page with a return link. Identifiers are exact lowercase catalog IDs; nested unknown paths use the site's 404 page.
- `/explore-map?district=pune` (and the other catalog IDs): open Map Explorer with an explicit district. The existing `/map` alias also accepts this query.

`src/districts/DistrictsPage.tsx` renders the overview and profiles. `src/districts/content.ts` contains editorial landscape introductions only. `src/districts/districts.css` provides scoped responsive styles. Routing, document titles and route focus are integrated in `src/App.tsx`. The catalog is bundled locally, so profiles need no asynchronous metadata request or account. Map resources keep their existing loading, unavailable and retry states.

## Metadata sources

`src/map/raster-catalog.json`, accessed through `districtCatalog` and `districtById` in `src/map/config.ts`, is the shared source for identifiers, labels, source filenames, native resolution, CRS, dimensions, valid counts/fractions, observed extrema, bounds, source tags and SHA-256 hashes. Profiles display the complete JavaScript decimal representations of the catalog extrema and valid fraction. Percentages are rounded to two decimal places and identified as rounded.

`src/map/color-scale.json` supplies the fixed 0–1 bands and colors, exactly as in Map Explorer. Editorial district descriptions contain no inferred statistics or evaluation metrics. The catalog was obtained by read-only inspection of `../ml/data/district_susceptibility/PRAHARI_*_250m_22pred_score.tif` using `scripts/geospatial/prepare_tiles.py`. Tests verify current catalog statistics and generated tiles against these originals.

## Updating dataset information

Do not hand-edit profile statistics or infer resolution from filenames. With the isolated geospatial environment described in `MAP_EXPLORER.md`:

```sh
cd frontend
npm run map:inspect
# Only when intentionally updating the validated checked-in metadata:
npm run map:inspect -- --write-catalog
# Regenerate local derived assets if approved source rasters have changed:
npm run map:tiles
npm run map:scores
```

Inspect the catalog diff and source hashes. A changed source requires corresponding visual and numerical manifests; existing parsers reject stale source hashes. Source inspection and these frontend generation tools do not change ML predictions. Generated assets stay in ignored `public/generated-data/` and must not be committed. Update editorial introductions only in `src/districts/content.ts`. If adding a study district, also review the existing map/geospatial allowlists and official district types; adding a public profile does not grant official access.

## Navigation and persistence

`districtMapURL` creates `/explore-map?district=<catalog-id>`. Map Explorer validates the query against the shared catalog. A valid explicit district takes precedence over the saved district and frames its catalog bounds even when a saved camera exists. The update retains other preferences (opacity, layers) and uses the existing persistence setter, debounce and flush lifecycle.

The query is applied once per router navigation, including changes while Map Explorer remains mounted. It does not continuously constrain the selector: later manual district and camera changes save normally. The query stays in the address bar, so reloading that explicit URL deliberately reapplies its district. Returning through `/explore-map` or `/map` without a district query restores the latest saved preferences. Invalid query IDs leave preferences intact and show an explanatory message. No auth/persistence schema, location inspection, tile or score lookup behavior is changed.

## Testing

```sh
cd frontend
npm run build
npm run test:districts
npm run test:map
npm run test:map-browser
npm run test:map:geo
npm run test:scores
npm run test:scores-browser
npm run test:scores:geo
npm run test:persistence
npm run test:persistence-browser
npm run test:permissions
npm run test:public-env
npm run test:bootstrap
npm run test:local-recovery
```

Browser suites launch the system Chromium (`CHROMIUM_PATH` can override `/usr/bin/chromium`) and local servers. The district suite builds an isolated production preview with auth disabled, uses the existing offline basemap fixture and checks all routes, exact catalog metadata, invalid IDs, profile/map links, URL priority over saved district/camera, normal autosave afterward, query changes on a mounted map, reload behavior, desktop/mobile automated WCAG AA, keyboard/focus behavior and overflow at 320, 390, 768, 1024 and 1440 px. Screenshots go to ignored `qa-results/`.

Map and score suites require real locally generated visual/numerical assets and golden samples, following `MAP_EXPLORER.md` and `LOCATION_INSPECTION.md`. The geospatial suites need rasterio/NumPy/Pillow in the isolated Python environment. Auth persistence tests mock Supabase transport; permission tests use isolated PostgreSQL. They do not contact a live Supabase project.

For public-site and unconfigured portal smoke checks, run `npm run dev` with public Supabase configuration unset, then in another terminal run `npm run verify:browser` and `npm run test:portal-browser` (or set `QA_BASE_URL` to a matching local preview).

Manual checks remain useful for screen-reader reading order, touch interaction, actual device rendering and deployed SPA deep-link fallback. Live basemap availability, invitation email delivery and configured live official sessions require their own integration environment; these tests do not establish those external services' health.

## Scientific limitations

- Scores are experimental, uncalibrated relative susceptibility outputs, not event probabilities, real-time forecasts, warning thresholds or a ranking of district risk.
- Valid raster coverage is `validPixels / (width × height)`: the share of valid pixels inside the source raster's rectangular extent. It is neither the share of a district covered nor the share at risk. Raster bounds are not administrative boundaries.
- Actual native cell spacing is 30 × 30 m in EPSG:32643, despite “250m” in filenames/model tags. Grid spacing does not prove effective predictor resolution or predictive accuracy at that scale.
- Observed extrema summarize valid raster cells only. Common fixed bands are not district-specific quantiles or evaluated risk classes.
- NoData sentinel −9999 represents excluded, missing or outside-coverage cells; it does not establish safety. Hidden overlays and loading errors are also not evidence of low susceptibility.
- Rainfall units are explicitly `UNVERIFIED` in source tags. The catalog provides no per-cell uncertainty estimates, calibration evidence or evaluation metrics. No such numbers are fabricated on these pages.
- Display colors are for interpretation; exact inspection reads original Float32 source cells. Field assessment, current authoritative guidance and local conditions remain necessary for decisions.
