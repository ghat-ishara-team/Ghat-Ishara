import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { release, manifests, sha256, checkPNG, decodeChunk, referenceCell, checkReference, inspectAssets } from './assets.mjs'
import { appRoutes } from './preflight.mjs'

export function validateOrigin(input) {
  let url
  try { url = new URL(input) } catch { throw new Error('Supply an HTTPS site origin (HTTP is allowed only for loopback tests)') }
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use a root origin without credentials, query or fragment')
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'HTTPS is required outside loopback')
  return url.origin
}
async function fetchBytes(origin, pathname, limit) {
  assert.ok(pathname.startsWith('/') && !pathname.startsWith('//') && new URL(pathname, origin).origin === origin, 'Cross-origin asset request refused')
  const response = await fetch(new URL(pathname, origin), { redirect: 'error', credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(15000) })
  const reader = response.body?.getReader(); assert.ok(reader, `${pathname}: response body missing`)
  const parts = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); throw new Error(`${pathname}: response too large`) }
      parts.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return { response, bytes: Buffer.concat(parts) }
}
function responseContract(response, pathname, type) {
  assert.equal(response.status, 200, `${pathname}: expected HTTP 200`)
  assert.ok(response.headers.get('content-type')?.split(';')[0] === type, `${pathname}: wrong content type`)
  const cache = response.headers.get('cache-control') ?? ''
  assert.ok(cache.includes('no-transform') && cache.includes('max-age=0') && cache.includes('must-revalidate') && !cache.includes('immutable'), `${pathname}: map data must revalidate without transformation`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
}

export async function verifyHosted(input, { allAssets = false, browser = false, log = console.log } = {}) {
  const origin = validateOrigin(input)
  const visualPath = '/generated-data/susceptibility/manifest.json'; const numericalPath = '/generated-data/scores/manifest.json'
  const v = await fetchBytes(origin, visualPath, 512 * 1024); const n = await fetchBytes(origin, numericalPath, 512 * 1024)
  responseContract(v.response, visualPath, 'application/json'); responseContract(n.response, numericalPath, 'application/json')
  const parsed = manifests(v.bytes, n.bytes)
  log('PASS: both hosted canonical manifests match the pinned release and all four source identities.')
  for (const [id, pin] of Object.entries(release.visual.districts)) {
    const { response, bytes } = await fetchBytes(origin, pin.sampleTile, 1024 * 1024)
    responseContract(response, pin.sampleTile, 'image/png'); checkPNG(bytes)
    assert.equal(sha256(bytes), pin.sampleSha256, `${id}: hosted PNG bytes changed`)
  }
  log('PASS: real PNG responses from all four districts preserve the pinned bytes, MIME and cache policy.')
  const decoded = new Map()
  for (const reference of release.references) {
    const { grid, key, url } = referenceCell(reference, parsed.numerical); const entry = grid.tiles[key]
    if (entry === null) { assert.equal(reference.score, null); continue }
    if (!decoded.has(url)) {
      const { response, bytes } = await fetchBytes(origin, url, 32 + 256 * 256 * 4 + 1024)
      responseContract(response, url, 'application/octet-stream')
      decoded.set(url, decodeChunk(bytes, grid, key, entry.sha256))
    }
    checkReference(reference, parsed.numerical, decoded.get(url))
  }
  log('PASS: six pinned source-cell references (all four districts, valid zero and NoData) match exact Float32 values.')
  const shell = await fetchBytes(origin, '/', 2 * 1024 * 1024)
  assert.equal(shell.response.status, 200); assert.ok(shell.bytes.includes(Buffer.from('id="root"')))
  for (const route of appRoutes.filter(route => route !== '/')) {
    const { response, bytes } = await fetchBytes(origin, route, 2 * 1024 * 1024)
    assert.equal(response.status, 200, `${route}: deep link failed`)
    assert.ok(response.headers.get('content-type')?.includes('text/html'))
    assert.ok(bytes.equals(shell.bytes), `${route}: not the same application shell`)
  }
  const missing = [
    '/generated-data/susceptibility/missing-manifest.json', '/generated-data/scores/missing-manifest.json',
    `/generated-data/susceptibility/${release.visual.buildId}/pune/12/0/0.png`,
    `/generated-data/scores/${release.numerical.buildId}/pune/999/999.sct.gz`,
    '/generated-data/unknown/missing.json',
  ]
  for (const pathname of missing) {
    const { response, bytes } = await fetchBytes(origin, pathname, 2 * 1024 * 1024)
    assert.equal(response.status, 404, `${pathname}: missing asset must return a genuine 404`)
    assert.ok(!bytes.equals(shell.bytes) && !bytes.includes(Buffer.from('id="root"')), `${pathname}: missing data returned the SPA shell`)
    assert.ok(!(response.headers.get('cache-control') ?? '').includes('immutable'), 'Do not cache missing files as immutable successes')
  }
  log('PASS: application deep links and five deliberate missing-data requests distinguish app HTML from genuine 404 errors.')
  if (allAssets) {
    const local = await inspectAssets(); const pending = [...local.expected]
    let done = 0; let failed = false
    const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      try { for (;;) {
        if (failed) break
        const next = pending.pop(); if (!next) break
        const [relative, entry] = next; const pathname = `/generated-data/${relative}`
        const { response, bytes } = await fetchBytes(origin, pathname, 1024 * 1024)
        responseContract(response, pathname, entry.kind === 'png' ? 'image/png' : entry.kind === 'score' ? 'application/octet-stream' : 'application/json')
        if (entry.kind === 'score') decodeChunk(bytes, entry.grid, entry.key, entry.sha256)
        else assert.equal(sha256(bytes), local.hashes.get(relative), `${relative}: hosted bytes differ`)
        done++
      } } catch (error) { failed = true; throw error }
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    log(`PASS: all ${done} hosted generated-data files verified against the pinned local release (four concurrent GETs).`)
  }
  if (browser) await verifyBrowser(origin, log)
  return parsed
}

async function verifyBrowser(origin, log) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage(); const errors = []
    page.on('pageerror', error => errors.push(error.message))
    // Fresh test-only browser storage; no official sessions, writes or mocked responses.
    for (const reference of release.references.filter(reference => reference.label === 'ui-valid')) {
      await page.goto(`${origin}/about`, { waitUntil: 'domcontentloaded' })
      // At z14, subpixel pointer rounding stays inside the 30 m source cell
      // centered by the reference. z11 pointer rounding can cross a native cell.
      await page.evaluate(reference => {
        const savedAt = Date.now()
        // Match the existing public schema exactly, including TTL and key order.
        const value = { district: reference.district, layers: ['susceptibility'], opacity: .75, position: { longitude: reference.longitude, latitude: reference.latitude, zoom: 14 } }
        localStorage.setItem('ghat-ishara:persist:public:map.preferences', JSON.stringify({ version: 1, savedAt, expiresAt: savedAt + 30 * 86400000, value }))
      }, reference)
      await page.goto(`${origin}/explore-map`, { waitUntil: 'domcontentloaded' })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => document.querySelector('[aria-label="Zoom in"]')?.disabled === false && !document.querySelector('.map-loading'))
      const canvas = page.locator('.maplibregl-canvas'); const box = await canvas.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.getByTestId('location-score').waitFor()
      assert.equal(await page.getByTestId('location-score').textContent(), reference.score.toPrecision(9), `${reference.district}: pointer click score differs`)
      assert.ok((await page.locator('.location-sample small').innerText()).includes(`row ${reference.row}, column ${reference.column}`))
      await page.getByRole('button', { name: 'Close location details', exact: true }).click()
      await canvas.focus(); await page.keyboard.press('Enter')
      await page.getByTestId('location-score').waitFor()
      assert.equal(await page.getByTestId('location-score').textContent(), reference.score.toPrecision(9))
    }
    assert.deepEqual(errors, [])
    await context.close()
    log('PASS: real browser pointer clicks and Enter inspect the exact original reference score in each district; no transport mocks.')
  } finally { await browser.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [origin, ...flags] = process.argv.slice(2)
    assert.ok(origin && flags.every(flag => ['--all-assets', '--browser'].includes(flag)), 'Usage: npm run verify:map-hosted -- https://YOUR-HOST [--all-assets] [--browser]')
    await verifyHosted(origin, { allAssets: flags.includes('--all-assets'), browser: flags.includes('--browser') })
  } catch (error) { console.error(`Hosted map verification FAILED: ${error.message}`); process.exitCode = 1 }
}
