// Local test model for the committed static rules, NOT Cloudflare's runtime and
// never a production server. Wrangler is deliberately not required/installed.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { glob, parseHeaders, parseRedirects } from './preflight.mjs'

const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.gz': 'application/octet-stream', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.csv': 'text/csv' }
export async function pagesFixture(directory, { transform = value => value } = {}) {
  const root = path.resolve(directory)
  const redirects = parseRedirects(await readFile(path.join(root, '_redirects'), 'utf8'))
  const rules = parseHeaders(await readFile(path.join(root, '_headers'), 'utf8'))
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      let file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!file.startsWith(root + path.sep)) { response.writeHead(400); response.end(); return }
      let status = 200
      if (!(await stat(file).catch(() => null))?.isFile()) {
        const rewrite = redirects.find(rule => glob(rule.from).test(pathname))
        file = path.join(root, rewrite ? 'index.html' : '404.html'); status = rewrite ? 200 : 404
      }
      let result = { status, body: await readFile(file), headers: { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' } }
      for (const rule of rules.filter(rule => glob(rule.pattern).test(pathname))) Object.assign(result.headers, rule.headers)
      if (status === 404) result.headers['cache-control'] = 'no-store'
      result = await transform(result, pathname)
      response.writeHead(result.status, result.headers); response.end(request.method === 'HEAD' ? undefined : result.body)
    } catch { response.writeHead(500); response.end('Local fixture failure') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}
