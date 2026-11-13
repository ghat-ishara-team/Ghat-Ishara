import assert from 'node:assert/strict'
import { readBootstrapConfig } from '../supabase/scripts/bootstrap-config.mjs'

// Invalid-signature, noncredential fixtures. Validation is local shape checking only.
const fakeJWT = role => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role, iss: 'DEMO_ONLY' })).toString('base64url')}.DEMO_NOT_A_SIGNATURE`
const config = {
  SUPABASE_URL: 'https://demo-only.example.invalid', SUPABASE_SERVICE_ROLE_KEY: fakeJWT('service_role'),
  BOOTSTRAP_ADMIN_EMAIL: ' Demo.Admin@example.invalid ', SITE_URL: 'http://127.0.0.1:5173',
  OFFICIAL_INVITE_REDIRECT_URL: 'http://127.0.0.1:5173/official/accept-invite',
}
assert.equal(readBootstrapConfig(config).email, 'demo.admin@example.invalid')
assert.ok(readBootstrapConfig({ ...config, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_DEMO_ONLY_NOT_A_REAL_KEY' }))
const invalid = [
  { SUPABASE_SERVICE_ROLE_KEY: '' },
  { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_DEMO_ONLY_NOT_A_KEY' },
  { SUPABASE_SERVICE_ROLE_KEY: fakeJWT('anon') },
  { SITE_URL: 'http://localhost:5173' },
  { OFFICIAL_INVITE_REDIRECT_URL: 'http://127.0.0.1:5173/' },
  { OFFICIAL_INVITE_REDIRECT_URL: 'http://127.0.0.1:5173/official/accept-invite?next=untrusted' },
  { SITE_URL: 'ftp://localhost', OFFICIAL_INVITE_REDIRECT_URL: 'ftp://localhost/official/accept-invite' },
  { SUPABASE_URL: 'https://user:password@demo-only.example.invalid' },
  { BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' },
]
for (const change of invalid) {
  assert.throws(() => readBootstrapConfig({ ...config, ...change }), error => {
    for (const value of Object.values(change).filter(Boolean)) assert.ok(!error.message.includes(value))
    return true
  })
}
console.log('PASS: bootstrap configuration accepts 2 valid shapes, rejects 9 invalid configurations without disclosing values. No Auth, email or database calls were made.')
