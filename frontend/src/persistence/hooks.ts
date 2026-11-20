import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { getPersistentCell } from './storage'
import type { OfficialScope, PersistenceSchema } from './storage'

/** Schemas must be stable module-level allowlists. Never pass arbitrary form/auth objects. */
export function usePersistentState<T>(schema: PersistenceSchema<T>, scope?: OfficialScope | null) {
  const cell = useMemo(() => getPersistentCell(schema, scope), [schema, scope?.project, scope?.userId])
  const snapshot = useSyncExternalStore(cell.subscribe, cell.getSnapshot, cell.getSnapshot)
  useEffect(() => () => cell.flush(), [cell])
  return { ...snapshot, setValue: cell.set, clear: cell.clear }
}

export function useFormDraft<T>(schema: PersistenceSchema<T> & { kind: 'official-draft' }, owner: OfficialScope | null) {
  const state = usePersistentState(schema, owner)
  return { draft: state.value, setDraft: state.setValue, clearDraft: state.clear, status: state.status }
}
