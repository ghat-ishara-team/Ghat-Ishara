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
let browser; let server; let passed = 0
const pass = message => { passed++; console.log(`PASS: ${message}`) }
try {
  await build({ logLevel: 'error', build: { outDir: 'qa-results/about-dist' } })
  server = await preview({ logLevel: 'error', build: { outDir: 'qa-results/about-dist' }, preview: { host: '127.0.0.1', port: 0 } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []; const external = []; const requested = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === 'tiles.openfreemap.org') return mockVectorBasemap(route)
    if (url.origin !== base) { external.push(url.origin); return route.abort() }
    return route.continue()
  })
  const page = await context.newPage()
  page.on('request', request => requested.push(new URL(request.url()).pathname))
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  const mainNav = () => page.getByRole('navigation', { name: 'Main navigation', exact: true })
  const audit = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    assert.deepEqual(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [])
  }
  await page.goto(`${base}/about`, { waitUntil: 'networkidle' })
  assert.equal(await page.title(), 'About | GHAT ISHARA')
  assert.equal(await page.locator('main').count(), 1); assert.equal(await page.locator('h1').count(), 1)
  assert.equal(await page.locator('h1').innerText(), 'A safer tomorrow\nstarts with understanding.')
  assert.equal(await mainNav().getByRole('link', { name: 'About', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await page.locator('.preview-note').count(), 0)
  assert.ok(!requested.some(path => path.startsWith('/generated-data/')))
  assert.deepEqual(external, [])
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Make the landscape easier to read.', exact: true }).waitFor()
  pass('public /about direct route/reload, title, active navigation, one main/h1, no placeholder, no map-data or external requests')

  const districts = page.getByRole('navigation', { name: 'Study district profiles', exact: true })
  assert.equal(await districts.getByRole('link').count(), catalog.length)
  for (const district of catalog) assert.equal(await districts.getByRole('link', { name: new RegExp(`^${district.name}`) }).getAttribute('href'), `/districts/${district.id}`)
  assert.equal(await page.locator('.about-capabilities article').count(), 6)
  const capabilities = await page.getByRole('region', { name: 'Explore. Inspect. Understand.', exact: true }).innerText()
  for (const text of ['Implemented today', 'MapLibre', 'original Float32', 'district profiles', 'recorded evaluation', 'save locally when browser storage is available', 'scoped autosave', 'saving a draft does not submit it', 'invitation-only']) assert.ok(capabilities.toLowerCase().includes(text.toLowerCase()), text)
  const science = await page.getByRole('region', { name: 'A research tool, with clear limits.', exact: true }).innerText()
  for (const text of ['static, experimental and uncalibrated', 'not real-time landslide warnings or event probabilities', '0.8 does not mean an 80% chance', 'NoData', 'do not establish safety', 'Rainfall units', 'not evidence of measured 30 m predictive accuracy', 'Do not rely on the platform alone']) assert.ok(science.includes(text), text)
  pass('catalog-derived four-district links, accurate implemented capabilities, and explicit scientific/safety limitations')

  const future = page.getByRole('region', { name: 'More evidence. Clearer interpretation.', exact: true })
  assert.ok((await future.innerText()).includes('proposed priorities, not released features or a confirmed delivery roadmap'))
  assert.equal(await future.getByRole('listitem').count(), 3)
  assert.equal(await page.getByRole('region', { name: 'Project team', exact: true }).count(), 0)
  assert.equal(await page.locator('#team-title, .about-team-pending, .lucide-users, .about-people-grid').count(), 0)
  const aboutText = (await page.locator('main').innerText()).toLowerCase()
  for (const removed of ['project team', 'the people behind the project', 'team details awaiting confirmation', 'member names, roles and affiliations']) assert.equal(aboutText.includes(removed), false)
  const official = page.getByRole('region', { name: 'Official access is invitation-only.', exact: true })
  for (const text of ['no public self-registration', 'role and assigned districts', 'not an operational government warning system', 'not evidence of government deployment or endorsement']) assert.ok((await official.innerText()).includes(text))
  assert.equal(await official.getByRole('link', { name: 'Official sign-in', exact: true }).getAttribute('href'), '/official/login')
  const photo = page.getByRole('img', { name: 'A waterfall descending into a green valley at Tamhini Ghat, Maharashtra.', exact: true })
  assert.equal(await photo.getAttribute('src'), '/images/tamhini-valley.webp')
  assert.equal(await photo.evaluate(image => image.complete && image.naturalWidth > 0), true)
  const figure = page.locator('figure')
  assert.ok((await figure.innerText()).includes('Scenic context, not a susceptibility map'))
  assert.equal(await figure.getByRole('link', { name: /Chetan Sane/ }).getAttribute('href'), 'https://unsplash.com/photos/a-waterfall-in-a-valley-7TBDoi67iUk')
  assert.equal(await figure.getByRole('link', { name: /Unsplash License/ }).getAttribute('href'), 'https://unsplash.com/license')
  pass('team section/icon/placeholder removed; proposed/released distinction, official-access caveats and existing image/credit preserved')

  await page.evaluate(() => { window.__aboutNavigationSentinel = true })
  for (const [name, path, heading] of [['Map Explorer', '/explore-map', 'Map Explorer'], ['Districts', '/districts', 'Four districts. One shared landscape.'], ['Methodology', '/methodology', '500 trees. 22 recorded inputs.']]) {
    await page.getByRole('navigation', { name: 'Explore GHAT ISHARA', exact: true }).getByRole('link', { name, exact: true }).click()
    await page.waitForURL(`**${path}`)
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__aboutNavigationSentinel), true)
    await mainNav().getByRole('link', { name: 'About', exact: true }).click()
    await page.waitForURL('**/about')
    await page.waitForFunction(() => document.querySelector('main') === document.activeElement)
  }
  for (const district of catalog) {
    await districts.getByRole('link', { name: new RegExp(`^${district.name}`) }).click()
    await page.waitForURL(`**/districts/${district.id}`)
    await page.getByRole('heading', { level: 1, name: new RegExp(`^${district.name}`) }).waitFor()
    await mainNav().getByRole('link', { name: 'About', exact: true }).click()
  }
  await page.getByRole('link', { name: 'Read the methodology and limitations', exact: true }).click()
  await page.waitForURL('**/methodology')
  await mainNav().getByRole('link', { name: 'About', exact: true }).click()
  pass('all public CTAs and four district profiles navigate client-side; return focus follows the shared route behavior')

  await audit()
  await page.locator('main').focus()
  await page.screenshot({ path: 'qa-results/about-desktop.png', fullPage: true })
  await page.screenshot({ path: 'qa-results/about-desktop-viewport.png' })
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `No overflow at ${width}px`)
    const contentBox = await page.locator('main').boundingBox()
    const officialBox = await official.boundingBox()
    assert.ok(Math.abs(contentBox.width - officialBox.width) < 1, `Official-access card fills the content width at ${width}px`)
  }
  await page.setViewportSize({ width: 390, height: 844 }); await audit()
  await page.locator('main').focus()
  await page.screenshot({ path: 'qa-results/about-mobile.png', fullPage: true })
  await page.screenshot({ path: 'qa-results/about-mobile-viewport.png' })
  const motion = await page.locator('main').evaluate(main => [...main.querySelectorAll('*')].every(node => {
    const style = getComputedStyle(node)
    return style.animationName === 'none' && style.transitionDuration.split(',').every(value => parseFloat(value) === 0)
  }))
  assert.equal(motion, true)
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await audit(); await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: 'Open navigation', exact: true }).evaluate(node => node === document.activeElement), true)
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('link', { name: 'About', exact: true }).click()
  await page.waitForURL('**/about')
  assert.equal(await page.getByRole('button', { name: 'Open navigation', exact: true }).getAttribute('aria-expanded'), 'false')
  pass('desktop/mobile WCAG AA checks, five responsive widths, meaningful image alt, reduced motion and mobile keyboard/menu behavior')

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('link', { name: 'Explore the Map', exact: true }).click()
  await page.locator('#map-district').selectOption('Satara')
  await page.locator('#map-opacity').fill('40')
  const key = 'ghat-ishara:persist:public:map.preferences'
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.value.district === 'Satara' && JSON.parse(localStorage.getItem(key))?.value.opacity === .4, key)
  await mainNav().getByRole('link', { name: 'About', exact: true }).click()
  await page.getByRole('navigation', { name: 'Explore GHAT ISHARA', exact: true }).getByRole('link', { name: 'Map Explorer', exact: true }).click()
  await page.waitForSelector('#map-district')
  assert.equal(await page.locator('#map-district').inputValue(), 'Satara')
  assert.equal(await page.locator('#map-opacity').inputValue(), '40')
  await mainNav().getByRole('link', { name: 'About', exact: true }).click()
  await page.getByRole('link', { name: 'Official sign-in', exact: true }).click()
  await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(), true)
  pass('map preferences survive About round trips; official CTA reaches the existing unconfigured invitation-only login')

  await page.goto(`${base}/about/unknown`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Let’s find your way back.', exact: true }).waitFor()
  const blocked = await browser.newContext()
  await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('STORAGE_DENIED_TEST') } }) })
  const fallback = await blocked.newPage(); await fallback.goto(`${base}/about`, { waitUntil: 'networkidle' })
  await fallback.getByRole('heading', { name: 'Official access is invitation-only.', exact: true }).waitFor()
  assert.equal(await fallback.getByRole('link', { name: 'Explore the Map', exact: true }).isVisible(), true)
  await blocked.close()
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  pass('unknown child route uses the existing 404; About remains usable without local storage; no browser/asset/external request errors')
  console.log(`PASS: ${passed} About browser scenarios. Offline basemap fixture; no live Supabase operations.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve())
}
