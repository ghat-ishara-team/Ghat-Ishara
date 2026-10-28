# Public map-data release preparation

**Status: local packaging and secure installation prepared; no GitHub Release published and no real fresh-clone download verified.** Current distribution is GitHub clone-and-run, not Cloudflare deployment. Teammate instructions: [CLONE_AND_RUN.md](CLONE_AND_RUN.md). The earlier [MAP_HOSTING.md](MAP_HOSTING.md) remains a deferred hosting option.

## Build the public archive

From `frontend/` with existing verified generated maps and installed dependencies:

```bash
npm run package:maps
npm run package:maps -- --verify release-output/ghat-ishara-public-maps-20261026.tar
npm run test:maps-distribution
npm run build
```

No upload occurs. The creator runs the existing read-only source preflight first. It packages **only** the exact 2,418 allowlisted paths in the two generated-data trees: 1,535 PNGs, 879 `.sct.gz` chunks, both canonical manifests and both timestamped reports. Paths inside the archive begin `susceptibility/` or `scores/`, relative to `public/generated-data/`. The 501 null numerical index entries intentionally have no chunk. There are no TIFFs, model binaries, CSV training data, credentials, official records or internal audit/research documents.

Output is ignored `frontend/release-output/`, outside public assets and tracked source. Do not `git add -f` it. Files are:

- `ghat-ishara-public-maps-20261026.tar`
- Matching `.tar.sha256` checksum and `.tar.json` inventory receipt (sidecars, not inside the archive).

The deterministic uncompressed USTAR archive avoids extra compression of PNG/gzip files and needs no new dependencies. Entries are ordered by relative path; mode 0644, zero UID/GID/mtime, empty owner names, canonical headers/padding and exactly two terminator blocks. The original payload bytes and existing build IDs are preserved. Packaging rechecks file hashes while reading and verifies the finished archive. Identical inputs produce the same SHA-256; differing existing outputs are refused rather than overwritten.

### Verified local candidate

| Item | Recorded value |
|---|---|
| Archive | `ghat-ishara-public-maps-20261026.tar` |
| Files | 2,418 |
| Archive bytes | 149,090,816 (142.18 MiB) |
| Original payload bytes | 147,279,495 |
| Archive SHA-256 | `0284ada2eb4bf68ac1ecff1aeaff7b898c3dfa3fb81d3b790bb90f137cdb576e` |
| Visual build | `20261026t193421624697z` |
| Numerical build | `20261026t213946834293z` |
| Pinned tree SHA-256 | `e063ee6a37ab4d8499cfa6d4f99f5fb60b89d9b50e5bd7223b3bc46805265fc6` |

This is a local candidate checksum, not evidence of an uploaded asset. Re-run packaging/verification before publication and compare the receipt. All scientific/source identity pins remain in [scripts/map-hosting/release.json](scripts/map-hosting/release.json); neither pins nor manifest identities are regenerated. The original [audit](MAP_HOSTING_AUDIT.md) established full source-cell fidelity. Distribution checks preserve those validated bytes; they do not re-evaluate the model or reopen source TIFFs.

## Configuration after approved upload

[scripts/map-distribution/github-release.json](scripts/map-distribution/github-release.json) deliberately contains **null** release fields. Do not fill them from guessed values. Record actual `releaseTag`, numeric `assetId`, exact `assetName`, `url`, `sha256` and `bytes` after publication. The repository is fixed to `shiragave2omkar-hub/Ghat-Ishara`. The URL must be the GitHub API asset endpoint for that actual numeric asset ID (`/repos/{owner}/{repo}/releases/assets/{asset_id}`); the downloader requests `application/octet-stream`. Do not use a `latest` endpoint or a mutable tag-based browser download URL.

The asset ID binds the request to a specific uploaded asset, and the pinned checksum binds its contents even if release metadata changes. Deleting/replacing the asset should fail setup until separately reviewed real details are pinned. Enable immutable releases where available under the repository's approved release process. GitHub documents [asset downloads](https://docs.github.com/en/rest/releases/assets#get-a-release-asset) and [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#immutable-releases).

## Extraction and download safeguards

