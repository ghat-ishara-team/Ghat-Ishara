
import assert from 'node:assert/strict'
import type { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { createInviteHandler } from './handler.ts'

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111'
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'
const OFFICER_EMAIL = 'demo.officer@example.invalid'
const ADMIN_EMAIL = 'demo.admin@example.invalid'

type Options = {
  invalidUser?: boolean
  denied?: boolean
  deliveryFailure?: boolean
  provisionFailure?: boolean
  cleanupFailure?: boolean
  environment?: Record<string, string>
  noBearer?: boolean
  origin?: string
  body?: unknown
  method?: string
}

function harness(options: Options = {}) {
  const env: Record<string, string> = {
    SITE_URL: 'http://127.0.0.1:5173',
    OFFICIAL_INVITE_REDIRECT_URL:
      'http://127.0.0.1:5173/official/accept-invite',
    SUPABASE_URL: 'https://demo-only.example.invalid',
    SUPABASE_ANON_KEY: 'DEMO_PUBLIC_KEY_NOT_REAL',
    SUPABASE_SERVICE_ROLE_KEY: 'DEMO_SERVER_KEY_NOT_REAL',
    ...options.environment,
  }

  const calls: string[] = []
  const requestBody = options.body ?? {
    application_id: APPLICATION_ID,
  }

  const isApprovalRequest =
    typeof requestBody === 'object' &&
    requestBody !== null &&
    !Array.isArray(requestBody) &&
    'application_id' in requestBody

  const caller = {
    auth: {
      getUser: async () => {
        calls.push('verify-user')
        return {
          data: {
            user: options.invalidUser
              ? null
              : { id: 'DEMO_ACTOR_UUID' },
          },
          error: options.invalidUser
            ? { message: 'invalid' }
            : null,
        }
      },
    },

    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name)

      if (isApprovalRequest) {
        assert.equal(name, 'begin_approved_official_invitation')
        assert.deepEqual(args, {
          p_application_id: APPLICATION_ID,
        })

        return options.denied
          ? { data: null, error: { code: '42501' } }
          : {
              data: [{
                reservation_id: RESERVATION_ID,
                recipient_email: OFFICER_EMAIL,
              }],
              error: null,
            }
      }

      assert.equal(name, 'begin_official_invitation')
      assert.equal(args.p_role, 'system_admin')
      assert.equal(args.p_email, ADMIN_EMAIL)
      assert.deepEqual(args.p_districts, [])

      return options.denied
        ? { data: null, error: { code: '42501' } }
        : { data: RESERVATION_ID, error: null }
    },
  }

  const service = {
    auth: {
      admin: {
        inviteUserByEmail: async (
          email: string,
          args: { redirectTo: string }
        ) => {
          calls.push('send-invite')

          assert.equal(
            email,
            isApprovalRequest ? OFFICER_EMAIL : ADMIN_EMAIL
          )
          assert.equal(
            args.redirectTo,
            env.OFFICIAL_INVITE_REDIRECT_URL
          )

          return {
            data: {
              user: options.deliveryFailure
                ? null
                : { id: 'DEMO_INVITED_UUID' },
            },
            error: options.deliveryFailure
              ? { message: 'DO_NOT_EXPOSE_PROVIDER_DETAIL' }
              : null,
          }
        },
      },
    },

    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name)

      assert.equal(
        args.p_actor_id,
        'DEMO_ACTOR_UUID',
        'Actor must come from verified Auth'
      )
      assert.equal(args.p_request_id, RESERVATION_ID)

      if (
        name === 'fail_official_invitation' &&
        options.cleanupFailure
      ) {
        throw new Error('DO_NOT_EXPOSE_PROVIDER_DETAIL')
      }

      if (name === 'finish_official_invitation') {
        assert.equal(args.p_user_id, 'DEMO_INVITED_UUID')
      }

      return {
        error:
          name === 'finish_official_invitation' &&
          options.provisionFailure
            ? { code: '42501' }
            : null,
      }
    },
  }

  const factory = ((
    _url: string,
    key: string,
    config: {
      global?: {
        headers: { Authorization: string }
      }
    }
  ) => {
    if (key === env.SUPABASE_SERVICE_ROLE_KEY) {
      calls.push('create-privileged-client')
      return service
    }

    assert.equal(
      config.global?.headers.Authorization,
      'Bearer DEMO_TOKEN_NOT_REAL'
    )
    return caller
  }) as unknown as typeof createClient

  const handler = createInviteHandler({
    env: name => env[name],
    createClient: factory,
  })

  const method = options.method ?? 'POST'
  const headers: Record<string, string> = {
    Origin: options.origin ?? env.SITE_URL,
    'Content-Type': 'application/json',
  }

  if (!options.noBearer) {
    headers.Authorization = 'Bearer DEMO_TOKEN_NOT_REAL'
  }

  const request = new Request(
    'http://127.0.0.1/functions/v1/invite-official',
    {
      method,
      headers,
      ...(method === 'POST'
        ? { body: JSON.stringify(requestBody) }
        : {}),
    }
  )

  return { run: () => handler(request), calls }
}

