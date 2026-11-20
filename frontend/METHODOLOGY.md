# Public Methodology page

`/methodology` is a public React route in `src/App.tsx`. It uses the shared site shell, navigation, fonts, focus handling and decorative landscape. The page itself is in `src/methodology/MethodologyPage.tsx`, with scoped styles in `methodology.css`.

## Evidence and updates

Read `METHODOLOGY_RESEARCH.md` before changing scientific claims. That internal audit separates the selected controlled 250 m experiment from earlier V1–V5 results and records missing provenance. It remains an internal document, not a bundled public download.

`src/methodology/evidence.ts` imports two small existing artifacts read-only:

- `../ml/data/controlled_250m_22pred_spatial_cv_results.csv`: recorded fold rows; unweighted means are calculated from these rows and formatted to six decimals.
- `../ml/results/final_model_evaluation.json`: historical reported test summary, kept separate from CV results and qualified as not fully independently reproducible.

Vite emits these two small files as hashed downloadable CSV/JSON assets. No models, training tables, source rasters or generated geospatial datasets are copied or distributed by this page. The page works without loading map assets or contacting Supabase. ML artifacts remain unchanged. A frontend build needs these two tracked source files, just as the repository supplies them.

Predictor groups and plain-language labels are maintained in `evidence.ts`; tests compare all 22 exact input names to the selected district inference script. Friendly labels must not imply verified formulas, data products, physical units or depth conventions beyond the audit evidence. Sample counts and public caveats come from the audit. District links, raster spacing and score bands reuse the shared map catalog/configuration.

Repository artifact paths in the Sources section identify evidence without inventing remote links or exposing local training inputs. Detailed unresolved sampling, leakage and provenance findings stay in the internal audit; consequential limitations remain visible on the public page.

## Verification

From `frontend/`:

```sh
npm run build
npm run test:methodology
npm run test:districts
npm run test:map
npm run test:map-browser
npm run test:scores
npm run test:scores-browser
npm run test:persistence
npm run test:persistence-browser
```

The methodology suite builds a production preview, uses system Chromium (`CHROMIUM_PATH` can override `/usr/bin/chromium`), disables Supabase, and uses the existing offline basemap fixture when testing map navigation. It verifies direct routing/reload, metadata and navigation, evidence-derived numbers, 22 predictor names, scientific caveats, historical-report separation, downloaded evidence bytes, keyboard disclosures, section anchors, five viewport widths, desktop/mobile automated WCAG AA, invalid child routes and map preference round trips. Screenshots and build artifacts remain in ignored `qa-results/`.

The existing public-site and unconfigured-portal smoke suites require a running local server with Supabase unset. Point `QA_BASE_URL` at the isolated `qa-results/methodology-dist` preview to avoid the developer's live environment. Existing persistence browser tests mock configured official sessions; no live authentication mutation is needed.

Automated tests do not establish scientific validity or replace screen-reader, physical-device and deployed deep-link checks. No training, raster generation, calibration or new model evaluation is part of this page's tests.
