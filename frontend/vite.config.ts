import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // Runtime checks are too late: VITE_ values can already be embedded in the bundle.
  // Reject recognizable private keys before Vite transforms any browser modules.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  for (const [name, raw] of Object.entries(env)) {
    const value = raw.trim()
    let jwtRole: unknown
    try { jwtRole = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString()).role }
    catch { /* A publishable key is not a JWT. */ }
    if (value && (value.startsWith('sb_secret_') || jwtRole === 'service_role'
      || /(?:SERVICE_ROLE|SECRET_KEY|JWT_SECRET|DATABASE_PASSWORD)/i.test(name))) {
      throw new Error('Unsafe public environment configuration: server secrets must never use the VITE_ prefix. No values have been printed.')
    }
    if (name === 'VITE_SUPABASE_PUBLISHABLE_KEY' && value && !value.startsWith('sb_publishable_') && jwtRole !== 'anon') {
      throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must be a publishable or legacy anon key. No values have been printed.')
    }
  }
  return {
    plugins: [react(), tailwindcss()],
    server: {
      fs: {
        // Preserve Vite 7 defaults and keep server credentials/private recovery plans off HTTP.
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/supabase/**'],
      },
    },
  }
})
