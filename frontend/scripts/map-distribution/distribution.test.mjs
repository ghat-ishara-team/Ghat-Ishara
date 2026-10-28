import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, symlink, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createArchive, verifyArchive, header, archiveName, checkScores, fileDigest } from './archive.mjs'
import { setupMaps, validateConfig, download } from './setup.mjs'
import { frontend, inspectAssets, sha256, release } from '../map-hosting/assets.mjs'

const quiet = () => {}
await test('public map distribution (temporary files only)', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ghat-distribution-'))
  let receipt; let archive; let bytes; let config; let serial = 0
  const freshPublic = async () => {
    const base = path.join(temporary, `frontend-${serial++}`); const publicDir = path.join(base, 'public'); await mkdir(publicDir, { recursive: true })
    for (const name of ['_headers', '_redirects', '404.html']) await copyFile(path.join(frontend, 'public', name), path.join(publicDir, name))
    return publicDir
  }
  const response = data => new Response(data, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } })
  const absent = async directory => { assert.ok(!(await readdir(path.dirname(directory))).some(name => name.startsWith('.map-setup'))); assert.ok(!(await readdir(directory)).includes('generated-data')) }
  const fixture = async (modify, check) => {
    const file = path.join(temporary, `bad-${serial++}.tar`)
    await copyFile(archive, file)
    try { await modify(file); await check(file) } finally { await rm(file, { force: true }) }
  }
  const patch = async (file, data, offset = 0) => { const handle = await open(file, 'r+'); try { await handle.write(data, 0, data.length, offset) } finally { await handle.close() } }
  try {
    await t.test('successful archive creation, exact inventory and byte integrity', async () => {
      receipt = await createArchive({ outputDir: path.join(temporary, 'release'), log: quiet }); archive = receipt.path
      assert.equal(receipt.files, 2418); assert.equal(receipt.unpackedBytes, 147279495)
      assert.deepEqual(await verifyArchive(archive, { expectedSha256: receipt.sha256 }), { sha256: receipt.sha256, files: 2418, bytes: receipt.bytes })
      assert.equal(receipt.treeSha256, release.treeSha256)
      bytes = await readFile(archive)
      // Fixture-only asset ID/tag, never used for a real network request or release configuration.
      config = { repository: 'shiragave2omkar-hub/Ghat-Ishara', releaseTag: 'fixture-only', assetId: 1, assetName: archiveName, url: 'https://api.github.com/repos/shiragave2omkar-hub/Ghat-Ishara/releases/assets/1', sha256: receipt.sha256, bytes: receipt.bytes }
    })
    await t.test('archive is reproducible across independent output directories', async () => {
      const second = await createArchive({ outputDir: path.join(temporary, 'repeat'), log: quiet })
      assert.equal(second.sha256, receipt.sha256); assert.equal(second.bytes, receipt.bytes)
      await rm(path.dirname(second.path), { recursive: true })
    })
    await t.test('clean temporary extraction preserves every byte and all four exact numerical references', async () => {
      const publicDir = await freshPublic()
      await verifyArchive(archive, { expectedSha256: receipt.sha256, extractPublicDir: publicDir })
      const checked = await inspectAssets(publicDir); await checkScores(publicDir, checked.numerical)
      assert.equal(checked.hashes.size, 2418)
      await rm(path.dirname(publicDir), { recursive: true })
    })
    await t.test('incorrect archive SHA-256 prevents all extraction', async () => {
      const publicDir = await freshPublic()
      await assert.rejects(verifyArchive(archive, { expectedSha256: '0'.repeat(64), extractPublicDir: publicDir }), /SHA-256 mismatch/)
      await absent(publicDir)
    })
    await t.test('corrupt entry bytes are rejected even with a matching outer archive checksum', async () => {
      await fixture(file => patch(file, Buffer.from([bytes[512] ^ 1]), 512), async file => {
        await assert.rejects(verifyArchive(file, { expectedSha256: (await fileDigest(file)).sha256 }), /pinned asset bytes/)
      })
    })
    await t.test('missing entry is rejected', async () => {
      let at = 0; let last = 0
      while (bytes[at]) { last = at; at += 512 + Math.ceil(parseInt(bytes.toString('ascii', at + 124, at + 135), 8) / 512) * 512 }
      await fixture(async file => { const handle = await open(file, 'r+'); try { await handle.truncate(last + 1024); await handle.write(Buffer.alloc(1024), 0, 1024, last) } finally { await handle.close() } }, file => assert.rejects(verifyArchive(file), /Missing (or unexpected|canonical)/))
    })
    await t.test('incomplete/truncated archive is rejected', async () => {
      await fixture(async file => { const handle = await open(file, 'r+'); try { await handle.truncate(4096) } finally { await handle.close() } }, file => assert.rejects(verifyArchive(file), /Truncated/))
    })
    for (const [label, edit, pattern] of [
      ['directory traversal', block => { block.fill(0, 0, 100); block.write('scores/../../escaped') }, /Unsafe archive path/],
      ['absolute paths', block => { block.fill(0, 0, 100); block.write('/tmp/escaped') }, /Unsafe archive path/],
      ['backslash paths', block => { block.fill(0, 0, 100); block.write('scores/..\\escaped') }, /Unsafe archive path/],
      ['symlink entries', block => { block[156] = 50; block.write('/tmp/escaped', 157) }, /header/],
      ['hardlink entries', block => { block[156] = 49 }, /header/],
      ['directory entries', block => { block[156] = 53 }, /header/],
      ['PAX extensions', block => { block[156] = 120 }, /header/],
      ['bad header checksum', block => { block[148] ^= 1 }, /header/],
      ['unexpected file', block => { const size = parseInt(block.toString('ascii', 124, 135), 8); header('scores/unexpected.json', size).copy(block) }, /Missing or unexpected/],
    ]) await t.test(`${label} rejected before extraction`, async () => {
      const block = Buffer.from(bytes.subarray(0, 512)); edit(block)
      const publicDir = await freshPublic()
      await fixture(file => patch(file, block), file => assert.rejects(verifyArchive(file, { extractPublicDir: publicDir }), pattern))
      await absent(publicDir)
    })
    await t.test('duplicate entry is rejected', async () => {
      const secondAt = 512 + Math.ceil(parseInt(bytes.toString('ascii', 124, 135), 8) / 512) * 512
      const firstName = bytes.toString('ascii', 0, bytes.indexOf(0))
      const secondSize = parseInt(bytes.toString('ascii', secondAt + 124, secondAt + 135), 8)
      await fixture(file => patch(file, header(firstName, secondSize), secondAt), file => assert.rejects(verifyArchive(file), /Duplicate/))
    })
    await t.test('unconfigured release and mutable latest fail closed without network', async () => {
      const actual = JSON.parse(await readFile(new URL('./github-release.json', import.meta.url)))
      assert.throws(() => validateConfig(actual), /not configured/)
      assert.throws(() => validateConfig({ ...config, releaseTag: 'latest' }), /not configured/)
      const publicDir = await freshPublic(); let requests = 0
      await assert.rejects(setupMaps({ publicDir, config: actual, fetchImpl: () => { requests++; throw new Error('No network allowed') }, log: quiet }), /not configured/)
      assert.equal(requests, 0); await absent(publicDir)
    })
    await t.test('successful pinned download, atomic install and idempotent reuse', async () => {
      const publicDir = await freshPublic(); let requests = 0
      const fetchImpl = async () => { requests++; return response(bytes) }
      assert.equal(await setupMaps({ publicDir, config, fetchImpl, log: quiet }), 'installed')
      assert.equal(await setupMaps({ publicDir, config: {}, fetchImpl: () => { throw new Error('Must not download') }, log: quiet }), 'reused')
      assert.equal(requests, 1)
      const checked = await inspectAssets(publicDir); await checkScores(publicDir, checked.numerical)
      assert.ok(!(await readdir(path.dirname(publicDir))).some(name => name.startsWith('.map-setup')))
      await rm(path.dirname(publicDir), { recursive: true })
    })
    for (const [label, fetchImpl, pattern, overrides] of [
      ['network failure', async () => { throw new Error('fixture network failure') }, /network failure/],
      ['missing release asset', async () => new Response('missing', { status: 404 }), /HTTP 404/],
      ['incomplete download', async () => new Response(bytes.subarray(0, 4096)), /Incomplete download/],
      ['oversized download', async () => new Response(bytes.subarray(0, 4096)), /exceeds pinned byte size/, { bytes: 1024 }],
      ['wrong content length', async () => response(bytes.subarray(0, 4096)), /length/],
      ['checksum mismatch', async () => response(bytes), /SHA-256 mismatch/, { sha256: '0'.repeat(64) }],
      ['interrupted stream', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4096)); controller.error(new Error('fixture interrupted stream')) } })), /interrupted stream/],
      ['unsafe redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/maps.tar' } }), /Unsafe download redirect/],
    ]) await t.test(`${label} leaves no map data, partial downloads or lock`, async () => {
      const publicDir = await freshPublic()
      await assert.rejects(setupMaps({ publicDir, config: { ...config, ...overrides }, fetchImpl, log: quiet }), pattern)
      await absent(publicDir)
    })
    await t.test('matching outer checksum cannot admit corrupt entries during setup', async () => {
      const publicDir = await freshPublic()
      const corrupt = Buffer.from(bytes); corrupt[512] ^= 1
      await assert.rejects(setupMaps({ publicDir, config: { ...config, sha256: sha256(corrupt) }, fetchImpl: async () => response(corrupt), log: quiet }), /pinned asset bytes/)
      await absent(publicDir)
    })
    await t.test('existing setup lock is preserved without starting a download', async () => {
      const publicDir = await freshPublic(); const lock = path.join(path.dirname(publicDir), '.map-setup.lock'); await writeFile(lock, 'fixture lock')
      await assert.rejects(setupMaps({ publicDir, config, fetchImpl: () => { throw new Error('Must not download') }, log: quiet }), /Another setup/)
      assert.equal(await readFile(lock, 'utf8'), 'fixture lock'); await rm(lock)
      await absent(publicDir)
    })
    await t.test('abort cleans staging and lock', async () => {
      const publicDir = await freshPublic(); const controller = new AbortController()
      await assert.rejects(setupMaps({ publicDir, config, signal: controller.signal, fetchImpl: async () => { controller.abort(new Error('fixture cancellation')); return response(bytes) }, log: quiet }), /cancellation/)
      await absent(publicDir)
    })
    await t.test('GitHub redirects do not forward private access tokens to CDN', async () => {
      const calls = []; const destination = path.join(temporary, 'redirect-download')
      await download(config, destination, { token: 'fixture-token', fetchImpl: async (url, options) => {
        calls.push({ url, options })
        return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }) : response(bytes)
      } })
      assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token'); assert.equal(calls[1].options.headers.Authorization, undefined)
      assert.equal(sha256(await readFile(destination)), receipt.sha256); await rm(destination)
    })
    await t.test('incomplete existing data is preserved and never overwritten', async () => {
      const publicDir = await freshPublic(); const target = path.join(publicDir, 'generated-data'); await mkdir(target)
      const sentinel = path.join(target, 'keep.txt'); await writeFile(sentinel, 'preserve me')
      await assert.rejects(setupMaps({ publicDir, config, fetchImpl: () => { throw new Error('Must not download') }, log: quiet }), /left untouched/)
      assert.equal(await readFile(sentinel, 'utf8'), 'preserve me')
    })
    await t.test('existing target and parent symlinks are rejected without writes', async () => {
      const publicDir = await freshPublic(); const external = path.join(temporary, 'outside'); await mkdir(external)
      await symlink(external, path.join(publicDir, 'generated-data'))
      await assert.rejects(setupMaps({ publicDir, config, log: quiet }), /left untouched/)
      const linked = path.join(temporary, 'linked-public'); await symlink(publicDir, linked)
      await assert.rejects(setupMaps({ publicDir: linked, config, log: quiet }), /without symlink/)
      assert.deepEqual(await readdir(external), [])
    })
    await t.test('extraction refuses existing generated-data and symlink staging paths', async () => {
      const publicDir = await freshPublic(); await mkdir(path.join(publicDir, 'generated-data'))
      await assert.rejects(verifyArchive(archive, { extractPublicDir: publicDir }), /EEXIST/)
      const linked = path.join(temporary, 'extract-link'); await symlink(publicDir, linked)
      await assert.rejects(verifyArchive(archive, { extractPublicDir: linked }), /without symlink/)
    })
    await t.test('packaging rejects missing and unexpected source files', async () => {
      const publicDir = await freshPublic(); const root = path.join(publicDir, 'generated-data'); await mkdir(root)
      for (const kind of ['scores', 'susceptibility']) { await mkdir(path.join(root, kind)); await copyFile(path.join(frontend, 'public/generated-data', kind, 'manifest.json'), path.join(root, kind, 'manifest.json')) }
      await writeFile(path.join(root, 'unexpected.txt'), 'unexpected')
      await assert.rejects(createArchive({ publicDir, outputDir: path.join(temporary, 'never-created'), log: quiet }), /incomplete or contains unexpected/)
    })
    await t.test('original working assets still verify after every negative test', async () => { assert.equal((await inspectAssets()).total, 147279495) })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
