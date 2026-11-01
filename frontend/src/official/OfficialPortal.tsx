import { useLayoutEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, LockKeyhole, LogOut, ShieldCheck } from 'lucide-react'
import { AuthProvider, useOfficialAuth } from './AuthProvider'
import { captureInvitation, clearInvitationToken, getInvitationToken, supabase } from './supabase'
import { parseOfficialContext } from './types'
import Dashboard from './Dashboard'
import AdminPage from './AdminPage'
import './official.css'

export function PortalFrame({ children, title, intro }: { children: ReactNode; title: string; intro?: string }) {
  const { session, official, logout } = useOfficialAuth()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  async function signOut() {
    setBusy(true); setError('')
    try { await logout(); navigate('/official/login', { replace: true }) }
    catch { setError('Sign-out could not be completed. Please retry.') }
    finally { setBusy(false) }
  }
  return <main id="main-content" tabIndex={-1} className="portal-page page-width">
    <Link className="back-link" to="/"><ArrowLeft size={16} aria-hidden="true" />Back to GHAT ISHARA</Link>
    <div className="portal-topline"><p className="eyebrow"><ShieldCheck size={15} aria-hidden="true" />Invitation-only official access</p>
      {official?.status === 'active' && official.role && <nav aria-label="Official navigation" className="portal-nav">
        <NavLink to="/official/dashboard">Dashboard</NavLink>
        {official.role === 'system_admin' && <NavLink to="/official/admin">Administration</NavLink>}
      </nav>}
    </div>
    <div className="portal-heading"><div><h1>{title}</h1>{intro && <p>{intro}</p>}</div>
      {session && <button type="button" className="portal-quiet-button" onClick={() => void signOut()} disabled={busy}><LogOut size={15} aria-hidden="true" />{busy ? 'Signing out…' : 'Sign out'}</button>}
    </div>
    {error && <p className="portal-message portal-error" role="alert">{error}</p>}
    {children}
  </main>
}

function AuthShell({ children, title }: { children: ReactNode; title: string }) {
  return <PortalFrame title="For those who safeguard the Ghats." intro="A shared landscape. A trusted circle of people working toward a safer tomorrow.">
    <div className="auth-layout">
      <div className="auth-intro"><ShieldCheck size={42} strokeWidth={1.2} aria-hidden="true" /><h2>Insight with responsibility.</h2><p>Official access is reserved for invited district officers, senior officers and system administrators.</p><p>Your role and assigned districts determine the records available to you.</p><span className="auth-region">Pune · Raigad · Ratnagiri · Satara</span></div>
      <section className="portal-card auth-card" aria-labelledby="auth-form-title"><LockKeyhole size={24} className="text-sage" aria-hidden="true" /><h2 id="auth-form-title">{title}</h2>{children}</section>
    </div>
  </PortalFrame>
}

function ConfigurationNotice() {
  return <p className="portal-message" role="status">Official sign-in is not configured for this deployment. No authentication requests can be made yet. Contact the project administrator.</p>
}

function LoginPage() {
  const { configured, session, official, loading, error: accessError } = useOfficialAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (loading) return <PortalFrame title="Checking your access…"><p role="status">Verifying your session and permissions.</p></PortalFrame>
  if (official?.status === 'active' && official.role) return <Navigate to="/official/dashboard" replace />
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true); setError('')
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) throw signInError
      setPassword('')
    } catch { setError('Unable to sign in. Check your details or contact your administrator.') }
    finally { setBusy(false) }
  }
  return <AuthShell title="Welcome back.">
    <p className="form-intro">Sign in to your official workspace.</p>
    {!configured && <ConfigurationNotice />}
    {session ? <div className="portal-message" role="status">{accessError ?? (official?.status === 'invited' ? 'Your invitation has not been accepted. Use your invitation email to set your password before its link expires.' : 'This account does not have active official access. Contact your administrator.')}<p>Use Sign out above to switch accounts.</p></div> : <form onSubmit={event => void submit(event)} className="portal-form">
      <label htmlFor="official-email">Email address</label><input id="official-email" type="email" autoComplete="username" placeholder="demo.officer@example.invalid" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={!configured || busy} />
      <label htmlFor="official-password">Password</label><input id="official-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={!configured || busy} />
      {(error || accessError) && <p className="portal-message portal-error" role="alert">{error || accessError}</p>}
      <button className="button button-green" disabled={!configured || busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={18} aria-hidden="true" /></button>
    </form>}
    <p className="form-footnote">Need access? Ask your system administrator for an invitation. Public maps remain available without an account.</p>
    <Link className="portal-text-link" to="/map">Return to the public map <ArrowRight size={14} aria-hidden="true" /></Link>
  </AuthShell>
}

