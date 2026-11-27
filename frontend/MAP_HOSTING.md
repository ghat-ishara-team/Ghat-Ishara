# Prepare a Cloudflare Pages Direct Upload release

**Cloudflare deployment is deferred.** The current plan is GitHub clone-and-run distribution; follow [CLONE_AND_RUN.md](CLONE_AND_RUN.md) and [MAP_RELEASE.md](MAP_RELEASE.md). `npm run setup:maps` uses the verified `maps-20261026` release pinned in the activation configuration, or reuses an existing verified map dataset. The activation changes must reach the branch teammates clone before that remote checkout uses the new pin. This document retains the previously prepared hosting option; no deployment is performed by setup.

This is deployment preparation, not deployment. The existing local static datasets stay at the same website origin and keep their audited bytes, manifests and paths. No Wrangler dependency, Cloudflare account binding, upload, R2/Supabase Storage, map API, retraining or asset generation is included.

Read [MAP_HOSTING_AUDIT.md](MAP_HOSTING_AUDIT.md) for the original read-only inventory, fidelity verification and risks. Phase 2 adds fail-closed release checks, static Pages files and a future-host verifier. Runtime map/score lookup and official authentication code are unchanged.

## Asset staging and build

Generated assets and `dist/` remain ignored by Git. Before building from a fresh checkout, restore the **existing, reviewed asset artifact** into `frontend/public/generated-data/`, preserving these complete trees:

```text
susceptibility/manifest.json
susceptibility/20261026t193421624697z.json
susceptibility/20261026t193421624697z/<district>/<z>/<x>/<y>.png
scores/manifest.json
scores/20261026t213946834293z.json
scores/20261026t213946834293z/<district>/<row>/<column>.sct.gz
```

Do not substitute LFS pointers or original TIFFs for the packaged web assets. No source rasters or Python GIS dependencies are needed for this release build. No command below regenerates tiles. Missing files must be restored from the same verified artifact, not silently replaced with new data.

From `frontend/`, using existing installed dependencies:

```sh
npm run map:preflight:source
npm run build
npm run map:preflight
npm run test:map-hosting
```

`npm run build` now runs source preflight, TypeScript, Vite and final-output preflight in that order. Any failure exits nonzero. Direct `vite build` calls bypass these npm guards and are not the release procedure. An old `dist/` can remain on disk after a failed source check; it is not a successful new release and must not be uploaded as one.

### What preflight proves

[release.json](scripts/map-hosting/release.json) pins the two canonical manifest digests/build IDs, catalog digest, expected PNG grid ranges, counts/bytes, whole generated-tree fingerprint and six audited source-cell references. It is small verification metadata, not a generated dataset. A different valid asset generation is deliberately rejected until separately reviewed; do not automatically rewrite pins to make a failed check pass.

The read-only checker verifies:

- Both canonical manifests and matching timestamped reports; exactly four unique districts; agreement with the checked-in source hashes, affine/grid metadata, color scale and current path format.
- Exactly 1,535 required PNG paths and 879 non-null numerical paths, with no unexpected generated files. The 501 null index entries intentionally have no file.
- PNG structure, CRCs, 256 × 256 RGBA format and bounded decompression; numerical gzip sizes, decoded SHA-256, header/window alignment and valid Float32/NoData values.
- A whole-tree SHA-256 over sorted relative-path strings, NUL, file SHA-256 and newline. This catches even a structurally valid re-encoding or changed PNG not covered by a per-file manifest hash. Existing payloads are never rewritten.
- Final `dist/generated-data/` contains precisely the same paths and bytes; all ordinary public assets and Pages files were copied unchanged; the app shell, referenced bundle files, styles and MapLibre worker exist; file count and per-file size fit the configured Pages limits; obvious private/source files and symlinks are rejected.

The audited map data remains **2,418 files / 147,279,495 bytes (140.46 MiB)**. The final site now adds three small Pages files to the previous inventory, giving **2,450 files**, roughly 144 MiB total. Keep an archive of the complete release plus its pins/revision for rollback; do not deploy `qa-results/`, repository internals, environment files, source ML data or official records.

Preflight binds this release to the previous audit's source-fidelity verification. It intentionally does not run ML, regenerate assets, or reopen original TIFFs. It does not establish scientific accuracy or authenticate a compromised host. The local release pins must be trusted.

## Static Pages routing

