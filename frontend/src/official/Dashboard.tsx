import { useEffect, useState } from 'react'
import { MapPin, RefreshCw } from 'lucide-react'
import { useOfficialAuth } from './AuthProvider'
import { PortalFrame } from './OfficialPortal'
import { supabase } from './supabase'
import { roleLabels } from './types'
import type { OfficialRecord } from './types'

export default function Dashboard() {
  const { official, revalidating } = useOfficialAuth()
  const districtScope = official?.districts.join(',') ?? ''
  const [records, setRecords] = useState<OfficialRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setRecords([])
    if (!supabase || revalidating) return
    void supabase.from('official_records').select('id,district,title,summary,created_at')
      .order('created_at', { ascending: false }).limit(100).returns<OfficialRecord[]>()
      .then(({ data, error: readError }) => {
        if (!current) return
        if (readError) setError('Records could not be loaded. Your permissions may have changed. Refresh your session or contact your administrator.')
        else setRecords(data ?? [])
        setLoading(false)
      })
    return () => { current = false }
  }, [official?.user_id, official?.role, districtScope, revalidating, revision])
  if (!official?.role) return null
  const visibleRecords = revalidating ? [] : records.filter(record => official.districts.includes(record.district))
  return <PortalFrame title="Your official workspace." intro="District-scoped records, available according to your current permissions.">
    <div className="portal-summary portal-card"><div><span className="portal-kicker">Signed in as</span><p>{official.email}</p><span className="role-badge">{roleLabels[official.role]}</span></div><div><span className="portal-kicker">Assigned districts</span><div className="district-tags">{official.districts.length ? official.districts.map(district => <span key={district}><MapPin size={13} aria-hidden="true" />{district}</span>) : <p>No district records assigned.</p>}</div></div></div>
    <section className="portal-card" aria-labelledby="records-title"><div className="section-heading"><h2 id="records-title">Authorized records</h2><button className="portal-quiet-button" onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw size={15} aria-hidden="true" />Refresh records</button></div>
      {loading ? <p role="status">Loading authorized records…</p> : error ? <p role="alert" className="portal-message portal-error">{error}</p> : visibleRecords.length ? <><p className="field-hint">Up to 100 most recent authorized records.</p><ul className="official-records">{visibleRecords.map(record => <li key={record.id}><span className="portal-kicker">{record.district}</span><h3>{record.title}</h3><p>{record.summary}</p></li>)}</ul></> : <p className="empty-state">No records are available for your assigned districts. This portal has no seeded operational records; data integration is a separate milestone.</p>}
    </section>
  </PortalFrame>
}
