import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { frontend, release, inspectAssets, referenceCell, checkReference, decodeChunk } from './assets.mjs'
import { preflight, checkOutput, parseRedirects } from './preflight.mjs'
import { verifyHosted, validateOrigin } from './verify-hosted.mjs'
import { pagesFixture } from './pages-fixture.mjs'

let passed = 0
const pass = text => { passed++; console.log(`PASS: ${text}`) }
const quiet = () => {}
const original = await preflight({ log: quiet })
pass('read-only source/output preflight validates the complete pinned production artifact')
for (const reference of release.references) {
  const { grid, key, url } = referenceCell(reference, original.numerical)
  const entry = grid.tiles[key]
  if (entry !== null) checkReference(reference, original.numerical, decodeChunk(await readFile(path.join(frontend, 'public', url)), grid, key, entry.sha256))
}
pass('six selected source-cell values retain exact Float32 representations')
assert.throws(() => parseRedirects('/* /index.html 200'), /Data paths/)
for (const bad of ['https://example.invalid/subpath', 'https://user:DEMO_ONLY@example.invalid', 'https://example.invalid/?token=DEMO_ONLY', 'http://example.invalid', 'invalid']) assert.throws(() => validateOrigin(bad))
pass('catch-all data rewrites and credential/query/subpath/non-HTTPS deployment origins are rejected')

// Negative cases mutate only copies owned by this test. Original assets remain read-only.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ghat-map-hosting-'))
const publicDir = path.join(temporary, 'public'); const output = path.join(temporary, 'dist')
let fixture
try {
  await cp(path.join(frontend, 'public'), publicDir, { recursive: true })
  await cp(path.join(frontend, 'dist'), output, { recursive: true })
  async function mutation(file, change, check, message) {
    const saved = await readFile(file)
    try { await change(file, saved); await assert.rejects(check) }
    finally { await writeFile(file, saved) }
    pass(message)
  }
  const pngRelative = release.visual.districts.pune.sampleTile.slice(1)
  const scoreRelative = [...original.expected.keys()].find(key => key.endsWith('.sct.gz'))
  const sourceCheck = () => preflight({ publicDir, sourceOnly: true, log: quiet })
  await mutation(path.join(publicDir, pngRelative), file => unlink(file), sourceCheck, 'missing source PNG fails preflight')
  await mutation(path.join(publicDir, pngRelative), (file, bytes) => { const bad = Buffer.from(bytes); bad[40] ^= 1; return writeFile(file, bad) }, sourceCheck, 'corrupt source PNG fails CRC/integrity preflight')
  await mutation(path.join(publicDir, 'generated-data', scoreRelative), file => unlink(file), sourceCheck, 'missing numerical chunk fails preflight')
  await mutation(path.join(publicDir, 'generated-data', scoreRelative), (file, bytes) => writeFile(file, bytes.subarray(0, 40)), sourceCheck, 'truncated numerical gzip fails preflight')
  await mutation(path.join(publicDir, 'generated-data', scoreRelative), (file, bytes) => {
    const raw = gunzipSync(bytes); raw.writeFloatLE(.123, 32); return writeFile(file, gzipSync(raw))
  }, sourceCheck, 'validly re-encoded but altered numerical payload fails pinned integrity checks')
  for (const kind of ['susceptibility', 'scores']) {
    await mutation(path.join(publicDir, 'generated-data', kind, 'manifest.json'), file => unlink(file), sourceCheck, `missing canonical ${kind} manifest fails preflight`)
    await mutation(path.join(publicDir, 'generated-data', kind, 'manifest.json'), (file, bytes) => {
      const manifest = JSON.parse(bytes)
      if (kind === 'scores') manifest.districts[0].sourceSha256 = '0'.repeat(64)
      else manifest.districts.pop()
      return writeFile(file, JSON.stringify(manifest))
    }, sourceCheck, `changed/incomplete ${kind} identity fails preflight`)
  }
  const extra = path.join(publicDir, 'generated-data', 'unexpected.txt')
  await writeFile(extra, 'Test-only unexpected output')
  try { await assert.rejects(sourceCheck) } finally { await unlink(extra) }
  pass('unexpected generated files fail the pinned release inventory')
  await mutation(path.join(output, pngRelative), file => unlink(file), () => checkOutput(publicDir, output, original), 'missing final-output asset fails even when public source is complete')
  await mutation(path.join(output, 'generated-data', scoreRelative), (file, bytes) => { const bad = Buffer.from(bytes); bad[32] ^= 1; return writeFile(file, bad) }, () => checkOutput(publicDir, output, original), 'corrupt final-output chunk fails byte-for-byte comparison')
  await mutation(path.join(output, '_redirects'), file => writeFile(file, '/* /index.html 200\n'), () => checkOutput(publicDir, output, original), 'changed final-output routing fails preflight')

  let mode = 'normal'
  fixture = await pagesFixture(output, { transform(result, pathname) {
    if (mode === 'spa' && result.status === 404) return { ...result, status: 200, body: readFileSync(path.join(output, 'index.html')) }
    if (mode === 'missing-manifest' && pathname.endsWith('/scores/manifest.json')) return { ...result, status: 404 }
    if (mode === 'stale-manifest' && pathname.endsWith('/scores/manifest.json')) return { ...result, body: Buffer.from('{}') }
    if (mode === 'png-corrupt' && pathname.endsWith('.png')) return { ...result, body: Buffer.from('not a PNG') }
    if (mode === 'bad-type' && pathname.endsWith('.sct.gz')) result.headers['content-type'] = 'text/html'
    if (mode === 'bad-chunk' && pathname.endsWith('.sct.gz')) result.body = Buffer.from('<html>bad chunk</html>')
    if (mode === 'bad-cache' && pathname.endsWith('/manifest.json')) result.headers['cache-control'] = 'public, max-age=31536000, immutable'
    if (mode === 'http-gzip' && result.status === 200 && pathname.endsWith('.sct.gz')) result.headers['content-encoding'] = 'gzip'
    return result
  } })
  await verifyHosted(fixture.origin, { allAssets: true, log: quiet })
  pass('future-host verifier passes real local HTTP for both manifests, all 2,418 generated files, four districts, six exact values, deep links and missing files')
  for (const failure of ['spa', 'missing-manifest', 'stale-manifest', 'png-corrupt', 'bad-type', 'bad-chunk', 'bad-cache']) {
    mode = failure
    await assert.rejects(() => verifyHosted(fixture.origin, { log: quiet }))
    pass(`future-host verifier rejects ${failure} responses`)
  }
  mode = 'http-gzip'
  await verifyHosted(fixture.origin, { log: quiet })
  pass('correct HTTP gzip delivery is accepted without double decompression')
  mode = 'normal'
  await verifyHosted(fixture.origin, { browser: true, log: quiet })
  pass('future-host browser mode verifies real pointer/keyboard score inspection in every district without map transport mocks')
} finally {
  await fixture?.close()
  await rm(temporary, { recursive: true, force: true })
}
await preflight({ log: quiet })
pass('original source/output still match the pinned release after all negative-fixture tests')
console.log(`PASS: ${passed} map-hosting scenarios. No Wrangler, account access, deployment, regeneration or original data changes.`)
