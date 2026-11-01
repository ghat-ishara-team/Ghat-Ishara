import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useReducedMotion } from 'motion/react'
import { AlertTriangle, ArrowLeft, Check, Layers3, LocateFixed, MapPin, Minus, Plus, RefreshCw } from 'lucide-react'
import { AttributionControl, Map as LibreMap, Marker, ScaleControl, setWorkerUrl, addProtocol } from 'maplibre-gl'
import workerURL from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { usePublicMapPreferences } from '../persistence/mapPreferences'
import type { District } from '../official/types'
import { baseStyle, boundsForDistrict, colorScale, districtById, districtCatalog, manifestURL, overlaySource, parseManifest } from './config'
import type { Manifest } from './config'
import { loadBasemapStyle, resolveBasemapConfiguration } from './basemap'
import { fetchSusceptibilityTile, tileProtocol } from './tileProtocol'
import 'maplibre-gl/dist/maplibre-gl.css'
import './map.css'
import { useLocationInspection } from './useLocationInspection'
import { LocationDetails } from './LocationDetails'

// MapLibre 6 uses a separate ESM worker; let Vite bundle its shared imports.
setWorkerUrl(workerURL)
addProtocol(tileProtocol, fetchSusceptibilityTile)
const basemap = resolveBasemapConfiguration({ VITE_BASEMAP_PROVIDER: import.meta.env.VITE_BASEMAP_PROVIDER, VITE_BASEMAP_STYLE: import.meta.env.VITE_BASEMAP_STYLE })