- HTTPS API URL constrained to this repository and numeric asset ID; bounded manual redirects only to allowlisted GitHub asset CDN hosts. No cookies. Optional private-access token only on the initial API host, never forwarded to CDN or stored in output.
- Ten-minute download deadline, caller cancellation, pinned byte limit/length and SHA-256. Streamed to a private staging file, never directly into public map paths. No network occurs for an existing verified dataset or an unconfigured release on a clean clone.
- Strict bounded USTAR reader, 160 MiB archive cap, maximum 2,418 entries and 512 KiB per file. It rejects absolute/traversal/backslash paths, links of any kind, directories, PAX/GNU extensions, duplicate/unexpected/missing entries, bad headers, padding, truncation and extra trailers. It never invokes a shell extraction tool.
- Every entry's raw-byte digest contributes to the existing pinned tree fingerprint. Full archive verification precedes any extraction. Staging writes use exclusive creation/no-follow checks; directory symlinks and existing extraction roots are refused. Staging is private, on the same filesystem, outside `public/`.
- Extracted data passes existing PNG/gzip/header/source/grid/numerical checks plus all six exact references. The existing preflight runs on staging before a single rename exposes both complete trees; the installed tree is checked again.
- Existing complete assets are verified/reused. Existing incomplete/corrupt/unexpected data is preserved with recovery instructions. An exclusive setup lock prevents concurrent installers. Failure/normal interruption removes owned staging and lock; hard-crash recovery is documented in teammate instructions.

These filesystem protections assume a repository and parent directories controlled by the operator. They are not an OS security boundary against a malicious concurrent process running as the same user. Checksums protect against accidental corruption/substitution relative to trusted checked-in pins, not a compromised repository that changes code and pins together.

## Tests

`npm run test:maps-distribution` uses OS temporary directories and fake fetch responses only; there is no real release download or publication. Tests cover deterministic creation, pinned inventory/bytes, clean extraction and all district references, bad SHA-256, corruption/missing/unexpected/duplicate entries, malformed/traversal/link archives, network/HTTP/short/interrupted/cancelled downloads, safe redirects without token forwarding, clean atomic installation, reuse, preserved incomplete existing data and symlink refusal. Original local assets are verified again after negative tests. Existing map, score, browser and hosting suites remain available unchanged.

Implementation verification completed: **37 distribution tests passed**, deterministic archive creation and repeat creation passed, and an independent Python standard-library tar reader confirmed every payload digest and the archive checksum without extracting files. `npm run build` passed source and final-output preflights and TypeScript. Existing map/score unit and browser suites, Districts, Methodology, About, Home/navigation, persistence unit/browser, isolated permission checks, public-environment guards, unconfigured official-portal browser checks and all 27 hosting scenarios passed. Browser suites use local previews and controlled service fixtures; configured live Supabase, live basemap delivery and a real GitHub clean-clone download are still separate acceptance steps. The generated data and archive remain ignored by Git.

## Publication checklist — future authorized work

- [ ] Run package, archive verification, distribution tests, build and relevant map/score/browser regressions against the intended frontend revision.
- [ ] Confirm the public allowlist and permission to distribute these existing model-derived map assets. Review no official records, internal reports, models, training data or credentials are included.
- [ ] Record the **actual** filename, byte size and SHA-256 from the verified archive and retain its receipt with the frontend revision. Compare with the candidate above.
- [ ] Obtain explicit approval to publish these public assets. Nothing in packaging/setup creates a release or uploads files.
- [ ] Create an appropriately versioned GitHub Release in the specified repository under that approval. Record the real tag; do not rely on `latest`.
- [ ] Upload the exact verified archive. Download the uploaded asset independently and verify its size/SHA-256 against the local receipt. Record the real numeric asset ID and API asset URL. Sidecar checksums may be published for human verification but are not trusted dynamically by setup.
- [ ] Fill the actual release details in `github-release.json`; use the checksum from the independently verified archive, not an untrusted remote checksum file. Never add tokens or generated data to the configuration/Git.
- [ ] In a clean clone with no local generated files, run `npm ci`, `npm run setup:maps`, source preflight, build and applicable tests. Test the real GitHub request/redirect path and repository access. Confirm a second setup reuses verified data without downloading.
- [ ] Verify Pune, Raigad, Ratnagiri and Satara overlays in a real browser; inspect each exact reference recorded in `scripts/map-hosting/release.json` (nine significant digits round-trip to the same Float32). Check actual pointer inspection, valid zero, NoData, district links and unavailable states. Basemap access is a separate external dependency.
- [ ] Confirm public pages and autosave remain intact, unconfigured officer login remains honest, and no configured Supabase operation was required for public map setup.
- [ ] Only after real release details and acceptance exist, separately approve committing/pushing the setup configuration and documentation. Do not claim clone-and-run distribution is operational before that real clean-clone test.

If acceptance fails, stop distribution; preserve the working local map trees and receipts. Correct release delivery or restore the previous trusted asset/configuration through review. Do not relax checksums, change source predictions, overwrite build IDs or modify authentication to bypass a failed setup.
