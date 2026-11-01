// Test-only entry point. Never included in the production website build.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { useOfficialMapPreferences, usePublicMapPreferences } from '../../src/persistence/mapPreferences'
import { synchronizeOfficialOwner } from '../../src/persistence/storage'
import type { District } from '../../src/official/types'
const owner = { project: 'https://persistence-tests.example.invalid', userId: '00000000-0000-4000-8000-000000000099' }
synchronizeOfficialOwner(owner.project, owner.userId)
function Fixture() {
  const publicState = usePublicMapPreferences()
  const [allowed, setAllowed] = useState<District[]>(['Pune', 'Satara'])
  const official = useOfficialMapPreferences(owner, allowed)
  return <main>
    <label>Public district<select aria-label="Public district" value={publicState.value.district ?? ''} onChange={event => publicState.setValue(previous => ({ ...previous, district: event.target.value as District || null }))}><option value="">All</option><option>Pune</option><option>Satara</option></select></label>
    <button onClick={() => publicState.setValue(previous => ({ ...previous, opacity: 0.4, layers: ['terrain'], position: { longitude: 74, latitude: 18.5, zoom: 9 } }))}>Change public map view</button>
    <output aria-label="Public preferences">{JSON.stringify(publicState.value)}</output><output aria-label="Public status">{publicState.status}</output>
    <label>Official district<select aria-label="Official district" value={official.value.district ?? ''} onChange={event => official.setValue(previous => ({ ...previous, district: event.target.value as District || null }))}><option value="">All</option>{allowed.map(district => <option key={district}>{district}</option>)}</select></label>
    <button onClick={() => setAllowed(['Satara'])}>Revoke Pune</button>
    <output aria-label="Official preferences">{JSON.stringify(official.value)}</output>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
