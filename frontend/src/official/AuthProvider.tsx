import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { officialProject, supabase } from './supabase'
import { clearOfficialDrafts, synchronizeOfficialOwner } from '../persistence/storage'
import { parseOfficialContext } from './types'
import type { OfficialContext } from './types'

type AuthState = { session: Session | null; official: OfficialContext | null; loading: boolean; revalidating: boolean; error: string | null }
type AuthValue = AuthState & { configured: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, official: null, loading: !!supabase, revalidating: false, error: null })
  const stateRef = useRef(state)
  const commit = useCallback((next: AuthState) => { stateRef.current = next; setState(next) }, [])
  const generation = useRef(0)
  const mounted = useRef(false)

  const load = useCallback(async (session: Session | null) => {
    const request = ++generation.current
    if (!mounted.current) return
    if (officialProject) synchronizeOfficialOwner(officialProject, session?.user.id ?? null)
    const previous = stateRef.current
    const sameVerifiedUser = !!session && previous.session?.user.id === session.user.id && previous.official?.status === 'active' && !!previous.official.role
    // A focus/token refresh is a background check, not a reason to unmount the page.
    // Initial sessions/account switches still block rendering until verified.
    commit({ session, official: sameVerifiedUser ? previous.official : null,
      loading: !!session && !sameVerifiedUser, revalidating: !!session && sameVerifiedUser, error: null })
    if (!supabase || !session) return
    try {
      const { data, error } = await supabase.rpc('get_official_context')
      if (error) throw error
      const official = parseOfficialContext(data)
      if (official && official.user_id !== session.user.id) throw new Error('Invalid access identity')
      if (mounted.current && request === generation.current) {
        if (officialProject) {
          if (!official || official.status !== 'active' || !official.role) clearOfficialDrafts(officialProject, session.user.id)
          else if (official.role !== 'system_admin') clearOfficialDrafts(officialProject, session.user.id, ['admin.invitation', 'admin.management'])
        }
        commit({ session, official, loading: false, revalidating: false, error: null })
      }
    } catch {
      if (mounted.current && request === generation.current) commit({ session, official: null, loading: false, revalidating: false, error: 'We could not verify your official access. Please retry or contact your administrator.' })
    }
  }, [commit])
  const refresh = useCallback(async () => {
    if (!supabase) return
    try {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      await load(data.session)
    } catch {
      ++generation.current
      if (mounted.current) commit({ session: null, official: null, loading: false, revalidating: false, error: 'Session unavailable. Please sign in again.' })
    }
  }, [load, commit])

  useEffect(() => {
    mounted.current = true
    if (!supabase) return () => { mounted.current = false }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Supabase calls this under its Auth lock; defer database work until after the callback.
      queueMicrotask(() => { if (mounted.current) void load(session) })
    })
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      ++generation.current
      subscription.unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [load, refresh])

  const logout = useCallback(async () => {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) throw new Error('Sign-out could not be completed. Please retry.')
    await load(null)
  }, [load])

  return <AuthContext.Provider value={{ ...state, configured: !!supabase, refresh, logout }}>{children}</AuthContext.Provider>
}

export function useOfficialAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('Official auth provider is required')
  return value
}
