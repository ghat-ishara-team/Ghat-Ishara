# GHAT ISHARA frontend

A React, TypeScript and Vite experimental landslide susceptibility platform for Pune, Raigad, Ratnagiri and Satara. Public pages include Home, the MapLibre Map Explorer with real static overlays and exact Float32 inspection, district profiles, Methodology and About. Public access requires no Supabase login. Official access is invitation-only and separately configured.

## Clone and run

Requires Node.js 22.12+ and npm 10+, Git, internet and repository access if private.

```bash
git clone --branch feature/website https://github.com/shiragave2omkar-hub/Ghat-Ishara.git
cd Ghat-Ishara/frontend
npm ci
npm run setup:maps
npm run dev
```

Open **http://127.0.0.1:5173/**. `feature/website` does not need to be merged into `main`. The published `maps-20261026` map asset is pinned by numeric asset ID and SHA-256. The activation changes must be present on the branch you clone; this task does not commit or push them. Setup downloads the public asset without a GitHub token, or reuses complete verified local data. See [CLONE_AND_RUN.md](CLONE_AND_RUN.md) for complete prerequisites, private-release access, optional LFS-download skipping, official-login limitations and troubleshooting.

Generated maps are ignored and distributed separately from code. No source TIFFs, models, Python GIS environment or training datasets are needed to run the public website. Scores are static, experimental and uncalibrated, not event probabilities or operational landslide warnings. Basemap resources require external OpenFreeMap access.

## Check and build

```bash
npm run map:preflight:source
npm run build
npm run preview
```

Build verifies map assets before Vite and validates the completed `dist/` afterward. Missing/corrupt maps fail the build. Local preview normally uses http://127.0.0.1:4173/.

## Distribution and tests

[MAP_RELEASE.md](MAP_RELEASE.md) documents deterministic public archive creation, SHA-256 pinning, safe extraction, tests and the publication checklist. `npm run package:maps` produces ignored local artifacts only; no script publishes a Release or deploys the site. `npm run test:maps-distribution` tests archives and installation in temporary directories.

Existing checks include `test:map`, `test:scores`, `test:map-browser`, `test:scores-browser`, `test:districts`, `test:methodology`, `test:about`, `test:persistence` and `test:persistence-browser`. Browser tests need system Chromium or `CHROMIUM_PATH`; automated checks do not replace manual accessibility and live-service verification.

See [MAP_EXPLORER.md](MAP_EXPLORER.md), [LOCATION_INSPECTION.md](LOCATION_INSPECTION.md), [DISTRICTS.md](DISTRICTS.md), [ABOUT.md](ABOUT.md), [OFFICIAL_PORTAL.md](OFFICIAL_PORTAL.md) and [ASSETS.md](ASSETS.md) for feature/configuration details and image/font credits. [MAP_HOSTING.md](MAP_HOSTING.md) retains the deferred Cloudflare preparation; no hosting or Supabase changes are needed for public local map setup.
