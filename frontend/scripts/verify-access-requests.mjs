// Actual SQL in isolated in-memory PostgreSQL; HTTP/mail use explicit doubles, no live services.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createAccessRequestHandler, digest } from '../supabase/functions/_shared/access-request-handler.ts'
import { submissionMessage, verificationMessage, validateAccessRequest } from '../shared/access-request.ts'

const application = (email = 'demo.officer@example.invalid') => ({ fullName: 'Demo Officer', email, department: 'Demo Department', designation: 'Demo Officer', districts: ['Pune'], reason: 'Review district susceptibility information for a controlled local demonstration.' })
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text, invited_at timestamptz, created_at timestamptz, email_confirmed_at timestamptz, encrypted_password text, banned_until timestamptz, deleted_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`)
for (const migration of ['202610240001_official_permissions.sql', '202610240002_official_management.sql', '202611010001_official_access_requests.sql']) {
  if (migration.startsWith('202611')) await db.exec('alter default privileges in schema private grant all on tables to anon, authenticated, service_role;')
  await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'))
}
async function asRole(role, operation, subject = '') {
  await db.exec(`begin; set local role ${role};`)
  try { await db.query("select set_config('request.jwt.claim.sub',$1,true)", [subject]); const result = await operation(); await db.exec('commit'); return result }
  catch (error) { await db.exec('rollback'); throw error }
}
async function rpc(name, args) {
  try {
    const rows = await asRole('service_role', () => name === 'submit_official_access_request'
      ? db.query('select public.submit_official_access_request($1::jsonb,$2,$3) as value', [JSON.stringify(args.p_application), args.p_verification_hash, args.p_email_bucket])
      : db.query('select public.verify_official_access_request($1) as value', [args.p_verification_hash]))
    return { data: rows.rows[0].value, error: null }
  } catch { return { data: null, error: { code: 'storage' } } }
}
function harness(action = 'submit', options = {}) {
  const mail = []; const tasks = []; const calls = []
  const config = { SITE_URL: 'http://127.0.0.1:5173', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'DEMO_SERVER_KEY_NOT_REAL', ACCESS_REQUEST_MAILPIT_URL: 'http://127.0.0.1:54324', ...options.env }
  const handler = createAccessRequestHandler(action, {
    env: name => config[name],
    createService: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return options.rpc ? options.rpc(name, args) : rpc(name, args) } }),
    defer: task => tasks.push(task),
    fetchImpl: async (_url, init) => {
      if (options.mailFailure) throw new Error('DEMO_PROVIDER_DETAIL_MUST_NOT_BE_RETURNED')
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
      mail.push(JSON.parse(init.body)); return new Response(null, { status: 200 })
    },
  })
  return { calls, mail, run: async (body = application(), init = {}) => {
    const result = await handler(new Request('http://127.0.0.1/functions/v1/local-test', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.SITE_URL, ...init.headers }, body: JSON.stringify(body), ...init }))
    await Promise.all(tasks)
    return result
  } }
}
const clear = () => db.exec('truncate private.official_access_requests, private.official_access_request_limits;')
async function submitSQL(body, hash = 'a'.repeat(64)) {
  return rpc('submit_official_access_request', { p_application: body, p_verification_hash: hash, p_email_bucket: await digest(body.email.trim().toLowerCase()) })
}
try {
  await test('valid submission persists claims, pending state and hashed capability without any official permissions', async () => {
    const h = harness(); const result = await h.run()
    assert.equal(result.status, 202); assert.equal((await result.json()).message, submissionMessage)
    assert.equal(h.mail.length, 1)
    const raw = /#token=([a-f0-9]{64})/.exec(h.mail[0].Text)[1]
    const row = (await db.query('select * from private.official_access_requests')).rows[0]
    assert.equal(row.status, 'pending'); assert.equal(row.email_verified_at, null)
    assert.equal(row.approved_role, null); assert.equal(row.approved_districts, null); assert.equal(row.reviewed_by, null); assert.equal(row.invitation_request_id, null)
    assert.equal(row.verification_hash, await digest(raw)); assert.ok(row.verification_hash !== raw)
    assert.deepEqual((await db.query('select to_json(requested_districts) districts from private.official_access_requests')).rows[0].districts, ['Pune'])
    for (const table of ['auth.users', 'public.official_profiles', 'public.official_role_assignments', 'public.official_district_assignments', 'private.official_invitation_requests']) assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0)
  })
  await test('normalization and multiline reasons are accepted; empty, malformed, oversized or privileged fields fail in both validators', async () => {
    await clear()
    const body = { ...application(), email: ' Demo.Officer@Example.Invalid ', reason: 'A controlled demonstration.\nReview local district information.' }
    const parsed = validateAccessRequest(body); assert.ok(parsed.data); assert.equal(parsed.data.email, 'demo.officer@example.invalid')
    assert.equal((await harness().run(body)).status, 202)
    for (const invalid of [null, [], { ...application(), fullName: '' }, { ...application(), email: 'invalid' }, { ...application(), department: 'x'.repeat(161) }, { ...application(), designation: '' }, { ...application(), reason: 'short' }, { ...application(), reason: 'x'.repeat(2001) }, { ...application(), districts: [] }, { ...application(), districts: ['Pune', 'Pune'] }, { ...application(), districts: ['Unsupported'] }, { ...application(), role: 'system_admin' }, { ...application(), status: 'approved' }, { ...application(), email_verified_at: 'now' }, { ...application(), fullName: '\u0000' }]) {
      assert.equal(validateAccessRequest(invalid).data, null)
      const h = harness(); assert.equal((await h.run(invalid)).status, 400); assert.equal(h.calls.length, 0)
      await assert.rejects(asRole('service_role', () => db.query('select public.submit_official_access_request($1::jsonb,$2,$3)', [JSON.stringify(invalid), 'b'.repeat(64), 'c'.repeat(64)])), error => ['22023', '22P05'].includes(error.code))
    }
  })
  await test('duplicates do not overwrite claims or rotate a live verification link; response does not enumerate accounts', async () => {
    await clear()
    const first = harness(); const firstResult = await first.run()
    const before = (await db.query('select full_name,verification_hash from private.official_access_requests')).rows[0]
    const duplicate = harness(); const duplicateResult = await duplicate.run({ ...application(), fullName: 'Different Claim' })
    assert.equal(await duplicateResult.text(), await firstResult.text()); assert.equal(duplicateResult.status, 202); assert.equal(duplicate.mail.length, 0)
    assert.deepEqual((await db.query('select full_name,verification_hash from private.official_access_requests')).rows[0], before)
    await db.exec("insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','demo.registered@example.invalid');")
    const registered = await harness().run(application('demo.registered@example.invalid'))
    assert.equal(registered.status, 202); assert.equal((await registered.json()).message, submissionMessage)
    assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n, 1)
    assert.equal((await db.query('select count(*)::int n from public.official_profiles')).rows[0].n, 0)
  })
  await test('email rate limit persists across handler instances; global/hour and daily budgets bound email sprays', async () => {
    await clear()
    for (let n = 0; n < 4; n++) assert.equal((await harness().run()).status, 202)
    const usage = await db.query("select attempts from private.official_access_request_limits where bucket like 'submit:email:%'")
    assert.equal(usage.rows[0].attempts, 4)
    await db.exec("update private.official_access_requests set verification_expires_at = now() - interval '1 minute';")
    assert.equal((await submitSQL(application(), 'd'.repeat(64))).data, false)
    await db.exec("update private.official_access_request_limits set attempts = 100 where bucket='submit:global';")
    assert.equal((await submitSQL(application('demo.other@example.invalid'))).data, false)
    assert.equal((await db.query("select count(*)::int n from private.official_access_request_limits where bucket like 'submit:email:%'")).rows[0].n, 1, 'No unbounded per-email buckets once global budget is exhausted')
    await clear()
    await db.exec("insert into private.official_access_request_limits values ('submit:daily',date_trunc('day',now()),1000);")
    assert.equal((await submitSQL(application())).data, false)
  })
  await test('oversized declared and streamed bodies, malformed JSON, wrong content types and extra roles never reach storage', async () => {
    const h = harness()
    for (const init of [
      { headers: { 'Content-Type': 'application/json', 'Content-Length': '9000' } },
      { body: ' '.repeat(9000) }, { body: '{' }, { headers: { 'Content-Type': 'text/plain' } },
      { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8193)); c.close() } }), duplex: 'half' },
    ]) assert.equal((await h.run(application(), init)).status, 400)
    assert.equal(h.calls.length, 0)
  })
  await test('slow request bodies are cancelled within the read deadline without storage access', async () => {
    const h = harness(); let cancelled = false
    const response = await h.run(application(), { body: new ReadableStream({ cancel() { cancelled = true } }), duplex: 'half' })
    assert.equal(response.status, 400); assert.equal(cancelled, true); assert.equal(h.calls.length, 0)
  })
  await test('GET cannot submit or consume verification; preflight performs no storage operation', async () => {
    for (const action of ['submit', 'verify']) {
      const h = harness(action)
      assert.equal((await h.run(application(), { method: 'GET', body: undefined })).status, 405)
      assert.equal((await h.run(application(), { method: 'OPTIONS', body: undefined })).status, 204)
      assert.equal(h.calls.length, 0); assert.equal(h.mail.length, 0)
    }
  })
  await test('verification is single-use, expires after 20 minutes and never changes pending status or permissions', async () => {
    await clear()
    const h = harness(); await h.run()
    const raw = /#token=([a-f0-9]{64})/.exec(h.mail[0].Text)[1]
    const verified = await harness('verify').run({ token: raw })
    assert.equal(verified.status, 200); assert.equal((await verified.json()).message, verificationMessage)
    const row = (await db.query('select status,email_verified_at,verification_hash from private.official_access_requests')).rows[0]
    assert.equal(row.status, 'pending'); assert.ok(row.email_verified_at); assert.equal(row.verification_hash, null)
    assert.equal((await rpc('verify_official_access_request', { p_verification_hash: await digest(raw) })).data, false)
    assert.equal((await harness('verify').run({ token: raw })).status, 200)
    assert.equal((await harness('verify').run({ token: '0'.repeat(64) })).status, 200)
    assert.equal((await harness('verify').run({ token: 'short' })).status, 400)
    assert.equal((await db.query('select count(*)::int n from public.official_profiles')).rows[0].n, 0)
    await clear(); await h.run()
    await db.exec("update private.official_access_requests set verification_expires_at=now()-interval '1 second';")
    const hash = (await db.query('select verification_hash from private.official_access_requests')).rows[0].verification_hash
    assert.equal((await rpc('verify_official_access_request', { p_verification_hash: hash })).data, false)
    assert.equal((await db.query('select count(*)::int n from private.official_access_requests where email_verified_at is not null')).rows[0].n, 0)
  })
  await test('expired challenges can be reissued within budgets; old tokens cannot verify the replacement', async () => {
    await clear(); assert.equal((await submitSQL(application())).data, true)
    await db.exec("update private.official_access_requests set verification_expires_at=now()-interval '1 second';")
    assert.equal((await submitSQL(application(), 'b'.repeat(64))).data, true)
    assert.equal((await rpc('verify_official_access_request', { p_verification_hash: 'a'.repeat(64) })).data, false)
    assert.equal((await rpc('verify_official_access_request', { p_verification_hash: 'b'.repeat(64) })).data, true)
    assert.equal((await submitSQL(application(), 'c'.repeat(64))).data, false)
  })
  await test('verification budgets persist and prevent changes after exhaustion; expired rate windows are pruned', async () => {
    await clear(); await submitSQL(application())
    await db.exec("insert into private.official_access_request_limits values ('verify:global',date_trunc('hour',now()),1000),('old-budget',now()-interval '3 days',1);")
    assert.equal((await rpc('verify_official_access_request', { p_verification_hash: 'a'.repeat(64) })).data, false)
    assert.equal((await db.query('select count(*)::int n from private.official_access_requests where email_verified_at is not null')).rows[0].n, 0)
    assert.equal((await db.query("select count(*)::int n from private.official_access_request_limits where bucket='old-budget'")).rows[0].n, 0)
  })
  await test('all direct application/limiter access and client RPC execution are denied, even with broad inherited defaults', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) for (const table of ['official_access_requests', 'official_access_request_limits']) {
      for (const command of [`select * from private.${table}`, `delete from private.${table}`, `update private.${table} set ${table === 'official_access_requests' ? "status='approved'" : 'attempts=1'}`, `insert into private.${table} default values`]) await assert.rejects(asRole(role, () => db.exec(command)), error => error.code === '42501')
    }
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(role, () => db.query('select public.submit_official_access_request($1::jsonb,$2,$3)', [JSON.stringify(application()), 'a'.repeat(64), 'b'.repeat(64)])), error => error.code === '42501')
      await assert.rejects(asRole(role, () => db.query('select public.verify_official_access_request($1)', ['a'.repeat(64)])), error => error.code === '42501')
    }
    const policy = await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('official_access_requests','official_access_request_limits') and c.relrowsecurity")
    assert.equal(policy.rows[0].n, 2)
    await assert.rejects(asRole('anon', () => db.exec('select * from public.official_records')), error => error.code === '42501')
    assert.equal((await asRole('authenticated', () => db.query('select * from public.official_records'))).rows.length, 0)
    assert.equal((await asRole('authenticated', () => db.query('select public.get_official_context() c'))).rows[0].c, null)
    // A real JWT subject/email alone must not turn a pending application into membership.
    const subject = '00000000-0000-4000-8000-000000000002'
    await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ($1,$2,now(),$3)', [subject, application().email, 'DEMO_AUTH_HASH_STUB'])
    assert.equal((await asRole('authenticated', () => db.query('select * from public.official_records'), subject)).rows.length, 0)
    assert.equal((await asRole('authenticated', () => db.query('select public.get_official_context() c'), subject)).rows[0].c, null)
    await assert.rejects(asRole('authenticated', () => db.query('select public.complete_official_invitation()'), subject), error => error.code === '42501')
  })
  await test('mail failure and duplicate/rate-limited suppression have the same generic acknowledgement', async () => {
    await clear()
    const failed = await harness('submit', { mailFailure: true }).run()
    assert.equal(failed.status, 202); assert.equal((await failed.json()).message, submissionMessage)
    const suppressed = await harness('submit', { rpc: () => ({ data: false, error: null }) }).run()
    assert.equal(suppressed.status, 202); assert.equal((await suppressed.json()).message, submissionMessage)
  })
  await test('acknowledgement does not wait for email network delivery', async () => {
    let release; let delivered = false; const tasks = []
    const paused = new Promise(resolve => { release = resolve })
    const env = { SITE_URL: 'http://127.0.0.1:5173', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'DEMO_SERVER_KEY_NOT_REAL', ACCESS_REQUEST_MAILPIT_URL: 'http://127.0.0.1:54324' }
    const handler = createAccessRequestHandler('submit', { env: name => env[name], createService: () => ({ rpc: () => Promise.resolve({ data: true, error: null }) }), defer: task => tasks.push(task), fetchImpl: async () => { await paused; delivered = true; return new Response(null) } })
    const response = await handler(new Request('http://127.0.0.1/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(application()) }))
    assert.equal(response.status, 202); assert.equal(delivered, false)
    release(); await Promise.all(tasks); assert.equal(delivered, true)
  })
  await test('missing mail configuration, unsafe mail targets, wrong origins and storage failures fail without disclosures', async () => {
    for (const env of [{ ACCESS_REQUEST_MAILPIT_URL: '' }, { ACCESS_REQUEST_MAILPIT_URL: 'https://untrusted.example.invalid' }, { SITE_URL: 'http://untrusted.example.invalid' }, { SITE_URL: 'http://user:DEMO_ONLY@localhost:5173' }, { ACCESS_REQUEST_MAILPIT_URL: 'http://user:DEMO_ONLY@localhost:54324' }]) {
      const h = harness('submit', { env }); const response = await h.run(); assert.equal(response.status, 503); assert.equal(h.calls.length, 0)
      assert.ok(!response.headers.get('Access-Control-Allow-Origin').includes('DEMO_ONLY'))
    }
    const h = harness(); assert.equal((await h.run(application(), { headers: { Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json' } })).status, 403); assert.equal(h.calls.length, 0)
    const failure = await harness('submit', { rpc: () => { throw new Error('DEMO_PROVIDER_DETAIL_MUST_NOT_BE_RETURNED') } }).run()
    assert.equal(failure.status, 503); assert.ok(!(await failure.text()).includes('DEMO_PROVIDER'))
  })
} finally { await db.close() }
