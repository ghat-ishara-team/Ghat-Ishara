import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { build, preview } from 'vite'
import { chromium } from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'

// Build the real application plus one isolated hook fixture. All Auth/REST traffic is mocked.
// No .env.local value is used by this build and no request reaches any Supabase project.
const fakeOrigin = 'https://persistence-tests.example.invalid'
const oldURL = process.env.VITE_SUPABASE_URL; const oldKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
process.env.VITE_SUPABASE_URL = fakeOrigin
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_DEMO_ONLY_TEST_FIXTURE'
let server; let browser
const executablePath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
const launch = { executablePath, headless: true, args: ['--no-sandbox'] }
const prefix = 'ghat-ishara:persist:'
let passed = 0
const pass = name => { passed++; console.log(`PASS: ${name}`) }
const waitValue = async (page, selector, value) => page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value, { selector, value })
try {
  await build({ logLevel: 'error', build: { outDir: 'qa-results/persistence-dist', rollupOptions: { input: { app: path.resolve('index.html'), fixture: path.resolve('scripts/fixtures/persistence.html') } } } })
  server = await preview({ logLevel: 'error', build: { outDir: 'qa-results/persistence-dist' }, preview: { host: '127.0.0.1', port: 0, open: false } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const fixtureURL = `${base}/scripts/fixtures/persistence.html`
  browser = await chromium.launch(launch)
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' })
  const adminId = '00000000-0000-4000-8000-000000000001'
  const secondId = '00000000-0000-4000-8000-000000000002'
  const targetId = '00000000-0000-4000-8000-000000000003'
  const user = id => ({ id, aud: 'authenticated', role: 'authenticated', email: id === secondId ? 'demo.second@example.invalid' : 'demo.admin@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' })
  const token = id => [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'DEMO_ONLY_INVALID_SIGNATURE'].join('.')
  let invitations = 0; let updates = 0; let checks = 0; let failInvite = true; let failUpdate = true; let currentRole = 'system_admin'; let failContext = false
  const target = { user_id: targetId, invitation_email: 'demo.target@example.invalid', status: 'active', invited_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  let targetExists = true; let currentStatus = 'active'; let currentDistricts = ['Pune']; let finishInvitation = null; let delayInvitation = false
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === base) return route.continue()
    if (url.origin !== fakeOrigin) throw new Error('Unexpected external request blocked')
    const method = route.request().method()
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } })
    if (method === 'OPTIONS') return respond({})
    const authorization = route.request().headers().authorization ?? ''
    let id = adminId
    try { id = JSON.parse(Buffer.from(authorization.split('.')[1], 'base64url').toString()).sub } catch { /* login has no user token */ }
    if (url.pathname === '/auth/v1/token') {
      const body = route.request().postDataJSON()
      const loginId = body.email === 'demo.second@example.invalid' ? secondId : adminId
      return respond({ access_token: token(loginId), refresh_token: 'DEMO_ONLY_REFRESH_FIXTURE', token_type: 'bearer', expires_in: 3600, user: user(loginId) })
    }
    if (url.pathname === '/auth/v1/user') return respond(user(id))
    if (url.pathname === '/auth/v1/logout') return respond({})
    if (url.pathname.endsWith('/rpc/get_official_context')) {
      checks++
      return failContext ? respond({ message: 'DEMO_ONLY_OFFLINE' }, 503) : respond({ user_id: id, email: user(id).email, status: currentStatus, role: currentRole, districts: currentDistricts, invitation_expires_at: '2099-01-01T00:00:00Z' })
    }
    if (url.pathname.endsWith('/official_profiles')) return respond(targetExists ? [target] : [])
    if (url.pathname.endsWith('/official_role_assignments')) return respond([{ user_id: targetId, role: 'district_officer' }])
    if (url.pathname.endsWith('/official_district_assignments')) return respond([{ user_id: targetId, district: 'Pune' }])
    if (url.pathname.endsWith('/audit_logs')) return respond([])
    if (url.pathname.endsWith('/official_records')) return respond([{ id: 'demo-record', district: 'Pune', title: 'DEMO_ONLY_PROTECTED_RECORD', summary: 'Never persist this record', created_at: '2026-01-01T00:00:00Z' }])
    if (url.pathname.endsWith('/invite-official')) { invitations++; if (delayInvitation) await new Promise(resolve => { finishInvitation = resolve }); return failInvite ? respond({ error: 'DEMO_ONLY_FAILURE' }, 400) : respond({ user_id: targetId }) }
    if (url.pathname.endsWith('/rpc/admin_update_official')) { updates++; return failUpdate ? respond({ message: 'DEMO_ONLY_FAILURE' }, 400) : respond(null) }
    throw new Error(`Unmocked API path: ${url.pathname}`)
  })
  const page = await context.newPage()
  const login = async (email = 'demo.admin@example.invalid') => {
    await page.goto(`${base}/official/login`)
    await page.locator('#official-email').fill(email)
    await page.locator('#official-password').fill('DEMO_ONLY_PASSWORD_NOT_PERSISTED')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('heading', { name: 'Your official workspace.' }).waitFor()
    await page.getByRole('link', { name: 'Administration', exact: true }).click()
    await page.locator('#admin-invite-email:enabled').waitFor()
    await page.locator('#managed-account:enabled').waitFor()
  }
  const inviteEmail = () => page.locator('#admin-invite-email')
  const fillInvite = async () => { await inviteEmail().fill('demo.invitee@example.invalid'); await page.locator('#admin-invite-role').selectOption('senior_officer'); await page.locator('#invite-Pune').check() }
  const focus = async () => {
    const before = checks
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('#admin-invite-email')?.disabled)
    assert.ok(checks > before)
  }
  await login(); await fillInvite()
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await page.getByText('DEMO_ONLY_PROTECTED_RECORD', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Administration', exact: true }).click()
  await waitValue(page, '#admin-invite-email', 'demo.invitee@example.invalid')
  assert.equal(await page.locator('#admin-invite-role').inputValue(), 'senior_officer')
  assert.equal(await page.locator('#invite-Pune').isChecked(), true)
  await page.getByRole('link', { name: 'Back to GHAT ISHARA' }).click()
  await page.goBack()
  await waitValue(page, '#admin-invite-email', 'demo.invitee@example.invalid')
  pass('invitation draft restores after official and public route navigation')
  await inviteEmail().evaluate(node => { node.dataset.mountMarker = 'preserved' })
  const other = await context.newPage(); await other.goto(base); await other.bringToFront(); await page.bringToFront(); await focus()
  assert.equal(await inviteEmail().getAttribute('data-mount-marker'), 'preserved')
  assert.equal(await inviteEmail().inputValue(), 'demo.invitee@example.invalid')
  await other.close(); await page.reload(); await waitValue(page, '#admin-invite-email', 'demo.invitee@example.invalid')
  assert.equal(invitations, 0); assert.equal(updates, 0)
  pass('tab/focus revalidation preserves DOM and drafts; refresh restores without submitting')
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await page.getByText('Invitation could not be issued.', { exact: false }).waitFor()
  assert.equal(await inviteEmail().inputValue(), 'demo.invitee@example.invalid')
  await page.reload(); await waitValue(page, '#admin-invite-email', 'demo.invitee@example.invalid')
  pass('failed invitation retains draft through refresh')
  failInvite = false
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await page.getByText('Invitation issued.', { exact: false }).waitFor()
  assert.equal(await inviteEmail().inputValue(), '')
  assert.equal(await page.locator('#admin-invite-role').inputValue(), 'district_officer')
  await page.reload(); await waitValue(page, '#admin-invite-email', '')
  assert.equal(invitations, 2)
  pass('confirmed invitation clears all draft fields and cannot restore submitted values')
  await fillInvite(); await page.getByRole('button', { name: 'Clear invitation draft', exact: true }).click()
  await page.reload(); await waitValue(page, '#admin-invite-email', '')
  pass('explicit Clear Draft persists across refresh')
  await fillInvite(); delayInvitation = true
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await page.getByRole('link', { name: 'Administration', exact: true }).click()
  await page.locator('#admin-invite-email:enabled').fill('demo.next-draft@example.invalid')
  assert.ok(finishInvitation); finishInvitation(); delayInvitation = false
  await page.reload(); await waitValue(page, '#admin-invite-email', 'demo.next-draft@example.invalid')
  await page.getByRole('button', { name: 'Clear invitation draft' }).click()
  pass('a late success from an unmounted form preserves newer unsent work')

  await page.locator('#managed-account:enabled').selectOption(targetId)
  await page.locator('#managed-role').selectOption('senior_officer')
  await page.locator('#manage-Satara').check()
  await page.reload(); await waitValue(page, '#managed-role', 'senior_officer')
  assert.equal(await page.locator('#manage-Satara').isChecked(), true)
  assert.equal(updates, 0)
  await page.getByRole('button', { name: 'Save access changes' }).click()
  await page.getByText('Account update was rejected.', { exact: false }).waitFor()
  assert.equal(await page.locator('#managed-role').inputValue(), 'senior_officer')
  pass('management intent restores only as editable UI and survives a failed explicit update')
  target.updated_at = '2026-02-01T00:00:00Z'
  await page.reload(); await waitValue(page, '#managed-role', 'district_officer')
  assert.equal(await page.locator('#manage-Satara').isChecked(), false)
  await page.locator('#managed-role').selectOption('senior_officer')
  target.updated_at = '2026-03-01T00:00:00Z'
  const beforeUpdate = updates
  await page.getByRole('button', { name: 'Save access changes' }).click()
  await page.getByText('This account changed or could not be verified.', { exact: false }).waitFor()
  assert.equal(updates, beforeUpdate)
  pass('changed account revision clears stale edits and pre-submit refresh prevents stale mutation')
  await page.locator('#managed-role:enabled').selectOption('senior_officer'); failUpdate = false
  await page.getByRole('button', { name: 'Save access changes' }).click()
  await page.getByText('Account permissions updated.', { exact: false }).waitFor()
  await page.reload(); await waitValue(page, '#managed-account', '')
  pass('confirmed management update clears its draft')
  await page.locator('#managed-account:enabled').selectOption(targetId)
  await page.getByRole('button', { name: 'Clear account access draft' }).click()
  assert.equal(await page.locator('#managed-account').inputValue(), '')
  await page.locator('#managed-account').selectOption(targetId); targetExists = false
  await page.reload(); await waitValue(page, '#managed-account', '')
  targetExists = true
  pass('management Clear Draft and no-longer-visible target discard selections safely')
  await fillInvite()
  failContext = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('heading', { name: 'Access could not be verified.' }).waitFor()
  failContext = false; await page.getByRole('button', { name: 'Retry verification' }).click()
  await waitValue(page, '#admin-invite-email', 'demo.invitee@example.invalid')
  pass('temporary authorization transport failure blocks access without destroying the draft')
  // A separate tab inherits the SDK session via localStorage, never the session draft.
  const tab = await context.newPage(); await tab.goto(`${base}/official/admin`)
  await waitValue(tab, '#admin-invite-email', '')
  await tab.getByRole('button', { name: 'Sign out', exact: true }).click()
  await tab.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  await page.bringToFront(); await page.goto(`${base}/official/login`)
  await page.locator('#official-email').waitFor()
  assert.equal(await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix) && key.includes('official:')).length, prefix), 0)
  await tab.close(); await login('demo.second@example.invalid')
  assert.equal(await inviteEmail().inputValue(), '')
  await fillInvite(); await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await login()
  assert.equal(await inviteEmail().inputValue(), '')
  pass('official drafts stay per-tab; cross-tab sign-out/account switching clear scoped data')
  await fillInvite(); currentRole = 'district_officer'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('heading', { name: 'Access restricted.' }).waitFor()
  assert.equal(await page.evaluate(prefix => Object.keys(sessionStorage).some(key => key.startsWith(prefix) && key.endsWith('admin.invitation')), prefix), false)
  currentRole = 'system_admin'; await page.reload(); await waitValue(page, '#admin-invite-email', '')
  pass('administrator role revocation removes administrator drafts and restricts the route')
  await fillInvite(); currentStatus = 'inactive'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('heading', { name: 'Access restricted.' }).waitFor()
  assert.equal(await page.evaluate(prefix => Object.keys(sessionStorage).some(key => key.startsWith(prefix) && key.endsWith('admin.invitation')), prefix), false)
  currentStatus = 'active'; await page.reload(); await waitValue(page, '#admin-invite-email', '')
  pass('inactive officials lose protected access and their official drafts are cleared')
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await page.getByText('DEMO_ONLY_PROTECTED_RECORD', { exact: true }).waitFor()
  currentDistricts = ['Satara']
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.locator('.district-tags').getByText('Satara', { exact: true }).waitFor()
  assert.equal(await page.getByText('DEMO_ONLY_PROTECTED_RECORD', { exact: true }).count(), 0)
  currentDistricts = ['Pune']; await page.getByRole('link', { name: 'Administration', exact: true }).click()
  await page.locator('#admin-invite-email:enabled').waitFor()
  pass('dashboard immediately hides records from revoked districts without persisting them')

  await fillInvite()
  const draftKey = await page.evaluate(prefix => Object.keys(sessionStorage).find(key => key.startsWith(prefix) && key.endsWith('admin.invitation')), prefix)
  await page.evaluate(key => sessionStorage.setItem(key, '{corrupt'), draftKey)
  await page.reload(); await waitValue(page, '#admin-invite-email', '')
  await fillInvite()
  await page.evaluate(key => { const entry = JSON.parse(sessionStorage.getItem(key)); entry.savedAt = Date.now() - 9 * 3600000; entry.expiresAt = entry.savedAt + 8 * 3600000; sessionStorage.setItem(key, JSON.stringify(entry)) }, draftKey)
  await page.reload(); await waitValue(page, '#admin-invite-email', '')
  pass('corrupted and expired browser envelopes are discarded without breaking the form')
  await inviteEmail().fill('sb_secret_DEMO_ONLY@example.invalid')
  await page.getByText('Not saved locally', { exact: true }).waitFor()
  const stored = await page.evaluate(prefix => [...Object.keys(sessionStorage), ...Object.keys(localStorage)].filter(key => key.startsWith(prefix)).map(key => sessionStorage.getItem(key) ?? localStorage.getItem(key)).join('\n'), prefix)
  for (const secret of ['DEMO_ONLY_PASSWORD', 'DEMO_ONLY_REFRESH', 'DEMO_ONLY_INVALID_SIGNATURE', 'sb_secret_', 'DEMO_ONLY_PROTECTED_RECORD']) assert.equal(stored.includes(secret), false)
  pass('new autosave namespace excludes passwords, SDK tokens, secret-like inputs and protected records')
  await page.getByRole('button', { name: 'Clear invitation draft' }).click()
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  assert.deepEqual(audit.violations.map(item => item.id), [])
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
  pass('administrator autosave controls pass automated WCAG AA and mobile overflow checks')
  await context.close()
  const fixture = await browser.newPage(); await fixture.goto(fixtureURL)
  await fixture.getByLabel('Public district', { exact: true }).selectOption('Satara')
  await fixture.getByRole('button', { name: 'Change public map view' }).click()
  await fixture.waitForFunction(() => document.querySelector('output[aria-label="Public status"]').textContent === 'saved')
  await fixture.reload(); assert.equal(await fixture.getByLabel('Public district', { exact: true }).inputValue(), 'Satara')
  const prefs = JSON.parse(await fixture.getByLabel('Public preferences').textContent())
  assert.deepEqual(prefs, { district: 'Satara', layers: ['terrain'], opacity: 0.4, position: { longitude: 74, latitude: 18.5, zoom: 9 } })
  await fixture.getByLabel('Official district', { exact: true }).selectOption('Pune')
  await fixture.getByRole('button', { name: 'Revoke Pune' }).click()
  assert.equal(JSON.parse(await fixture.getByLabel('Official preferences').textContent()).district, null)
  pass('future map hooks restore full public view and revalidate revoked district intent')
  await fixture.close()
  const denied = await browser.newContext()
  await denied.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('DEMO_ONLY_STORAGE_DENIED') } }) })
  const blocked = await denied.newPage(); await blocked.goto(fixtureURL)
  await blocked.getByLabel('Public district', { exact: true }).selectOption('Pune')
  await blocked.waitForFunction(() => document.querySelector('output[aria-label="Public status"]').textContent === 'unavailable')
  assert.equal(await blocked.getByLabel('Public district', { exact: true }).inputValue(), 'Pune')
  await denied.close()
  pass('blocked browser storage leaves controls usable with truthful saving status')
  await browser.close(); browser = null
  await mkdir('qa-results', { recursive: true })
  const profile = await mkdtemp(path.resolve('qa-results/persistence-browser-profile-'))
  let persistent = await chromium.launchPersistentContext(profile, launch)
  let restartPage = await persistent.newPage(); await restartPage.goto(fixtureURL)
  await restartPage.getByLabel('Public district', { exact: true }).selectOption('Pune')
  await restartPage.waitForFunction(() => document.querySelector('output[aria-label="Public status"]').textContent === 'saved')
  await persistent.close()
  persistent = await chromium.launchPersistentContext(profile, launch)
  try {
    restartPage = await persistent.newPage(); await restartPage.goto(fixtureURL)
    assert.equal(await restartPage.getByLabel('Public district', { exact: true }).inputValue(), 'Pune')
  } finally { await persistent.close() }
  pass('public localStorage preferences survive closing and relaunching the browser process')
  assert.deepEqual(errors, [])
  console.log(`PASS: ${passed} browser scenarios. Supabase transport mocked; zero live project operations.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve())
  if (oldURL === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = oldURL
  if (oldKey === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY; else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = oldKey
}