function AcceptInvitePage() {
  const { configured, logout } = useOfficialAuth()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null)
  const [token, setToken] = useState(getInvitationToken)
  const location = useLocation()
  useLayoutEffect(() => {
    // Email links may arrive as same-document hash navigation after this module loaded.
    setToken(captureInvitation())
    setVerifiedUserId(null)
  }, [location.key, location.hash, location.search])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!supabase || (!token && !verifiedUserId)) return
    if (password.length < 12 || password.length > 128 || password !== confirmation) {
      setError('Use 12–128 characters and enter the same password in both fields.'); return
    }
    setBusy(true); setError('')
    try {
      let userId = verifiedUserId
      if (!userId) {
        const { data, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: token!, type: 'invite' })
        if (verifyError || !data.user) throw new Error('verify')
        userId = data.user.id
        setVerifiedUserId(userId)
        clearInvitationToken()
        setToken(null)
      }
      const { data: current, error: identityError } = await supabase.auth.getUser()
      if (identityError || current.user?.id !== userId) throw new Error('identity')
      const { data, error: contextError } = await supabase.rpc('get_official_context')
      const profile = parseOfficialContext(data)
      if (contextError || !profile || profile.status !== 'invited' || new Date(profile.invitation_expires_at).getTime() <= Date.now()) throw new Error('profile')
      const { error: passwordError } = await supabase.auth.updateUser({ password })
      if (passwordError) throw passwordError
      const { error: activationError } = await supabase.rpc('complete_official_invitation')
      if (activationError) throw activationError
      setPassword(''); setConfirmation(''); setComplete(true)
      await logout()
    } catch {
      setError('Invitation setup could not be completed. The link may be expired, already used, or access may not be available. Check your connection and retry on this page, or contact your administrator for help.')
    } finally { setBusy(false) }
  }
  return <AuthShell title={complete ? 'You’re ready to sign in.' : 'Your invitation. Your workspace.'}>
    {!configured && <ConfigurationNotice />}
    {complete && error && <p className="portal-message portal-error" role="alert">Your invitation was accepted, but sign-out could not be completed. Use Sign out above before signing in again.</p>}
    {complete ? <><p className="portal-message" role="status">Your password has been set and your invitation accepted.</p><Link to="/official/login" className="button button-green">Go to sign in<ArrowRight size={18} aria-hidden="true" /></Link></> : <>
      <p className="form-intro">Choose a strong, unique password to accept your invitation. Your administrator has already assigned your role and districts.</p>
      {!token && !verifiedUserId && <p className="portal-message portal-error" role="alert">A valid invitation email link is required. If your link expired or was already used, contact your administrator. If you already accepted it, sign in below.</p>}
      <form className="portal-form" onSubmit={event => void submit(event)}>
        <label htmlFor="invite-password">Create password</label><input id="invite-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} disabled={!configured || (!token && !verifiedUserId) || busy} aria-describedby="password-hint" />
        <p id="password-hint" className="field-hint">Use at least 12 characters. A unique passphrase works well.</p>
        <label htmlFor="invite-confirmation">Confirm password</label><input id="invite-confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={!configured || (!token && !verifiedUserId) || busy} />
        {error && <p className="portal-message portal-error" role="alert">{error}</p>}
        <button type="submit" className="button button-green" disabled={!configured || (!token && !verifiedUserId) || busy}>{busy ? 'Accepting invitation…' : 'Set password & accept'}<ArrowRight size={17} aria-hidden="true" /></button>
      </form>
      <Link className="portal-text-link" to="/official/login">Already accepted? Sign in</Link>
    </>}
  </AuthShell>
}

function RequireOfficial({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { session, official, loading, error, refresh } = useOfficialAuth()
  if (loading) return <PortalFrame title="Checking your access…"><p role="status">Verifying your session and permissions.</p></PortalFrame>
  if (!session) return <Navigate to="/official/login" replace />
  if (error) return <PortalFrame title="Access could not be verified."><p className="portal-message portal-error" role="alert">{error}</p><button className="button button-outline" onClick={() => void refresh()}>Retry verification</button></PortalFrame>
  if (!official || official.status !== 'active' || !official.role || (admin && official.role !== 'system_admin')) return <PortalFrame title="Access restricted."><p className="portal-message" role="status">{admin && official?.status === 'active' ? 'Administration is available only to active system administrators.' : 'Your account does not have active official permissions. Contact your administrator.'}</p><Link className="portal-text-link" to={official?.status === 'active' ? '/official/dashboard' : '/official/login'}>Return to {official?.status === 'active' ? 'dashboard' : 'sign in'}</Link></PortalFrame>
  return children
}

export default function OfficialPortal() {
  return <AuthProvider><Routes>
    <Route path="login" element={<LoginPage />} />
    <Route path="accept-invite" element={<AcceptInvitePage />} />
    <Route path="dashboard" element={<RequireOfficial><Dashboard /></RequireOfficial>} />
    <Route path="admin" element={<RequireOfficial admin><AdminPage /></RequireOfficial>} />
    <Route path="*" element={<Navigate to="/official/login" replace />} />
  </Routes></AuthProvider>
}
