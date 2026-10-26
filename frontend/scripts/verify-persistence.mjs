import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

// Compile the actual browser modules, without adding a second implementation or dependency.
const output = path.resolve('qa-results/persistence-unit')
for (const file of ['persistence/storage', 'persistence/schemas', 'persistence/mapPreferences', 'persistence/hooks', 'official/types']) {
  const source = await readFile(`src/${file}.ts`, 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from '(\.\.?\/[^']+)'/g, "from '$1.mjs'")
  await mkdir(path.dirname(`${output}/${file}.mjs`), { recursive: true })
  await writeFile(`${output}/${file}.mjs`, compiled)
}
const { PersistentCell, persistenceKey, PERSISTENCE_PREFIX, ...core } = await import(`${output}/persistence/storage.mjs`)
const { invitationDraftSchema: invite, managementDraftSchema: manage, accountFingerprint, reconcileManagementDraft } = await import(`${output}/persistence/schemas.mjs`)
const { publicMapSchema: map, authorizedMapPreferences } = await import(`${output}/persistence/mapPreferences.mjs`)
class MemoryStorage {
  data = new Map(); writes = 0
  get length() { return this.data.size }
  key(index) { return [...this.data.keys()][index] ?? null }
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { this.writes++; this.data.set(key, String(value)) }
  removeItem(key) { this.data.delete(key) }
}
let count = 0
function test(name, run) { run(); count++; console.log(`PASS: ${name}`) }
const memory = new MemoryStorage()
const scope = { project: 'https://demo-project.example.invalid', userId: '00000000-0000-4000-8000-000000000001' }
const key = persistenceKey(invite, scope)
const draft = { email: 'demo.invitee@example.invalid', role: 'senior_officer', districts: ['Pune', 'Raigad'] }
let now = 1000
const cell = () => new PersistentCell(invite, key, memory, () => true, () => now)
let active = cell()
test('automatic allowlisted draft save, duplicate updates do not write', () => {
  active.set(draft); const writes = memory.writes; active.set({ ...draft }); active.flush()
  assert.equal(memory.writes, writes); assert.equal(active.getSnapshot().status, 'saved')
})
test('remount/refresh restores exact draft synchronously', () => { active.dispose(); active = cell(); assert.deepEqual(active.getSnapshot().value, draft) })
test('clear removes the envelope and restored values', () => { active.clear(); assert.equal(memory.getItem(key), null); assert.deepEqual(cell().getSnapshot().value, invite.initial()) })
test('unknown form fields never persist', () => {
  active.set({ ...draft, password: 'DEMO_ONLY_PASSWORD', access_token: 'DEMO_ONLY_TOKEN', records: [{ title: 'DEMO_RECORD' }] })
  assert.deepEqual(JSON.parse(memory.getItem(key)).value, draft)
})
test('secret-shaped strings are blocked rather than autosaved', () => {
  active.set({ ...draft, email: 'sb_secret_DEMO_ONLY@example.invalid' })
  assert.equal(active.getSnapshot().status, 'blocked'); assert.equal(memory.getItem(key), null)
})
test('corrupt JSON, wrong version, expired, future and non-allowlisted envelopes are discarded', () => {
  const valid = { version: 1, savedAt: now, expiresAt: now + invite.ttlMs, value: draft }
  for (const raw of ['{broken', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, savedAt: -invite.ttlMs, expiresAt: 0 }), JSON.stringify({ ...valid, savedAt: now + 120000 }), JSON.stringify({ ...valid, value: { ...draft, password: 'DEMO_ONLY_PASSWORD' } }), JSON.stringify({ ...valid, value: { ...draft, unexpected: 'not-approved' } })]) {
    memory.setItem(key, raw); const restored = cell(); assert.deepEqual(restored.getSnapshot().value, invite.initial()); assert.equal(memory.getItem(key), null); restored.dispose()
  }
})
test('denied or full storage keeps editable in-memory state without throwing', () => {
  for (const storage of [null, { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('denied') } }]) {
    const unavailable = new PersistentCell(invite, key, storage); unavailable.set(draft)
    assert.deepEqual(unavailable.getSnapshot().value, draft); assert.equal(unavailable.getSnapshot().status, 'unavailable'); unavailable.clear(); assert.equal(unavailable.getSnapshot().status, 'unavailable'); unavailable.dispose()
  }
})
test('public preferences survive a new storage consumer; debounce batches and flushes changes', () => {
  const publicKey = persistenceKey(map); const publicCell = new PersistentCell(map, publicKey, memory)
  publicCell.set({ ...map.initial(), district: 'Satara', opacity: 0.4 }); publicCell.set(previous => ({ ...previous, opacity: 0.5 }))
  assert.equal(memory.getItem(publicKey), null); publicCell.flush(); publicCell.dispose()
  const restored = new PersistentCell(map, publicKey, memory)
  assert.equal(restored.getSnapshot().value.district, 'Satara'); assert.equal(restored.getSnapshot().value.opacity, 0.5); restored.dispose()
})
test('invalid map layers, districts, opacity and position are rejected', () => {
  for (const value of [{ ...map.initial(), district: 'Mumbai' }, { ...map.initial(), layers: ['private-records'] }, { ...map.initial(), opacity: 2 }, { ...map.initial(), position: { longitude: 300, latitude: 18, zoom: 7 } }]) assert.equal(map.parse(value), null)
})
test('revoked district selections disappear against latest permissions', () => {
  const previous = { ...map.initial(), district: 'Pune' }
  assert.equal(authorizedMapPreferences(previous, ['Satara']).district, null)
  assert.equal(authorizedMapPreferences(previous, ['Pune']), previous)
})
const target = { user_id: '00000000-0000-4000-8000-000000000003', invitation_email: 'demo.target@example.invalid', role: 'district_officer', districts: ['Pune'], status: 'active', invited_at: '2026-01-01', accepted_at: '2026-01-01', updated_at: '2026-01-01' }
const changes = { selectedId: target.user_id, baseline: accountFingerprint(target), changes: { role: 'senior_officer', districts: ['Satara'] } }
test('management intent restores only against the same fresh target revision', () => {
  assert.deepEqual(reconcileManagementDraft(changes, [target], scope.userId), changes)
  assert.deepEqual(reconcileManagementDraft(changes, [], scope.userId), manage.initial())
  assert.deepEqual(reconcileManagementDraft(changes, [{ ...target, districts: ['Raigad'] }], scope.userId).changes, {})
  assert.deepEqual(reconcileManagementDraft(changes, [{ ...target, updated_at: '2026-02-01' }], scope.userId).changes, {})
  assert.deepEqual(reconcileManagementDraft(changes, [target], target.user_id).changes, {})
})
test('pending users cannot restore activation; accepted users cannot restore invited status', () => {
  const pending = { ...target, accepted_at: null, status: 'invited' }
  assert.deepEqual(reconcileManagementDraft({ ...changes, baseline: accountFingerprint(pending), changes: { status: 'active' } }, [pending], scope.userId).changes, {})
  assert.deepEqual(reconcileManagementDraft({ ...changes, changes: { status: 'invited' } }, [target], scope.userId).changes, {})
})
const sessionStorage = new MemoryStorage(); const localStorage = new MemoryStorage()
globalThis.window = Object.assign(new EventTarget(), { sessionStorage, localStorage })
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
test('account and environment scope isolation, same-account focus retains draft', () => {
  core.synchronizeOfficialOwner(scope.project, scope.userId)
  const saved = core.getPersistentCell(invite, scope); saved.set(draft)
  core.synchronizeOfficialOwner(scope.project, scope.userId)
  assert.deepEqual(saved.getSnapshot().value, draft)
  const secondProject = { ...scope, project: 'https://other-project.example.invalid' }
  core.synchronizeOfficialOwner(secondProject.project, scope.userId)
  assert.deepEqual(core.getPersistentCell(invite, secondProject).getSnapshot().value, invite.initial())
  assert.notEqual(persistenceKey(invite, scope), persistenceKey(invite, secondProject))
})
test('account switching clears old official data and stale callbacks cannot resurrect it', () => {
  const previous = core.getPersistentCell(invite, scope)
  sessionStorage.setItem('unrelated', 'preserve'); localStorage.setItem('ghat-ishara-official-auth', 'SDK-managed-fixture')
  const second = { ...scope, userId: '00000000-0000-4000-8000-000000000002' }
  core.synchronizeOfficialOwner(scope.project, second.userId); previous.set(draft); previous.flush()
  assert.equal(sessionStorage.getItem(key), null); assert.deepEqual(previous.getSnapshot().value, invite.initial())
  assert.deepEqual(core.getPersistentCell(invite, second).getSnapshot().value, invite.initial())
  assert.equal(sessionStorage.getItem('unrelated'), 'preserve'); assert.equal(localStorage.getItem('ghat-ishara-official-auth'), 'SDK-managed-fixture')
})
test('sign-out clears pending writes and retains public preferences', () => {
  core.synchronizeOfficialOwner(scope.project, scope.userId)
  const publicCell = core.getPersistentCell(map); publicCell.set({ ...map.initial(), district: 'Pune' }); publicCell.flush()
  const deferred = core.getPersistentCell({ ...invite, id: 'test.deferred', debounceMs: 200 }, scope); deferred.set(draft)
  core.synchronizeOfficialOwner(scope.project, null); window.dispatchEvent(new Event('pagehide'))
  assert.equal(sessionStorage.getItem(persistenceKey({ ...invite, id: 'test.deferred' }, scope)), null)
  assert.equal(publicCell.getSnapshot().value.district, 'Pune')
})
test('hidden tab/pagehide flushes debounced approved values', () => {
  const publicCell = core.getPersistentCell(map); publicCell.set({ ...map.initial(), district: 'Satara' })
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(publicCell.getSnapshot().status, 'saved')
})
test('unknown schemas/roles/districts cannot masquerade as official access', () => {
  assert.equal(invite.parse({ ...draft, role: 'root' }), null); assert.equal(invite.parse({ ...draft, districts: ['Mumbai'] }), null)
  assert.equal(manage.parse({ selectedId: 'not-a-uuid', baseline: '', changes: {} }), null)
  assert.equal([...sessionStorage.data.keys()].some(key => key.startsWith(PERSISTENCE_PREFIX) && /password|access_token|refresh_token/.test(sessionStorage.getItem(key))), false)
})
const expiring = new PersistentCell({ ...invite, ttlMs: 15 }, 'test.expiring', memory)
expiring.set(draft)
await new Promise(resolve => setTimeout(resolve, 30))
assert.deepEqual(expiring.getSnapshot().value, invite.initial())
assert.equal(memory.getItem('test.expiring'), null)
expiring.dispose(); passExpiry()
function passExpiry() { count++; console.log('PASS: expiration clears an already mounted in-memory draft and its stored envelope') }
active.dispose()
console.log(`PASS: ${count} persistence unit scenarios (actual storage/schema modules; no network or Supabase writes).`)
