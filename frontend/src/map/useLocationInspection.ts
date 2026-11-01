import { useEffect, useRef, useState } from 'react'
import type { District } from '../official/types'
import { ScoreLookup, validPoint } from './scoreLookup'
import type { InspectionResult, Point } from './scoreLookup'

type State = { key: string; status: 'loading' | 'complete' | 'unavailable'; result: InspectionResult | null }
export function useLocationInspection(district: District | null) {
  const [point, setPoint] = useState<Point | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>({ key: '', status: 'loading', result: null })
  const [lookup] = useState(() => new ScoreLookup())
  const generation = useRef(0)
  const key = point ? `${point.longitude}|${point.latitude}|${district ?? 'all'}|${attempt}` : ''
  useEffect(() => {
    const request = ++generation.current
    if (!point) return
    let current = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    setState({ key, status: 'loading', result: null })
    void lookup.inspect(point, district, controller.signal).then(result => {
      if (current && generation.current === request) setState({ key, status: 'complete', result })
    }).catch(() => {
      if (current && generation.current === request) setState({ key, status: 'unavailable', result: null })
    }).finally(() => clearTimeout(timer))
    return () => { current = false; ++generation.current; clearTimeout(timer); controller.abort() }
  }, [point, district, key, lookup])
  // Never render the previous point/district's score, even before effect cleanup runs.
  const visible = state.key === key ? state : { key, status: 'loading' as const, result: null }
  return { point, ...visible, select: (next: Point) => { if (validPoint(next)) setPoint({ ...next }) }, clear: () => setPoint(null), retry: () => setAttempt(value => value + 1) }
}
export type LocationInspection = ReturnType<typeof useLocationInspection>
