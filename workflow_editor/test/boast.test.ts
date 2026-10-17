// workflow_editor p12: Boast serving. The published page and its assets come
// from one resolved commit; the working tree is a distinct, explicit preview;
// absent is a state, failures are errors; nothing outside boast/ is served;
// every response is sandboxed (opaque origin) and media answer byte ranges.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessContext, RepoHost } from '../server/access.ts'
import { createHandler } from '../server/api.ts'
import { boastState } from '../server/boast.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import type { Gitea, GiteaRepo } from '../server/gitea.ts'
import { setShareArea } from '../server/shares.ts'

let root = ''
let srv: Server
let base = ''
let ctx: AccessContext
let dir = '' // the workspace
let remote = ''
let share = ''

function stubHost(gitea: string): RepoHost {
  const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(gitea, owner, `${name}.git`), htmlUrl: '', description: '', empty: false, defaultBranch: 'main', archived: false })
  return {
    url: 'http://gitea.test', cloneUrl: (o, n) => join(gitea, o, `${n}.git`), gitEnv: async () => ({}),
    repoById: async id => (id === 1 ? info(1, 'dev', 'pj-a') : null),
    repo: async (o, n) => (o === 'dev' && n === 'pj-a' ? info(1, o, n) : null),
  }
}
const head = (repo: string) => gitOk(repo, ['rev-parse', 'HEAD']).then(x => x.trim())
async function commitPush(files: Record<string, string>, message = 'boast') {
  for (const [p, t] of Object.entries(files)) { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), t) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', message]); await gitOk(dir, ['push', '-q', 'origin', 'HEAD:main'])
  return head(dir)
}
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}/${path}`, { headers, redirect: 'manual' })
const state = async (q = '') => (await (await get(`api/boast/a?refresh=1${q.replace('?', '&')}`)).json()) as { state: string; commit: string; entry: string | null; source: string; workspace?: { dirty: boolean } }

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-boast-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
  const area = join(root, 'area')
  const gitea = join(root, 'gitea')
  const registry = join(area, 'registry.json')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  dir = join(area, 'pj-a')
  const c = await createProject({ dir, id: 'a', name: 'Project A', intent: 'Ship things.', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(c.ok, c.message)
  remote = join(gitea, 'dev', 'pj-a.git')
  await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'HEAD:main'])
  const raw = JSON.parse(await readFile(registry, 'utf8'))
  raw.workspaces[0].project = 'a'
  raw.repositories = [{ gitea: { id: 1, owner: 'dev', name: 'pj-a' }, category: 'root', description: '' }]
  raw.projects = [{ id: 'a', root: 'gitea:1' }]
  await writeFile(registry, JSON.stringify(raw, null, 2))
  const host = stubHost(gitea)
  ctx = { registryFile: registry, area, gitea: host, fetchTtlMs: 0 }
  share = join(root, 'share')
  await mkdir(join(share, 'runs', 'o1'), { recursive: true })
  await writeFile(join(share, '.wfe-share.json'), '{"share":"agshare"}')
  await writeFile(join(share, 'runs', 'o1', 'clip.mp4'), Buffer.alloc(1000, 7))
  await writeFile(join(share, 'runs', 'o1', 'page.html'), '<p>on the share</p>')
  await writeFile(join(area, 'shares.json'), JSON.stringify({ shares: { agshare: { root: share } } }))
  setShareArea(area)
  srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], gitea: host as unknown as Gitea }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
})
after(async () => { srv?.close(); setShareArea(undefined); await rm(root, { recursive: true, force: true }) })

test('absent is a state, not a failure; an unknown project is a failure', async () => {
  const s = await state()
  assert.equal(s.state, 'absent')
  assert.equal(s.entry, null)
  assert.equal(s.commit, await head(remote))
  const r = await get('api/boast/nope')
  assert.equal(r.status, 404)
  assert.equal(((await r.json()) as { detail: { state: string } }).detail.state, 'absent')
})

test('the page and its assets come from the commit the state resolved, also after main moves on', async () => {
  const c1 = await commitPush({ 'boast/index.html': '<link rel="stylesheet" href="style.css"><h1>v1</h1>', 'boast/style.css': 'h1{color:red}', 'boast/media/clip.mp4': 'x'.repeat(5000) })
  const s1 = await state()
  assert.equal(s1.state, 'present')
  assert.equal(s1.commit, c1)
  assert.equal(s1.entry, `api/boast/a/c/${c1}/`)
  const c2 = await commitPush({ 'boast/index.html': '<h1>v2</h1>', 'boast/style.css': 'h1{color:blue}' })
  assert.notEqual(c1, c2)
  const page = await get(`${s1.entry}`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type')!, /^text\/html/)
  assert.match(await page.text(), /v1/)
  assert.equal(await (await get(`api/boast/a/c/${c1}/style.css`)).text(), 'h1{color:red}', 'the asset of the same commit')
  assert.equal(await (await get(`api/boast/a/c/${c2}/style.css`)).text(), 'h1{color:blue}')
  assert.equal((await state()).commit, c2, 'a new state read gives the new commit')
  const css = await get(`api/boast/a/c/${c1}/style.css`)
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.match(css.headers.get('cache-control')!, /immutable/)
  const etag = css.headers.get('etag')!
  assert.equal((await get(`api/boast/a/c/${c1}/style.css`, { 'if-none-match': etag })).status, 304)
  // A folder without its slash is redirected, so relative URLs resolve inside it.
  const redirect = await get(`api/boast/a/c/${c1}`)
  assert.equal(redirect.status, 301)
  assert.equal(redirect.headers.get('location'), `${c1}/`)
  assert.equal((await get(`api/boast/a/c/${c1}/nothing.png`)).status, 404)
  assert.equal((await get('api/boast/a/c/main/index.html')).status, 400, 'only full commit ids address content')
})

test('every response is sandboxed without same-origin; module scripts may load', async () => {
  const s = await state()
  const r = await get(s.entry!)
  const csp = r.headers.get('content-security-policy')!
  assert.match(csp, /^sandbox /)
  assert.match(csp, /allow-scripts/)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  // The page's opaque origin cannot write.
  const w = await fetch(`${base}/api/workspaces/a/project`, { method: 'PUT', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(w.status, 403)
})

test('byte ranges for media', async () => {
  const s = await state()
  const one = await commitPush({ 'boast/media/clip.mp4': Buffer.alloc(5000, 1).toString('latin1') })
  assert.ok(one)
  const s2 = await state()
  assert.notEqual(s.commit, s2.commit)
  const r = await get(`api/boast/a/c/${s2.commit}/media/clip.mp4`, { range: 'bytes=0-1' })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 0-1/5000')
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.equal((await r.arrayBuffer()).byteLength, 2)
  const tail = await get(`api/boast/a/c/${s2.commit}/media/clip.mp4`, { range: 'bytes=4990-' })
  assert.equal(tail.status, 206)
  assert.equal((await tail.arrayBuffer()).byteLength, 10)
  assert.equal((await get(`api/boast/a/c/${s2.commit}/media/clip.mp4`, { range: 'bytes=9000-' })).status, 416)
})

test('content-root boundaries: traversal, symbolic links, .git', async () => {
  await symlink('../project.yaml', join(dir, 'boast', 'escape.yaml'))
  await symlink('style.css', join(dir, 'boast', 'alias.css'))
  const c = await commitPush({})
  assert.equal((await get(`api/boast/a/c/${c}/%2E%2E%2Fproject.yaml`)).status, 400, 'an encoded traversal')
  assert.equal((await get(`api/boast/a/c/${c}/escape.yaml`)).status, 403, 'a committed link leaving boast/')
  const alias = await get(`api/boast/a/c/${c}/alias.css`)
  assert.equal(alias.status, 200)
  assert.equal(await alias.text(), 'h1{color:blue}', 'a link inside boast/ is followed')
  assert.equal((await get(`api/boast/a/w/a/escape.yaml`)).status, 403, 'a working-tree link leaving boast/')
  assert.equal((await get(`api/boast/a/w/a/media%2F%2E%2E%2F%2E%2E%2Fproject.yaml`)).status, 400)
  assert.equal((await get(`api/boast/a/c/${c}/.git/config`)).status, 403)
})

test('preview is the working tree, explicit and distinguishable; ignored files are not shown', async () => {
  await writeFile(join(dir, 'boast', 'index.html'), '<h1>draft</h1>')
  await writeFile(join(dir, '.gitignore'), `${await readFile(join(dir, '.gitignore'), 'utf8').catch(() => '')}boast/secret.txt\n`)
  await writeFile(join(dir, 'boast', 'secret.txt'), 'local only')
  const p = await state('?source=worktree&workspace=a')
  assert.equal(p.source, 'worktree')
  assert.equal(p.state, 'present')
  assert.equal(p.entry, 'api/boast/a/w/a/')
  assert.equal(p.workspace?.dirty, true)
  const page = await get(p.entry!)
  assert.match(await page.text(), /draft/)
  assert.equal(page.headers.get('cache-control'), 'no-cache')
  assert.match(page.headers.get('content-security-policy')!, /^sandbox /)
  const pub = await state()
  assert.doesNotMatch(await (await get(pub.entry!)).text(), /draft/, 'published content is unaffected')
  assert.equal((await get('api/boast/a/w/a/secret.txt')).status, 404)
  assert.equal((await get('api/boast/a/w/nope/')).status, 404)
  const direct = await boastState(ctx, 'a', { source: 'worktree' })
  assert.equal(direct.workspace?.id, 'a')
})

test('shared:// references resolve to an inline display route with ranges', async () => {
  const r = (await (await get(`api/share-ref?ref=${encodeURIComponent('shared://agshare/runs/o1/clip.mp4')}`)).json()) as { state: string; url: string; download: string; path: string }
  assert.equal(r.state, 'ok')
  assert.equal(r.url, 'api/shares/agshare/runs/o1/clip.mp4?inline=1')
  assert.equal(r.path, join(await realpath(share), 'runs', 'o1', 'clip.mp4'))
  const v = await get(r.url, { range: 'bytes=0-9' })
  assert.equal(v.status, 206)
  assert.equal(v.headers.get('content-type'), 'video/mp4')
  assert.equal(v.headers.get('content-disposition'), 'inline')
  const d = await get(r.download)
  assert.match(d.headers.get('content-disposition')!, /^attachment/)
  const html = await get('api/shares/agshare/runs/o1/page.html?inline=1')
  assert.match(html.headers.get('content-type')!, /^text\/html/)
  assert.match(html.headers.get('content-security-policy')!, /^sandbox /)
  const folder = (await (await get(`api/share-ref?ref=${encodeURIComponent('shared://agshare/runs/o1/')}`)).json()) as { url: string }
  assert.equal(folder.url, 'api/shares/agshare/runs/o1/?inline=1')
  const listing = await get(folder.url)
  assert.match(listing.headers.get('content-type')!, /^text\/html/)
  assert.match(await listing.text(), /href="clip\.mp4\?inline=1"/)
  const missing = (await (await get(`api/share-ref?ref=${encodeURIComponent('shared://agshare/none.png')}`)).json()) as { state: string; url: null }
  assert.equal(missing.state, 'absent')
  assert.equal(missing.url, null)
  assert.equal((await get('api/share-ref?ref=http://x')).status, 400)
})
