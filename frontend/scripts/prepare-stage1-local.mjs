// Prepare source/config copies only. Never connects to Docker, Auth or a database.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const target = path.join(frontend, 'qa-results/stage1-local')
const sourceConfig = await readFile(path.join(frontend, 'supabase/config.toml'), 'utf8')
assert.match(sourceConfig, /^project_id = "ghat-ishara-official-portal"$/m, 'Unexpected source project ID; review isolated setup before proceeding')
await mkdir(path.dirname(target), { recursive: true })
// Refuse to overwrite an existing test project or its private environment files.
await mkdir(target, { mode: 0o700 })
await mkdir(path.join(target, 'supabase'), { mode: 0o700 })
for (const name of ['migrations', 'functions', 'templates']) await cp(path.join(frontend, 'supabase', name), path.join(target, 'supabase', name), { recursive: true, errorOnExist: true, force: false })
await cp(path.join(frontend, 'shared'), path.join(target, 'shared'), { recursive: true, errorOnExist: true, force: false })
let config = sourceConfig.replace('project_id = "ghat-ishara-official-portal"', 'project_id = "ghat-ishara-stage1-test"')
  .replaceAll('127.0.0.1:5173', '127.0.0.1:5178').replaceAll('127.0.0.1:4173', '127.0.0.1:4187')
config += '\n[api]\nport = 65421\nschemas = ["public", "graphql_public"]\n\n[db]\nport = 65422\nshadow_port = 65420\n\n[studio]\nport = 65423\n\n[inbucket]\nport = 65424\nsmtp_port = 65425\npop3_port = 65426\n\n[edge_runtime]\ninspector_port = 65427\n\n[analytics]\nenabled = false\n'
await writeFile(path.join(target, 'supabase/config.toml'), config, { flag: 'wx', mode: 0o600 })
await writeFile(path.join(target, 'supabase/.env.local'), 'SITE_URL=http://127.0.0.1:5178\nOFFICIAL_INVITE_REDIRECT_URL=http://127.0.0.1:5178/official/accept-invite\nACCESS_REQUEST_MAILPIT_URL=http://supabase_inbucket_ghat-ishara-stage1-test:8025\n', { flag: 'wx', mode: 0o600 })
console.log('Prepared ignored qa-results/stage1-local: distinct project ID, API 65421, DB 65422, Studio 65423, mail capture 65424, frontend 5178. No services started or database changes made. Follow ACCESS_REQUESTS.md.')
