// Strict deterministic USTAR subset: regular files only, no extensions or links.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, readFile, rename, unlink, lstat } from 'node:fs/promises'
import path from 'node:path'
import { frontend, inspectAssets, manifests, release, sha256, referenceCell, decodeChunk, checkReference } from '../map-hosting/assets.mjs'
import { preflight } from '../map-hosting/preflight.mjs'

export const archiveName = 'ghat-ishara-public-maps-20261026.tar'
export const MAX_ARCHIVE = 160 * 1024 * 1024
const ZERO = Buffer.alloc(512)
const FILES = release.visual.files + release.numerical.files + 4
export function safeName(name) {
  assert.ok(/^(scores|susceptibility)\/[a-zA-Z0-9_./-]+$/.test(name) && name.length < 100 && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe archive path')
  return name
}
export function header(name, size) {
  safeName(name)
  assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 512 * 1024, 'Invalid entry size')
  const out = Buffer.alloc(512)
  out.write(name, 0, 100, 'ascii')
  for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 0]]) out.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii')
  out.fill(32, 148, 156); out[156] = 48; out.write('ustar\0', 257, 'ascii'); out.write('00', 263, 'ascii')
  out.write([...out].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return out
}
export async function exists(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function realDirectories(directory) {
  const resolved = path.resolve(directory)
  const parent = path.dirname(resolved)
  if (parent !== resolved) await realDirectories(parent)
  assert.ok((await lstat(resolved)).isDirectory(), `Expected directory without symlink: ${resolved}`)
}
async function readAt(file, size, position) {
  const out = Buffer.alloc(size); let done = 0
  while (done < size) {
    const result = await file.read(out, done, size - done, position + done)
    assert.ok(result.bytesRead, 'Truncated archive')
    done += result.bytesRead
  }
  return out
}
async function writeAll(file, bytes) {
  let offset = 0
  while (offset < bytes.length) offset += (await file.write(bytes, offset)).bytesWritten
}
export async function fileDigest(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const hash = createHash('sha256'); const stat = await handle.stat()
    assert.ok(stat.isFile() && stat.size <= MAX_ARCHIVE, 'Invalid archive file or size')
    for (let at = 0; at < stat.size; at += 1024 * 1024) hash.update(await readAt(handle, Math.min(1024 * 1024, stat.size - at), at))
    return { sha256: hash.digest('hex'), bytes: stat.size }
  } finally { await handle.close() }
}
export async function checkScores(publicDir, numerical) {
  for (const reference of release.references) {
    const { grid, key, url } = referenceCell(reference, numerical)
    const entry = grid.tiles[key]
    if (entry === null) { assert.equal(reference.score, null); continue }
    const bytes = await readFile(path.join(publicDir, url.slice(1)))
    checkReference(reference, numerical, decodeChunk(bytes, grid, key, entry.sha256))
  }
}
async function writeReceipt(file, content) {
  let handle
  try { handle = await open(file, 'wx', 0o644) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { assert.equal(await existing.readFile('utf8'), content, 'Existing receipt differs; choose another output directory') } finally { await existing.close() }
    return
  }
  try { await handle.writeFile(content) } finally { await handle.close() }
}
export async function createArchive({ publicDir = path.join(frontend, 'public'), outputDir = path.join(frontend, 'release-output'), log = console.log } = {}) {
  const checked = await preflight({ publicDir, sourceOnly: true, log })
  await mkdir(outputDir, { recursive: true }); await realDirectories(outputDir)
  const destination = path.join(outputDir, archiveName)
  const temporary = path.join(outputDir, `.${archiveName}.${process.pid}.partial`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    for (const name of [...checked.expected.keys()].sort()) {
      const bytes = await readFile(path.join(publicDir, 'generated-data', name))
      assert.equal(sha256(bytes), checked.hashes.get(name), 'Asset changed during packaging')
      await writeAll(file, header(name, bytes.length)); await writeAll(file, bytes)
      if (bytes.length % 512) await writeAll(file, ZERO.subarray(0, 512 - bytes.length % 512))
    }
    await writeAll(file, Buffer.alloc(1024)); await file.sync(); await file.close()
    const info = await verifyArchive(temporary)
    if (await exists(destination)) {
      assert.deepEqual(await fileDigest(destination), { sha256: info.sha256, bytes: info.bytes }, 'Existing archive differs; choose another output directory')
      await unlink(temporary)
    } else await rename(temporary, destination)
    await writeReceipt(destination + '.sha256', `${info.sha256}  ${archiveName}\n`)
    const receipt = { filename: archiveName, files: info.files, bytes: info.bytes, unpackedBytes: checked.total, sha256: info.sha256, treeSha256: release.treeSha256, visualBuildId: release.visual.buildId, numericalBuildId: release.numerical.buildId }
    await writeReceipt(destination + '.json', JSON.stringify(receipt, null, 2) + '\n')
    log(JSON.stringify(receipt, null, 2)); return { ...receipt, path: destination }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

// Scan before extraction. Require exactly the pinned inventory and bytes; no tar utility runs.
export async function verifyArchive(archive, { expectedSha256, extractPublicDir } = {}) {
  if (expectedSha256 !== undefined) assert.match(expectedSha256, /^[a-f0-9]{64}$/, 'Invalid pinned SHA-256')
  const file = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    assert.ok(stat.isFile() && stat.size >= 1024 && stat.size <= MAX_ARCHIVE && stat.size % 512 === 0, 'Invalid archive size')
    const digest = createHash('sha256'); const entries = new Map(); const json = new Map(); let offset = 0
    for (;;) {
      assert.ok(offset + 512 <= stat.size, 'Missing archive terminator')
      const block = await readAt(file, 512, offset); digest.update(block); offset += 512
      if (block.equals(ZERO)) {
        assert.equal(offset + 512, stat.size, 'Unexpected archive trailer')
        const last = await readAt(file, 512, offset); assert.ok(last.equals(ZERO), 'Invalid archive terminator'); digest.update(last); break
      }
      const nameEnd = block.indexOf(0); assert.ok(nameEnd > 0 && nameEnd < 100, 'Invalid archive name')
      const name = safeName(block.toString('ascii', 0, nameEnd))
      const sizeString = block.toString('ascii', 124, 135)
      assert.match(sizeString, /^[0-7]{11}$/, 'Invalid archive entry length')
      const size = parseInt(sizeString, 8)
      // Equality to canonical header also rejects non-ASCII names, links, PAX, prefixes,
      // duplicate metadata, nonzero timestamps, bad checksums and non-regular entries.
      assert.ok(block.equals(header(name, size)), 'Unsupported or corrupt archive header (links/extensions forbidden)')
      assert.ok(!entries.has(name) && entries.size < FILES, 'Duplicate or unexpected archive entries')
      const padded = Math.ceil(size / 512) * 512
      assert.ok(offset + padded <= stat.size - 1024, 'Truncated archive entry')
      const payload = await readAt(file, padded, offset); digest.update(payload)
      assert.ok(payload.subarray(size).every(byte => byte === 0), 'Nonzero archive padding')
      entries.set(name, { size, offset, hash: sha256(payload.subarray(0, size)) })
      if (name.endsWith('.json')) json.set(name, payload.subarray(0, size))
      offset += padded
    }
    const hash = digest.digest('hex')
    if (expectedSha256 !== undefined) assert.equal(hash, expectedSha256, 'Archive SHA-256 mismatch; nothing installed')
    assert.ok(json.has('susceptibility/manifest.json') && json.has('scores/manifest.json'), 'Missing canonical manifests')
    const parsed = manifests(json.get('susceptibility/manifest.json'), json.get('scores/manifest.json'))
    assert.deepEqual([...entries.keys()].sort(), [...parsed.expected.keys()].sort(), 'Missing or unexpected archive entries')
    const tree = createHash('sha256')
    for (const name of [...entries.keys()].sort()) tree.update(`${name}\0${entries.get(name).hash}\n`)
    assert.equal(tree.digest('hex'), release.treeSha256, 'Archive entries differ from pinned asset bytes')
    if (extractPublicDir) {
      // Caller must supply a new private staging directory. Never extract over existing data.
      await realDirectories(extractPublicDir)
      const root = path.join(extractPublicDir, 'generated-data'); await mkdir(root, { mode: 0o700 })
      for (const [name, entry] of entries) {
        const target = path.join(root, name)
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await realDirectories(path.dirname(target))
        const bytes = await readAt(file, entry.size, entry.offset)
        assert.equal(sha256(bytes), entry.hash, 'Archive changed during extraction')
        const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
        try { await writeAll(out, bytes) } finally { await out.close() }
      }
      const checked = await inspectAssets(extractPublicDir); await checkScores(extractPublicDir, checked.numerical)
    }
    return { sha256: hash, bytes: stat.size, files: entries.size }
  } finally { await file.close() }
}