export default function MapExplorer() {
  const location = useLocation()
  const requestedId = new URLSearchParams(location.search).get('district')
  const requestedDistrict = districtById(requestedId)
  const preferences = usePublicMapPreferences()
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const reducedMotion = useReducedMotion()
  const reducedRef = useRef(reducedMotion)
  reducedRef.current = reducedMotion
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [styleRevision, setStyleRevision] = useState(0)
  const [basemapLoading, setBasemapLoading] = useState(true)
  const basemapFailed = useRef(false)
  const providerInstalled = useRef(false)
  const [busy, setBusy] = useState(true)
  const [mapError, setMapError] = useState(false)
  const [basemapError, setBasemapError] = useState(false)
  const [tileErrors, setTileErrors] = useState<string[]>([])
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [retry, setRetry] = useState(0)
  const { district, opacity, layers } = preferences.value
  const inspection = useLocationInspection(district)
  const inspectionRef = useRef(inspection)
  inspectionRef.current = inspection
  const overlayVisible = layers.includes('susceptibility')
  const selected = districtCatalog.find(item => item.name === district)
  const activeOverlays = (manifest?.districts ?? []).filter(item => !district || item.name === district)
  const missing = districtCatalog.filter(item => (!district || item.name === district) && !manifest?.districts.some(layer => layer.id === item.id))
  const activeTileError = activeOverlays.some(item => tileErrors.includes(item.id))

  // Apply URL intent once per navigation, not on every preference update. Controls
  // and autosave then work normally even while the original query remains in the URL.
  useEffect(() => {
    const explicit = districtById(new URLSearchParams(location.search).get('district'))
    if (!explicit) return
    preferencesRef.current.setValue(previous => ({ ...previous, district: explicit.name }))
    mapRef.current?.fitBounds(explicit.bounds, { padding: 35, duration: 0 })
  }, [location.key, location.search])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let current = true
    setDataState('loading'); setManifest(null); setTileErrors([])
    void fetch(manifestURL, { signal: controller.signal, cache: 'no-cache' }).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('missing manifest')
      const parsed = parseManifest(await response.json())
      if (!parsed) throw new Error('invalid manifest')
      if (current) { setManifest(parsed); setDataState('ready') }
    }).catch(() => { if (current) setDataState('unavailable') }).finally(() => clearTimeout(timer))
    return () => { current = false; controller.abort(); clearTimeout(timer) }
  }, [retry])

  useEffect(() => {
    if (!container.current) return
    document.getElementById('main-content')?.focus({ preventScroll: true })
    let map: LibreMap
    let current = true
    try {
      const saved = preferencesRef.current
      const position = saved.value.position
      map = new LibreMap({ container: container.current, style: baseStyle(),
        center: [Math.min(77, Math.max(71, position.longitude)), Math.min(21, Math.max(15, position.latitude))],
        zoom: Math.min(14, Math.max(6, position.zoom)), minZoom: 6, maxZoom: 14,
        maxBounds: [[71, 15], [77, 21]], renderWorldCopies: false,
        attributionControl: false, dragRotate: false, pitchWithRotate: false,
      })
      mapRef.current = map
      map.touchZoomRotate.disableRotation()
      map.addControl(new AttributionControl({ compact: false, customAttribution: basemap.attribution }), 'bottom-right')
      map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
      map.getCanvas().setAttribute('aria-label', 'Interactive susceptibility map. Arrow keys pan; plus and minus zoom. Press Enter to inspect the map center. District and layer controls follow the map.')
      map.on('style.load', () => { if (current) { setReady(true); setStyleRevision(previous => previous + 1) } })
      map.on('sourcedataloading', () => { if (current) setBusy(true) })
      map.on('idle', () => { if (current) { setBusy(false); if (providerInstalled.current) setBasemapLoading(false) } })
      map.on('error', event => {
        if (!current) return
        setBusy(false)
        const sourceId = (event as unknown as { sourceId?: string }).sourceId
        // Raster request errors can omit sourceId; their public tile URL still identifies the layer.
        const resource = (event.error as Error & { url?: string })?.url ?? event.error?.message ?? ''
        const districtFromURL = /Susceptibility tile unavailable: (pune|raigad|ratnagiri|satara)/.exec(resource)?.[1]
          ?? /\/generated-data\/susceptibility\/[a-z0-9-]+\/(pune|raigad|ratnagiri|satara)\//.exec(resource)?.[1]
        if (sourceId?.startsWith('susceptibility-') || districtFromURL) {
          const id = districtFromURL ?? sourceId!.slice('susceptibility-'.length)
          setTileErrors(previous => previous.includes(id) ? previous : [...previous, id])
        } else if (!basemapFailed.current) {
          basemapFailed.current = true
          setBasemapError(true); setBasemapLoading(false)
        }
      })
      map.on('webglcontextlost', () => { if (current) setMapError(true) })
      map.on('click', event => inspectionRef.current.select({ longitude: event.lngLat.lng, latitude: event.lngLat.lat }))
      map.getCanvas().addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); const center = map.getCenter(); inspectionRef.current.select({ longitude: center.lng, latitude: center.lat }) }
      })
      map.on('moveend', () => {
        if (!current) return
        const center = map.getCenter()
        preferencesRef.current.setValue(previous => ({ ...previous, position: { longitude: +center.lng.toFixed(6), latitude: +center.lat.toFixed(6), zoom: +map.getZoom().toFixed(3) } }))
      })
      if (requestedDistrict || saved.status !== 'saved') map.fitBounds(requestedDistrict?.bounds ?? boundsForDistrict(saved.value.district), { padding: 30, duration: 0 })
    } catch { setMapError(true); setBusy(false); return }
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)
    return () => { current = false; observer.disconnect(); map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.isStyleLoaded()) return
    // Remove only derived overlays; basemap and camera state remain intact.
    for (const item of districtCatalog) {
      const id = `susceptibility-${item.id}`
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    }
    if (!manifest) return
    for (const item of manifest.districts) {
      const id = `susceptibility-${item.id}`
      const source = overlaySource(item, manifest)
      source.tiles = source.tiles?.map(path => `${tileProtocol}://${path.slice(1)}`)
      map.addSource(id, source)
      const latest = preferencesRef.current.value
      map.addLayer({ id, type: 'raster', source: id,
        layout: { visibility: latest.layers.includes('susceptibility') && (!latest.district || latest.district === item.name) ? 'visible' : 'none' },
        paint: { 'raster-opacity': latest.opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } })
    }
  }, [ready, styleRevision, manifest])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const item of districtCatalog) {
      const id = `susceptibility-${item.id}`
      if (map.getLayer(id)) {
        map.setPaintProperty(id, 'raster-opacity', opacity)
        map.setLayoutProperty(id, 'visibility', overlayVisible && (!district || district === item.name) ? 'visible' : 'none')
      }
    }
  }, [ready, styleRevision, manifest, district, opacity, overlayVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const controller = new AbortController()
    let current = true
    let deadline: ReturnType<typeof setTimeout>
    basemapFailed.current = false; providerInstalled.current = false
    setBasemapLoading(true)
    const fail = () => {
      if (!current) return
      basemapFailed.current = true; setBasemapError(true); setBasemapLoading(false)
    }
    deadline = setTimeout(() => { controller.abort(); fail() }, 15000)
    void loadBasemapStyle(basemap, controller.signal).then(style => {
      if (!current || basemapFailed.current) return
      providerInstalled.current = true
      map.setStyle(style, { diff: false })
      // Complete only once the provider's visible resources finish, not on an earlier background idle.
      map.once('idle', () => { if (current) { clearTimeout(deadline); setBasemapLoading(false); setStyleRevision(previous => previous + 1) } })
    }).catch(fail)
    return () => { current = false; clearTimeout(deadline); controller.abort() }
  }, [retry])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !basemapError || mapError) return
    providerInstalled.current = false
    // Remove failed provider sources, not CSS-cover the warning imagery or retry against another host.
    // style.load restores the real overlays on the honest empty geographic canvas.
    map.setStyle(baseStyle(), { diff: false })
  }, [basemapError, mapError])

  useEffect(() => {
    const map = mapRef.current
    const point = inspection.point
    if (!map || !point) return
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'location-marker'
    button.setAttribute('aria-label', `Selected location: latitude ${point.latitude.toFixed(6)}, longitude ${point.longitude.toFixed(6)}. Open location details`)
    button.title = 'Open location details'
    button.addEventListener('click', event => { event.stopPropagation(); document.getElementById('location-details')?.focus({ preventScroll: true }) })
    const marker = new Marker({ element: button }).setLngLat([point.longitude, point.latitude]).addTo(map)
    return () => { marker.remove() }
  }, [inspection.point])

  function frameDistrict(next: District | null) {
    preferences.setValue(previous => ({ ...previous, district: next }))
    mapRef.current?.fitBounds(boundsForDistrict(next), { padding: 35, duration: reducedRef.current ? 0 : 650 })
  }
  function retryResources() {
    basemapFailed.current = false
    setBasemapError(false); setTileErrors([])
    setRetry(previous => previous + 1)
  }
  const localStatus = preferences.status === 'saved' ? 'View saved locally' : preferences.status === 'saving' ? 'Saving view…' : preferences.status === 'unavailable' || preferences.status === 'blocked' ? 'Local saving unavailable' : 'Public map · no account needed'

  return <main id="main-content" tabIndex={-1} className="explorer-page">
    <header className="explorer-heading"><div><Link to="/" className="map-back"><ArrowLeft size={14} aria-hidden="true" />Back to GHAT ISHARA</Link><p className="map-eyebrow">WESTERN GHATS · MAHARASHTRA</p><h1>Map Explorer</h1><p>Read the landscape. Understand susceptibility.</p></div><span className="map-public-badge"><span className="status-dot" aria-hidden="true" />Public explorer</span></header>
    <div className="explorer-workspace">
      <section className="map-viewport" aria-label="Geographic map">
        <a href="#map-controls" className="map-skip">Skip map to layer controls</a>
        <div className="map-canvas" ref={container} />
        <div className="map-view-label"><MapPin size={14} aria-hidden="true" />{district ?? 'Four-district study region'}</div>
        <div className="map-camera-controls" role="group" aria-label="Map view controls"><button onClick={() => mapRef.current?.zoomIn({ duration: reducedMotion ? 0 : 200 })} aria-label="Zoom in" disabled={!ready || mapError}><Plus size={19} aria-hidden="true" /></button><button onClick={() => mapRef.current?.zoomOut({ duration: reducedMotion ? 0 : 200 })} aria-label="Zoom out" disabled={!ready || mapError}><Minus size={19} aria-hidden="true" /></button><button onClick={() => frameDistrict(district)} aria-label="Reset district view" disabled={!ready || mapError}><LocateFixed size={19} aria-hidden="true" /></button></div>
        {(busy || basemapLoading || dataState === 'loading') && !mapError && <p className="map-loading" role="status">Loading {dataState === 'loading' ? 'susceptibility catalog' : basemapLoading ? 'geographic basemap' : 'map tiles'}…</p>}
        <LocationDetails inspection={inspection} district={district} onClose={() => { inspection.clear(); mapRef.current?.getCanvas().focus({ preventScroll: true }) }} />
        {mapError && <div className="map-fatal" role="alert"><AlertTriangle size={24} aria-hidden="true" /><h2>The interactive map could not start.</h2><p>Enable WebGL in your browser, or try another browser and reload this page. District information and the score legend remain available below.</p></div>}
      </section>
      <aside id="map-controls" className="map-panel" aria-label="Map layer controls" tabIndex={-1}>
        <div className="map-panel-title"><Layers3 size={18} aria-hidden="true" /><h2>Explore the region</h2></div>
        <label className="map-label" htmlFor="map-district">Study district</label><select id="map-district" value={district ?? ''} onChange={event => frameDistrict(event.target.value ? event.target.value as District : null)}><option value="">All four districts</option>{districtCatalog.map(item => <option key={item.id}>{item.name}</option>)}</select>
        {requestedId !== null && !requestedDistrict && <p className="map-small" role="status">The district in this URL is not recognised. Your current map preferences are being used.</p>}
        <button className="map-retry" type="button" disabled={!ready || mapError} onClick={() => { const center = mapRef.current?.getCenter(); if (center) inspection.select({ longitude: center.lng, latitude: center.lat }) }}><MapPin size={14} aria-hidden="true" />Inspect map center</button>
        <p className="map-small">Click the map to inspect an original source-cell score. Keyboard: focus the map, pan with arrow keys, then press Enter.</p>
        <div className="map-panel-divider" />
        <label className="map-overlay-toggle"><span><strong>Susceptibility overlay</strong><small>Experimental ML output</small></span><input id="map-overlay" type="checkbox" checked={overlayVisible} onChange={event => preferences.setValue(previous => ({ ...previous, layers: event.target.checked ? [...previous.layers.filter(layer => layer !== 'susceptibility'), 'susceptibility'] : previous.layers.filter(layer => layer !== 'susceptibility') }))} /></label>
        <div className="map-opacity-label"><label htmlFor="map-opacity">Overlay opacity</label><output htmlFor="map-opacity">{Math.round(opacity * 100)}%</output></div><input id="map-opacity" type="range" min="0" max="100" step="5" value={Math.round(opacity * 100)} onChange={event => preferences.setValue(previous => ({ ...previous, opacity: Number(event.target.value) / 100 }))} disabled={!overlayVisible} />
        <p className="map-small" aria-live="polite">{!overlayVisible ? basemapError ? 'Overlay hidden. The geographic basemap is unavailable.' : basemapLoading ? 'Overlay hidden. The geographic basemap is loading.' : 'Overlay hidden. The basemap remains visible.' : opacity === 0 ? 'Opacity is zero. Increase it to see the overlay.' : 'Transparent areas have no displayed model score.'}</p>
        <div className="map-legend"><h3>{colorScale.label}</h3><div className="map-legend-bar" aria-hidden="true">{colorScale.colors.map(color => <span key={color} style={{ background: color }} />)}</div><div className="map-legend-extremes"><span>Lower</span><span>Higher</span></div><ul>{colorScale.labels.map((label, index) => <li key={label}><span className="legend-swatch" style={{ background: colorScale.colors[index] }} aria-hidden="true" />{label}</li>)}<li><span className="legend-swatch nodata-swatch" aria-hidden="true" />NoData / excluded / outside coverage</li></ul><p className="map-small">Fixed score bands across all districts. Not calibrated probabilities.</p></div>
        {dataState === 'unavailable' || dataState === 'ready' && missing.length > 0 ? <div className="map-notice" role="status"><strong>Susceptibility data unavailable</strong><p>{dataState === 'unavailable' ? 'The generated layer catalog is missing or invalid.' : `No generated layer is available for ${missing.map(item => item.name).join(', ')}.`} The basemap is independent of this data. No simulated scores are shown.</p></div> : dataState === 'ready' && <p className="map-data-ready"><Check size={14} aria-hidden="true" />{activeOverlays.length} real district {activeOverlays.length === 1 ? 'layer' : 'layers'} available</p>}
        {(basemapError || activeTileError) && <div className="map-notice" role="alert"><strong>{activeTileError ? 'Some susceptibility tiles could not load.' : 'The basemap could not load.'}</strong><p>{basemapError ? basemap.problem ?? 'Geographic context is unavailable. Real susceptibility overlays and controls still work; the plain background is not geographic data.' : 'Check your connection and retry.'} A blank area during a loading failure is not evidence of low susceptibility.</p></div>}
        <button className="map-retry" type="button" onClick={retryResources}><RefreshCw size={14} aria-hidden="true" />Retry map resources</button>
        <p className="map-local-status" role="status">{localStatus}</p>
        <details className="map-source-details"><summary>About this layer</summary><p>{basemap.label}. <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Report a basemap issue</a>.</p><p>30 m source pixels · EPSG:32643. Display tiles use Web Mercator and nearest-neighbour sampling, zoom 6–12; closer views magnify the display.</p>{selected && <p>{selected.name}: {(selected.validFraction * 100).toFixed(1)}% of the raster rectangle contains valid scores. Bounds describe a raster footprint, not an administrative boundary.</p>}{manifest && <p>Tiles prepared {new Date(manifest.generatedAt).toLocaleDateString()}.</p>}</details>
      </aside>
    </div>
    <footer className="map-science-note"><AlertTriangle size={18} aria-hidden="true" /><p><strong>Research interpretation, not an operational warning.</strong> These experimental model scores describe relative susceptibility, not real-time forecasts or event probabilities. Rainfall units are marked unverified in the source outputs. NoData means excluded, outside coverage or missing data; it does not mean safe. Do not use this map alone for emergency, travel or engineering decisions.</p></footer>
  </main>
}
