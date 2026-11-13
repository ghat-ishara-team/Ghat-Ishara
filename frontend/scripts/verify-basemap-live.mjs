import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { build, preview } from 'vite'
import { chromium } from 'playwright-core'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

// Opt-in network integration check: four ordinary map views, not a download/scraping job.
// No routing/interception, cache bypass, header overrides, proxies or user-agent spoofing.
process.env.VITE_SUPABASE_URL = ''
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = ''
process.env.VITE_BASEMAP_PROVIDER = 'openfreemap'
process.env.VITE_BASEMAP_STYLE = 'liberty'
let server; let browser
const directory = 'qa-results/basemap-live'
try {
  await mkdir(directory, { recursive: true })
  await build({ logLevel: 'error', build: { outDir: 'qa-results/basemap-live-dist' } })
  server = await preview({ logLevel: 'error', build: { outDir: 'qa-results/basemap-live-dist' }, preview: { host: '127.0.0.1', port: 0 } })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' })
  const errors = []; const badResponses = []; const vectorLayers = new Set(); const placeNames = new Set()
  const requests = []; const jobs = []; let vectorTiles = 0; let pngImages = 0; let sampleSprite = false; let currentDistrict = 'Pune'
  const coverage = []; const districtTiles = new Map(); const overlayDistricts = new Set()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'tiles.openfreemap.org' && requests.length < 6) jobs.push(request.allHeaders().then(headers => requests.push({ referer: headers.referer ?? null, cacheControl: headers['cache-control'] ?? null, pragma: headers.pragma ?? null, authorization: !!headers.authorization })))
    if (url.hostname === 'tile.openstreetmap.org') errors.push('Unexpected direct OSM tile request')
    if (url.pathname.includes('/generated-data/') && url.pathname.endsWith('.png')) {
      const district = /\/(pune|raigad|ratnagiri|satara)\//.exec(url.pathname)?.[1]
      if (district) overlayDistricts.add(district)
    }
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.hostname !== 'tiles.openfreemap.org') return
    const district = currentDistrict
    jobs.push((async () => {
      if (!response.ok()) { badResponses.push({ status: response.status(), type: response.headers()['content-type'] }); return }
      if (url.pathname.endsWith('.pbf') && !url.pathname.includes('/fonts/')) {
        const body = await response.body()
        assert.notEqual(body[0], 137, 'Vector tile must not contain a PNG warning image even if HTTP 200')
        assert.notEqual(body[0], 60, 'Vector tile must not be an HTML error page')
        const tile = new VectorTile(new PbfReader(body)); vectorTiles++
        const xyz = /\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname)
        if (xyz) {
          const [z,x,y] = xyz.slice(1).map(Number)
          const latitude = row => Math.atan(Math.sinh(Math.PI * (1-2*row/2**z)))*180/Math.PI
          coverage.push([x/2**z*360-180,latitude(y+1),(x+1)/2**z*360-180,latitude(y)])
        }
        districtTiles.set(district, (districtTiles.get(district) ?? 0) + 1)
        for (const [name, layer] of Object.entries(tile.layers)) {
          if (layer.length) vectorLayers.add(name)
          if (name === 'place') for (let index = 0; index < Math.min(layer.length, 100); index++) {
            const properties = layer.feature(index).properties
            if (typeof properties['name:en'] === 'string') placeNames.add(properties['name:en'])
            else if (typeof properties.name === 'string') placeNames.add(properties.name)
          }
        }
      } else if (response.headers()['content-type']?.includes('image/')) {
        const body = await response.body(); pngImages++
        assert.deepEqual([...body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        // Optional style sprites, never geographic raster tiles. Save one for visual inspection.
        assert.ok(url.pathname.includes('/sprites/'), 'No geographic warning-image tiles should be rendered')
        if (!sampleSprite) { sampleSprite = true; await writeFile(`${directory}/provider-sprite.png`, body) }
      }
    })())
  })
  // Set a public preference before first render to avoid loading a second unused initial viewport.
  await page.addInitScript(() => {
    if (localStorage.getItem('ghat-ishara:persist:public:map.preferences')) return
    localStorage.setItem('ghat-ishara:persist:public:map.preferences', JSON.stringify({ version: 1, savedAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, value: { district: 'Pune', layers: ['susceptibility'], opacity: 0.4, position: { longitude: 74.1, latitude: 18.65, zoom: 8 } } }))
  })
  await page.goto(`${origin}/explore-map`)
  const settle = async () => {
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom in"]')?.disabled === false && !document.querySelector('.map-loading'), null, { timeout: 40000 })
    assert.equal(await page.getByText('The basemap could not load.', { exact: true }).count(), 0)
    assert.equal(await page.locator('.map-fatal').count(), 0)
    assert.equal(await page.getByText('Some susceptibility tiles could not load.', { exact: true }).count(), 0)
  }
  await settle()
  for (const district of ['Pune', 'Raigad', 'Ratnagiri', 'Satara']) {
    currentDistrict = district
    await page.locator('#map-district').selectOption(district)
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    await page.waitForLoadState('networkidle')
    await settle()
    await page.screenshot({ path: `${directory}/${district.toLowerCase()}-live.png`, fullPage: true })
    assert.equal(await page.locator('#map-district').inputValue(), district)
  }
  await Promise.all(jobs)
  assert.equal(await page.locator('meta[name=referrer]').getAttribute('content'), 'strict-origin')
  assert.ok(requests.length > 0)
  assert.ok(requests.every(request => request.referer === `${origin}/` && !request.authorization && request.cacheControl !== 'no-cache' && request.pragma !== 'no-cache'))
  assert.equal(vectorTiles > 0, true)
  assert.ok(vectorLayers.has('transportation') && vectorLayers.has('place'), 'Real road and place geography must be present')
  assert.ok(placeNames.size > 0)
  assert.deepEqual([...overlayDistricts].sort(), ['pune', 'raigad', 'ratnagiri', 'satara'])
  const catalog=JSON.parse(await readFile('src/map/raster-catalog.json','utf8'))
  for (const district of catalog) {
    const center=[(district.bounds[0]+district.bounds[2])/2,(district.bounds[1]+district.bounds[3])/2]
    assert.ok(coverage.some(bounds=>center[0]>=bounds[0]&&center[0]<=bounds[2]&&center[1]>=bounds[1]&&center[1]<=bounds[3]),`Decoded real vector coverage for ${district.name}, including cache reuse`)
  }
  assert.deepEqual(badResponses, []); assert.deepEqual(errors, [])
  const summary = { provider: 'OpenFreeMap Liberty', vectorTiles, pngImages, vectorLayers: [...vectorLayers].sort(), districtTileResponses: Object.fromEntries(districtTiles), placeNameExamples: [...placeNames].slice(0, 15), requestHeaders: requests, allFourRealOverlaysRequested: true, badResponses, errors }
  await writeFile(`${directory}/results.json`, JSON.stringify(summary, null, 2) + '\n')
  console.log(`PASS: live OpenFreeMap in all four districts; ${vectorTiles} decoded geographic vector tiles, ${pngImages} sprite images, origin-only Referer, default caching, no direct OSM/Supabase requests.`)
  console.log(`Screenshots, image sample and verification summary: ${directory}/`)
} finally { await browser?.close(); await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve()) }
