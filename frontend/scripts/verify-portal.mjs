import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'

const baseURL = process.env.QA_BASE_URL ?? 'http://127.0.0.1:5173'
await mkdir('qa-results', { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  const externalRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(baseURL).origin) externalRequests.push(new URL(request.url()).origin)
  })
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Official Login' }).click()
  await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(), true, 'Run this smoke test without Supabase configuration')
  assert.ok(await page.getByText('Official sign-in is not configured', { exact: false }).isVisible())
  assert.equal(await page.getByLabel('Email address', { exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('link', { name: /sign up|register/i }).count(), 0)
  await page.screenshot({ path: 'qa-results/official-login.png', fullPage: true })
  for (const route of ['/official/login', '/official/accept-invite', '/official/dashboard', '/official/admin']) {
    await page.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' })
    if (route.endsWith('dashboard') || route.endsWith('admin')) {
      assert.equal(new URL(page.url()).pathname, '/official/login', 'Guest protected route redirects')
    }
    assert.equal(await page.locator('main h1').count(), 1)
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    assert.deepEqual(audit.violations.map(item => item.id), [], `Accessibility: ${route}`)
  }
  await page.goto(`${baseURL}/official/accept-invite`, { waitUntil: 'networkidle' })
  assert.ok(await page.getByText('A valid invitation email link is required.', { exact: false }).isVisible())
  assert.equal(await page.getByRole('button', { name: 'Set password & accept', exact: true }).isDisabled(), true)
  // A non-credential dummy fragment tests scrubbing only. It must never produce an Auth call.
  await page.goto(`${baseURL}/official/accept-invite#token_hash=DEMO_ONLY_INVALID_FRAGMENT_1234567890&type=invite`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.location.hash === '')
  assert.equal(new URL(page.url()).hash, '', 'Same-document invitation navigation is scrubbed without a reload')
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(new URL(page.url()).hash, '')
  assert.equal(await page.getByRole('button', { name: 'Set password & accept', exact: true }).isDisabled(), true)
  for (const width of [320, 390, 768, 960, 1024, 1200, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${baseURL}/official/login`, { waitUntil: 'networkidle' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `No overflow at ${width}`)
    if (width === 390) await page.screenshot({ path: 'qa-results/official-login-mobile.png', fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('link', { name: 'Official Login' }).click()
  await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'), 'false')
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [], 'Unconfigured portal must make no external Auth requests')
  console.log('PASS: unconfigured portal, disabled forms, no fake authentication, guest redirects, invitation fragment scrubbing, public/mobile links, 8 viewports and automated WCAG AA checks.')
  console.log('Configured sessions, email delivery and live authorization still require Supabase integration tests.')
} finally { await browser.close() }
