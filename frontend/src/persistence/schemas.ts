import { districts, roles } from '../official/types'
import type { District, ManagedOfficial, OfficialRole, OfficialStatus } from '../official/types'
import type { PersistenceSchema } from './storage'

const isObject = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input)
const validRole = (input: unknown): input is OfficialRole => roles.includes(input as OfficialRole)
const validStatus = (input: unknown): input is OfficialStatus => ['invited', 'active', 'inactive'].includes(String(input))
const validDistricts = (input: unknown): input is District[] => Array.isArray(input) && input.length <= 4 && input.every(item => districts.includes(item)) && new Set(input).size === input.length
const validId = (input: unknown): input is string => typeof input === 'string' && (input === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input))
const HOURS_8 = 8 * 60 * 60 * 1000

export type InvitationDraft = { email: string; role: OfficialRole; districts: District[] }
export const invitationDraftSchema = {
  id: 'admin.invitation', kind: 'official-draft' as const, version: 1, ttlMs: HOURS_8,
  initial: (): InvitationDraft => ({ email: '', role: 'district_officer', districts: [] }),
  parse(input: unknown): InvitationDraft | null {
    if (!isObject(input) || typeof input.email !== 'string' || input.email.length > 254 || !validRole(input.role) || !validDistricts(input.districts)) return null
    return { email: input.email, role: input.role, districts: [...input.districts] }
  },
} satisfies PersistenceSchema<InvitationDraft>

export type ManagementDraft = {
  selectedId: string; baseline: string
  changes: { role?: OfficialRole; districts?: District[]; status?: OfficialStatus }
}
export const managementDraftSchema = {
  id: 'admin.management', kind: 'official-draft' as const, version: 1, ttlMs: HOURS_8,
  initial: (): ManagementDraft => ({ selectedId: '', baseline: '', changes: {} }),
  parse(input: unknown): ManagementDraft | null {
    if (!isObject(input) || !validId(input.selectedId) || typeof input.baseline !== 'string' || !/^[0-9a-f]{0,16}$/.test(input.baseline) || !isObject(input.changes)) return null
    const changes: ManagementDraft['changes'] = {}
    if ('role' in input.changes) { if (!validRole(input.changes.role)) return null; changes.role = input.changes.role }
    if ('districts' in input.changes) { if (!validDistricts(input.changes.districts)) return null; changes.districts = [...input.changes.districts] }
    if ('status' in input.changes) { if (!validStatus(input.changes.status)) return null; changes.status = input.changes.status }
    return { selectedId: input.selectedId, baseline: input.baseline, changes }
  },
} satisfies PersistenceSchema<ManagementDraft>

// A UI conflict detector only, never an authorization decision or server revision lock.
export function accountFingerprint(account: ManagedOfficial) {
  const text = JSON.stringify([account.user_id, account.role, account.status, [...account.districts].sort(), account.accepted_at, account.updated_at])
  let left = 2166136261; let right = 5381
  for (let index = 0; index < text.length; index++) { left = Math.imul(left ^ text.charCodeAt(index), 16777619); right = Math.imul(right, 33) ^ text.charCodeAt(index) }
  return (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0')
}

export function reconcileManagementDraft(draft: ManagementDraft, accounts: ManagedOfficial[], viewerId: string): ManagementDraft {
  if (!draft.selectedId) return managementDraftSchema.initial()
  const account = accounts.find(item => item.user_id === draft.selectedId)
  if (!account) return managementDraftSchema.initial()
  const baseline = accountFingerprint(account)
  if (account.user_id === viewerId || draft.baseline !== baseline) return { selectedId: account.user_id, baseline, changes: {} }
  const changes = { ...draft.changes }
  if ((!account.accepted_at && changes.status === 'active') || (account.status !== 'invited' && changes.status === 'invited')) delete changes.status
  return { selectedId: account.user_id, baseline, changes }
}
