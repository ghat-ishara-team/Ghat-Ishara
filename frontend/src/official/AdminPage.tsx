import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { MailPlus, RefreshCw } from 'lucide-react'
import { useOfficialAuth } from './AuthProvider'
import { PortalFrame } from './OfficialPortal'
import { officialDraftScope, supabase } from './supabase'
import { useFormDraft } from '../persistence/hooks'
import { accountFingerprint, invitationDraftSchema, managementDraftSchema, reconcileManagementDraft } from '../persistence/schemas'
import { DraftControls } from '../persistence/DraftControls'
import { districts, roles, roleLabels } from './types'
import type { AuditLog, District, ManagedOfficial, OfficialRole, OfficialStatus, Profile } from './types'

function DistrictPicker({ value, onChange, disabled, id }: { value: District[]; onChange: (value: District[]) => void; disabled: boolean; id: string }) {
  return <fieldset className="district-picker" disabled={disabled}><legend>Assigned districts</legend>{districts.map(district => <label key={district} htmlFor={`${id}-${district}`}><input id={`${id}-${district}`} type="checkbox" checked={value.includes(district)} onChange={event => onChange(event.target.checked ? [...value, district] : value.filter(item => item !== district))} />{district}</label>)}</fieldset>
}

export default function AdminPage() {
  const { session, official, revalidating } = useOfficialAuth()
  const owner = session ? officialDraftScope(session.user.id) : null
  const invitation = useFormDraft(invitationDraftSchema, owner)
  const management = useFormDraft(managementDraftSchema, owner)
  const { email, role, districts: scope } = invitation.draft
  const [accounts, setAccounts] = useState<ManagedOfficial[]>([])
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [accountsReady, setAccountsReady] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [managementNotice, setManagementNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const loadGeneration = useRef(0)
  const canAdminister = official?.status === 'active' && official.role === 'system_admin' && !revalidating
  const validatedManagement = useMemo(() => accountsReady
    ? reconcileManagementDraft(management.draft, accounts, official?.user_id ?? '') : managementDraftSchema.initial(),
  [accountsReady, accounts, management.draft, official?.user_id])
  const selectedId = validatedManagement.selectedId
  const selected = accountsReady ? accounts.find(account => account.user_id === selectedId) : undefined
  const self = selectedId === official?.user_id
  const editRole = validatedManagement.changes.role ?? selected?.role ?? 'district_officer'
  const editScope = validatedManagement.changes.districts ?? selected?.districts ?? []
  const editStatus = validatedManagement.changes.status ?? selected?.status ?? 'active'
  const editingDisabled = busy || loading || !!accountError || !canAdminister || self
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++loadGeneration.current }
  }, [])
  useEffect(() => {
    if (accountsReady && JSON.stringify(validatedManagement) !== JSON.stringify(management.draft)) {
      if (management.draft.selectedId) setManagementNotice(previous => previous || 'Account access changed or is no longer available. Unfinished changes were cleared; review current settings.')
      management.setDraft(validatedManagement)
    }
  }, [accountsReady, validatedManagement, management.draft, management.setDraft])

  const load = useCallback(async () => {
    if (!supabase || !mounted.current) return null
    const request = ++loadGeneration.current
    const current = () => mounted.current && request === loadGeneration.current
    setLoading(true); setAccountError('')
    try {
      const [profiles, audit] = await Promise.all([
        supabase.from('official_profiles').select('user_id,invitation_email,status,invited_at,accepted_at,updated_at').order('invited_at', { ascending: false }).limit(100).returns<Profile[]>(),
        supabase.from('audit_logs').select('id,actor_id,target_user_id,action,created_at').order('created_at', { ascending: false }).limit(100).returns<AuditLog[]>(),
      ])
      if (profiles.error || audit.error) throw new Error('read')
      const ids = (profiles.data ?? []).map(profile => profile.user_id)
      let freshAccounts: ManagedOfficial[] = []
      if (ids.length) {
        const [assignedRoles, assignedDistricts] = await Promise.all([
          supabase.from('official_role_assignments').select('user_id,role').in('user_id', ids).returns<{ user_id: string; role: OfficialRole }[]>(),
          supabase.from('official_district_assignments').select('user_id,district').in('user_id', ids).returns<{ user_id: string; district: District }[]>(),
        ])
        if (assignedRoles.error || assignedDistricts.error) throw new Error('read')
        freshAccounts = (profiles.data ?? []).flatMap(profile => {
          const assigned = assignedRoles.data?.find(item => item.user_id === profile.user_id)
          return assigned ? [{ ...profile, role: assigned.role, districts: (assignedDistricts.data ?? []).filter(item => item.user_id === profile.user_id).map(item => item.district) }] : []
        })
      }
      if (!current()) return null
      setAccounts(freshAccounts); setAccountsReady(true); setLogs(audit.data ?? [])
      return freshAccounts
    } catch {
      if (current()) setAccountError('Administrative records could not be loaded. Your permissions may have changed. Retry or contact the project operator.')
      return null
    } finally { if (current()) setLoading(false) }
  }, [])
  useEffect(() => { if (!revalidating) void load() }, [load, official, revalidating])

  async function invite(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !canAdminister || busy) return
    if (role !== 'system_admin' && !scope.length) { setError('Assign at least one district to an officer.'); return }
    const submittedDraft = invitation.draft
    setBusy(true); setError(''); setMessage('')
    try {
      const { data, error: invitationError } = await supabase.functions.invoke('invite-official', { body: { email: email.trim(), role, districts: scope } })
      if (invitationError || !data?.user_id) throw new Error('invite')
      setMessage('Invitation issued. The official must accept the email link and set their password within one hour.')
      // A late response must not erase new work entered after navigating away and back.
      invitation.setDraft(current => JSON.stringify(current) === JSON.stringify(submittedDraft) ? invitationDraftSchema.initial() : current)
      await load()
    } catch { setError('Invitation could not be issued. Check account status, existing accounts, configuration and the hourly limit. If an email was sent, ask the project operator to review its provisioning state before retrying.') }
    finally { setBusy(false) }
  }
  function selectAccount(id: string) {
    setMessage(''); setError(''); setManagementNotice('')
    const account = accounts.find(item => item.user_id === id)
    management.setDraft(account ? { selectedId: id, baseline: accountFingerprint(account), changes: {} } : managementDraftSchema.initial())
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !selected || !canAdminister || editingDisabled) return
    if (editRole !== 'system_admin' && !editScope.length) { setError('Assign at least one district to an officer.'); return }
    const submittedDraft = management.draft
    setBusy(true); setError(''); setMessage(''); setManagementNotice('')
    try {
      // Reload the target immediately before an explicit mutation. Cached UI intent is not authority.
      const freshAccounts = await load()
      const fresh = freshAccounts?.find(account => account.user_id === selectedId)
      if (!fresh || accountFingerprint(fresh) !== validatedManagement.baseline) {
        setManagementNotice('This account changed or could not be verified. Review the refreshed settings before saving.'); return
      }
      const { error: updateError } = await supabase.rpc('admin_update_official', { p_user_id: selectedId, p_role: editRole, p_districts: editScope, p_status: editStatus })
      if (updateError) throw updateError
      setMessage('Account permissions updated. Database access checks use the new permissions immediately.')
      management.setDraft(current => JSON.stringify(current) === JSON.stringify(submittedDraft) ? managementDraftSchema.initial() : current)
      await load()
    } catch { setError('Account update was rejected. Verify administrator access, district scope and invitation acceptance. You cannot change your own account.') }
    finally { setBusy(false) }
  }

  return <PortalFrame title="Administration, with accountability." intro="Invite approved officials, manage district access and review administrative changes.">
    {error && <p role="alert" className="portal-message portal-error">{error}</p>}{accountError && <p role="alert" className="portal-message portal-error">{accountError}</p>}{message && <p role="status" className="portal-message">{message}</p>}
    {revalidating && <p className="field-hint" role="status">Checking current permissions…</p>}
    <div className="admin-grid">
      <section className="portal-card" aria-labelledby="invite-title"><MailPlus size={24} className="text-sage" aria-hidden="true" /><h2 id="invite-title">Invite an official</h2><p className="form-intro">Send an invitation to a verified, approved recipient. They choose their own password.</p><form className="portal-form" onSubmit={event => void invite(event)}>
        <label htmlFor="admin-invite-email">Recipient email</label><input id="admin-invite-email" type="email" required maxLength={254} placeholder="demo.invitee@example.invalid" value={email} onChange={event => invitation.setDraft(previous => ({ ...previous, email: event.target.value }))} disabled={busy || !canAdminister} />
        <label htmlFor="admin-invite-role">Application role</label><select id="admin-invite-role" value={role} onChange={event => invitation.setDraft(previous => ({ ...previous, role: event.target.value as OfficialRole }))} disabled={busy || !canAdminister}>{roles.map(item => <option value={item} key={item}>{roleLabels[item]}</option>)}</select>
        <DistrictPicker id="invite" value={scope} onChange={value => invitation.setDraft(previous => ({ ...previous, districts: value }))} disabled={busy || !canAdminister} />
        <p className="field-hint">Officers need at least one district. Administrative authority alone does not grant district records. Maximum 10 invitation requests per administrator per hour.</p>
        <DraftControls status={invitation.status} onClear={invitation.clearDraft} disabled={busy} label="Clear invitation draft" />
        <button className="button button-green" type="submit" disabled={busy || !canAdminister}>{busy ? 'Working…' : 'Send invitation'}</button>
      </form></section>
      <section className="portal-card" aria-labelledby="manage-title"><h2 id="manage-title">Manage account access</h2><p className="form-intro">A second administrator must approve changes to your own account.</p>{!accountsReady && loading ? <p role="status">Loading accounts…</p> : <form className="portal-form" onSubmit={event => void save(event)}>
        {managementNotice && <p className="field-hint" role="status">{managementNotice}</p>}
        <label htmlFor="managed-account">Official account · latest 100</label><select id="managed-account" value={selectedId} onChange={event => selectAccount(event.target.value)} disabled={busy || loading || !!accountError || !canAdminister}><option value="">Select an account</option>{accounts.map(account => <option key={account.user_id} value={account.user_id}>{account.invitation_email} · {account.status}</option>)}</select>
        {selected && <><label htmlFor="managed-role">Application role</label><select id="managed-role" value={editRole} onChange={event => management.setDraft(previous => ({ ...previous, changes: { ...previous.changes, role: event.target.value as OfficialRole } }))} disabled={editingDisabled}>{roles.map(item => <option key={item} value={item}>{roleLabels[item]}</option>)}</select>
          <DistrictPicker id="manage" value={editScope} onChange={value => management.setDraft(previous => ({ ...previous, changes: { ...previous.changes, districts: value } }))} disabled={editingDisabled} />
          <label htmlFor="managed-status">Account status</label><select id="managed-status" value={editStatus} onChange={event => management.setDraft(previous => ({ ...previous, changes: { ...previous.changes, status: event.target.value as OfficialStatus } }))} disabled={editingDisabled}>{selected.status === 'invited' && <option value="invited">Invited</option>}{selected.accepted_at && <option value="active">Active</option>}<option value="inactive">Inactive</option></select>
          {self && <p className="field-hint">Your account cannot be changed here. Ask another active administrator.</p>}
          <button className="button button-green" type="submit" disabled={editingDisabled}>Save access changes</button></>}
        <DraftControls status={management.status} onClear={() => { management.clearDraft(); setManagementNotice('') }} disabled={busy} label="Clear account access draft" />
      </form>}</section>
    </div>
    <section className="portal-card audit-card" aria-labelledby="audit-title"><div className="section-heading"><h2 id="audit-title">Administrative audit log</h2><button className="portal-quiet-button" onClick={() => { setError(''); void load() }} disabled={loading || busy}><RefreshCw size={15} aria-hidden="true" />Refresh</button></div><p className="field-hint">Latest 100 entries. Invitation tokens and passwords are never recorded here.</p>{loading ? <p role="status">Loading audit entries…</p> : logs.length ? <div className="portal-table-wrap"><table><caption className="sr-only">Administrative changes</caption><thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Actor UUID</th><th scope="col">Target UUID</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{new Date(log.created_at).toLocaleString()}</td><td>{log.action}</td><td>{log.actor_id ?? 'Trusted database operation'}</td><td>{log.target_user_id ?? '—'}</td></tr>)}</tbody></table></div> : <p className="empty-state">No audit entries available.</p>}</section>
  </PortalFrame>
}
