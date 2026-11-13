import catalog from './raster-catalog.json'
import scale from './color-scale.json'
import type { RasterSourceSpecification } from 'maplibre-gl'
import type { District } from '../official/types'

export type Bounds = [number, number, number, number]
export const districtCatalog = catalog.map(item => ({ ...item, name: item.name as District, bounds: item.bounds as Bounds }))
/** Public URLs use the catalog's exact, lowercase identifiers. */
export const districtById = (id: string | null | undefined) => districtCatalog.find(item => item.id === id)
export const districtMapURL = (id: string) => `/explore-map?district=${encodeURIComponent(id)}`
export const studyBounds: Bounds = [Math.min(...catalog.map(item => item.bounds[0])), Math.min(...catalog.map(item => item.bounds[1])), Math.max(...catalog.map(item => item.bounds[2])), Math.max(...catalog.map(item => item.bounds[3]))]
export const colorScale = scale
export const manifestURL = '/generated-data/susceptibility/manifest.json'
export { emptyBasemapStyle as baseStyle } from './basemap'
export type Overlay = { id: string; name: District; bounds: Bounds; tiles: string; sampleTile: string; tileCount: number; tileBytes: number }
export type Manifest = { version: 1; generatedAt: string; minzoom: number; maxzoom: number; districts: Overlay[] }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
export function validBounds(value: unknown): value is Bounds {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] >= -180 && value[2] <= 180 && value[1] >= -85 && value[3] <= 85 && value[0] < value[2] && value[1] < value[3]
}
export function parseManifest(value: unknown): Manifest | null {
  if (!isObject(value) || value.version !== 1 || value.crs !== 'EPSG:3857' || value.scheme !== 'xyz' || value.tileSize !== 256
    || !Number.isInteger(value.minzoom) || !Number.isInteger(value.maxzoom) || Number(value.minzoom) < 5 || Number(value.maxzoom) > 12 || Number(value.minzoom) > Number(value.maxzoom)
    || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || JSON.stringify(value.colorScale) !== JSON.stringify(scale) || !Array.isArray(value.districts)) return null
  const overlays: Overlay[] = []
  for (const item of value.districts) {
    if (!isObject(item) || item.status !== 'ready') continue
    const source = districtCatalog.find(source => source.id === item.id && source.name === item.name)
    if (!source || !validBounds(item.bounds) || item.bounds.some((coordinate, index) => Math.abs(coordinate - source.bounds[index]) > 0.00001)
      || item.sha256 !== source.sha256 || typeof item.tiles !== 'string' || typeof item.sampleTile !== 'string'
      || !/^\/generated-data\/susceptibility\/[a-z0-9-]+\/(pune|raigad|ratnagiri|satara)\/\{z\}\/\{x\}\/\{y\}\.png$/.test(item.tiles)
      || !/^\/generated-data\/susceptibility\/[a-z0-9-]+\/(pune|raigad|ratnagiri|satara)\/\d+\/\d+\/\d+\.png$/.test(item.sampleTile)
      || !item.tiles.includes(`/${source.id}/`) || !Number.isInteger(item.tileCount) || Number(item.tileCount) < 1 || !Number.isFinite(item.tileBytes)
      || overlays.some(other => other.id === item.id)) return null
    overlays.push({ id: source.id, name: source.name, bounds: item.bounds, tiles: item.tiles, sampleTile: item.sampleTile, tileCount: Number(item.tileCount), tileBytes: Number(item.tileBytes) })
  }
  return { version: 1, generatedAt: value.generatedAt, minzoom: Number(value.minzoom), maxzoom: Number(value.maxzoom), districts: overlays }
}
export function overlaySource(overlay: Overlay, manifest: Manifest): RasterSourceSpecification {
  return { type: 'raster', tiles: [overlay.tiles], tileSize: 256, scheme: 'xyz', bounds: overlay.bounds, minzoom: manifest.minzoom, maxzoom: manifest.maxzoom, attribution: 'GHAT ISHARA · experimental ML susceptibility' }
}
export const boundsForDistrict = (district: District | null): Bounds => districtCatalog.find(item => item.name === district)?.bounds ?? studyBounds
