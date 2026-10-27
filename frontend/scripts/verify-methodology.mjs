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
const csvPath = '../ml/data/controlled_250m_22pred_spatial_cv_results.csv'
const reportPath = '../ml/results/final_model_evaluation.json'
const csv = await readFile(csvPath, 'utf8')
const reportText = await readFile(reportPath, 'utf8')
const report = JSON.parse(reportText)
const catalog = JSON.parse(await readFile('src/map/raster-catalog.json', 'utf8'))
const scale = JSON.parse(await readFile('src/map/color-scale.json', 'utf8'))
const research = await readFile('METHODOLOGY_RESEARCH.md', 'utf8')
const inference = await readFile('../ml/scripts/prahari_district_22pred_inference.py', 'utf8')
const expectedInputs = ['BASE_FEATURES', 'EXTRA_FEATURES'].flatMap(name => [...inference.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\]`))[1].matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]))
assert.equal(expectedInputs.length, 22)
const [header, ...lines] = csv.trim().split(/\r?\n/)
const columns = header.split(',')
const folds = lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [columns[index], Number(value)])))
const metricColumns = { 'Mean ROC-AUC': 'auc', 'Mean F1': 'f1', 'Mean recall': 'recall', 'Mean precision': 'precision' }
let browser; let server; let passed = 0
const pass = message => { passed++; console.log(`PASS: ${message}`) }
try {
  await build({ logLevel: 'error', build: { outDir: 'qa-results/methodology-dist' } })
  server = await preview({ logLevel: 'error', build: { outDir: 'qa-results/methodology-dist' }, preview: { host: '127.0.0.1', port: 0 } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []; const requests = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === 'tiles.openfreemap.org') return mockVectorBasemap(route)
    if (url.origin !== base) return route.abort()
    return route.continue()
  })
  const page = await context.newPage()
  page.on('request', request => requests.push(new URL(request.url()).pathname))
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  const audit = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    assert.deepEqual(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [])
  }
  await page.goto(`${base}/methodology`, { waitUntil: 'networkidle' })
  assert.equal(await page.locator('main').count(), 1)
  assert.equal(await page.locator('h1').count(), 1)
  assert.equal(await page.title(), 'Methodology | GHAT ISHARA')
  assert.equal(await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Methodology', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await page.locator('.preview-note').count(), 0)
  assert.ok(!requests.some(path => path.startsWith('/generated-data/') || path.startsWith('/ml/')))
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '500 trees. 22 recorded inputs.', exact: true }).waitFor()
  pass('public /methodology direct route and reload, document title, active navigation, one main/h1, no map-data or authentication dependency')

  for (const [title, column] of Object.entries(metricColumns)) {
    const expected = (folds.reduce((total, fold) => total + fold[column], 0) / folds.length).toFixed(6)
    const metric = page.locator('.method-metrics > div').filter({ has: page.getByText(title, { exact: true }) })
    assert.equal(await metric.locator('dd').first().innerText(), expected)
    assert.ok(research.includes(expected))
  }
  const evaluation = page.locator('#evaluation')
  for (const caveat of ['unweighted arithmetic means', 'not pooled test results', 'not an accuracy percentage', 'cannot yet be fully independently reproduced']) assert.ok((await evaluation.innerText()).includes(caveat))
  await page.getByText('Inspect the five recorded folds', { exact: true }).click()
  const tableRows = page.getByRole('table').locator('tbody tr')
  assert.equal(await tableRows.count(), 5)
  for (let index = 0; index < folds.length; index++) {
    const row = folds[index]
    assert.deepEqual(await tableRows.nth(index).locator('th, td').allTextContents(), [String(row.fold), String(row.samples), row.auc.toFixed(6), row.f1.toFixed(6), row.recall.toFixed(6), row.precision.toFixed(6)])
  }
  pass('all four mean metrics and five fold rows match the selected CSV; interpretation distinguishes recorded means from accuracy and independent replication')

  const codes = await page.locator('[data-predictor]').allTextContents()
  assert.deepEqual([...codes].sort(), [...expectedInputs].sort())
  assert.equal(new Set(codes).size, 22)
  const groups = page.locator('.method-predictors article')
  assert.equal(await groups.count(), 5)
  for (const group of await groups.all()) await group.locator('summary').click()
  for (const code of await page.locator('[data-predictor]').all()) assert.equal(await code.isVisible(), true)
  const inputs = await page.locator('#inputs').innerText()
  assert.ok(inputs.includes(report.model)); assert.ok(catalog.every(item => item.tags.MODEL === report.model))
  for (const caveat of ['21 numeric columns', 'encodes lithology', 'Earlier V1–V5 experiments are separate', 'formulas remain unverified', 'Rainfall units remain unverified']) assert.ok(inputs.includes(caveat))
  assert.ok(!codes.includes('distance_to_road_m')); assert.ok(!codes.includes('distance_to_fault_m'))
  pass('all 22 exact input names match inference code, grouped accessibly; selected model, preprocessing and source caveats remain distinct from older experiments')

  const samples = await page.locator('#samples').innerText()
  assert.deepEqual(await page.locator('.method-stat').allTextContents(), [report.training_samples.toLocaleString('en-IN'), String(report.test_samples), '3'])
  for (const text of ['2,048 samples', '1,031 labelled landslides', '1,017 backgrounds', '815 landslide-labelled and 790 background', '216 landslide-labelled and 224 background', 'outside both', 'exact implementation is not verified', 'not the raster cell size', '0.30°', 'five spatial folds', 'Neighbouring blocks', 'does not guarantee independence']) assert.ok(samples.includes(text), text)
  const historical = page.getByRole('complementary', { name: 'Reported final-test summary' })
  assert.ok((await historical.innerText()).includes('not fully independently reproducible'))
  assert.ok((await historical.innerText()).includes('do not establish an untouched independent test'))
  assert.equal(await historical.locator('details').getAttribute('open'), null)
  const toggle = historical.locator('summary'); await toggle.focus(); await page.keyboard.press('Enter')
  assert.deepEqual(await historical.locator('dd').allTextContents(), [report.roc_auc.toFixed(4), report.accuracy.toFixed(4)])
  pass('development/test/unassigned counts and nominal sampling caveat are accurate; historical test figures are separate and keyboard expandable')

  const scores = await page.locator('#scores').innerText()
  for (const text of ['30 × 30 m', 'does not establish measured 30 m predictive accuracy', '0.8 does not mean an 80% chance', 'NoData does not mean safe', '−9999', 'not the share of a district covered or at risk']) assert.ok(scores.includes(text), text)
  assert.deepEqual(await page.locator('.method-bands li').allTextContents(), scale.labels)
  const limitations = await page.locator('#limitations').innerText()
  for (const text of ['Rainfall units', 'event-level leakage', 'prior use of shared test geography', 'No external, time-based or leave-one-district-out validation', 'No confidence intervals', 'No operational warning capability', 'do not monitor current rainfall']) assert.ok(limitations.includes(text), text)
  for (const district of catalog) assert.equal(await page.getByRole('navigation', { name: 'District susceptibility maps' }).getByRole('link', { name: `View ${district.name} on Map`, exact: true }).getAttribute('href'), `/explore-map?district=${district.id}`)
  pass('static raster workflow, shared bands, score/NoData and spatial/operational limitations are explicit; district links reuse catalog IDs')

  await page.getByText('Repository artifact references', { exact: true }).click()
  const references = await page.locator('#sources').innerText()
  for (const path of ['frontend/METHODOLOGY_RESEARCH.md', 'ml/models/rf_250m_controlled_22pred_EXPERIMENT.joblib', 'ml/scripts/prahari_district_22pred_inference.py', 'ml/data/controlled_250m_22pred_spatial_cv_results.csv', 'ml/results/final_model_evaluation.json']) assert.ok(references.includes(path))
  for (const [name, expected] of [['Download recorded folds (CSV)', csv], ['Download historical report (JSON)', reportText]]) {
    const link = page.getByRole('link', { name, exact: true })
    const response = await context.request.get(new URL(await link.getAttribute('href'), base).href)
    assert.equal(response.status(), 200); assert.equal(await response.text(), expected)
    assert.ok(await link.getAttribute('download'))
  }
  pass('repository/audit references identify actual evidence; downloadable small reports match original bytes without distributing training data or the internal audit')

  for (const anchor of await page.getByRole('navigation', { name: 'Methodology sections' }).getByRole('link').all()) {
    const id = (await anchor.getAttribute('href')).slice(1)
    assert.equal(await page.locator(`[id="${id}"]`).count(), 1)
  }
  await audit()
  await page.evaluate(() => document.activeElement?.blur())
  await page.screenshot({ path: 'qa-results/methodology-desktop.png', fullPage: true })
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `No overflow at ${width}px with all details expanded`)
  }
  await page.setViewportSize({ width: 390, height: 844 }); await audit()
  await page.screenshot({ path: 'qa-results/methodology-mobile-expanded.png', fullPage: true })
  await page.reload({ waitUntil: 'networkidle' }); await audit()
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: 'Open navigation', exact: true }).evaluate(node => node === document.activeElement), true)
  await page.screenshot({ path: 'qa-results/methodology-mobile.png', fullPage: true })
  pass('section anchors, keyboard disclosures/menu, expanded responsive layouts at five widths, and desktop/mobile automated WCAG AA checks pass')

  // Use real public controls to ensure the new informational route does not reset preferences.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('navigation', { name: 'District susceptibility maps' }).getByRole('link', { name: 'View Pune on Map', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#map-district')?.value === 'Pune')
  await page.locator('#map-opacity').fill('40')
  const key = 'ghat-ishara:persist:public:map.preferences'
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.value.opacity === .4, key)
  await page.evaluate(() => { window.__methodologyRoutingSentinel = true })
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Methodology', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('main') === document.activeElement)
  assert.equal(await page.evaluate(() => window.__methodologyRoutingSentinel), true)
  await page.getByRole('link', { name: 'Meet the districts', exact: true }).click()
  await page.waitForURL('**/districts')
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Explore Map', exact: true }).click()
  await page.waitForSelector('#map-district')
  assert.equal(await page.locator('#map-district').inputValue(), 'Pune')
  assert.equal(await page.locator('#map-opacity').inputValue(), '40')
  pass('methodology → district map links, client-side navigation/focus, districts CTA and map autosave survive route round trips')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('link', { name: 'Methodology', exact: true }).click()
  await page.waitForURL('**/methodology')
  assert.equal(await page.getByRole('button', { name: 'Open navigation', exact: true }).getAttribute('aria-expanded'), 'false')
  await page.goto(`${base}/methodology/unknown`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Let’s find your way back.', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  pass('mobile navbar reaches methodology and closes; unsupported child routes retain the site 404; no browser/asset errors')
  console.log(`PASS: ${passed} methodology browser scenarios. Real saved evidence; offline basemap; no Supabase operations.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve())
}
