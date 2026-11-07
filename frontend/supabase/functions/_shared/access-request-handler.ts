import { submissionMessage, verificationMessage, validateAccessRequest } from '../../../shared/access-request.ts'

type Service = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }
type Dependencies = {
  env: (name: string) => string | undefined
  createService: (url: string, key: string) => Service
  defer: (task: Promise<unknown>) => void
  fetchImpl?: typeof fetch
}
const MAX_BODY = 8192
class InvalidBody extends Error {}
export async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || Number(request.headers.get('content-length')) > MAX_BODY || !request.body) throw new InvalidBody()
  const reader = request.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = []; let count = 0
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          count += value.byteLength
          if (count > MAX_BODY) throw new InvalidBody()
          chunks.push(value)
        }
        const bytes = new Uint8Array(count); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InvalidBody()), 5000) }),
    ])
  } catch { throw new InvalidBody() }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}) }
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}
function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('') }
function localMailpit(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname) || /^supabase_inbucket_[a-zA-Z0-9_-]+$/.test(url.hostname))) throw new Error('configuration')
  return new URL('/api/v1/send', url)
}

export function createAccessRequestHandler(action: 'submit' | 'verify', { env, createService, defer, fetchImpl = fetch }: Dependencies) {
  return async (request: Request) => {
    const site = env('SITE_URL') ?? ''
    let allowedSite = 'null'
    try {
      const parsed = new URL(site)
      if (parsed.origin === site && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)))) allowedSite = site
    } catch { /* Never reflect an invalid origin or URL credentials into response headers. */ }
    const origin = request.headers.get('origin')
    const headers = { 'Access-Control-Allow-Origin': allowedSite, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Referrer-Policy': 'no-referrer' }
    const respond = (status: number, message: string) => new Response(JSON.stringify({ message }), { status, headers })
    if (allowedSite === 'null') return respond(503, 'Access request service is not configured.')
    if (origin && origin !== site) return respond(403, 'Origin not allowed.')
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, 'POST required.')
    let mailURL: URL; let backend: string; let serviceKey: string
    try {
      backend = env('SUPABASE_URL') ?? ''; serviceKey = env('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      if (!backend || !serviceKey) throw new Error('configuration')
      // Stage 1 has an explicit local capture adapter; no unconfigured hosted mail fallback.
      mailURL = localMailpit(env('ACCESS_REQUEST_MAILPIT_URL') ?? '')
    } catch { return respond(503, 'Access request service is not configured.') }
    let input: unknown
    try { input = await readBoundedJson(request) }
    catch { return respond(400, 'Provide a bounded JSON request with valid applicant information.') }
    try {
      if (action === 'verify') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
          !('token' in input) || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) return respond(400, 'Provide a valid verification link.')
        const { error } = await createService(backend, serviceKey).rpc('verify_official_access_request', { p_verification_hash: await digest(input.token) })
        if (error) throw new Error('storage')
        // Same response for unused, expired, replayed and unknown well-formed tokens.
        return respond(200, verificationMessage)
      }
      const { data } = validateAccessRequest(input)
      if (!data) return respond(400, 'Provide valid applicant information and supported requested districts.')
      const secret = token()
      const { data: deliver, error } = await createService(backend, serviceKey).rpc('submit_official_access_request', {
        p_application: data, p_verification_hash: await digest(secret), p_email_bucket: await digest(data.email),
      })
      if (error) throw new Error('storage')
      if (deliver === true) {
        // No SMTP/network wait in the acknowledgement path and no raw token in SQL/logs.
        defer((async () => {
          try {
            const response = await fetchImpl(mailURL, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000),
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                From: { Email: 'no-reply@ghat-ishara.example.invalid', Name: 'GHAT ISHARA local development' },
                To: [{ Email: data.email }], Subject: 'Verify your GHAT ISHARA access request',
                Text: `Confirm the email address for your access request within 20 minutes. Open this link, then press Confirm email:\n${site}/official/verify-request#token=${secret}\n\nIf you did not request access, ignore this message. Verification is not government identity verification, approval, an invitation or account creation.`,
              }) })
            await response.body?.cancel()
          } catch { /* No provider response, personal data or verification capability in logs. Retry after expiry. */ }
        })())
      }
      return respond(202, submissionMessage)
    } catch { return respond(503, 'Access request service is temporarily unavailable. Please try later.') }
  }
}
