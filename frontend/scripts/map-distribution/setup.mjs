import assert from 'node:assert/strict'
import { open, readFile, mkdtemp, mkdir, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { frontend, inspectAssets } from '../map-hosting/assets.mjs'
import { preflight } from '../map-hosting/preflight.mjs'
import { archiveName, MAX_ARCHIVE, exists, realDirectories, verifyArchive, fileDigest } from './archive.mjs'

export function validateConfig(config) {
  assert.ok(config?.repository === 'shiragave2omkar-hub/Ghat-Ishara' && typeof config.releaseTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.releaseTag) && !/latest/i.test(config.releaseTag) && Number.isSafeInteger(config.assetId) && config.assetId > 0 && config.assetName === archiveName && /^[a-f0-9]{64}$/.test(config.sha256 ?? '') && Number.isSafeInteger(config.bytes) && config.bytes >= 1024 && config.bytes <= MAX_ARCHIVE && config.url === `https://api.github.com/repos/${config.repository}/releases/assets/${config.assetId}`, 'Map release is not configured. An approved GitHub Release must be published first; fill scripts/map-distribution/github-release.json with its actual tag, asset ID, asset name, API asset URL, byte size and SHA-256. See MAP_RELEASE.md. No unverified download was attempted.')
  return config
}
const CDN = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
// Requests are bound to the pinned asset; range responses never weaken archive checks.
const RANGE_BYTES = 1024 * 1024
const RANGE_CONCURRENCY = 4
export async function download(config, destination, { fetchImpl = fetch, signal, token, log = () => {} } = {}) {
  validateConfig(config)
  const failedRequest = new AbortController()
  const combined = AbortSignal.any([AbortSignal.timeout(60 * 60 * 1000), failedRequest.signal, ...(signal ? [signal] : [])])
  let file; let total = 0; let lastProgress = Date.now()
  async function request(input, range) {
    let url = new URL(input)
    for (let redirects = 0; redirects <= 5; redirects++) {
      combined.throwIfAborted()
      let response
      try { response = await fetchImpl(url.href, { redirect: 'manual', credentials: 'omit', signal: combined, headers: {
        Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'X-GitHub-Api-Version': '2022-11-28', Range: range,
        ...(url.hostname === 'api.github.com' && token ? { Authorization: `Bearer ${token}` } : {}),
      } }) } catch (error) {
        combined.throwIfAborted()
        const failure = new Error('GitHub asset network failure. Check your connection and repository access.')
        failure.rangeRetryable = error instanceof TypeError
        throw failure
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        assert.ok(redirects < 5, 'Too many download redirects')
        const next = new URL(response.headers.get('location'), url)
        assert.ok(next.protocol === 'https:' && !next.username && !next.password && !next.hash && !next.port && CDN.has(next.hostname), 'Unsafe download redirect')
        url = next; continue
      }
      return { response, url: url.href }
    }
  }
  async function receive(response, start, end, ranged) {
    let received = 0
    try {
      assert.equal(response.status, ranged ? 206 : 200, `GitHub asset download returned HTTP ${response.status}. Check release publication and repository access; for private assets set GH_TOKEN in your shell (never a VITE_ variable).`)
      const expected = end - start + 1
      if (ranged) {
        assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${config.bytes}`, 'Unexpected download Content-Range')
        assert.ok([null, 'identity'].includes(response.headers.get('content-encoding')), 'Encoded byte ranges are not supported')
      } else assert.equal(response.headers.get('content-range'), null, 'Unexpected partial response')
      const length = response.headers.get('content-length')
      if (length !== null) assert.equal(length, String(expected), 'Incomplete or unexpected download length')
      assert.ok(response.body, 'Empty download response')
      for await (const chunk of response.body) {
        combined.throwIfAborted()
        assert.ok(received + chunk.length <= expected && total + chunk.length <= config.bytes, 'Download exceeds pinned byte size')
        let offset = 0
        while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset, start + received + offset)).bytesWritten
        received += chunk.length; total += chunk.length
        if (Date.now() - lastProgress >= 30000 || total === config.bytes) {
          log(`Downloaded ${(total / 1048576).toFixed(1)} / ${(config.bytes / 1048576).toFixed(1)} MiB (${Math.floor(total / config.bytes * 100)}%).`)
          lastProgress = Date.now()
        }
      }
      combined.throwIfAborted()
      assert.equal(received, expected, 'Incomplete download; nothing installed')
    } catch (error) {
      total -= received
      await response.body?.cancel().catch(() => {})
      if (ranged && !combined.aborted && (error instanceof TypeError || error.message.includes('Incomplete download; nothing installed'))) error.rangeRetryable = true
      throw error
    }
  }
  async function receiveRange(input, start, end, probe = false) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      combined.throwIfAborted()
      try {
        const part = await request(input, `bytes=${start}-${end}`)
        const ranged = !probe || part.response.status !== 200
        await receive(part.response, start, ranged ? end : config.bytes - 1, ranged)
        return { url: part.url, ranged }
      } catch (error) {
        if (!error.rangeRetryable || combined.aborted || attempt === 3) throw error
        log(`Retrying interrupted archive range (attempt ${attempt + 1} of 3).`)
        await new Promise(resolve => setTimeout(resolve, attempt * 250))
      }
    }
  }
  try {
    const firstEnd = Math.min(64 * 1024, config.bytes) - 1
    // The installer owns this private staging file; no existing destination is overwritten.
    file = await open(destination, 'wx', 0o600)
    // An initial HTTP 200 falls back to the original full-stream path.
    const first = await receiveRange(config.url, 0, firstEnd, true)
    if (first.ranged) {
      log('Byte ranges verified; continuing with at most four concurrent requests.')
      let next = firstEnd + 1; let failure
      await Promise.all(Array.from({ length: RANGE_CONCURRENCY }, async () => {
        try {
          while (next < config.bytes && !failure) {
            const start = next; const end = Math.min(config.bytes - 1, start + RANGE_BYTES - 1); next = end + 1
            await receiveRange(first.url, start, end)
          }
        } catch (error) { failure ??= error; failedRequest.abort(error) }
      }))
      if (failure) throw failure
    }
    combined.throwIfAborted()
    assert.equal(total, config.bytes, 'Incomplete download; nothing installed')
    await file.sync()
    // Hash the complete assembled file in byte order, including all range boundaries.
    const completed = await fileDigest(destination)
    assert.equal(completed.bytes, config.bytes, 'Incomplete download file')
    assert.equal(completed.sha256, config.sha256, 'Archive SHA-256 mismatch; nothing installed')
    combined.throwIfAborted()
  } finally { await file?.close() }
}

export async function setupMaps({ publicDir = path.join(frontend, 'public'), config, fetchImpl, signal, token, log = console.log } = {}) {
  await realDirectories(publicDir)
  const target = path.join(publicDir, 'generated-data')
  if (await exists(target)) {
    try {
      await preflight({ publicDir, sourceOnly: true, log })
      log('Existing public map assets are complete and verified; reused without downloading or overwriting.'); return 'reused'
    } catch (error) {
      throw new Error(`Existing generated-data is incomplete, corrupt or unsafe; left untouched. ${error.message}\nPreserve it by moving it outside public/ yourself, then retry setup. See CLONE_AND_RUN.md.`)
    }
  }
  validateConfig(config)
  const parent = path.dirname(publicDir)
  const lockPath = path.join(parent, '.map-setup.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another setup may be running (.map-setup.lock). If interrupted, confirm it has stopped before manually removing the lock; see CLONE_AND_RUN.md.')
    throw error
  }
  let staging
  try {
    assert.ok(!(await exists(target)), 'Map data appeared during setup; existing files left untouched')
    staging = await mkdtemp(path.join(parent, '.map-setup-'))
    const archive = path.join(staging, 'download.partial')
    log('Downloading the pinned public map archive from its approved GitHub asset ID…')
    await download(config, archive, { fetchImpl, signal, token, log })
    const stagePublic = path.join(staging, 'public'); await mkdir(stagePublic, { mode: 0o700 })
    await verifyArchive(archive, { expectedSha256: config.sha256, extractPublicDir: stagePublic })
    // Read-only original preflight against the staged maps plus existing static hosting files.
    const { copyFile } = await import('node:fs/promises')
    for (const name of ['_headers', '_redirects', '404.html']) await copyFile(path.join(publicDir, name), path.join(stagePublic, name))
    await preflight({ publicDir: stagePublic, sourceOnly: true, log })
    signal?.throwIfAborted()
    await realDirectories(publicDir)
    assert.ok(!(await exists(target)), 'Map data appeared during setup; existing files left untouched')
    // One rename on the same filesystem exposes both complete trees together.
    await rename(path.join(stagePublic, 'generated-data'), target)
    await inspectAssets(publicDir)
    log('Installed and verified all four districts: 1,535 PNG tiles and 879 original Float32 chunks.'); return 'installed'
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }) }
    finally { await lock.close(); await unlink(lockPath) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Map setup interrupted; incomplete temporary download will be removed'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    assert.equal(process.argv.length, 2, 'Usage: npm run setup:maps (release settings come only from the reviewed configuration)')
    const config = JSON.parse(await readFile(new URL('./github-release.json', import.meta.url), 'utf8'))
    await setupMaps({ config, signal: controller.signal, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN })
  } catch (error) { console.error(`Map setup FAILED: ${error.message}`); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
