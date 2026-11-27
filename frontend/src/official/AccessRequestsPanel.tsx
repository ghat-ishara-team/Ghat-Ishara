
import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

type OfficerRole = 'district_officer' | 'senior_officer'
type Decision = 'approved' | 'rejected'

type AccessRequest = {
  id: string
  full_name: string
  email: string
  department: string
  designation: string
  reason: string
  requested_districts: string[]
  submitted_at: string
  email_verified_at: string
}

export default function AccessRequestsPanel() {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [reviewId, setReviewId] = useState<string | null>(null)
  const [role, setRole] = useState<OfficerRole>('district_officer')
  const [districts, setDistricts] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [message, setMessage] = useState('')

  const loadRequests = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      if (!supabase) {
        throw new Error('Supabase is not configured')
      }

      const { data, error: requestError } = await supabase.rpc(
        'admin_list_access_requests',
        { p_limit: 25 }
      )

      if (requestError) throw requestError

      setRequests((data ?? []) as AccessRequest[])
    } catch {
      setRequests([])
      setError('Unable to load access requests.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  const startReview = (request: AccessRequest) => {
    if (submitting) return

    if (reviewId === request.id) {
      setReviewId(null)
      return
    }

    setReviewId(request.id)
    setRole('district_officer')
    setDistricts([...request.requested_districts])
    setNotes('')
    setReviewError('')
    setMessage('')
  }

  const toggleDistrict = (district: string) => {
    setDistricts(current =>
      current.includes(district)
        ? current.filter(value => value !== district)
        : [...current, district]
    )
  }

  const submitReview = async (
    request: AccessRequest,
    decision: Decision
  ) => {
    if (!supabase || submitting || reviewId !== request.id) return

    setReviewError('')
    setMessage('')

    const cleanNotes = notes.trim()

    if (cleanNotes.length < 10 || cleanNotes.length > 1000) {
      setReviewError('Review notes must contain 10–1000 characters.')
      return
    }

    if (decision === 'approved') {
      if (
        districts.length === 0 ||
        districts.some(d => !request.requested_districts.includes(d))
      ) {
        setReviewError('Select at least one requested district.')
        return
      }
    }

    setSubmitting(true)

    try {
      const { error: decisionError } = await supabase.rpc(
        'admin_review_access_request',
        {
          p_request_id: request.id,
          p_decision: decision,
          p_role: decision === 'approved' ? role : null,
          p_districts: decision === 'approved' ? districts : null,
          p_notes: cleanNotes
        }
      )

      if (decisionError) throw decisionError

      setReviewId(null)
      setNotes('')
      setDistricts([])

      setMessage(
        decision === 'approved'
          ? `${request.full_name}'s application was approved. Invitation is not yet issued.`
          : `${request.full_name}'s application was rejected.`
      )

      await loadRequests()
    } catch {
      setReviewError(
        'Unable to record the decision. Refresh the requests and verify the application is still pending.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  const notesValid =
    notes.trim().length >= 10 && notes.trim().length <= 1000

  return (
    <section
      className="portal-card"
      aria-labelledby="access-requests-title"
    >
      <div className="section-heading">
        <h2 id="access-requests-title">Officer Access Requests</h2>

        <button
          type="button"
          className="portal-quiet-button"
          onClick={() => {
            setMessage('')
            void loadRequests()
          }}
          disabled={loading || submitting}
        >
          Refresh
        </button>
      </div>

      <p className="field-hint">
        Review email-verified applications and approve only the
        permissions required for each officer.
      </p>

      {message && <p role="status">{message}</p>}

      {loading && <p role="status">Loading requests…</p>}

      {error && <p role="alert">{error}</p>}

      {!loading && !error && requests.length === 0 && (
        <p className="empty-state">No pending requests.</p>
      )}

      {!loading && !error && requests.map(request => (
        <article className="portal-card" key={request.id}>
          <h3>{request.full_name}</h3>

          <p><strong>Email:</strong> {request.email}</p>
          <p><strong>Department:</strong> {request.department}</p>
          <p><strong>Designation:</strong> {request.designation}</p>

          <p>
            <strong>Requested districts:</strong>{' '}
            {request.requested_districts.join(', ')}
          </p>

          <p><strong>Reason:</strong> {request.reason}</p>

          <p>
            <strong>Submitted:</strong>{' '}
            {new Date(request.submitted_at).toLocaleString()}
          </p>

          <button
            type="button"
            className="portal-quiet-button"
            onClick={() => startReview(request)}
            disabled={submitting}
            aria-expanded={reviewId === request.id}
          >
            {reviewId === request.id ? 'Close review' : 'Review application'}
          </button>

          {reviewId === request.id && (
            <div>
              <h4>Administrator decision</h4>

              <p className="field-hint">
                Approval records the authorized role and districts.
                Officer invitations will be issued in the next stage.
              </p>

              <div>
                <label htmlFor={`role-${request.id}`}>
                  Approved officer role
                </label>

                <select
                  id={`role-${request.id}`}
                  value={role}
                  disabled={submitting}
                  onChange={event =>
                    setRole(event.target.value as OfficerRole)
                  }
                >
                  <option value="district_officer">
                    District Officer
                  </option>
                  <option value="senior_officer">
                    Senior Officer
                  </option>
                </select>
              </div>

              <fieldset disabled={submitting}>
                <legend>Approved districts</legend>

                {request.requested_districts.map(district => (
                  <label
                    key={district}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      margin: '0.5rem 0'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={districts.includes(district)}
                      onChange={() => toggleDistrict(district)}
                    />
                    {district}
                  </label>
                ))}
              </fieldset>

              <div>
                <label htmlFor={`notes-${request.id}`}>
                  Review notes
                </label>

                <textarea
                  id={`notes-${request.id}`}
                  value={notes}
                  maxLength={1000}
                  rows={4}
                  disabled={submitting}
                  placeholder="Explain why access is approved or rejected."
                  onChange={event => setNotes(event.target.value)}
                />

                <p className="field-hint">
                  Required: 10–1000 characters. {notes.trim().length}/1000
                </p>
              </div>

              {reviewError && (
                <p role="alert">{reviewError}</p>
              )}

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  marginTop: '1rem'
                }}
              >
                <button
                  type="button"
                  disabled={
                    submitting ||
                    !notesValid ||
                    districts.length === 0
                  }
                  onClick={() => void submitReview(request, 'approved')}
                >
                  {submitting ? 'Saving…' : 'Approve'}
                </button>

                <button
                  type="button"
                  className="portal-quiet-button"
                  disabled={submitting || !notesValid}
                  onClick={() => void submitReview(request, 'rejected')}
                >
                  Reject
                </button>

                <button
                  type="button"
                  className="portal-quiet-button"
                  disabled={submitting}
                  onClick={() => setReviewId(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
    </section>
  )
}
