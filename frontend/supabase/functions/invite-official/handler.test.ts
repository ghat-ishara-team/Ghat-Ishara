// Explicit offline test doubles. --deny-net --deny-env prevents any project/email access.
import assert from 'node:assert/strict'
import type { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { createInviteHandler } from './handler.ts'

type Options = {
  invalidUser?: boolean; denied?: boolean; deliveryFailure?: boolean; provisionFailure?: boolean;
  cleanupFailure?: boolean; environment?: Record<string, string>; noBearer?: boolean;
  origin?: string; body?: unknown; method?: string;
}
function harness(options: Options = {}) {
  const env: Record<string, string> = {
    SITE_URL: 'http://127.0.0.1:5173', OFFICIAL_INVITE_REDIRECT_URL: 'http://127.0.0.1:5173/official/accept-invite',
    SUPABASE_URL: 'https://demo-only.example.invalid', SUPABASE_ANON_KEY: 'DEMO_PUBLIC_KEY_NOT_REAL',
    SUPABASE_SERVICE_ROLE_KEY: 'DEMO_SERVER_KEY_NOT_REAL', ...options.environment,
  }
  const calls: string[] = []
  const caller = {
    auth: { getUser: async () => {
      calls.push('verify-user')
      return { data: { user: options.invalidUser ? null : { id: 'DEMO_ACTOR_UUID' } }, error: options.invalidUser ? { message: 'invalid' } : null }
    } },
    rpc: async (name: string) => {
      assert.equal(name, 'begin_official_invitation')
      calls.push('authorize-active-admin')
      return options.denied ? { data: null, error: { code: '42501' } } : { data: 'DEMO_REQUEST_UUID', error: null }
    },
  }
  const service = {
    auth: { admin: { inviteUserByEmail: async (email: string, args: { redirectTo: string }) => {
      calls.push('send-invite')
      assert.equal(email, 'demo.invitee@example.invalid')
      assert.equal(args.redirectTo, env.OFFICIAL_INVITE_REDIRECT_URL)
      return { data: { user: options.deliveryFailure ? null : { id: 'DEMO_INVITED_UUID' } }, error: options.deliveryFailure ? { message: 'DO_NOT_EXPOSE_PROVIDER_DETAIL' } : null }
    } } },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name)
      assert.equal(args.p_actor_id, 'DEMO_ACTOR_UUID', 'Actor must come from verified Auth, never request body')
      if (name === 'fail_official_invitation' && options.cleanupFailure) throw new Error('DO_NOT_EXPOSE_PROVIDER_DETAIL')
      return { error: name === 'finish_official_invitation' && options.provisionFailure ? { code: '42501' } : null }
    },
  }
  const factory = ((_url: string, key: string, config: { global?: { headers: { Authorization: string } } }) => {
    if (key === env.SUPABASE_SERVICE_ROLE_KEY) { calls.push('create-privileged-client'); return service }
    assert.equal(config.global?.headers.Authorization, 'Bearer DEMO_TOKEN_NOT_REAL')
    return caller
  }) as unknown as typeof createClient
  const handler = createInviteHandler({ env: name => env[name], createClient: factory })
  const method = options.method ?? 'POST'
  const headers: Record<string, string> = { Origin: options.origin ?? env.SITE_URL, 'Content-Type': 'application/json' }
  if (!options.noBearer) headers.Authorization = 'Bearer DEMO_TOKEN_NOT_REAL'
  const request = new Request('http://127.0.0.1/functions/v1/invite-official', {
    method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {
      email: ' Demo.Invitee@example.invalid ', role: 'district_officer', districts: ['Pune'], actor_id: 'FORGED_ACTOR', redirectTo: 'https://untrusted.example.invalid',
    }) } : {}),
  })
  return { run: () => handler(request), calls }
}

Deno.test('active administrator verification precedes privileged client and email send', async () => {
  const test = harness()
  const response = await test.run()
  assert.equal(response.status, 200)
  assert.deepEqual(test.calls, ['verify-user', 'authorize-active-admin', 'create-privileged-client', 'send-invite', 'finish_official_invitation'])
  assert.equal((await response.json()).user_id, 'DEMO_INVITED_UUID')
})
Deno.test('anonymous, invalid, inactive or non-admin callers never send an invite', async () => {
  for (const [options, status] of [[{ noBearer: true }, 401], [{ invalidUser: true }, 401], [{ denied: true }, 403]] as const) {
    const test = harness(options)
    assert.equal((await test.run()).status, status)
    assert.ok(!test.calls.includes('send-invite'))
    assert.ok(!test.calls.includes('create-privileged-client'))
  }
})
Deno.test('revocation during delivery fails provisioning and reports failure', async () => {
  const test = harness({ provisionFailure: true })
  const response = await test.run()
  assert.equal(response.status, 400)
  assert.ok(test.calls.includes('finish_official_invitation'))
  assert.ok(test.calls.includes('fail_official_invitation'))
  assert.ok(!(await response.text()).includes('user_id'))
})
Deno.test('delivery and cleanup failures return generic errors without provider details', async () => {
  const test = harness({ deliveryFailure: true, cleanupFailure: true })
  const response = await test.run()
  assert.equal(response.status, 400)
  assert.ok(!(await response.text()).includes('DO_NOT_EXPOSE_PROVIDER_DETAIL'))
})
Deno.test('untrusted redirects and non-HTTP localhost schemes are rejected', async () => {
  const redirects: Record<string, string>[] = [
    { OFFICIAL_INVITE_REDIRECT_URL: 'https://untrusted.example.invalid/official/accept-invite' },
    { OFFICIAL_INVITE_REDIRECT_URL: 'http://127.0.0.1:5173/official/accept-invite?next=untrusted' },
    { SITE_URL: 'ftp://localhost', OFFICIAL_INVITE_REDIRECT_URL: 'ftp://localhost/official/accept-invite' },
  ]
  for (const environment of redirects) {
    const test = harness({ environment })
    assert.equal((await test.run()).status, 503)
    assert.deepEqual(test.calls, [])
  }
})
Deno.test('wrong origins, missing configuration and unsupported methods are denied', async () => {
  for (const [options, status] of [[{ origin: 'https://untrusted.example.invalid' }, 403], [{ environment: { SUPABASE_SERVICE_ROLE_KEY: '' } }, 503], [{ method: 'GET' }, 405]] as const) {
    const test = harness(options)
    assert.equal((await test.run()).status, status)
    assert.deepEqual(test.calls, [])
  }
})
Deno.test('invalid roles and districts never reach invitation authorization', async () => {
  for (const body of [
    { email: 'demo.invitee@example.invalid', role: 'owner', districts: ['Pune'] },
    { email: 'demo.invitee@example.invalid', role: 'district_officer', districts: [] },
    { email: 'demo.invitee@example.invalid', role: 'district_officer', districts: ['Pune', 'Pune'] },
    { email: 'demo.invitee@example.invalid', role: 'senior_officer', districts: ['Unsupported district'] },
    [], 'invalid body',
  ]) {
    const test = harness({ body })
    assert.equal((await test.run()).status, 400)
    assert.deepEqual(test.calls, ['verify-user'])
  }
})
