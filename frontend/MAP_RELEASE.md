# Public map-data GitHub Release

**Status: the published `maps-20261026` asset is verified through GitHub CLI and pinned in the working-tree setup configuration. Real anonymous clean-checkout installation, reuse, build and browser exact-score acceptance have passed with the pending activation changes applied.** Current distribution is GitHub clone-and-run, not Cloudflare deployment. Teammate instructions: [CLONE_AND_RUN.md](CLONE_AND_RUN.md). The earlier [MAP_HOSTING.md](MAP_HOSTING.md) remains a deferred hosting option.

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

### Verified asset identity

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

GitHub CLI verified the published asset metadata on 28 October 2026: public repository, release ID `426846503`, tag `maps-20261026`, asset ID `685423078`, state `uploaded`, exact size and the `sha256:` digest above. [Release page](https://github.com/shiragave2omkar-hub/Ghat-Ishara/releases/tag/maps-20261026). The release is published as a **prerelease** and GitHub reports **`immutable: false`**. No release settings or assets were changed during activation. The setup security pin is the numeric asset ID plus the independently supplied SHA-256, not an assumption that the tag or release is immutable. All scientific/source identity pins remain in [scripts/map-hosting/release.json](scripts/map-hosting/release.json); neither pins nor manifest identities are regenerated. The original [audit](MAP_HOSTING_AUDIT.md) established full source-cell fidelity. Distribution checks preserve those validated bytes; they do not re-evaluate the model or reopen source TIFFs.

## Active download configuration

[scripts/map-distribution/github-release.json](scripts/map-distribution/github-release.json) now records the verified tag, numeric asset ID, filename, 149,090,816-byte size and pinned checksum. Its exact URL is [API asset 685423078](https://api.github.com/repos/shiragave2omkar-hub/Ghat-Ishara/releases/assets/685423078), as returned by GitHub CLI. The downloader requests `application/octet-stream`, follows bounded GitHub CDN redirects and verifies the full downloaded archive. It does not use `latest`, a tag-based browser-download URL, or a checksum fetched dynamically from the release.

The asset ID binds the request to a specific uploaded asset, and the pinned checksum binds its contents even if release metadata changes. Deleting/replacing the asset should fail setup until separately reviewed real details are pinned. Enable immutable releases where available under the repository's approved release process. GitHub documents [asset downloads](https://docs.github.com/en/rest/releases/assets#get-a-release-asset) and [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#immutable-releases).

## Extraction and download safeguards

- HTTPS API URL constrained to this repository and numeric asset ID; bounded manual redirects only to allowlisted GitHub asset CDN hosts. No cookies. Optional private-access token only on the initial API host, never forwarded to CDN or stored in output.
- One-hour total download deadline with progress messages approximately every 30 seconds while bytes arrive, caller cancellation, pinned byte limit/length and SHA-256. Streamed to a private staging file, never directly into public map paths. No network occurs for an existing verified dataset or an unconfigured release on a clean clone.
- Strict bounded USTAR reader, 160 MiB archive cap, maximum 2,418 entries and 512 KiB per file. It rejects absolute/traversal/backslash paths, links of any kind, directories, PAX/GNU extensions, duplicate/unexpected/missing entries, bad headers, padding, truncation and extra trailers. It never invokes a shell extraction tool.
- Setup first requests a 64 KiB byte range, verifies its exact `Content-Range` and length, then retrieves non-overlapping 1 MiB ranges with at most four concurrent requests. Encoded, truncated, mismatched or ignored later range responses fail; an initial HTTP 200 response that ignores Range falls back to the original full-stream path. The complete assembled file is hashed in byte order against the same pinned SHA-256 before extraction. Transient fetch failures or interrupted range bodies retry that exact range at most three times, overwriting only its private staging interval and resetting its progress count. Protocol/header errors and whole-file checksum failures never retry as valid data. A permanent failure cancels peers and normal setup cleanup removes owned staging.
- Every entry's raw-byte digest contributes to the existing pinned tree fingerprint. Full archive verification precedes any extraction. Staging writes use exclusive creation/no-follow checks; directory symlinks and existing extraction roots are refused. Staging is private, on the same filesystem, outside `public/`.
- Extracted data passes existing PNG/gzip/header/source/grid/numerical checks plus all six exact references. The existing preflight runs on staging before a single rename exposes both complete trees; the installed tree is checked again.
- Existing complete assets are verified/reused. Existing incomplete/corrupt/unexpected data is preserved with recovery instructions. An exclusive setup lock prevents concurrent installers. Failure/normal interruption removes owned staging and lock; hard-crash recovery is documented in teammate instructions.

These filesystem protections assume a repository and parent directories controlled by the operator. They are not an OS security boundary against a malicious concurrent process running as the same user. Checksums protect against accidental corruption/substitution relative to trusted checked-in pins, not a compromised repository that changes code and pins together.

## Tests

`npm run test:maps-distribution` uses OS temporary directories and fake fetch responses only; there is no real release download or publication. Tests cover deterministic creation, pinned inventory/bytes, clean extraction and all district references, bad SHA-256, corruption/missing/unexpected/duplicate entries, malformed/traversal/link archives, network/HTTP/short/interrupted/cancelled downloads, safe redirects without token forwarding, clean atomic installation, reuse, preserved incomplete existing data and symlink refusal. Original local assets are verified again after negative tests. Existing map, score, browser and hosting suites remain available unchanged.

Original preparation verification: **37 distribution tests passed**, deterministic archive creation and repeat creation passed, and an independent Python standard-library tar reader confirmed every payload digest and the archive checksum without extracting files. `npm run build` passed source and final-output preflights and TypeScript. Existing map/score unit and browser suites, Districts, Methodology, About, Home/navigation, persistence unit/browser, isolated permission checks, public-environment guards, unconfigured official-portal browser checks and all 27 hosting scenarios passed. Browser suites use local previews and controlled service fixtures; configured live Supabase and live basemap delivery remain separate acceptance steps. The activation-specific real download acceptance is recorded below. The generated data and archive remain ignored by Git.

## Activation verification

The updated installer passes **46 distribution tests**, including authenticated API/CDN range isolation, exact range coverage, bounded concurrency, interrupted-range retries, retry exhaustion, sanitized request errors, ignored-Range fallback, and rejection of malformed, truncated, encoded or corrupted ranges. `npm run map:preflight` and `npm run build` pass in the original working repository.

Metadata verification used these read-only commands (no tokens or response headers printed):

```bash
gh release view maps-20261026 --repo shiragave2omkar-hub/Ghat-Ishara --json tagName,isDraft,isPrerelease,url,assets
gh api repos/shiragave2omkar-hub/Ghat-Ishara --jq '{full_name,private,visibility}'
gh api repos/shiragave2omkar-hub/Ghat-Ishara/releases/tags/maps-20261026 --jq '{id,tag_name,draft,prerelease,immutable,published_at,assets:[.assets[]|{id,name,size,state,digest,url,browser_download_url}]}'
```

A real anonymous GitHub clone of `feature/website` at `f12d5fbea4b388b648109b8986c484d5a42e3273` was made in an isolated temporary directory with Git LFS smudging skipped. Only the pending activation configuration, setup script and test changes were applied; no local generated maps, environment files, archives or dependency directory were copied. `npm ci` completed successfully. The complete real public asset downloaded with `GH_TOKEN` and `GITHUB_TOKEN` absent, passed the exact 149,090,816-byte count and pinned SHA-256, then passed archive/manifest/source/tree/PNG/numerical checks before installation. A second `npm run setup:maps` reused the verified data without downloading or overwriting. `npm run build` passed in this checkout. A Chromium check against its actual Vite development server loaded real downloaded PNGs and numerical chunks for Pune, Raigad, Ratnagiri and Satara, and verified pointer plus Enter inspection against the exact native row/column and nine-significant-digit score in each district. All six stored source-cell references (including zero and NoData) also passed. Only the external OpenFreeMap basemap used the existing fixture; no susceptibility or score response was mocked, and there were no Supabase requests. No original TIFFs, local generated maps, model execution or geospatial regeneration were needed.

The transfer available during acceptance was unusually slow. A single-connection attempt reached 91% before its one-hour limit and left no installed maps or incomplete staging. An initial parallel attempt then exposed an independently closed CDN stream; the installer now retries interrupted individual ranges up to three times instead of discarding other completed ranges on the first transient error. Setup verifies and uses bounded parallel byte ranges when available, retains the HTTP 200 single-stream fallback, allows a bounded hour, and reports received MiB/percentage approximately every 30 seconds while receiving data. The size cap, expected byte count, SHA-256, inventory, source identities, PNG/chunk validation and extraction checks remain enforced. A deliberately interrupted real transfer cleaned its partial download, staging and lock without installing public data.

The public repository/release requires no GitHub token. Private-repository access remains supported via shell-only `GH_TOKEN` or `GITHUB_TOKEN`; the Node downloader does not automatically read `gh auth login` credentials. Tokens are sent only to the pinned GitHub API host, never a CDN redirect or CDN range request. No private-repository integration test or live Supabase operation was performed.

## Release discipline and remaining source publication

- [x] Verify the real published tag, public visibility, asset ID, filename, byte size, upload state and digest through GitHub CLI.
- [x] Pin the verified API asset URL and the maintainer-supplied checksum in the working-tree configuration.
- [x] Keep negative tests independent of the now-configured release, and test the actual pin plus anonymous requests and private-token redirect isolation.
- [x] Complete real clean-checkout installation, repeat-setup reuse, build and browser exact-score acceptance with the pending activation changes applied.
- [ ] After review, the maintainer must separately commit/push the activation changes to `feature/website` before teammates cloning that remote branch receive them. **No commit or push is performed in this task.** The remote revision used for acceptance still has the old unset configuration; acceptance applies the pending activation changes explicitly.

For a future data release: obtain publication approval, package/verify only the public allowlist, record the actual bytes/checksum, upload without overwriting existing build identities, verify the published asset independently, review new pins, then repeat clean-checkout acceptance. Do not change existing maps or relax validation to make a failed release pass. Preserve the previous trusted configuration/assets for rollback; authentication is not part of a map-data rollback.
