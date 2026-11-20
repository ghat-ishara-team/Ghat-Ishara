// Pure local validation. No environment reads, SDK initialization or network calls.
export function readBootstrapConfig(env) {
  const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BOOTSTRAP_ADMIN_EMAIL', 'SITE_URL', 'OFFICIAL_INVITE_REDIRECT_URL']
  if (names.some(name => typeof env[name] !== 'string' || !env[name].trim())) {
    throw new Error('Bootstrap configuration is incomplete. Fill the server-only bootstrap environment file; values are not printed.')
  }
  const url = env.SUPABASE_URL.trim()
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY.trim()
  const email = env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase()
  const redirect = env.OFFICIAL_INVITE_REDIRECT_URL.trim()
  const siteURL = env.SITE_URL.trim()
  const allowedProtocol = value => value.protocol === 'https:' || (value.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(value.hostname))
  try {
    const project = new URL(url)
    const destination = new URL(redirect)
    const site = new URL(siteURL)
    if (!allowedProtocol(project) || project.username || project.password || project.search || project.hash || project.pathname !== '/'
      || !allowedProtocol(destination) || destination.username || destination.password || destination.search || destination.hash
      || destination.pathname !== '/official/accept-invite' || destination.origin !== siteURL || site.origin !== siteURL) throw new Error('redirect')
  } catch {
    throw new Error('Invalid bootstrap URLs. Use a project origin and an exact HTTPS or HTTP-loopback invitation URL matching SITE_URL; no queries or fragments.')
  }
  let role
  try { role = JSON.parse(Buffer.from(serviceKey.split('.')[1] ?? '', 'base64url').toString()).role }
  catch { /* New secret keys are not JWTs. */ }
  if (!serviceKey.startsWith('sb_secret_') && role !== 'service_role') {
    throw new Error('Bootstrap requires a server secret or legacy service-role key, not a browser publishable/anon key. Values are not printed.')
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Supply the approved recipient email in the private bootstrap environment file.')
  return { url, serviceKey, email, redirect }
}
