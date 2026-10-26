import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
// Override GHAT_GEO_PYTHON for a teammate's isolated environment; never install system packages.
const python = process.env.GHAT_GEO_PYTHON ?? (existsSync('../.venv/bin/python') ? realpathSync('../.venv') + '/bin/python' : 'python3')
const mode = process.argv[2]
const args = mode === 'test' ? ['scripts/geospatial/test_tiles.py'] : ['scripts/geospatial/prepare_tiles.py', ...(mode === 'generate' ? ['--generate'] : []), ...process.argv.slice(3)]
const result = spawnSync(python, args, { stdio: 'inherit' })
if (result.error) console.error('Geospatial Python could not start. See MAP_EXPLORER.md for isolated environment setup.')
process.exit(result.status ?? 1)
