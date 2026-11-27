export const PERSISTENCE_PREFIX = 'ghat-ishara:persist:'
export type StorageKind = 'public-preference' | 'official-draft'
export type OfficialScope = { project: string; userId: string }
export type PersistenceStatus = 'empty' | 'saving' | 'saved' | 'unavailable' | 'blocked'
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type PersistenceSchema<T> = {
  id: string; kind: StorageKind; version: number; ttlMs: number; debounceMs?: number
  initial: () => T; parse: (input: unknown) => T | null
}
export type Snapshot<T> = { value: T; status: PersistenceStatus }

export function projectIdentity(url: string) {
  const project = new URL(url)
  if (project.username || project.password || project.search || project.hash) throw new Error('Invalid persistence project')
  return project.origin + project.pathname.replace(/\/+$/, '')
}
export function officialPrefix(project: string, userId?: string) {
  const base = `${PERSISTENCE_PREFIX}official:${encodeURIComponent(projectIdentity(project))}:`
  return userId ? `${base}${encodeURIComponent(userId)}:` : base
}
export function persistenceKey<T>(schema: PersistenceSchema<T>, scope?: OfficialScope | null) {
  if (schema.kind === 'public-preference') return `${PERSISTENCE_PREFIX}public:${schema.id}`
  return scope ? `${officialPrefix(scope.project, scope.userId)}${schema.id}` : null
}

// Defense in depth after schema projection. This is not a general-purpose secret detector.
export function containsForbiddenData(value: unknown): boolean {
  if (typeof value === 'string') return /sb_(?:secret|publishable)_|(?:eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:access_token|refresh_token|token_hash|service_role_key|apikey)\s*[=:]/i.test(value)
  if (Array.isArray(value)) return value.some(containsForbiddenData)
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) =>
    /^(?:password|passwordconfirmation|accesstoken|refreshtoken|tokenhash|invitationlink|apikey|servicerolekey|secretkey)$/i.test(key.replace(/[^a-z]/gi, '')) || containsForbiddenData(item))
  return false
}

export class PersistentCell<T> {
  private snapshot: Snapshot<T>
  private listeners = new Set<() => void>()
  private pending = false
  private lastValue: string | null = null
  private expiresAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly initialValue: T
  private readonly initialJSON: string
  constructor(
    private schema: PersistenceSchema<T>, private key: string | null,
    private storage: StorageLike | null, private canAccess: () => boolean = () => true,
    private now: () => number = Date.now,
  ) {
    this.initialValue = schema.initial()
    this.initialJSON = JSON.stringify(this.initialValue)
    this.snapshot = { value: this.initialValue, status: 'empty' }
    if (!key || !storage || !canAccess()) return
    try {
      const raw = storage.getItem(key)
      if (raw === null) return
      const envelope = JSON.parse(raw)
      const value = schema.parse(envelope?.value)
      if (envelope?.version !== schema.version || !Number.isFinite(envelope.savedAt)
        || envelope.savedAt > now() + 60000 || envelope.expiresAt !== envelope.savedAt + schema.ttlMs
        || envelope.expiresAt <= now() || value === null || containsForbiddenData(envelope.value)
        || JSON.stringify(value) !== JSON.stringify(envelope.value)) {
        storage.removeItem(key); return
      }
      this.lastValue = JSON.stringify(value)
      if (this.lastValue === this.initialJSON) { storage.removeItem(key); this.lastValue = null; return }
      this.expiresAt = envelope.expiresAt
      this.snapshot = { value, status: 'saved' }
      this.scheduleExpiry()
    } catch {
      try { storage.removeItem(key) } catch { /* Storage may be denied. */ }
      this.snapshot = { value: this.initialValue, status: 'unavailable' }
    }
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: T, status: PersistenceStatus) {
    this.snapshot = { value, status }
    this.listeners.forEach(listener => listener())
  }
  private cancelPending() { clearTimeout(this.timer); this.pending = false }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer)
    if (!this.expiresAt) return
    this.expiryTimer = setTimeout(() => {
      if (this.expiresAt <= this.now()) this.clear()
      else this.scheduleExpiry()
    }, Math.min(Math.max(1, this.expiresAt - this.now()), 2147483647))
    // In Node-only tests a multi-hour browser TTL must not keep the process alive.
    if (typeof this.expiryTimer === 'object') this.expiryTimer.unref?.()
  }
  set = (update: T | ((previous: T) => T)) => {
    if (!this.canAccess()) return
    const candidate = typeof update === 'function' ? (update as (previous: T) => T)(this.snapshot.value) : update
    const projected = this.schema.parse(candidate)
    if (projected === null) return
    const json = JSON.stringify(projected)
    if (json === JSON.stringify(this.snapshot.value)) return
    this.cancelPending()
    if (containsForbiddenData(projected)) {
      clearTimeout(this.expiryTimer); this.expiresAt = 0
      this.removeStored()
      this.publish(projected, 'blocked')
      return
    }
    if (json === this.initialJSON) { this.clear(); return }
    this.pending = true
    this.expiresAt = this.now() + this.schema.ttlMs
    this.publish(projected, 'saving')
    this.scheduleExpiry()
    if (this.schema.debounceMs) this.timer = setTimeout(this.flush, this.schema.debounceMs)
    else this.flush()
  }
  flush = () => {
    clearTimeout(this.timer)
    if (!this.pending) return
    this.pending = false
    if (!this.canAccess()) { this.clear(); return }
    if (!this.key || !this.storage) { this.publish(this.snapshot.value, 'unavailable'); return }
    const valueJSON = JSON.stringify(this.snapshot.value)
    if (valueJSON === this.lastValue) { this.publish(this.snapshot.value, 'saved'); return }
    try {
      const savedAt = this.now()
      this.storage.setItem(this.key, JSON.stringify({ version: this.schema.version, savedAt, expiresAt: savedAt + this.schema.ttlMs, value: this.snapshot.value }))
      this.lastValue = valueJSON
      this.expiresAt = savedAt + this.schema.ttlMs
      this.scheduleExpiry()
      this.publish(this.snapshot.value, 'saved')
    } catch { this.publish(this.snapshot.value, 'unavailable') }
  }
  private removeStored() {
    let removed = !this.key || !!this.storage
    if (this.key && this.storage) try { this.storage.removeItem(this.key) } catch { removed = false }
    this.lastValue = null
    return removed
  }
  clear = () => {
    this.cancelPending(); clearTimeout(this.expiryTimer); this.expiresAt = 0
    const removed = this.removeStored()
    this.publish(this.schema.initial(), removed ? 'empty' : 'unavailable')
  }
  dispose = () => { this.cancelPending(); clearTimeout(this.expiryTimer); this.listeners.clear() }
}

