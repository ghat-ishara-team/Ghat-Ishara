export const districts = ['Pune', 'Raigad', 'Ratnagiri', 'Satara'] as const
export const roles = ['district_officer', 'senior_officer', 'system_admin'] as const
export type District = typeof districts[number]
export type OfficialRole = typeof roles[number]
export type OfficialStatus = 'invited' | 'active' | 'inactive'
export const roleLabels: Record<OfficialRole, string> = {
  district_officer: 'District officer', senior_officer: 'Senior officer', system_admin: 'System administrator',
}
export type OfficialContext = {
  user_id: string; email: string; status: OfficialStatus; role: OfficialRole | null
  districts: District[]; invitation_expires_at: string
}
export type OfficialRecord = { id: string; district: District; title: string; summary: string; created_at: string }
export type Profile = { user_id: string; invitation_email: string; status: OfficialStatus; invited_at: string; accepted_at: string | null; updated_at: string }
export type ManagedOfficial = Profile & { role: OfficialRole; districts: District[] }
export type AuditLog = { id: number; actor_id: string | null; target_user_id: string | null; action: string; created_at: string }

export function parseOfficialContext(value: unknown): OfficialContext | null {
  if (value === null) return null
  if (typeof value !== 'object' || !value) throw new Error('Invalid access response')
  const context = value as Record<string, unknown>
  if (typeof context.user_id !== 'string' || typeof context.email !== 'string'
    || !['invited', 'active', 'inactive'].includes(String(context.status))
    || (context.role !== null && !roles.includes(context.role as OfficialRole))
    || !Array.isArray(context.districts) || !context.districts.every(d => districts.includes(d))
    || typeof context.invitation_expires_at !== 'string') throw new Error('Invalid access response')
  return context as OfficialContext
}
