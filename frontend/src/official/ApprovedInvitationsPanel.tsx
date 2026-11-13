
import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

type ApprovedRequest = {
  id: string
  full_name: string
  email: string
  approved_role: string
  approved_districts: string[]
  reviewed_at: string
}

export default function ApprovedInvitationsPanel() {
  const [requests, setRequests] = useState<ApprovedRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadRequests = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      if (!supabase) {
        throw new Error('Supabase is not configured')
      }

      const { data, error: requestError } = await supabase.rpc(
        'admin_list_approved_access_requests',
        { p_limit: 25 }
      )

      if (requestError) throw requestError

      setRequests((data ?? []) as ApprovedRequest[])
    } catch {
      setRequests([])
      setError('Unable to load approved applications.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  const inviteOfficer = async (request: ApprovedRequest) => {
    if (!supabase || sendingId) return

    const confirmed = window.confirm(
      `Send an invitation to ${request.email}?\n\n` +
      `Role: ${request.approved_role}\n` +
      `Districts: ${request.approved_districts.join(', ')}`
    )

    if (!confirmed) return

    setSendingId(request.id)
    setError('')
    setMessage('')

    try {
      const { data, error: invitationError } =
        await supabase.functions.invoke('invite-official', {
          body: {
            application_id: request.id
          }
        })

      if (invitationError || !data?.user_id) {
        throw new Error('Invitation failed')
      }

      setMessage(
        `Invitation issued for ${request.email}. ` +
        'The officer must accept the invitation and set a password.'
      )

      await loadRequests()
    } catch {
      setError(
        'Invitation could not be completed. ' +
        'Do not retry automatically. Check the invitation audit ' +
        'and Supabase Auth state before attempting recovery.'
      )
    } finally {
      setSendingId(null)
    }
  }

  return (
    <section
      className="portal-card"
      aria-labelledby="approved-requests-title"
    >
      <div className="section-heading">
        <h2 id="approved-requests-title">
          Approved Officers
        </h2>

        <button
          type="button"
          className="portal-quiet-button"
          disabled={loading || sendingId !== null}
          onClick={() => void loadRequests()}
        >
          Refresh
        </button>
      </div>

      <p className="field-hint">
        Approved officer applications awaiting invitations.
        Roles and districts are taken from the approved
        database record.
      </p>

      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}

      {loading && (
        <p role="status">Loading approved applications…</p>
      )}

      {!loading && !error && requests.length === 0 && (
        <p className="empty-state">
          No approved officers awaiting invitation.
        </p>
      )}

      {!loading && !error && requests.map(request => (
        <article className="portal-card" key={request.id}>
          <h3>{request.full_name}</h3>

          <p>
            <strong>Email:</strong> {request.email}
          </p>

          <p>
            <strong>Approved role:</strong>{' '}
            {request.approved_role === 'district_officer'
              ? 'District Officer'
              : 'Senior Officer'}
          </p>

          <p>
            <strong>Approved districts:</strong>{' '}
            {request.approved_districts.join(', ')}
          </p>

          <p>
            <strong>Approved:</strong>{' '}
            {new Date(request.reviewed_at).toLocaleString()}
          </p>

          <button
            type="button"
            className="button button-green"
            disabled={sendingId !== null || loading}
            onClick={() => void inviteOfficer(request)}
          >
            {sendingId === request.id
              ? 'Sending invitation…'
              : 'Invite approved officer'}
          </button>
        </article>
      ))}
    </section>
  )
}
