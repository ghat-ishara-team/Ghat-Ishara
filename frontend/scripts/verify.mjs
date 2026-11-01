import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'
import { mockVectorBasemap } from './fixtures/map-basemap.mjs'

// Run against npm run dev or npm run preview. Uses the host's Chromium.
const baseURL = process.env.QA_BASE_URL ?? 'http://127.0.0.1:5173'
await mkdir('qa-results', { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  await context.route('https://tiles.openfreemap.org/**', route => mockVectorBasemap(route))
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('h1').innerText(), 'GHAT\nISHARA')
  assert.equal(await page.locator('.hero').count(), 1)
  assert.equal(await page.locator('main section').count(), 0)
  await page.screenshot({ path: 'qa-results/desktop.png', fullPage: true })
  const desktopAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  assert.deepEqual(desktopAudit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], 'Desktop accessibility')

  // A document-level sentinel verifies that CTA navigation stays client-side.
  await page.evaluate(() => { window.__routingSentinel = true })
  await page.getByRole('link', { name: 'Explore the Map', exact: true }).click()
  await page.waitForURL('**/map')
  await page.getByRole('heading', { name: 'Map Explorer', exact: true }).waitFor()
  assert.equal(await page.locator('h1').innerText(), 'Map Explorer')
  assert.equal(await page.evaluate(() => window.__routingSentinel), true)
  assert.equal(await page.locator('main').evaluate(el => el === document.activeElement), true)
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('h1').innerText(), 'Map Explorer')
  const mapAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  assert.deepEqual(mapAudit.violations.map(item => item.id), [], 'Map Explorer accessibility')
  for (const route of ['/districts', '/methodology', '/about', '/missing-page']) {
    await page.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' })
    assert.equal(await page.locator('main h1').count(), 1)
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    assert.deepEqual(audit.violations.map(item => item.id), [], `Accessibility on ${route}`)
  }

  for (const [width, height] of [[1920, 1080], [1440, 900], [1024, 768], [768, 1024], [390, 844], [320, 740], [844, 390]]) {
    await page.setViewportSize({ width, height })
    await page.goto(baseURL, { waitUntil: 'networkidle' })
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))
    assert.ok(layout.scrollWidth <= layout.width, `No horizontal overflow at ${width}x${height}`)
    if (width >= 1024 && height >= 768) assert.ok(layout.height <= height + 1, `Hero fits desktop at ${width}x${height}`)
    assert.ok(await page.getByRole('link', { name: 'Explore the Map', exact: true }).isVisible())
    if (width === 390 || width === 768) await page.screenshot({ path: `qa-results/${width === 390 ? 'mobile' : 'tablet'}.png`, fullPage: true })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  const toggle = page.getByRole('button', { name: /^(Open|Close) navigation$/ })
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  const mobileAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  assert.deepEqual(mobileAudit.violations.map(item => item.id), [], 'Mobile menu accessibility')
  await page.keyboard.press('Escape')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true)
  await toggle.click()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Districts' }).click()
  await page.waitForURL('**/districts')
  await page.getByRole('heading', { name: 'Four districts. One shared landscape.', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'), 'false')
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  assert.equal(await page.locator('.hero-copy').evaluate(el => getComputedStyle(el).opacity), '1')
  await page.getByRole('link', { name: 'Learn More' }).click()
  await page.waitForURL('**/about')
  assert.deepEqual(errors, [], 'No browser or asset errors')
  console.log('PASS: routes, client-side navigation, direct reload, keyboard menu, 7 viewports, reduced motion, WCAG AA axe checks, and asset loading.')
  console.log('Screenshots saved in frontend/qa-results/.')
} finally {
  await browser.close()
}
