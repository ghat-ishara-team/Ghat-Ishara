import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Deliberately invalid fixtures, passed only through the child environment, never logged.
const fakeJWT = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"service_role","iss":"DEMO_ONLY"}').toString('base64url')}.DEMO_NOT_A_SIGNATURE`
const probes = [
  { VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_DEMO_ONLY_NOT_A_REAL_KEY' },
  { VITE_SUPABASE_PUBLISHABLE_KEY: fakeJWT },
  { VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_OTHER_CONFIGURATION: fakeJWT },
  { VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SERVICE_ROLE_KEY: 'DEMO_SERVER_ONLY_NOT_A_KEY' },
]
for (const probe of probes) {
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'qa-results/public-env-probe'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, ...probe }, encoding: 'utf8',
  })
  if (result.error) throw new Error(`Unable to start Vite configuration probe (${result.error.code ?? 'unknown error'}).`)
  assert.equal(result.status, 1, 'Unsafe public configuration must fail before bundling')
  const output = result.stdout + result.stderr
  assert.ok(output.includes('Unsafe public environment configuration'), 'Fail with the expected configuration guard')
  for (const value of Object.values(probe).filter(Boolean)) assert.ok(!output.includes(value), 'Never print rejected values')
}

// Scan browser sources and built assets without printing any potential credential values.
const findings = []
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) { await scan(file); continue }
    if (!/\.(?:[cm]?[jt]sx?|html|json|css|map)$/.test(entry.name)) continue
    const source = await readFile(file, 'utf8')
    if (/sb_secret_[A-Za-z0-9_-]{12,}/.test(source)) findings.push({ file, kind: 'secret-key literal' })
    for (const match of source.matchAll(/(?:eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
      try {
        if (JSON.parse(Buffer.from(match[1], 'base64url').toString()).role === 'service_role') findings.push({ file, kind: 'service-role JWT literal' })
      } catch { /* Not a JWT payload. */ }
    }
    if (file.startsWith('dist') && /SUPABASE_SERVICE_ROLE_KEY|BOOTSTRAP_ADMIN_EMAIL/.test(source)) findings.push({ file, kind: 'server-only module in bundle' })
  }
}
await scan('src')
await scan('dist')
assert.deepEqual(findings, [], 'Browser source/build scan; values are intentionally omitted')
console.log('PASS: 4 unsafe-public-environment build probes rejected without value disclosure; browser source/build contains no recognized secret-key or service-role JWT literals or server-only modules.')