- [public/_redirects](public/_redirects) rewrites **only** application paths to `/index.html`: `/map`, `/explore-map`, `/districts` and children, `/methodology`, `/about`, `/official` and children. Canonical/trailing-slash public paths are covered.
- [public/404.html](public/404.html) disables Cloudflare's automatic SPA catch-all and supplies a small, accessible static error document. Missing `/generated-data/*`, missing bundle files and unrelated unknown direct paths therefore return genuine HTTP 404 rather than HTTP 200 app HTML. Unknown district/official children still reach the existing React router through their explicit rewrite. An unrelated unknown URL opened directly gets the static 404 with a home link; client-side unknown-route handling remains unchanged.
- Never add `/* /index.html 200`, a generated-data rewrite, an asset proxy, or a blanket HTML fallback. Never remove the top-level 404 file. No Pages Functions or worker is required.

These are supported Pages mechanisms: [routing/404 behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/), [rewrite syntax](https://developers.cloudflare.com/pages/configuration/redirects/). Actual edge behavior still needs the future hosted verification; a local server model is not the Cloudflare runtime.

## MIME, encoding and caching

[public/_headers](public/_headers) configures static responses without changing Auth/CSP settings:

| Resource | Expected content type | Cache / transformation contract |
|---|---|---|
| Canonical manifests | `application/json` | `public, max-age=0, must-revalidate, no-transform` |
| Timestamped PNGs | `image/png` | Same conservative revalidation policy; no lossy optimization/conversion |
| Timestamped `.sct.gz` | `application/octet-stream` | Same policy; stored gzip bytes, no manually added HTTP `Content-Encoding` |
| Timestamped report JSON | Host's `application/json` mapping | Same map-data policy |
| `index.html` | `text/html` | `no-cache` |
| `404.html` | `text/html` | `no-store`; data misses must not be treated as immutable successes |

All generated-data responses also have `X-Content-Type-Options: nosniff`. The first demonstration deliberately **revalidates versioned map data too**, rather than assigning a year-long immutable policy to paths that could include failed requests. Browsers may retain data and revalidate it; this is not `no-store` for successful map files. Optimize immutable caching only in a later reviewed policy that correctly separates successful assets from errors. This is an intentional conservative refinement of the audit's suggested long-lived caching.

There is no fabricated CORS policy, credential forwarding, image resizing or numerical re-encoding. Keep the entire `dist/` on one HTTPS origin. Do not enable provider image optimization or binary transformations for these paths. Header definitions are non-overlapping for cache control; do not combine incompatible wildcard rules. [Pages header configuration](https://developers.cloudflare.com/pages/configuration/headers/).

The `.gz` filename denotes the stored data representation. Do not add `Content-Encoding: gzip` to arbitrary responses or compress an already gzipped file while falsely labeling the body. The existing browser decoder and verifier accept either the stored gzip bytes or a correctly HTTP-decoded `GHATSCR1` payload; both must produce the pinned decoded hash. Incorrect encoding and SPA HTML fail validation. No range requests or Supabase credentials are needed.

## Verify a future hosted URL

No hosted origin was supplied or contacted as part of this preparation. Once a preview upload is separately authorized, run:

```sh
cd frontend
npm run verify:map-hosted -- https://YOUR-PREVIEW.pages.dev
# Full dataset acceptance: roughly 140 MiB over the network, four concurrent GETs.
npm run verify:map-hosted -- https://YOUR-PREVIEW.pages.dev --all-assets
# Real UI pointer and Enter inspection with existing system Chromium:
npm run verify:map-hosted -- https://YOUR-PREVIEW.pages.dev --browser
# Both checks can be combined:
npm run verify:map-hosted -- https://YOUR-PREVIEW.pages.dev --all-assets --browser
```

This is a read-only GET/browser verifier: no cloud credentials, writes, login, official API mutation or asset upload. It accepts root HTTPS origins; plain HTTP is allowed only on loopback for tests. Credentialed URLs, query/fragment inputs and subpath origins are rejected; HTTP asset redirects are rejected rather than following another storage origin. `CHROMIUM_PATH` may override `/usr/bin/chromium` for browser mode.

Default checks cover both manifests against the pinned release, real PNG responses for every district, six exact numerical references (four valid district cases, Pune valid zero and NoData), all listed application deep links, MIME/cache/encoding, and five deliberate missing-data requests. Numerical checks project the actual reference coordinates, check the source row/column, decode the native chunk, validate its hash and compare exact Float32 values. Nine-significant-digit display values must round-trip to the same Float32.

`--all-assets` additionally requires the local pinned generated asset set and verifies every hosted file, comparing PNG/JSON bytes and decoded numerical hashes. It stops scheduling new requests after a failure. `--browser` uses a fresh local test browser profile, seeds only public map camera preferences, then performs actual pointer clicks and Enter inspection in each district. It does not mock transport or submit official forms. External basemap services may also receive the map's ordinary requests. The verifier does not replace a manual basemap-availability check or live Auth integration review.

Reference values and source-cell coordinates are recorded in `release.json` and explained in the audit. New dataset versions require a separate review; the script intentionally rejects a deployment with different manifests even if it happens to render.

## Manual Direct Upload — instructions only, NOT executed

Do not run the following until upload/deployment is authorized. Wrangler was not installed, invoked or connected to an account in this task. An operator must already have an approved Wrangler installation/account/project; account setup is outside this preparation. Use the operator's secure credential mechanism, never a `VITE_` variable or public file.

1. Restore the audited local assets, use the intended public frontend environment, and run the full build/preflight above. Keep the build output and pins together. Check the project targets the intended existing origin; new origins may need a separate official-auth origin review without changing it in the map task.
2. Confirm a Pages **Direct Upload** project and its configured production-branch name. Choose a preview deployment label that does not equal that production branch. Avoid dashboard drag-and-drop: the site exceeds its 1,000-file limit. Wrangler's documented 20,000-file / 25 MiB-per-file limits fit this release. [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).
3. From `frontend/`, after authorization, manually upload the **complete** `dist/` directory:

   ```sh
   # MANUAL PUBLICATION ACTION — not part of npm build or preflight.
   wrangler pages deploy dist --project-name YOUR_APPROVED_PROJECT --branch YOUR_PREVIEW_LABEL
   ```

   Do not substitute `public/`, the repository root or a PNG-only directory. Do not run an implicit `npx` installation. The command publishes a deployment; it was not run here.
4. Run the real hosted verifier against the returned HTTPS preview origin, including exhaustive and browser modes. Check anonymous overlays/scores, deep links, missing data, caching, mobile layout, workers and basemap attribution. Static 404 responses must have error status; HTML error documents are acceptable, the application shell is not.
5. Promote or publish to the approved production target only after acceptance and separate authorization. Before any production upload, rerun preflight on the exact artifact being uploaded. A bare Wrangler command cannot enforce our npm checks automatically; operators must not skip them.

## Tests and boundaries

```sh
npm run test:map-hosting
npm run test:map
npm run test:map-browser
npm run test:scores
npm run test:scores-browser
npm run test:districts
npm run test:methodology
npm run test:about
npm run test:persistence
npm run test:persistence-browser
```

`test:map-hosting` requires the completed production build. It first validates original public/output assets read-only, then changes only test-owned copies under an OS temporary directory. Negative cases cover missing/corrupt PNGs/chunks/manifests, wrong source identity, unexpected files, incomplete final output and bad rewrites. A local HTTP fixture applies the committed redirect/header rules and tests the hosted verifier, including full inventory, genuine 404s, stale/HTML/wrong-MIME/corrupt responses, correct HTTP gzip and real browser score inspection. Temporary copies are cleaned up; original assets are checked again afterward.

The fixture is an explicit local model, **not Wrangler or the Cloudflare edge runtime**. It does not prove the provider's actual header/redirect/cache behavior. `vite preview` also does not apply Pages `_headers`/`_redirects`; use existing frontend suites for app regression and the dedicated fixture for local hosting-contract tests. Real preview acceptance remains required after an authorized upload. There is no deployment command in an npm script.

## Rollback and release discipline

Keep a complete previous deployment artifact, its frontend revision and compatible map manifests/pins. If preview checks fail, do not promote. If a production release later fails, restore the previous complete Pages deployment; do not edit model predictions, relax hash checks, disable Auth or overwrite an immutable build directory as a fix.

Retain prior timestamped assets where open clients may still reference them. This release intentionally pins one existing visual and one numerical build and rejects extras, so a future multi-version retention release needs a deliberate pin/preflight update; do not silently append old builds to bypass checks. No old assets were deleted here.

After any rollback, verify both manifests and one exact reference per district again. Do not purge/delete data or change Supabase settings during rollback without separate authorization.
