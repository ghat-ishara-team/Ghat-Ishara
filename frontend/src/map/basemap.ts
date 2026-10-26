import type { StyleSpecification } from 'maplibre-gl'

export type BasemapEnvironment = { VITE_BASEMAP_PROVIDER?: string; VITE_BASEMAP_STYLE?: string }
export type BasemapConfiguration = { id: string; label: string; styleURL: string | null; attribution: string; problem: string | null }
export const providerOrigin = 'https://tiles.openfreemap.org'
const attribution = '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> · © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
export function resolveBasemapConfiguration(environment: BasemapEnvironment): BasemapConfiguration {
  const provider = environment.VITE_BASEMAP_PROVIDER?.trim() || 'openfreemap'
  const style = environment.VITE_BASEMAP_STYLE?.trim() || 'liberty'
  if (provider === 'none') return { id: provider, label: 'Basemap disabled', styleURL: null, attribution: '', problem: 'The geographic basemap is disabled for this deployment. Real susceptibility overlays and map controls remain available.' }
  if (provider !== 'openfreemap' || !['liberty', 'positron', 'dark'].includes(style)) return { id: 'unconfigured', label: 'Basemap unconfigured', styleURL: null, attribution: '', problem: 'The geographic basemap configuration is unsupported. Ask the site operator to check the public basemap settings.' }
  return { id: provider, label: `OpenFreeMap · ${style[0].toUpperCase()}${style.slice(1)}`, styleURL: `${providerOrigin}/styles/${style}`, attribution, problem: null }
}
/** A real empty geographic canvas while a provider is loading/unavailable; never fake geography. */
export function emptyBasemapStyle(): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#142b2b' } }] }
}
function providerURL(input: unknown): input is string {
  if (typeof input !== 'string') return false
  try { const url = new URL(input); return url.origin === providerOrigin && !url.username && !url.password && !url.search && !url.hash }
  catch { return false }
}
export function validateBasemapStyle(input: unknown): StyleSpecification {
  if (!input || typeof input !== 'object') throw new Error('Invalid geographic basemap style')
  const style = input as StyleSpecification
  if (style.version !== 8 || !style.sources || typeof style.sources !== 'object' || !Array.isArray(style.layers)
    || (style.glyphs !== undefined && !providerURL(style.glyphs)) || (style.sprite !== undefined && !providerURL(style.sprite))) throw new Error('Invalid geographic basemap style')
  // Use vector geography only. Omit the provider's optional low-zoom shaded raster,
  // so a PNG warning image cannot be accepted as a geographic basemap tile.
  const sources: StyleSpecification['sources'] = {}
  for (const [id, source] of Object.entries(style.sources)) {
    if (source.type === 'raster') continue
    if (source.type !== 'vector' || !providerURL(source.url)) throw new Error('Unsupported geographic basemap source')
    // Preserve required credits even if TileJSON changes, and deduplicate the control’s identical fallback credit.
    sources[id] = { ...source, attribution }
  }
  if (!Object.keys(sources).length) throw new Error('Geographic basemap has no vector sources')
  const layers = style.layers.filter(layer => !('source' in layer) || typeof layer.source === 'string' && !!sources[layer.source])
  return { ...style, sources, layers }
}
export async function loadBasemapStyle(configuration: BasemapConfiguration, signal: AbortSignal): Promise<StyleSpecification> {
  if (!configuration.styleURL) throw new Error('Geographic basemap unconfigured')
  const response = await fetch(configuration.styleURL, { signal, credentials: 'omit' })
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('Geographic basemap unavailable')
  return validateBasemapStyle(await response.json())
}
