import proj4 from 'proj4'
import { districtCatalog, colorScale, studyBounds } from './config'
import type { District } from '../official/types'

export type Point = { longitude: number; latitude: number }
export type Grid = { id: string; name: District; width: number; height: number; transform: number[]; nodata: number; tiles: Record<string, { sha256: string; bytes: number } | null> }
export type ScoreManifest = { version: 1; buildId: string; tileSize: 256; districts: Grid[] }
export type Sample = { district: District; score: number; row: number; column: number }
export type InspectionResult = { values: Sample[]; unavailable: District[] }
export const scoreManifestURL = '/generated-data/scores/manifest.json'
const UTM43 = '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs'
const MAX_BYTES = 32 + 256 * 256 * 4
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function validPoint(point: Point): boolean {
  return Number.isFinite(point.longitude) && Number.isFinite(point.latitude) && Math.abs(point.longitude) <= 180 && Math.abs(point.latitude) <= 85
}
export function cellForProjectedPoint(grid: Pick<Grid, 'width' | 'height' | 'transform'>, x: number, y: number) {
  const [a, b, c, d, e, f] = grid.transform
  const determinant = a * e - b * d
  if (!Number.isFinite(x) || !Number.isFinite(y) || !determinant) return null
  const column = Math.floor((e * (x - c) - b * (y - f)) / determinant)
  const row = Math.floor((-d * (x - c) + a * (y - f)) / determinant)
  return row >= 0 && row < grid.height && column >= 0 && column < grid.width ? { row: row === 0 ? 0 : row, column: column === 0 ? 0 : column } : null
}
export function projectedPoint(point: Point): [number, number] {
  if (!validPoint(point)) throw new Error('Invalid location coordinates')
  return proj4('EPSG:4326', UTM43, [point.longitude, point.latitude]) as [number, number]
}
export function parseScoreManifest(input: unknown): ScoreManifest {
  if (!isRecord(input) || input.version !== 1 || input.encoding !== 'float32-le' || input.compression !== 'gzip'
    || input.tileSize !== 256 || typeof input.buildId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(input.buildId)
    || !Array.isArray(input.districts) || input.districts.length !== 4) throw new Error('Invalid numerical catalog')
  const grids: Grid[] = []
  for (const source of districtCatalog) {
    const item = input.districts.find(value => isRecord(value) && value.id === source.id)
    if (!isRecord(item) || item.name !== source.name || item.sourceSha256 !== source.sha256 || item.crs !== 'EPSG:32643'
      || item.width !== source.width || item.height !== source.height || item.nodata !== source.nodata
      || !Array.isArray(item.transform) || item.transform.length !== 6 || !item.transform.every(Number.isFinite) || !isRecord(item.tiles)) throw new Error('Numerical catalog does not match source')
    const expected = [source.resolution[0], 0, source.sourceBounds[0], 0, -source.resolution[1], source.sourceBounds[3]]
    if (!expected.every((value, index) => item.transform instanceof Array && item.transform[index] === value)) throw new Error('Invalid source grid alignment')
    const columns = Math.ceil(source.width / 256); const rows = Math.ceil(source.height / 256)
    if (Object.keys(item.tiles).length !== columns * rows) throw new Error('Incomplete numerical index')
    const tiles: Grid['tiles'] = {}
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const key = `${row}/${column}`; const tile = item.tiles[key]
      if (tile === null) tiles[key] = null
      else if (isRecord(tile) && typeof tile.sha256 === 'string' && /^[a-f0-9]{64}$/.test(tile.sha256)
        && Number.isInteger(tile.bytes) && Number(tile.bytes) > 0 && Number(tile.bytes) <= MAX_BYTES + 1024) tiles[key] = { sha256: tile.sha256, bytes: Number(tile.bytes) }
      else throw new Error('Invalid numerical tile entry')
    }
    grids.push({ id: source.id, name: source.name, width: source.width, height: source.height, transform: item.transform as number[], nodata: source.nodata, tiles })
  }
  return { version: 1, buildId: input.buildId, tileSize: 256, districts: grids }
}
export function scoreBand(score: number) {
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Invalid model score')
  const index = Math.min(colorScale.colors.length - 1, colorScale.breaks.slice(1).filter(value => score >= value).length)
  return { label: colorScale.labels[index], color: colorScale.colors[index] }
}
export function formatScore(score: number) { return score.toPrecision(9) }

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) { await reader.cancel(); throw new Error('Numerical response exceeds bounds') }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
export async function decodeScoreTile(bytes: Uint8Array, grid: Grid, row: number, column: number, sha256: string): Promise<DataView> {
  let decoded = bytes
  if (bytes[0] === 31 && bytes[1] === 139) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Numerical decompression unavailable')
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    decoded = await boundedBytes(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_BYTES)
  }
  const width = Math.min(256, grid.width - column); const height = Math.min(256, grid.height - row)
  if (decoded.length !== 32 + width * height * 4 || new TextDecoder().decode(decoded.subarray(0, 8)) !== 'GHATSCR1') throw new Error('Invalid numerical tile')
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength)
  if (view.getUint32(8, true) !== row || view.getUint32(12, true) !== column || view.getUint32(16, true) !== width
    || view.getUint32(20, true) !== height || view.getFloat32(24, true) !== grid.nodata || view.getUint32(28, true) !== 1) throw new Error('Misaligned numerical tile')
  const digest = await crypto.subtle.digest('SHA-256', decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer)
  if ([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') !== sha256) throw new Error('Numerical integrity check failed')
  for (let offset = 32; offset < view.byteLength; offset += 4) {
    const value = view.getFloat32(offset, true)
    if (value !== grid.nodata && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Invalid numerical score')
  }
  return view
}

/** In-memory public data only: maximum eight decoded tiles (~2 MiB), no browser persistence. */
export class ScoreLookup {
  private manifest: ScoreManifest | null = null
  private cache = new Map<string, DataView>()
  async inspect(point: Point, selectedDistrict: District | null, signal: AbortSignal): Promise<InspectionResult> {
    if (!validPoint(point)) throw new Error('Invalid location coordinates')
    // A loose geographic guard avoids projecting points far outside UTM 43N. Exact
    // coverage decisions use the original native grid, not a densified WGS84 rectangle.
    if (point.longitude < studyBounds[0] - 1 || point.longitude > studyBounds[2] + 1
      || point.latitude < studyBounds[1] - 1 || point.latitude > studyBounds[3] + 1) return { values: [], unavailable: [] }
    const [x, y] = projectedPoint(point)
    const candidates = districtCatalog.filter(item => (!selectedDistrict || item.name === selectedDistrict)
      && cellForProjectedPoint({ width: item.width, height: item.height,
        transform: [item.resolution[0], 0, item.sourceBounds[0], 0, -item.resolution[1], item.sourceBounds[3]] }, x, y))
    if (!candidates.length) return { values: [], unavailable: [] }
    if (!this.manifest) {
      const response = await fetch(scoreManifestURL, { signal, credentials: 'omit', cache: 'no-cache' })
      if (!response.ok || !response.headers.get('content-type')?.includes('json') || !response.body) throw new Error('Numerical data unavailable')
      const raw = await boundedBytes(response.body, 512 * 1024)
      const parsed = parseScoreManifest(JSON.parse(new TextDecoder().decode(raw)))
      signal.throwIfAborted(); this.manifest = parsed
    }
    const manifest = this.manifest
    const values: Sample[] = []; const unavailable: District[] = []
    await Promise.all(candidates.map(async source => {
      try {
        const grid = manifest.districts.find(grid => grid.name === source.name)!
        const cell = cellForProjectedPoint(grid, x, y)
        if (!cell) return
        const row = Math.floor(cell.row / 256) * 256; const column = Math.floor(cell.column / 256) * 256
        const key = `${row / 256}/${column / 256}`; const entry = grid.tiles[key]
        if (entry === null) return
        const url = `/generated-data/scores/${manifest.buildId}/${grid.id}/${key}.sct.gz`
        let tile = this.cache.get(url)
        if (tile) { this.cache.delete(url); this.cache.set(url, tile) }
        else {
          const response = await fetch(url, { signal, credentials: 'omit' })
          if (!response.ok || !response.body || response.headers.get('content-type')?.includes('text/')) throw new Error('Numerical tile unavailable')
          const bytes = await boundedBytes(response.body, MAX_BYTES + 1024)
          tile = await decodeScoreTile(bytes, grid, row, column, entry.sha256)
          signal.throwIfAborted()
          this.cache.set(url, tile)
          if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
        }
        const width = tile.getUint32(16, true)
        const score = tile.getFloat32(32 + ((cell.row - row) * width + cell.column - column) * 4, true)
        if (score !== grid.nodata) values.push({ district: grid.name, score, row: cell.row, column: cell.column })
      } catch (error) { if (signal.aborted) throw error; unavailable.push(source.name) }
    }))
    signal.throwIfAborted()
    return { values: values.sort((a, b) => a.district.localeCompare(b.district)), unavailable: unavailable.sort() }
  }
}
