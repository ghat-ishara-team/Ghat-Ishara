import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateSync } from 'node:zlib'
import proj4 from 'proj4'

export const frontend = fileURLToPath(new URL('../../', import.meta.url))
export const release = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'))
export const catalog = JSON.parse(await readFile(path.join(frontend, 'src/map/raster-catalog.json'), 'utf8'))
const scale = JSON.parse(await readFile(path.join(frontend, 'src/map/color-scale.json'), 'utf8'))
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const MAX_CHUNK = 32 + 256 * 256 * 4
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export function checkPNG(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG signature')
  let offset = 8; let ended = false; const idat = []; let chunks = 0
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'Truncated PNG chunk')
    const size = bytes.readUInt32BE(offset); const end = offset + 12 + size
    assert.ok(end <= bytes.length, 'Truncated PNG data')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    assert.equal(crc32(bytes.subarray(offset + 4, end - 4)), bytes.readUInt32BE(end - 4), 'PNG CRC mismatch')
    if (chunks++ === 0) {
      assert.equal(type, 'IHDR'); assert.equal(size, 13)
      assert.equal(bytes.readUInt32BE(offset + 8), 256); assert.equal(bytes.readUInt32BE(offset + 12), 256)
      assert.deepEqual([...bytes.subarray(offset + 16, offset + 21)], [8, 6, 0, 0, 0], 'Expected 8-bit non-interlaced RGBA')
    }
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, end - 4))
    offset = end
    if (type === 'IEND') { assert.equal(size, 0); ended = true; break }
  }
  assert.ok(ended && offset === bytes.length && idat.length, 'Incomplete PNG')
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 256 * 1025 })
  assert.equal(raw.length, 256 * 1025)
  for (let row = 0; row < 256; row++) assert.ok(raw[row * 1025] <= 4, 'Invalid PNG filter')
}

export function decodeChunk(bytes, grid, key, expectedHash) {
  const raw = bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, { maxOutputLength: MAX_CHUNK }) : bytes
  const [row, column] = key.split('/').map(value => Number(value) * 256)
  const width = Math.min(256, grid.width - column); const height = Math.min(256, grid.height - row)
  assert.equal(raw.length, 32 + width * height * 4, 'Numerical payload length mismatch')
  assert.equal(raw.toString('ascii', 0, 8), 'GHATSCR1')
  assert.deepEqual([8, 12, 16, 20].map(offset => raw.readUInt32LE(offset)), [row, column, width, height], 'Numerical window mismatch')
  assert.equal(raw.readFloatLE(24), grid.nodata); assert.equal(raw.readUInt32LE(28), 1)
  assert.equal(sha256(raw), expectedHash, 'Numerical SHA-256 mismatch')
  for (let offset = 32; offset < raw.length; offset += 4) {
    const score = raw.readFloatLE(offset)
    assert.ok(score === grid.nodata || Number.isFinite(score) && score >= 0 && score <= 1, 'Invalid numerical score')
  }
  return raw
}

export function manifests(visualBytes, scoreBytes) {
  assert.equal(sha256(visualBytes), release.visual.manifestSha256, 'Visual manifest differs from pinned release')
  assert.equal(sha256(scoreBytes), release.numerical.manifestSha256, 'Numerical manifest differs from pinned release')
  const visual = JSON.parse(visualBytes); const numerical = JSON.parse(scoreBytes)
  assert.deepEqual([visual.version, visual.buildId, visual.crs, visual.scheme, visual.tileSize, visual.minzoom, visual.maxzoom], [1, release.visual.buildId, 'EPSG:3857', 'xyz', 256, 6, 12])
  assert.deepEqual([numerical.version, numerical.buildId, numerical.tileSize, numerical.encoding, numerical.compression], [1, release.numerical.buildId, 256, 'float32-le', 'gzip'])
  assert.deepEqual(visual.colorScale, scale)
  for (const list of [visual.districts, numerical.districts]) assert.deepEqual(list.map(item => item.id).sort(), catalog.map(item => item.id).sort(), 'Expected exactly four unique study districts')
  const expected = new Map()
  for (const source of catalog) {
    const v = visual.districts.find(item => item.id === source.id)
    const n = numerical.districts.find(item => item.id === source.id)
    assert.equal(v.name, source.name); assert.equal(n.name, source.name)
    assert.equal(v.sha256, source.sha256); assert.equal(n.sourceSha256, source.sha256)
    assert.equal(v.status, 'ready'); assert.deepEqual(v.bounds, source.bounds)
    assert.deepEqual([n.crs, n.width, n.height, n.nodata], ['EPSG:32643', source.width, source.height, source.nodata])
    assert.deepEqual(n.transform, [source.resolution[0], 0, source.sourceBounds[0], 0, -source.resolution[1], source.sourceBounds[3]])
    assert.equal(v.tiles, `/generated-data/susceptibility/${visual.buildId}/${source.id}/{z}/{x}/{y}.png`)
    const pin = release.visual.districts[source.id]
    assert.equal(v.sampleTile, pin.sampleTile); assert.equal(v.tileCount, pin.files); assert.equal(v.tileBytes, pin.bytes)
    for (const [z, [x0, y0, x1, y1]] of Object.entries(pin.zooms)) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) expected.set(`susceptibility/${visual.buildId}/${source.id}/${z}/${x}/${y}.png`, { kind: 'png' })
    }
    const rows = Math.ceil(n.height / 256); const cols = Math.ceil(n.width / 256)
    assert.equal(Object.keys(n.tiles).length, rows * cols, 'Incomplete numerical index')
    let files = 0; let bytes = 0
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const key = `${row}/${col}`; const entry = n.tiles[key]
      if (entry === null) continue
      assert.ok(entry && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_CHUNK + 1024, 'Invalid numerical entry')
      files++; bytes += entry.bytes
      expected.set(`scores/${numerical.buildId}/${source.id}/${key}.sct.gz`, { kind: 'score', grid: n, key, ...entry })
    }
    assert.equal(files, n.files); assert.equal(bytes, n.bytes)
  }
  assert.equal([...expected.values()].filter(item => item.kind === 'png').length, release.visual.files)
  assert.equal([...expected.values()].filter(item => item.kind === 'score').length, release.numerical.files)
  assert.equal(visual.tileCount, release.visual.files); assert.equal(visual.tileBytes, release.visual.bytes)
  assert.equal(numerical.files, release.numerical.files); assert.equal(numerical.bytes, release.numerical.bytes)
  for (const [kind, m, bytes] of [['susceptibility', visual, visualBytes], ['scores', numerical, scoreBytes]]) {
    expected.set(`${kind}/manifest.json`, { kind: 'json', hash: sha256(bytes) })
    expected.set(`${kind}/${m.buildId}.json`, { kind: 'json', hash: sha256(bytes) })
  }
  return { visual, numerical, expected }
}

