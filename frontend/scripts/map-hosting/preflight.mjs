import assert from 'node:assert/strict'
import { readFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { frontend, inspectAssets, walk, sha256, release } from './assets.mjs'

export const hostingFiles = ['_headers', '_redirects', '404.html']
export const appRoutes = ['/', '/map', '/map/', '/explore-map', '/explore-map/', '/districts', '/districts/pune', '/districts/raigad', '/districts/ratnagiri', '/districts/satara', '/methodology', '/methodology/', '/about', '/about/', '/official/login', '/official/accept-invite', '/official/dashboard', '/official/admin']
export const glob = pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
export function parseRedirects(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const [from, to, status, ...extra] = line.split(/\s+/)
    assert.equal(to, '/index.html', 'Only app-shell rewrites are allowed'); assert.equal(status, '200'); assert.equal(extra.length, 0)
    assert.ok(!glob(from).test('/generated-data/scores/missing.sct.gz') && !from.startsWith('/generated-data'), 'Data paths must not be rewritten')
    assert.ok(/^\/(map|explore-map|districts|methodology|about|official)(\/\*|\/)?$/.test(from), 'Unexpected application rewrite')
    return { from, to, status: Number(status) }
  })
}
export function parseHeaders(text) {
  const rules = []; let rule
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { rule = { pattern: line.trim(), headers: {} }; rules.push(rule) }
    else {
      const match = /^\s+([^:]+):\s*(.*)$/.exec(line)
      assert.ok(match && rule, 'Invalid Pages header rule')
      rule.headers[match[1].toLowerCase()] = match[2]
    }
  }
  return rules
}
export async function checkHosting(publicDir) {
  const redirects = parseRedirects(await readFile(path.join(publicDir, '_redirects'), 'utf8'))
  for (const route of appRoutes.filter(route => route !== '/')) assert.ok(redirects.some(rule => glob(rule.from).test(route)), `Missing app rewrite: ${route}`)
  const headers = parseHeaders(await readFile(path.join(publicDir, '_headers'), 'utf8'))
  for (const asset of ['/generated-data/susceptibility/manifest.json', '/generated-data/scores/manifest.json', `/generated-data/susceptibility/${release.visual.buildId}/pune/6/45/28.png`, `/generated-data/scores/${release.numerical.buildId}/pune/0/0.sct.gz`]) {
    const matches = headers.filter(rule => glob(rule.pattern).test(asset))
    const caches = matches.flatMap(rule => rule.headers['cache-control'] ? [rule.headers['cache-control']] : [])
    assert.equal(caches.length, 1, 'Missing/overlapping cache rules'); assert.ok(caches[0].includes('no-transform') && caches[0].includes('must-revalidate') && caches[0].includes('max-age=0'))
    const merged = Object.assign({}, ...matches.map(rule => rule.headers))
    assert.equal(merged['content-type'], asset.endsWith('.png') ? 'image/png' : asset.endsWith('.gz') ? 'application/octet-stream' : 'application/json')
    assert.equal(merged['x-content-type-options'], 'nosniff')
    assert.equal(merged['content-encoding'], undefined, 'Do not relabel stored gzip bodies as HTTP gzip')
  }
  const notFound = await readFile(path.join(publicDir, '404.html'), 'utf8')
  assert.ok(notFound.includes('<html lang="en">') && notFound.includes('<main>') && notFound.includes('404'))
  assert.ok(!notFound.includes('id="root"') && !notFound.includes('<script'), '404 must be a genuine static error document, not an SPA shell')
}

export async function checkOutput(publicDir, dist, inspected) {
  const output = await walk(dist)
  assert.ok(output.length <= 20000, 'Pages file limit exceeded')
  for (const file of output) {
    const rel = path.relative(dist, file).split(path.sep).join('/')
    assert.ok(!/(^|\/)(\.env[^/]*|\.git|\.aws|supabase|qa-results|ml)(\/|$)|\.(tif|tiff|joblib|pem|key)$/i.test(rel), 'Unintended private/source file in production output')
    assert.ok((await lstat(file)).size <= 25 * 1024 * 1024, 'Pages asset size limit exceeded')
  }
  const outputMap = output.filter(file => file.startsWith(path.join(dist, 'generated-data') + path.sep))
  assert.deepEqual(outputMap.map(file => path.relative(path.join(dist, 'generated-data'), file).split(path.sep).join('/')).sort(), [...inspected.hashes.keys()].sort(), 'Production map asset set differs from validated source')
  for (const [relative, hash] of inspected.hashes) assert.equal(sha256(await readFile(path.join(dist, 'generated-data', relative))), hash, `Production map bytes differ: ${relative}`)
  for (const file of hostingFiles) assert.ok((await readFile(path.join(publicDir, file))).equals(await readFile(path.join(dist, file))), `Production hosting file differs: ${file}`)
  await checkHosting(dist)
  const html = await readFile(path.join(dist, 'index.html'), 'utf8')
  assert.ok(html.includes('id="root"') && html.includes('type="module"'), 'Missing production application shell')
  const assets = output.filter(file => file.startsWith(path.join(dist, 'assets') + path.sep))
  assert.ok(assets.some(file => /maplibre-gl-worker-.+\.js$/.test(file)), 'Bundled map worker missing')
  assert.ok(assets.some(file => file.endsWith('.css')), 'Production styles missing')
  for (const file of output.filter(file => /\.(html|js|css)$/.test(file))) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/["'(]\/assets\/([a-zA-Z0-9._-]+)["')]/g)) assert.ok(output.includes(path.join(dist, 'assets', match[1])), `Referenced production asset missing: ${match[1]}`)
  }
  // Every ordinary public asset (image, favicon, routing metadata) is copied too.
  for (const file of (await walk(publicDir)).filter(file => !file.startsWith(path.join(publicDir, 'generated-data') + path.sep))) {
    const rel = path.relative(publicDir, file)
    assert.ok((await readFile(file)).equals(await readFile(path.join(dist, rel))), `Public asset differs in output: ${rel}`)
  }
  return output.length
}

export async function preflight({ publicDir = path.join(frontend, 'public'), dist = path.join(frontend, 'dist'), sourceOnly = false, log = console.log } = {}) {
  const inspected = await inspectAssets(publicDir)
  await checkHosting(publicDir)
  log(`PASS: pinned manifests, four districts/source hashes, ${release.visual.files} intact PNGs, ${release.numerical.files} intact numerical chunks; ${inspected.total} bytes unchanged.`)
  if (!sourceOnly) log(`PASS: final output has ${await checkOutput(publicDir, dist, inspected)} files; map bytes, application assets, worker, routing and headers verified.`)
  return inspected
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    assert.ok(args.every(arg => arg === '--source-only'), 'Usage: node scripts/map-hosting/preflight.mjs [--source-only]')
    await preflight({ sourceOnly: args.includes('--source-only') })
  } catch (error) { console.error(`Map deployment preflight FAILED: ${error.message}\nRestore the audited asset set; no files are regenerated automatically. See MAP_HOSTING.md.`); process.exitCode = 1 }
}
