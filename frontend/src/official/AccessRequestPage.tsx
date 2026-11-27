import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { requestDistricts, requestLimits, submissionMessage, validateAccessRequest, verificationMessage } from '../../shared/access-request'
import type { AccessRequest, RequestErrors } from '../../shared/access-request'
import { PortalFrame } from './OfficialPortal'
import { supabase } from './supabase'

const emptyRequest = (): AccessRequest => ({ fullName: '', email: '', department: '', designation: '', districts: [], reason: '' })
const labels = { fullName: 'Full name', email: 'Official email address', department: 'Department', designation: 'Designation', reason: 'Reason for requesting access' }
let requestToken: string | null = null
function captureRequestToken() {
  if (window.location.pathname !== '/official/verify-request') return null
  if (window.location.hash || window.location.search) {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
    requestToken = token && /^[a-f0-9]{64}$/.test(token) ? token : null
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }
  return requestToken
}
captureRequestToken()

export default function AccessRequestPage() {
  const [draft, setDraft] = useState(emptyRequest)
  const [errors, setErrors] = useState<RequestErrors>({})
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const summary = useRef<HTMLDivElement>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!supabase || busy) return
    const result = validateAccessRequest(draft)
    setErrors(result.errors); setFailure('')
    if (!result.data) { requestAnimationFrame(() => summary.current?.focus()); return }
    setBusy(true)
    try {
      const { error } = await supabase.functions.invoke('submit-access-request', { body: result.data })
      if (error) throw new Error('submission')
      setDraft(emptyRequest()); setComplete(true)
    } catch { setFailure('Your request could not be submitted. Please try again later.'); requestAnimationFrame(() => summary.current?.focus()) }
    finally { setBusy(false) }
  }
  return <PortalFrame title="Request official access." intro="Tell us why you need access. A verified email is required before your request can be considered.">
    <section className="portal-card auth-card" aria-label="Official access request">
      <p>Submitting a request does not create an account or grant permissions. Email verification confirms mailbox ownership, not government identity or approval. Administrator review is a later stage.</p>
      {!supabase && <p className="portal-message" role="status">Access requests are not configured for this deployment. Public maps remain available without an account.</p>}
      {complete ? <p className="portal-message" role="status">{submissionMessage}</p> : <form className="portal-form" onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
        {(Object.keys(errors).length > 0 || failure) && <div ref={summary} tabIndex={-1} role="alert" className="portal-message portal-error">
          {failure || <><p>Check the following fields:</p><ul>{Object.entries(errors).map(([field, message]) => <li key={field}><a href={`#request-${field}`}>{field === 'districts' ? 'Requested districts' : labels[field as keyof typeof labels]}: {message}</a></li>)}</ul></>}
        </div>}
        {(Object.keys(labels) as (keyof typeof labels)[]).map(field => <div className="request-field" key={field}>
          <label htmlFor={`request-${field}`}>{labels[field]}</label>
          {field === 'reason' ? <textarea id={`request-${field}`} rows={5} required minLength={20} maxLength={requestLimits[field]} value={draft[field]} onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))} disabled={!supabase || busy} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `request-${field}-error` : undefined} /> :
            <input id={`request-${field}`} type={field === 'email' ? 'email' : 'text'} required maxLength={requestLimits[field]} autoComplete={field === 'fullName' ? 'name' : field === 'email' ? 'email' : field === 'department' ? 'organization' : 'organization-title'} value={draft[field]} onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))} disabled={!supabase || busy} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `request-${field}-error` : undefined} />}
          {errors[field] && <p id={`request-${field}-error`} className="portal-error">{errors[field]}</p>}
        </div>)}
        <fieldset id="request-districts" className="district-picker" disabled={!supabase || busy} aria-describedby={errors.districts ? 'request-districts-error' : undefined} aria-invalid={!!errors.districts}>
          <legend>Requested districts</legend>{requestDistricts.map(district => <label key={district}><input type="checkbox" value={district} checked={draft.districts.includes(district)} onChange={event => setDraft(previous => ({ ...previous, districts: event.target.checked ? [...previous.districts, district] : previous.districts.filter(item => item !== district) }))} />{district}</label>)}
        </fieldset>
        {errors.districts && <p id="request-districts-error" className="portal-error">{errors.districts}</p>}
        <p className="field-hint">Choose at least one district. You cannot request an administrator role. Do not include passwords, identity documents or sensitive operational information.</p>
        <button className="button button-green" type="submit" disabled={!supabase || busy}>{busy ? 'Submitting…' : 'Submit access request'}</button>
      </form>}
      <Link className="portal-text-link" to="/official/login">Already invited? Sign in</Link>
    </section>
  </PortalFrame>
}

export function VerifyAccessRequestPage() {
  const location = useLocation()
  const [token, setToken] = useState(captureRequestToken)
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState('')
  useLayoutEffect(() => { setToken(captureRequestToken()); setComplete(false); setError('') }, [location.key, location.hash, location.search])
  async function verify() {
    if (!supabase || !token || busy) return
    setBusy(true); setError('')
    try {
      const { error: failure } = await supabase.functions.invoke('verify-access-request', { body: { token } })
      if (failure) throw new Error('verification')
      requestToken = null; setToken(null); setComplete(true)
    } catch { setError('Verification could not be processed. Try again on this page or request a new link after it expires.') }
    finally { setBusy(false) }
  }
  return <PortalFrame title="Confirm your request email.">
    <section className="portal-card auth-card" aria-label="Request email verification">
      <p>Confirm only if you submitted an access request. This step does not approve access, set a password or sign you in.</p>
      {!supabase && <p className="portal-message" role="status">Email verification is not configured for this deployment.</p>}
      {complete ? <p className="portal-message" role="status">{verificationMessage}</p> : <>
        {!token && <p className="portal-message" role="alert">A valid request verification link is required. Open the link from your verification email.</p>}
        {error && <p className="portal-message portal-error" role="alert">{error}</p>}
        <button className="button button-green" disabled={!supabase || !token || busy} onClick={() => void verify()}>{busy ? 'Confirming…' : 'Confirm email'}</button>
      </>}
      <Link className="portal-text-link" to="/official/request-access">Request access</Link>
    </section>
  </PortalFrame>
}