export async function walk(directory) {
  assert.ok((await lstat(directory)).isDirectory(), 'Expected a real directory')
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Deployment assets must not be symbolic links')
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full))
    else { assert.ok(entry.isFile(), 'Unexpected non-file asset'); files.push(full) }
  }
  return files.sort()
}

export async function inspectAssets(publicDir = path.join(frontend, 'public')) {
  assert.equal(sha256(await readFile(path.join(frontend, 'src/map/raster-catalog.json'))), release.catalogSha256, 'Source catalog changed; review the pinned release')
  const root = path.join(publicDir, 'generated-data')
  const parsed = manifests(await readFile(path.join(root, 'susceptibility/manifest.json')), await readFile(path.join(root, 'scores/manifest.json')))
  const files = await walk(root)
  assert.deepEqual(files.map(file => path.relative(root, file).split(path.sep).join('/')).sort(), [...parsed.expected.keys()].sort(), 'Generated asset set incomplete or contains unexpected files')
  const hashes = new Map(); const tree = createHash('sha256'); let total = 0
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/'); const entry = parsed.expected.get(relative)
    const bytes = await readFile(file)
    try {
      if (entry.kind === 'png') checkPNG(bytes)
      else if (entry.kind === 'score') { assert.equal(bytes.length, entry.bytes); assert.equal(bytes[0], 31); assert.equal(bytes[1], 139); decodeChunk(bytes, entry.grid, entry.key, entry.sha256) }
      else assert.equal(sha256(bytes), entry.hash, 'Manifest/report mismatch')
    } catch (error) { throw new Error(`${relative}: ${error.message}`) }
    const hash = sha256(bytes); hashes.set(relative, hash); tree.update(`${relative}\0${hash}\n`); total += bytes.length
  }
  assert.equal(tree.digest('hex'), release.treeSha256, 'Asset tree differs from pinned release (corruption/re-encoding/unexpected version)')
  return { ...parsed, hashes, total }
}

export function referenceCell(reference, numerical) {
  const source = catalog.find(source => source.name === reference.district)
  const grid = numerical.districts.find(grid => grid.id === source.id)
  const [x, y] = proj4('EPSG:4326', '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs', [reference.longitude, reference.latitude])
  const row = Math.floor((y - grid.transform[5]) / grid.transform[4]); const column = Math.floor((x - grid.transform[2]) / grid.transform[0])
  assert.equal(row, reference.row); assert.equal(column, reference.column)
  const key = `${Math.floor(row / 256)}/${Math.floor(column / 256)}`
  return { grid, key, row, column, url: `/generated-data/scores/${numerical.buildId}/${grid.id}/${key}.sct.gz` }
}

export function checkReference(reference, numerical, raw) {
  const { row, column } = referenceCell(reference, numerical)
  const width = raw.readUInt32LE(16)
  const value = raw.readFloatLE(32 + ((row % 256) * width + column % 256) * 4)
  assert.equal(value, reference.score === null ? -9999 : reference.score, `${reference.district} ${reference.label}: exact Float32 reference differs`)
  if (reference.score !== null) assert.equal(Math.fround(Number(value.toPrecision(9))), reference.score)
}
