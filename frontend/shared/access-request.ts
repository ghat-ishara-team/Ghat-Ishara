// Public validation only. No service configuration, persistence or credentials here.
export const requestDistricts = ['Pune', 'Raigad', 'Ratnagiri', 'Satara'] as const
export const requestLimits = { fullName: 120, email: 254, department: 160, designation: 120, reason: 2000 } as const
export type AccessRequest = Record<keyof typeof requestLimits, string> & { districts: string[] }
export type RequestErrors = Partial<Record<keyof AccessRequest, string>>
export function validateAccessRequest(value: unknown): { data: AccessRequest | null; errors: RequestErrors } {
  const errors: RequestErrors = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { data: null, errors: { fullName: 'Provide the requested applicant information.' } }
  const source = value as Record<string, unknown>
  const data = { districts: source.districts } as AccessRequest
  for (const [field, maximum] of Object.entries(requestLimits) as [keyof typeof requestLimits, number][]) {
    const input = source[field]
    const text = typeof input === 'string' ? input.trim() : ''
    data[field] = field === 'email' ? text.toLowerCase() : text
    if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) errors[field] = `Enter between 1 and ${maximum} characters.`
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = 'Enter a valid official email address.'
  if (data.reason.length < 20) errors.reason = 'Explain why you need access using at least 20 characters.'
  if (!Array.isArray(source.districts) || source.districts.length < 1 || source.districts.length > 4 ||
    source.districts.some(d => !requestDistricts.includes(d as typeof requestDistricts[number])) || new Set(source.districts).size !== source.districts.length) errors.districts = 'Choose one or more supported districts, without duplicates.'
  if (Object.keys(source).some(key => ![...Object.keys(requestLimits), 'districts'].includes(key))) errors.fullName = 'Only applicant information and requested districts may be submitted.'
  return { data: Object.keys(errors).length ? null : data, errors }
}
export const submissionMessage = 'If this request can be processed, a verification email will arrive. Check your inbox and spam folder. This does not create an account or grant access.'
export const verificationMessage = 'Verification processed. A valid, unused link confirms your email only. It does not approve access or create an account. If the link expired, submit your request again.'