export function browserStorage(kind: StorageKind): Storage | null {
  try { return kind === 'public-preference' ? window.localStorage : window.sessionStorage }
  catch { return null }
}

type RegistryEntry = { cell: unknown; scope: OfficialScope | null; key: string; flush: () => void; clear: () => void }
const registry = new Map<string, RegistryEntry>()
const owners = new Map<string, string | null>()
const ownerKey = (project: string) => `${officialPrefix(project)}owner`

export function clearOfficialDrafts(project: string, userId?: string, schemaIds?: string[]) {
  const prefix = officialPrefix(project, userId)
  const matches = (key: string) => key.startsWith(prefix) && (!schemaIds || schemaIds.some(id => key.endsWith(`:${id}`)))
  for (const entry of registry.values()) if (matches(entry.key)) entry.clear()
  const storage = browserStorage('official-draft')
  if (storage) try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key && matches(key)) storage.removeItem(key)
    }
  } catch { /* Owner isolation still works in memory if storage is inaccessible. */ }
}

export function synchronizeOfficialOwner(projectURL: string, userId: string | null) {
  const project = projectIdentity(projectURL)
  const storage = browserStorage('official-draft')
  let previous = owners.get(project)
  if (previous === undefined) {
    try {
      const saved = JSON.parse(storage?.getItem(ownerKey(project)) ?? 'null')
      previous = saved?.version === 1 && typeof saved.userId === 'string' ? saved.userId : null
    } catch { previous = null }
  }
  if (previous !== userId || userId === null) clearOfficialDrafts(project)
  owners.set(project, userId)
  try {
    if (userId) {
      if (previous !== userId) storage?.setItem(ownerKey(project), JSON.stringify({ version: 1, userId }))
    } else storage?.removeItem(ownerKey(project))
  } catch { /* No credential or role is ever placed in this ownership marker. */ }
}

let lifecycleInstalled = false
export function getPersistentCell<T>(schema: PersistenceSchema<T>, scope?: OfficialScope | null): PersistentCell<T> {
  const key = persistenceKey(schema, scope)
  const registryKey = key ?? `disabled:${schema.id}`
  const existing = registry.get(registryKey)
  if (existing) return existing.cell as PersistentCell<T>
  const canAccess = () => schema.kind === 'public-preference' || !!scope && owners.get(projectIdentity(scope.project)) === scope.userId
  const cell = new PersistentCell(schema, key, browserStorage(schema.kind), canAccess)
  registry.set(registryKey, { cell, scope: scope ?? null, key: registryKey, flush: cell.flush, clear: cell.clear })
  if (!lifecycleInstalled && typeof window !== 'undefined') {
    lifecycleInstalled = true
    const flush = () => registry.forEach(entry => entry.flush())
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
  }
  return cell
}
