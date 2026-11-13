import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
// Override GHAT_GEO_PYTHON for a teammate's isolated environment; never install system packages.
const python = process.env.GHAT_GEO_PYTHON ?? (existsSync('../.venv/bin/python') ? realpathSync('../.venv') + '/bin/python' : 'python3')
const mode = process.argv[2]
const script = mode.startsWith('scores') ? 'scripts/geospatial/prepare_scores.py' : 'scripts/geospatial/prepare_tiles.py'
const args = mode === 'test-scores' ? ['scripts/geospatial/test_scores.py'] : mode === 'test' ? ['scripts/geospatial/test_tiles.py'] : [script, ...(['generate', 'scores'].includes(mode) ? ['--generate'] : []), ...process.argv.slice(3)]
const result = spawnSync(python, args, { stdio: 'inherit' })
if (result.error) console.error('Geospatial Python could not start. See MAP_EXPLORER.md for isolated environment setup.')
process.exit(result.status ?? 1)
