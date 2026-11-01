import { createClient } from '@supabase/supabase-js'
import { projectIdentity, synchronizeOfficialOwner } from '../persistence/storage'
import type { OfficialScope } from '../persistence/storage'

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

const configured = validPublicConfiguration()
export const officialProject = configured ? projectIdentity(url!) : null
export const officialDraftScope = (userId: string): OfficialScope | null => officialProject ? { project: officialProject, userId } : null
export const supabase = configured ? createClient(url!, publicKey!, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'ghat-ishara-official-auth' },
}) : null

// Keep cleanup alive even when the user navigates from the portal to a public route.
// This callback performs no Supabase calls and never persists the session itself.
if (supabase && officialProject) {
  const project = officialProject
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    synchronizeOfficialOwner(project, session?.user.id ?? null)
  })
  import.meta.hot?.dispose(() => subscription.unsubscribe())
}