Deno.test('approved officer invitation follows authorized sequence', async () => {
  const test = harness()
  const response = await test.run()

  assert.equal(response.status, 200)
  assert.deepEqual(test.calls, [
    'verify-user',
    'begin_approved_official_invitation',
    'create-privileged-client',
    'send-invite',
    'finish_official_invitation',
  ])
  assert.equal(
    (await response.json()).user_id,
    'DEMO_INVITED_UUID'
  )
})

Deno.test('unapproved application cannot trigger invitation', async () => {
  const test = harness({ denied: true })
  const response = await test.run()

  assert.equal(response.status, 403)
  assert.deepEqual(test.calls, [
    'verify-user',
    'begin_approved_official_invitation',
  ])
})

Deno.test('anonymous and invalid users cannot invite officers', async () => {
  for (const options of [
    { noBearer: true },
    { invalidUser: true },
  ]) {
    const test = harness(options)

    assert.equal((await test.run()).status, 401)
    assert.ok(!test.calls.includes('send-invite'))
    assert.ok(!test.calls.includes('create-privileged-client'))
  }
})

Deno.test('browser cannot override approved permissions', async () => {
  const bodies = [
    {
      application_id: APPLICATION_ID,
      role: 'system_admin',
    },
    {
      application_id: APPLICATION_ID,
      districts: ['Raigad'],
    },
    {
      application_id: APPLICATION_ID,
      email: 'attacker@example.invalid',
    },
    {
      application_id: 'invalid-uuid',
    },
    {
      email: OFFICER_EMAIL,
      role: 'district_officer',
      districts: ['Pune'],
    },
    {
      email: OFFICER_EMAIL,
      role: 'senior_officer',
      districts: ['Pune'],
    },
  ]

  for (const body of bodies) {
    const test = harness({ body })
    const response = await test.run()

    assert.equal(response.status, 400)
    assert.deepEqual(test.calls, ['verify-user'])
  }
})

Deno.test('separate system administrator invitation is supported', async () => {
  const test = harness({
    body: {
      email: ADMIN_EMAIL,
      role: 'system_admin',
      districts: [],
    },
  })

  const response = await test.run()

  assert.equal(response.status, 200)
  assert.deepEqual(test.calls, [
    'verify-user',
    'begin_official_invitation',
    'create-privileged-client',
    'send-invite',
    'finish_official_invitation',
  ])
})

Deno.test('administrator reservation denial prevents email delivery', async () => {
  const test = harness({
    denied: true,
    body: {
      email: ADMIN_EMAIL,
      role: 'system_admin',
      districts: [],
    },
  })

  assert.equal((await test.run()).status, 403)
  assert.ok(!test.calls.includes('send-invite'))
})

Deno.test('revoked authorization during provisioning fails closed', async () => {
  const test = harness({ provisionFailure: true })
  const response = await test.run()

  assert.equal(response.status, 400)
  assert.ok(test.calls.includes('finish_official_invitation'))
  assert.ok(test.calls.includes('fail_official_invitation'))
  assert.ok(!(await response.text()).includes('user_id'))
})

Deno.test('delivery and cleanup failures hide provider details', async () => {
  const test = harness({
    deliveryFailure: true,
    cleanupFailure: true,
  })

  const response = await test.run()

  assert.equal(response.status, 400)
  assert.ok(test.calls.includes('fail_official_invitation'))
  assert.ok(
    !(await response.text()).includes(
      'DO_NOT_EXPOSE_PROVIDER_DETAIL'
    )
  )
})

Deno.test('unsafe redirects are rejected', async () => {
  const environments: Record<string, string>[] = [
    {
      OFFICIAL_INVITE_REDIRECT_URL:
        'https://untrusted.example.invalid/official/accept-invite',
    },
    {
      OFFICIAL_INVITE_REDIRECT_URL:
        'http://127.0.0.1:5173/official/accept-invite?next=bad',
    },
    {
      SITE_URL: 'ftp://localhost',
      OFFICIAL_INVITE_REDIRECT_URL:
        'ftp://localhost/official/accept-invite',
    },
  ]

  for (const environment of environments) {
    const test = harness({ environment })

    assert.equal((await test.run()).status, 503)
    assert.deepEqual(test.calls, [])
  }
})

Deno.test('wrong origins and invalid configuration are blocked', async () => {
  const cases: Array<[Options, number]> = [
    [{ origin: 'https://untrusted.example.invalid' }, 403],
    [{ environment: { SUPABASE_SERVICE_ROLE_KEY: '' } }, 503],
    [{ method: 'GET' }, 405],
  ]

  for (const [options, expected] of cases) {
    const test = harness(options)

    assert.equal((await test.run()).status, expected)
    assert.deepEqual(test.calls, [])
  }
})
