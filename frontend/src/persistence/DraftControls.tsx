import type { PersistenceStatus } from './storage'

const labels: Record<PersistenceStatus, string> = {
  empty: 'No local draft', saving: 'Saving…', saved: 'Saved locally',
  unavailable: 'Local saving unavailable', blocked: 'Not saved locally',
}
export function DraftControls({ status, onClear, disabled, label }: { status: PersistenceStatus; onClear: () => void; disabled: boolean; label: string }) {
  return <div className="draft-controls">
    <span className="draft-status" role="status" aria-live="polite" aria-atomic="true">{labels[status]}</span>
    <button className="portal-quiet-button" type="button" onClick={onClear} disabled={disabled} aria-label={label}>Clear Draft</button>
  </div>
}
