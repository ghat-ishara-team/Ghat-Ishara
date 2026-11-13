// Use only the synthetic configured build documented in ACCESS_REQUESTS.md. All backend calls are intercepted.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'
import { submissionMessage, verificationMessage } from '../shared/access-request.ts'

const base = process.env.QA_BASE_URL ?? 'http://127.0.0.1:4187'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const calls = []; const errors = []
  let release
  const pause = new Promise(resolve => { release = resolve })
  // Block every external origin; no real project, account or email can be contacted.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(base).origin) return route.continue()
    if (url.origin !== 'https://stage1-fixture.example.invalid') return route.abort()
    const action = url.pathname.split('/').at(-1)
    if (!['submit-access-request', 'verify-access-request'].includes(action)) { errors.push('Unexpected backend operation'); return route.abort() }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': new URL(base).origin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } })
    const body = route.request().postDataJSON()
    calls.push({ action, body })
    if (action === 'submit-access-request') await pause
    return route.fulfill({ status: action === 'submit-access-request' ? 202 : 200, headers: { 'Access-Control-Allow-Origin': new URL(base).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: action === 'submit-access-request' ? submissionMessage : verificationMessage }) })
  })
  const page = await context.newPage()
  page.on('pageerror', () => errors.push('Browser runtime error'))
  await page.goto(`${base}/official/request-access`, { waitUntil: 'networkidle' })
  assert.equal(await page.getByRole('combobox').count(), 0, 'No role selection')
  await page.getByRole('button', { name: 'Submit access request', exact: true }).click()
  await page.getByRole('alert').waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert')
  assert.equal(await page.getByRole('alert').evaluate(element => document.activeElement === element), true)
  assert.equal(calls.length, 0)
  for (const [label, value] of [['Full name', 'Demo Officer'], ['Official email address', 'demo.officer@example.invalid'], ['Department', 'Demo Department'], ['Designation', 'Demo Officer'], ['Reason for requesting access', 'A controlled local demonstration of requested district access.']]) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole('checkbox', { name: 'Pune', exact: true }).check()
  await page.getByRole('button', { name: 'Submit access request', exact: true }).click()
  await page.getByRole('button', { name: 'Submitting…', exact: true }).waitFor()
  assert.equal(await page.getByLabel('Full name', { exact: true }).isDisabled(), true)
  release()
  await page.getByText(submissionMessage, { exact: true }).waitFor()
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'submit-access-request')
  assert.equal('role' in calls[0].body, false); assert.deepEqual(calls[0].body.districts, ['Pune'])
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('demo.officer@example.invalid') || value.includes('Demo Officer'))), false, 'Application drafts are never persisted in browser storage')
  await page.goto(`${base}/official/verify-request#token=${'a'.repeat(64)}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.location.hash === '')
  assert.equal(calls.length, 1, 'Opening an email link does not consume it')
  await page.getByRole('button', { name: 'Confirm email', exact: true }).click()
  await page.getByText(verificationMessage, { exact: true }).waitFor()
  assert.equal(calls.length, 2); assert.equal(calls[1].action, 'verify-access-request')
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('a'.repeat(64)))), false)
  await page.goto(`${base}/official/verify-request#token=${'b'.repeat(64)}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.location.hash === '')
  assert.equal(calls.length, 2, 'Same-document hash navigation is scrubbed without verification')
  for (const path of ['/official/request-access', '/official/verify-request']) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'No horizontal overflow')
    }
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    assert.deepEqual(audit.violations.map(item => item.id), [], 'Request page accessibility')
  }
  assert.deepEqual(errors, [])
  console.log('PASS: Stage 1 form validation/focus, loading state, generic acknowledgement, no role assignment or stored application draft, fragment scrubbing, explicit verification, four viewports and WCAG AA checks. Backend responses are fixtures.')
} finally { await browser.close() }
