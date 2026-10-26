import { createClient } from '@supabase/supabase-js'

// Capture only the custom invitation fragment. Remove it before any Auth requests/rendering.
// Fragments are not sent in HTTP requests. Never persist or log this token.
let invitationTokenHash: string | null = null
export function captureInvitation() {
  if (window.location.pathname !== '/official/accept-invite') return null
  if (!window.location.hash && !window.location.search) return invitationTokenHash
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const tokenHash = fragment.get('token_hash')
  const valid = fragment.get('type') === 'invite' && tokenHash && /^[a-zA-Z0-9_-]{20,1024}$/.test(tokenHash)
  window.history.replaceState(window.history.state, '', window.location.pathname)
  invitationTokenHash = valid ? tokenHash : null
  return invitationTokenHash
}
captureInvitation()
export const getInvitationToken = () => invitationTokenHash
export const clearInvitationToken = () => { invitationTokenHash = null }

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
function validPublicConfiguration() {
  if (!url || !publicKey) return false
  try {
    const parsedURL = new URL(url)
    if (parsedURL.username || parsedURL.password || parsedURL.search || parsedURL.hash
      || (parsedURL.protocol !== 'https:' && !(parsedURL.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsedURL.hostname)))) return false
    if (publicKey.startsWith('sb_publishable_')) return true
    // Support legacy anon keys, but reject secret/service-role keys accidentally pasted here.
    const payload = JSON.parse(atob(publicKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role === 'anon'
  } catch { return false }
}

export const supabase = validPublicConfiguration() ? createClient(url!, publicKey!, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'ghat-ishara-official-auth' },
}) : null
