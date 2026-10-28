import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open, readFile, mkdtemp, mkdir, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { frontend, inspectAssets } from '../map-hosting/assets.mjs'
import { preflight } from '../map-hosting/preflight.mjs'
import { archiveName, MAX_ARCHIVE, exists, realDirectories, verifyArchive } from './archive.mjs'

export function validateConfig(config) {
  assert.ok(config?.repository === 'shiragave2omkar-hub/Ghat-Ishara' && typeof config.releaseTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.releaseTag) && !/latest/i.test(config.releaseTag) && Number.isSafeInteger(config.assetId) && config.assetId > 0 && config.assetName === archiveName && /^[a-f0-9]{64}$/.test(config.sha256 ?? '') && Number.isSafeInteger(config.bytes) && config.bytes >= 1024 && config.bytes <= MAX_ARCHIVE && config.url === `https://api.github.com/repos/${config.repository}/releases/assets/${config.assetId}`, 'Map release is not configured. An approved GitHub Release must be published first; fill scripts/map-distribution/github-release.json with its actual tag, asset ID, asset name, API asset URL, byte size and SHA-256. See MAP_RELEASE.md. No unverified download was attempted.')
  return config
}
const CDN = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
export async function download(config, destination, { fetchImpl = fetch, signal, token } = {}) {
  validateConfig(config)
  const timeout = AbortSignal.timeout(10 * 60 * 1000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let url = new URL(config.url); let response
  for (let redirects = 0; redirects <= 5; redirects++) {
    combined.throwIfAborted()
    response = await fetchImpl(url.href, { redirect: 'manual', credentials: 'omit', signal: combined, headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'X-GitHub-Api-Version': '2022-11-28', ...(url.hostname === 'api.github.com' && token ? { Authorization: `Bearer ${token}` } : {}) } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      assert.ok(redirects < 5, 'Too many download redirects')
      const next = new URL(response.headers.get('location'), url)
      assert.ok(next.protocol === 'https:' && !next.username && !next.password && !next.hash && !next.port && CDN.has(next.hostname), 'Unsafe download redirect')
      url = next; continue
    }
    break
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`GitHub asset download returned HTTP ${response.status}. Check release publication and repository access; for private assets set GH_TOKEN in your shell (never a VITE_ variable).`)
  }
  let file
  const hash = createHash('sha256'); let total = 0
  try {
    const length = response.headers.get('content-length')
    if (length !== null) assert.equal(length, String(config.bytes), 'Incomplete or unexpected download length')
    assert.ok(response.body, 'Empty download response')
    file = await open(destination, 'wx', 0o600)
    for await (const chunk of response.body) {
      combined.throwIfAborted(); total += chunk.length
      assert.ok(total <= config.bytes, 'Download exceeds pinned byte size')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) offset += (await file.write(chunk, offset)).bytesWritten
    }
    combined.throwIfAborted()
    assert.equal(total, config.bytes, 'Incomplete download; nothing installed')
    assert.equal(hash.digest('hex'), config.sha256, 'Archive SHA-256 mismatch; nothing installed')
    await file.sync()
  } catch (error) {
    await response.body?.cancel().catch(() => {})
    throw error
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
    await download(config, archive, { fetchImpl, signal, token })
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
