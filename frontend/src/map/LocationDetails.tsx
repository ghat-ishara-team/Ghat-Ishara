import { MapPin, RefreshCw, X } from 'lucide-react'
import type { District } from '../official/types'
import type { LocationInspection } from './useLocationInspection'
import { formatScore, scoreBand } from './scoreLookup'

export function LocationDetails({ inspection, district, onClose }: { inspection: LocationInspection; district: District | null; onClose: () => void }) {
  if (!inspection.point) return null
  const { point, result, status } = inspection
  return <section id="location-details" className="location-details" role="region" aria-labelledby="location-title" tabIndex={-1}>
    <div className="location-heading"><h2 id="location-title"><MapPin size={16} aria-hidden="true" />Location details</h2><button type="button" onClick={onClose} aria-label="Close location details"><X size={16} aria-hidden="true" /></button></div>
    <dl className="location-coordinates"><div><dt>Latitude</dt><dd>{point.latitude.toFixed(6)}°</dd></div><div><dt>Longitude</dt><dd>{point.longitude.toFixed(6)}°</dd></div><div className="location-selected"><dt>Selected district</dt><dd>{district ?? 'All four districts'}</dd></div></dl>
    <div className="location-result" role="status" aria-live="polite" aria-atomic="true">
      {status === 'loading' ? <p>Looking up the original model score…</p> : status === 'unavailable' ? <p><strong>Numerical data unavailable.</strong> No score could be verified for this location. Check your connection or ask the site operator to prepare the numerical data.</p> : <>
        {!result?.values.length && !result?.unavailable.length && <p><strong>No model score available</strong><br />This location is outside the selected raster’s valid coverage or lies on a NoData pixel.</p>}
        {result?.values.map(sample => {
          const band = scoreBand(sample.score)
          return <div className="location-sample" key={sample.district}><span className="location-dataset">{sample.district} dataset</span><strong className="location-score" data-testid="location-score">{formatScore(sample.score)}</strong><span className="location-band"><i style={{ background: band.color }} aria-hidden="true" />Score band {band.label}</span><small>Source pixel: row {sample.row}, column {sample.column}</small></div>
        })}
        {!!result?.unavailable.length && <p className="location-unavailable"><strong>Numerical data unavailable for {result.unavailable.join(', ')}.</strong> {result.values.length ? 'Only the verified dataset scores are shown.' : 'No score could be verified. A failed lookup does not mean low susceptibility or NoData.'}</p>}
      </>}
    </div>
    {(status === 'unavailable' || !!result?.unavailable.length) && <button type="button" className="map-retry" onClick={inspection.retry}><RefreshCw size={13} aria-hidden="true" />Retry score lookup</button>}
    <p className="location-caveat">Original 30 m source cell; values shown to 9 significant digits. Scores are not calibrated landslide probabilities or live warnings. Dataset coverage is not an administrative boundary.</p>
  </section>
}
