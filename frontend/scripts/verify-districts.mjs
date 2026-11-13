import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build, preview } from 'vite'
import { chromium } from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'
import { mockVectorBasemap } from './fixtures/map-basemap.mjs'

process.env.VITE_SUPABASE_URL = ''
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = ''
process.env.VITE_BASEMAP_PROVIDER = 'openfreemap'
process.env.VITE_BASEMAP_STYLE = 'liberty'
const catalog = JSON.parse(await readFile('src/map/raster-catalog.json', 'utf8'))
const scale = JSON.parse(await readFile('src/map/color-scale.json', 'utf8'))
const key = 'ghat-ishara:persist:public:map.preferences'
let browser; let server; let passed = 0
const pass = message => { passed++; console.log(`PASS: ${message}`) }
try {
  await build({ logLevel: 'error', build: { outDir: 'qa-results/districts-dist' } })
  server = await preview({ logLevel: 'error', build: { outDir: 'qa-results/districts-dist' }, preview: { host: '127.0.0.1', port: 0 } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === 'tiles.openfreemap.org') return mockVectorBasemap(route)
    if (url.origin !== base) return route.abort()
    return route.continue()
  })
  const page = await context.newPage()
  const audit = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    assert.deepEqual(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [])
  }
  const responsive = async () => {
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `No overflow at ${width}px on ${page.url()}`)
    }
  }
  await page.goto(`${base}/districts`)
  assert.equal(await page.locator('h1').innerText(), 'Four districts.\nOne shared landscape.')
  assert.equal(await page.locator('article').count(), catalog.length)
  for (const district of catalog) {
    const card = page.getByRole('article', { name: district.name, exact: true })
    assert.ok((await card.innerText()).includes(district.source))
    assert.ok((await card.innerText()).includes(`${(district.validFraction * 100).toFixed(2)}%`))
    assert.equal(await card.getByRole('link', { name: `Explore district: ${district.name}`, exact: true }).getAttribute('href'), `/districts/${district.id}`)
    assert.equal(await card.getByRole('link', { name: `View ${district.name} on Map`, exact: true }).getAttribute('href'), `/explore-map?district=${district.id}`)
  }
  await audit(); await responsive()
  await page.screenshot({ path: 'qa-results/districts-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'qa-results/districts-mobile.png', fullPage: true })
  await audit()
  pass('overview has four real catalog cards, profile/map links, responsive layouts and desktop/mobile WCAG AA checks')
  await page.setViewportSize({ width: 1440, height: 1000 })
  for (const district of catalog) {
    await page.goto(`${base}/districts/${district.id}`)
    await page.getByRole('heading', { name: new RegExp(`^${district.name}`), level: 1 }).waitFor()
    assert.equal(await page.title(), `${district.name} district | GHAT ISHARA`)
    const facts = page.locator('.district-facts')
    for (const expected of [district.source, district.crs, district.tags.MODEL, `${district.resolution[0]} × ${district.resolution[1]} m`, district.validPixels.toLocaleString('en-IN'), (district.width * district.height).toLocaleString('en-IN'), String(district.validFraction)]) assert.ok((await facts.innerText()).includes(expected), `${district.id}: ${expected}`)
    assert.equal(await page.getByTestId('score-range').evaluate(node => {
      const copy = node.cloneNode(true)
      copy.querySelectorAll('small').forEach(note => note.remove())
      return copy.textContent
    }), `${district.minimum} – ${district.maximum}`)
    assert.ok((await page.getByTestId('valid-coverage').innerText()).startsWith(`${(district.validFraction * 100).toFixed(2)}%`))
    for (const label of scale.labels) assert.ok((await page.locator('.district-bands').innerText()).includes(label))
    for (const text of ['not the percentage of the district covered or at risk', 'NoData does not mean safe', 'rainfall units as unverified', 'no per-cell uncertainty estimates']) assert.ok((await page.locator('main').innerText()).includes(text))
    await page.getByText('Source verification and geographic extent', { exact: true }).click()
    assert.ok((await page.locator('.district-provenance').innerText()).includes(district.sha256))
    await audit(); await responsive()
    await page.setViewportSize({ width: 390, height: 844 }); await audit()
    pass(`${district.name}: direct route, exact metadata, shared bands, scientific caveats, provenance, responsive layout and WCAG AA`)
  }
  await page.screenshot({ path: 'qa-results/district-profile-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('navigation', { name: 'Study districts' }).getByRole('link', { name: 'Pune', exact: true }).click()
  assert.ok(page.url().endsWith('/districts/pune'))
  await page.waitForFunction(() => document.querySelector('main') === document.activeElement)
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'All districts')
  pass('cross-district navigation sets the profile title, focuses main content and preserves keyboard access')
  for (const id of ['unknown', 'Pune', 'pune-extra', '%3Cscript%3E']) {
    await page.goto(`${base}/districts/${id}`)
    await page.getByRole('heading', { name: 'District not found.', exact: true }).waitFor()
    assert.equal(await page.locator('.district-facts').count(), 0)
    assert.equal(await page.getByRole('link', { name: 'Browse districts' }).getAttribute('href'), '/districts')
  }
  await audit()
  await page.goto(`${base}/districts/pune/extra`)
  await page.getByRole('heading', { name: 'Let’s find your way back.', exact: true }).waitFor()
  pass('unknown, case-mismatched, malformed and nested identifiers show unavailable/404 states without another district’s data')

  // Seed preferences through real controls, not a guessed persistence envelope.
  await page.goto(`${base}/explore-map`)
  await page.locator('#map-district').selectOption('Satara')
  await page.locator('#map-opacity').fill('40')
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.value.opacity === .4, key)
  const savedDistrict = async name => page.waitForFunction(({ key, name }) => JSON.parse(localStorage.getItem(key))?.value.district === name, { key, name })
  for (const district of catalog) {
    await page.goto(`${base}/districts/${district.id}`)
    await page.getByRole('link', { name: `View ${district.name} on Map`, exact: true }).first().click()
    await page.waitForURL(`**/explore-map?district=${district.id}`)
    await page.waitForFunction(name => document.querySelector('#map-district')?.value === name, district.name)
    await savedDistrict(district.name)
    assert.equal(await page.locator('#map-opacity').inputValue(), '40')
    await page.waitForFunction(({ key, bounds }) => {
      const position = JSON.parse(localStorage.getItem(key))?.value.position
      return position && position.longitude >= bounds[0] && position.longitude <= bounds[2] && position.latitude >= bounds[1] && position.latitude <= bounds[3]
    }, { key, bounds: district.bounds })
    // An unchanged explicit query must not keep overriding subsequent control input.
    const next = district.name === 'Pune' ? 'Raigad' : 'Pune'
    await page.locator('#map-district').selectOption(next); await savedDistrict(next)
    assert.equal(await page.locator('#map-district').inputValue(), next)
  }
  pass('each profile opens its correct map, overrides saved district/camera, preserves opacity, and then allows normal controls/autosave')
  // Same mounted MapExplorer, new navigation key/query; no component remount required.
  await page.evaluate(() => { history.pushState({}, '', '/explore-map?district=ratnagiri'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await savedDistrict('Ratnagiri')
  await page.locator('#map-district').selectOption('Satara'); await savedDistrict('Satara')
  await page.reload(); await savedDistrict('Ratnagiri')
  await page.goto(`${base}/explore-map?district=invalid`)
  await page.getByText('The district in this URL is not recognised.', { exact: false }).waitFor()
  assert.equal(await page.locator('#map-district').inputValue(), 'Ratnagiri')
  await page.locator('#map-district').selectOption('Pune'); await savedDistrict('Pune')
  await page.goto(`${base}/explore-map`)
  assert.equal(await page.locator('#map-district').inputValue(), 'Pune')
  pass('new queries on the mounted map and explicit-query reloads take precedence; invalid/absent queries preserve normal preferences')
  assert.deepEqual(errors, [])
  console.log(`PASS: ${passed} district browser scenarios. Offline basemap fixture; no Supabase operations.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve())
}
