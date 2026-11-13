import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertLocalRecoveryTarget, assertRecoveryCandidate, createPrivateRecoverySQL } from '../supabase/scripts/local-recovery-plan.mjs'

const url = 'http://127.0.0.1:54321'
const redirect = 'http://127.0.0.1:5173/official/accept-invite'
assert.doesNotThrow(() => assertLocalRecoveryTarget(url, redirect))
for (const target of ['https://demo-only.example.invalid', 'http://localhost:54321', 'http://127.0.0.1:54322']) {
  assert.throws(() => assertLocalRecoveryTarget(target, redirect))
}
for (const target of ['https://demo-only.example.invalid/official/accept-invite', `${redirect}?next=untrusted`, 'http://127.0.0.1:5173/']) {
  assert.throws(() => assertLocalRecoveryTarget(url, target))
}
const user = { id: '00000000-0000-4000-8000-000000000001', email: 'demo.admin@example.invalid', invited_at: new Date(Date.now() - 7200000).toISOString() }
assert.doesNotThrow(() => assertRecoveryCandidate(user, user.email, 0, 0))
for (const change of [{ email_confirmed_at: 'set' }, { confirmed_at: 'set' }, { phone_confirmed_at: 'set' }, { last_sign_in_at: 'set' }, { deleted_at: 'set' }, { banned_until: new Date(Date.now() + 60000).toISOString() }]) {
  assert.throws(() => assertRecoveryCandidate({ ...user, ...change }, user.email, 0, 0))
}
assert.throws(() => assertRecoveryCandidate(user, 'another@example.invalid', 0, 0))
assert.throws(() => assertRecoveryCandidate(user, user.email, 1, 0))
assert.throws(() => assertRecoveryCandidate(user, user.email, 0, 1))
const source = await readFile(new URL('../supabase/bootstrap-first-admin.sql', import.meta.url), 'utf8')
const { bootstrap, verify } = createPrivateRecoverySQL(source, user.id)
assert.ok(bootstrap.startsWith('\\set ON_ERROR_STOP on\n\\set VERBOSITY terse\n'))
assert.ok(bootstrap.includes(`first_admin_id uuid := '${user.id}'::uuid;`))
assert.ok(bootstrap.includes("invited_at > now() - interval '1 hour'"))
assert.ok(verify.includes('begin read only;'))
assert.ok(verify.includes("r.role = 'system_admin'"))
assert.ok(verify.includes("p.status = 'invited'"))
assert.ok(verify.includes('READY_FOR_PASSWORD_SETUP'))
assert.ok(!/\b(?:insert|update|delete|truncate)\b/i.test(verify))
assert.throws(() => createPrivateRecoverySQL(source, 'NOT_A_UUID'))
assert.throws(() => createPrivateRecoverySQL('bad template', user.id))
console.log('PASS: local-only recovery guards, unchanged expiry, private UUID substitution and read-only pre-password verification. Pure offline tests; no Auth or database requests.')
