# Clone and run GHAT ISHARA

The public website runs locally with real, static susceptibility overlays and original Float32 score inspection for Pune, Raigad, Ratnagiri and Satara. The published [`maps-20261026` release](https://github.com/shiragave2omkar-hub/Ghat-Ishara/releases/tag/maps-20261026) is pinned by numeric asset ID, exact byte size and SHA-256 in the activation configuration. Setup never downloads an unverified substitute. **These activation changes must be present on the branch you clone:** this task does not commit or push them. A real anonymous clone, with these pending activation changes applied, passed dependency installation, map download, verified reuse, build and all four districts' browser score checks; see [MAP_RELEASE.md](MAP_RELEASE.md) for its verification record.

## Prerequisites

- Node.js **22.12.0 or later** and npm **10 or later** (lockfile version 3); use a supported Node LTS release meeting that requirement. Implementation was tested with Node 25.9.0 / npm 11.12.1.
- Git and access to `shiragave2omkar-hub/Ghat-Ishara` if private.
- Internet for `npm ci`, the one-time map archive download, and the external OpenFreeMap basemap. The maps are local after setup; this is not a fully offline basemap application.
- Approximately 150 MB download; allow at least **600 MB free for map download, staging and build copies**, plus dependencies. Chromium is needed only for browser tests, not normal use.

The website branch does **not** need to be merged into `main`. These commands use `feature/website` directly:

```bash
git clone --branch feature/website https://github.com/shiragave2omkar-hub/Ghat-Ishara.git
cd Ghat-Ishara/frontend
npm ci
npm run setup:maps
npm run dev
```

Open **http://127.0.0.1:5173/**. If the port is occupied, Vite may print a different address. Use a modern browser supporting WebGL, Web Crypto and gzip DecompressionStream. GitHub hosts the download; susceptibility files and scores are subsequently served from the same local Vite origin, with no map API or Supabase Storage.

Original ML rasters/predictors/models are not required. If Git LFS is installed, an ordinary clone may download large original source files tracked by the repository. To skip these unnecessary LFS downloads, optionally prefix the clone command with `GIT_LFS_SKIP_SMUDGE=1` (bash). This does not replace `setup:maps`.

The verified repository and release are currently public, so no GitHub token or GitHub CLI installation is needed to run setup. If access later becomes private, make a GitHub access token available as `GH_TOKEN` (or `GITHUB_TOKEN`) through your secure shell environment, with access to the release repository. Never put it in frontend `.env` files, a `VITE_` variable, the JSON configuration, command output or Git. The downloader sends it only to GitHub's API, never to redirected asset CDN hosts. Repository Git access and API token access are separate; `gh auth login` alone does not configure the Node downloader. No token is needed for a public release.

## What setup verifies

The two ignored sibling directories are installed together:

```text
public/generated-data/susceptibility/  # 1,535 PNG tiles + 2 JSON metadata files
public/generated-data/scores/          # 879 gzip Float32 chunks + 2 JSON metadata files
```

The approved archive has fixed paths/build IDs and unchanged bytes. Setup downloads verified byte ranges with at most four concurrent requests when supported (or one full stream when ranges are ignored). It checks the complete archive's pinned SHA-256 and byte length, strict regular-file archive structure, both pinned manifests, exact file inventory and whole-tree fingerprint. Before installation, the existing map preflight checks every PNG and numerical chunk, source hashes and four districts. All six stored exact-score references are checked, including one per district, valid zero and NoData. Only then is the complete directory installed. It does not run Python, ML inference or a map generator.

Running setup again validates and reuses complete existing data without downloading or rewriting it. Incomplete/corrupt/unexpected existing data is **preserved and refused**, not automatically repaired or deleted. This prevents a download failure from damaging working files.

## Public access and limitations

The public Home, Map Explorer (`/explore-map`), Districts, Methodology and About pages require no Supabase authentication. Scores are static, experimental, uncalibrated relative susceptibility scores, not event probabilities or real-time landslide warnings. This is not an operational warning system.

Official login is invitation-only and needs separately configured Supabase Auth/database/Edge services and approved public frontend configuration. A fresh clone without those services shows the existing unconfigured official-login state; it cannot create accounts or simulate a successful official session. See [OFFICIAL_PORTAL.md](OFFICIAL_PORTAL.md). No authentication changes are part of map setup.

## Checks and troubleshooting

```bash
npm run map:preflight:source
npm run build
npm run map:preflight
npm run test:maps-distribution
npm run test:map
npm run test:scores
```

- **Release not configured:** your checkout may predate the activation changes, or the reviewed configuration is missing/invalid. Ask the maintainer for the branch containing the activation changes; see [MAP_RELEASE.md](MAP_RELEASE.md). Do not invent a URL/checksum or bypass verification.
- **Slow connection:** setup reports received MiB/percentage approximately every 30 seconds while data arrives, with a one-hour total deadline for the 149 MB archive. It validates the entire file before installation; interrupted retries start over.
- **HTTP 401/403/404 or download failure:** check internet, actual release publication, repository permissions and token access. Retry setup after resolving access. Transient interruptions of individual ranges retry up to three times during the same transfer. A failed or cancelled setup removes its owned temporary data; rerunning starts a new verified download rather than trusting an unknown partial file.
- **Checksum/length/integrity mismatch:** stop; do not update pins to fit the failed download. The maintainer must compare the published asset to the independently verified local archive. No new map data is installed.
- **Existing incomplete map data:** stop Vite. Preserve the entire `frontend/public/generated-data` by moving it to a backup directory **outside `public/`**, then rerun setup using the verified release configuration. Do not merge old and new assets, regenerate chunks or remove source ML files. Moving it back restores the old state if needed.
- **Interrupted setup:** normal errors, SIGINT and SIGTERM remove owned temporary downloads/staging and the setup lock. SIGKILL, power loss or a crash can leave `frontend/.map-setup-*` and `.map-setup.lock`. Confirm no setup is running before manually removing only those stale ignored items. Never remove `public/generated-data` as cleanup. There is no automatic deletion of unknown stale directories.
- **Missing overlays or unavailable scores:** run source preflight; both sibling trees are needed. Numerical null-index entries mean NoData and intentionally have no file. An unavailable fetch is not a score of zero. If preflight passes, inspect browser network errors and WebGL support; external basemap connectivity is separate.
- **Build failure:** use the required Node/npm versions, run `npm ci` from `frontend/`, then setup and preflight. `npm run build` deliberately fails when maps are missing; direct `vite build` bypasses that protection. Read the first reported failure. Never copy environment secrets into `public/`.
- **Local lock or filesystem error:** setup needs write permission to frontend staging and public directories on the same filesystem. Directory symlinks are deliberately rejected. Do not run simultaneous setup operations.

Existing browser checks (`test:map-browser`, `test:scores-browser`, `test:districts`, `test:methodology`, `test:about`, `test:persistence-browser`) require a system Chromium at `/usr/bin/chromium`, or `CHROMIUM_PATH`. They use isolated builds and controlled external-service fixtures. Real basemap and configured Supabase acceptance remain separate manual checks.
