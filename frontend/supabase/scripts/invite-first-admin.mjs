// Trusted project-owner CLI only. This file is never imported into the browser bundle.
import { createClient } from '@supabase/supabase-js'
import { readBootstrapConfig } from './bootstrap-config.mjs'

const { url, serviceKey, email, redirect } = readBootstrapConfig(process.env)
if (process.argv.includes('--check')) {
  console.log('Bootstrap configuration format is valid. No project requests were made; credentials and delivery have not been verified.')
} else {
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: existing, error: lookupError } = await client.from('official_role_assignments').select('user_id').eq('role', 'system_admin').limit(1)
  if (lookupError || !existing || existing.length) throw new Error('Bootstrap unavailable: verify migrations and existing administrators.')
  const { data, error } = await client.auth.admin.inviteUserByEmail(email, { redirectTo: redirect })
  if (error || !data.user) throw new Error('Bootstrap invitation failed; review Auth state in the project dashboard.')
  console.log(`Invited Auth UUID: ${data.user.id}`)
  console.log('Use this UUID in bootstrap-first-admin.sql as project owner BEFORE accepting the invitation email.')
}
