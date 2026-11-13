import { useEffect } from 'react'
import { districts } from '../official/types'
import type { District } from '../official/types'
import { usePersistentState } from './hooks'
import type { OfficialScope, PersistenceSchema } from './storage'

export const mapLayers = ['susceptibility', 'district-boundaries', 'terrain'] as const
export type MapPreferences = {
  district: District | null; layers: (typeof mapLayers[number])[]; opacity: number
  position: { longitude: number; latitude: number; zoom: number }
}
const parse = (value: unknown): MapPreferences | null => {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if ((input.district !== null && !districts.includes(input.district as District)) || !Array.isArray(input.layers)
    || input.layers.length > mapLayers.length || !input.layers.every(layer => mapLayers.includes(layer))
    || new Set(input.layers).size !== input.layers.length || !Number.isFinite(input.opacity) || Number(input.opacity) < 0 || Number(input.opacity) > 1
    || !input.position || typeof input.position !== 'object') return null
  const position = input.position as Record<string, unknown>
  if (![position.longitude, position.latitude, position.zoom].every(Number.isFinite)
    || Math.abs(Number(position.longitude)) > 180 || Math.abs(Number(position.latitude)) > 85 || Number(position.zoom) < 0 || Number(position.zoom) > 22) return null
  return { district: input.district as District | null, layers: [...input.layers], opacity: input.opacity as number,
    position: { longitude: Number(position.longitude), latitude: Number(position.latitude), zoom: Number(position.zoom) } }
}
const initial = (): MapPreferences => ({ district: null, layers: ['susceptibility', 'district-boundaries'], opacity: 0.75, position: { longitude: 73.8, latitude: 18, zoom: 7 } })
export const publicMapSchema: PersistenceSchema<MapPreferences> = { id: 'map.preferences', kind: 'public-preference', version: 1, ttlMs: 30 * 24 * 60 * 60 * 1000, debounceMs: 200, initial, parse }
export const officialMapSchema: PersistenceSchema<MapPreferences> = { ...publicMapSchema, kind: 'official-draft', ttlMs: 8 * 60 * 60 * 1000 }
export const usePublicMapPreferences = () => usePersistentState(publicMapSchema)
export function authorizedMapPreferences(value: MapPreferences, allowedDistricts: readonly District[]): MapPreferences {
  return value.district && !allowedDistricts.includes(value.district) ? { ...value, district: null } : value
}
/** Pass districts from a freshly verified official context; this does not authorize data access. */
export function useOfficialMapPreferences(owner: OfficialScope | null, allowedDistricts: readonly District[]) {
  const state = usePersistentState(officialMapSchema, owner)
  const value = authorizedMapPreferences(state.value, allowedDistricts)
  useEffect(() => { if (value !== state.value) state.setValue(value) }, [value, state.value, state.setValue])
  return { ...state, value, setValue: (update: MapPreferences | ((previous: MapPreferences) => MapPreferences)) => state.setValue(previous => authorizedMapPreferences(typeof update === 'function' ? update(previous) : update, allowedDistricts)) }
}
