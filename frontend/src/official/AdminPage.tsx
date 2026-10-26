import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { MailPlus, RefreshCw } from 'lucide-react'
import { useOfficialAuth } from './AuthProvider'
import { PortalFrame } from './OfficialPortal'
import { supabase } from './supabase'
import { districts, roles, roleLabels } from './types'
import type { AuditLog, District, ManagedOfficial, OfficialRole, OfficialStatus, Profile } from './types'

function DistrictPicker({ value, onChange, disabled, id }: { value: District[]; onChange: (value: District[]) => void; disabled: boolean; id: string }) {
  return <fieldset className="district-picker" disabled={disabled}><legend>Assigned districts</legend>{districts.map(district => <label key={district} htmlFor={`${id}-${district}`}><input id={`${id}-${district}`} type="checkbox" checked={value.includes(district)} onChange={event => onChange(event.target.checked ? [...value, district] : value.filter(item => item !== district))} />{district}</label>)}</fieldset>
}

export default function AdminPage() {
  const { official } = useOfficialAuth()
  const [accounts, setAccounts] = useState<ManagedOfficial[]>([])
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OfficialRole>('district_officer')
  const [scope, setScope] = useState<District[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [editRole, setEditRole] = useState<OfficialRole>('district_officer')
  const [editScope, setEditScope] = useState<District[]>([])
  const [editStatus, setEditStatus] = useState<OfficialStatus>('active')

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    try {
      const [profiles, audit] = await Promise.all([
        supabase.from('official_profiles').select('user_id,invitation_email,status,invited_at,accepted_at').order('invited_at', { ascending: false }).limit(100).returns<Profile[]>(),
        supabase.from('audit_logs').select('id,actor_id,target_user_id,action,created_at').order('created_at', { ascending: false }).limit(100).returns<AuditLog[]>(),
      ])
      if (profiles.error || audit.error) throw new Error('read')
      const ids = (profiles.data ?? []).map(profile => profile.user_id)
      if (ids.length) {
        const [assignedRoles, assignedDistricts] = await Promise.all([
          supabase.from('official_role_assignments').select('user_id,role').in('user_id', ids).returns<{ user_id: string; role: OfficialRole }[]>(),
          supabase.from('official_district_assignments').select('user_id,district').in('user_id', ids).returns<{ user_id: string; district: District }[]>(),
        ])
        if (assignedRoles.error || assignedDistricts.error) throw new Error('read')
        setAccounts((profiles.data ?? []).flatMap(profile => {
          const assigned = assignedRoles.data?.find(item => item.user_id === profile.user_id)
          return assigned ? [{ ...profile, role: assigned.role, districts: (assignedDistricts.data ?? []).filter(item => item.user_id === profile.user_id).map(item => item.district) }] : []
        }))
      } else setAccounts([])
      setLogs(audit.data ?? [])
    } catch { setError('Administrative records could not be loaded. Your permissions may have changed. Retry or contact the project operator.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function invite(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    if (role !== 'system_admin' && !scope.length) { setError('Assign at least one district to an officer.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const { data, error: invitationError } = await supabase.functions.invoke('invite-official', { body: { email: email.trim(), role, districts: scope } })
      if (invitationError || !data?.user_id) throw new Error('invite')
      setMessage('Invitation issued. The official must accept the email link and set their password within one hour.')
      setEmail(''); setScope([])
      await load()
    } catch { setError('Invitation could not be issued. Check account status, existing accounts, configuration and the hourly limit. If an email was sent, ask the project operator to review its provisioning state before retrying.') }
    finally { setBusy(false) }
  }
  function selectAccount(id: string) {
    setSelectedId(id); setMessage(''); setError('')
    const account = accounts.find(item => item.user_id === id)
    if (account) { setEditRole(account.role); setEditScope(account.districts); setEditStatus(account.status) }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !selectedId) return
    if (editRole !== 'system_admin' && !editScope.length) { setError('Assign at least one district to an officer.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const { error: updateError } = await supabase.rpc('admin_update_official', { p_user_id: selectedId, p_role: editRole, p_districts: editScope, p_status: editStatus })
      if (updateError) throw updateError
      setMessage('Account permissions updated. Database access checks use the new permissions immediately.')
      setSelectedId('')
      await load()
    } catch { setError('Account update was rejected. Verify administrator access, district scope and invitation acceptance. You cannot change your own account.') }
    finally { setBusy(false) }
  }
  const selected = accounts.find(account => account.user_id === selectedId)
  const self = selectedId === official?.user_id

  return <PortalFrame title="Administration, with accountability." intro="Invite approved officials, manage district access and review administrative changes.">
    {error && <p role="alert" className="portal-message portal-error">{error}</p>}{message && <p role="status" className="portal-message">{message}</p>}
    <div className="admin-grid">
      <section className="portal-card" aria-labelledby="invite-title"><MailPlus size={24} className="text-sage" aria-hidden="true" /><h2 id="invite-title">Invite an official</h2><p className="form-intro">Send an invitation to a verified, approved recipient. They choose their own password.</p><form className="portal-form" onSubmit={event => void invite(event)}>
        <label htmlFor="admin-invite-email">Recipient email</label><input id="admin-invite-email" type="email" required maxLength={254} placeholder="demo.invitee@example.invalid" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />
        <label htmlFor="admin-invite-role">Application role</label><select id="admin-invite-role" value={role} onChange={event => setRole(event.target.value as OfficialRole)} disabled={busy}>{roles.map(item => <option value={item} key={item}>{roleLabels[item]}</option>)}</select>
        <DistrictPicker id="invite" value={scope} onChange={setScope} disabled={busy} />
        <p className="field-hint">Officers need at least one district. Administrative authority alone does not grant district records. Maximum 10 invitation requests per administrator per hour.</p>
        <button className="button button-green" type="submit" disabled={busy}>{busy ? 'Working…' : 'Send invitation'}</button>
      </form></section>
      <section className="portal-card" aria-labelledby="manage-title"><h2 id="manage-title">Manage account access</h2><p className="form-intro">A second administrator must approve changes to your own account.</p>{loading ? <p role="status">Loading accounts…</p> : <form className="portal-form" onSubmit={event => void save(event)}>
        <label htmlFor="managed-account">Official account · latest 100</label><select id="managed-account" value={selectedId} onChange={event => selectAccount(event.target.value)} disabled={busy}><option value="">Select an account</option>{accounts.map(account => <option key={account.user_id} value={account.user_id}>{account.invitation_email} · {account.status}</option>)}</select>
        {selected && <><label htmlFor="managed-role">Application role</label><select id="managed-role" value={editRole} onChange={event => setEditRole(event.target.value as OfficialRole)} disabled={self || busy}>{roles.map(item => <option key={item} value={item}>{roleLabels[item]}</option>)}</select>
          <DistrictPicker id="manage" value={editScope} onChange={setEditScope} disabled={self || busy} />
          <label htmlFor="managed-status">Account status</label><select id="managed-status" value={editStatus} onChange={event => setEditStatus(event.target.value as OfficialStatus)} disabled={self || busy}>{selected.status === 'invited' && <option value="invited">Invited</option>}{selected.accepted_at && <option value="active">Active</option>}<option value="inactive">Inactive</option></select>
          {self && <p className="field-hint">Your account cannot be changed here. Ask another active administrator.</p>}
          <button className="button button-green" type="submit" disabled={self || busy}>Save access changes</button></>}
      </form>}</section>
    </div>
    <section className="portal-card audit-card" aria-labelledby="audit-title"><div className="section-heading"><h2 id="audit-title">Administrative audit log</h2><button className="portal-quiet-button" onClick={() => { setError(''); void load() }} disabled={loading || busy}><RefreshCw size={15} aria-hidden="true" />Refresh</button></div><p className="field-hint">Latest 100 entries. Invitation tokens and passwords are never recorded here.</p>{loading ? <p role="status">Loading audit entries…</p> : logs.length ? <div className="portal-table-wrap"><table><caption className="sr-only">Administrative changes</caption><thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Actor UUID</th><th scope="col">Target UUID</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{new Date(log.created_at).toLocaleString()}</td><td>{log.action}</td><td>{log.actor_id ?? 'Trusted database operation'}</td><td>{log.target_user_id ?? '—'}</td></tr>)}</tbody></table></div> : <p className="empty-state">No audit entries available.</p>}</section>
  </PortalFrame>
}
