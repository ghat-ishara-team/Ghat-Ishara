import type { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'

type Dependencies = { env: (name: string) => string | undefined; createClient: typeof createClient }

const roles = ['district_officer', 'senior_officer', 'system_admin']
const districts = ['Pune', 'Raigad', 'Ratnagiri', 'Satara']

export function createInviteHandler({ env, createClient }: Dependencies) {
  return async (request: Request) => {
    const siteURL = env('SITE_URL') ?? ''
    const origin = request.headers.get('origin')
    const cors = {
      'Access-Control-Allow-Origin': origin === siteURL ? origin : siteURL,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    }
    const respond = (status: number, body: object) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
    if (origin && origin !== siteURL) return respond(403, { error: 'Origin not allowed.' })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return respond(405, { error: 'POST required.' })

    let requestId: string | null = null
    let actorId: string | null = null
    const url = env('SUPABASE_URL')
    const publicKey = env('SUPABASE_ANON_KEY')
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
    const redirect = env('OFFICIAL_INVITE_REDIRECT_URL')
    if (!url || !publicKey || !serviceKey || !siteURL || !redirect) return respond(503, { error: 'Invitation service is not configured.' })
    let service: SupabaseClient | null = null

    try {
      const redirectURL = new URL(redirect)
      if (redirectURL.origin !== siteURL || redirectURL.pathname !== '/official/accept-invite'
        || redirectURL.search || redirectURL.hash || redirectURL.username || redirectURL.password
        || !(redirectURL.protocol === 'https:' || (redirectURL.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirectURL.hostname)))) {
        return respond(503, { error: 'Invitation redirect is not configured correctly.' })
      }
      const authorization = request.headers.get('Authorization') ?? ''
      if (!authorization.startsWith('Bearer ')) return respond(401, { error: 'Sign in required.' })
      const caller = createClient(url, publicKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
      // Verify with Supabase Auth; do not merely decode or trust a browser-supplied UUID/JWT role.
      const { data: { user }, error: userError } = await caller.auth.getUser(authorization.slice(7))
      if (userError || !user) return respond(401, { error: 'Sign in required.' })
      actorId = user.id
      const text = await request.text()
      if (text.length > 4000) return respond(400, { error: 'Request too large.' })
      const body = JSON.parse(text)
      if (!body || typeof body !== 'object' || typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
        || !roles.includes(body.role) || !Array.isArray(body.districts) || body.districts.length > 4
        || body.districts.some((district: unknown) => typeof district !== 'string' || !districts.includes(district))
        || new Set(body.districts).size !== body.districts.length
        || (body.role !== 'system_admin' && body.districts.length === 0)) {
        return respond(400, { error: 'Provide a valid email, role and district assignments.' })
      }
      // Database checks active administrator status and rate limit under an advisory lock.
      const { data: reservation, error: reserveError } = await caller.rpc('begin_official_invitation', {
        p_email: body.email, p_role: body.role, p_districts: body.districts,
      })
      if (reserveError || !reservation) return respond(reserveError?.code === '42501' ? 403 : 400, {
        error: 'Invitation not authorized or request rejected. Check account status, existing accounts and the hourly invitation limit.',
      })
      requestId = reservation
      service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await service.auth.admin.inviteUserByEmail(body.email.trim().toLowerCase(), { redirectTo: redirect })
      if (error || !data.user) throw new Error('Invitation delivery failed')
      // Identity/profile provisioning is fail-closed if authorization changes during email delivery.
      const { error: provisionError } = await service.rpc('finish_official_invitation', {
        p_request_id: requestId, p_actor_id: actorId, p_user_id: data.user.id,
      })
      if (provisionError) throw new Error('Invitation provisioning failed')
      return respond(200, { message: 'Invitation issued. Access remains pending until password setup and acceptance.', user_id: data.user.id })
    } catch {
      if (service && requestId && actorId) {
        try { await service.rpc('fail_official_invitation', { p_request_id: requestId, p_actor_id: actorId }) }
        catch { /* Cleanup must not expose provider errors or produce an unhandled rejection. */ }
      }
      // Never return/log raw Auth errors, request bodies, passwords, tokens or invitation links.
      return respond(400, { error: 'Invitation could not be completed. Review the invitation audit and Auth user state before retrying.' })
    }
  }
}
