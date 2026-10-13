// The service is reached from the LAN under any of the host's names: no host
// list by default, and a page may write to the origin it was opened from.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seed } from '../scripts/seed.ts'
import { createHandler } from '../server/api.ts'

let root = ''
let server: Server
let port = 0

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-lan-'))
  await rm(root, { recursive: true })
  await seed(root, false)
  server = createServer(createHandler({ registryFile: join(root, 'registry.json'), allowedOrigins: [] }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})
after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) })

// fetch cannot set Host, so the requests go through node:http.
function call(method: string, host: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host, 'content-type': 'application/json' }
    if (origin) headers.origin = origin
    const req = request({ host: '127.0.0.1', port, method, path: '/api/workspaces', headers }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(method === 'GET' ? undefined : '{}')
  })
}

test('any host name is answered when no host list is given', async () => {
  assert.equal(await call('GET', 'agstudio.lan:8098'), 200)
  assert.equal(await call('GET', '192.168.1.20:8098'), 200)
})

test('a page writes to its own origin under a LAN name; another site may not', async () => {
  assert.notEqual(await call('POST', 'agstudio.lan:8093', 'http://agstudio.lan:8093'), 403)
  assert.equal(await call('POST', 'agstudio.lan:8093', 'http://evil.example'), 403)
  assert.equal(await call('POST', 'agstudio.lan:8093', 'http://agstudio.lan:9999'), 403)
})

test('a host list, when given, still restricts', async () => {
  const s = createServer(createHandler({ registryFile: join(root, 'registry.json'), allowedOrigins: [], allowedHosts: ['localhost'] }))
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as { port: number }).port
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, path: '/api/workspaces', headers: { host: 'agstudio.lan' } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject); req.end()
  })
  s.closeAllConnections(); s.close()
  assert.equal(status, 403)
})
