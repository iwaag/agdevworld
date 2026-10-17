// p12 browser check: the Boast area against a private fixture served on this
// host's LAN name over plain HTTP (the origin the person uses). It needs a
// built UI (`vite build`) and ffmpeg for the test video.
//
//   node checks/boast.ts            (Chromium)
//   WFE_BROWSER=webkit node checks/boast.ts
//
// Checks: published page and same-commit assets; the frame keeps its document
// and a playing video across project refreshes, events and mode switches;
// video seeking (byte ranges); height messages; copy with its fallback;
// shared:// resolution and inline media; absent and failed states; update
// indication without reload; open-in-new-tab isolation; a narrow layout.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { RepoHost } from '../server/access.ts'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import type { Gitea, GiteaRepo } from '../server/gitea.ts'
import { setShareArea } from '../server/shares.ts'
import { Watcher } from '../server/watch.ts'
import { check, done, open, SHOTS, shot } from './lib.ts'

const exec = promisify(execFile)
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'wfe-boast-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check\n\temail = c@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const area = join(root, 'area'), gitea = join(root, 'gitea'), registry = join(area, 'registry.json')
await mkdir(join(gitea, 'dev'), { recursive: true })

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><title>fixture</title></head>
<body><h1 id="t">Boast fixture</h1><p id="loaded"></p>
<video id="v" src="media/clip.mp4" muted playsinline controls width="320"></video>
<p><button id="copy">Copy path</button> <span id="copyres"></span></p>
<p><button id="res">Resolve share</button> <span id="resres"></span></p>
<img id="shared" alt="" width="40"><a id="alone" href="media/clip.mp4" target="_blank">clip</a>
<div style="height:700px"></div>
<script type="module" src="app.js"></script></body></html>`
const APP = `window.__loadedAt = performance.timeOrigin; document.getElementById('loaded').textContent = 'origin ' + window.origin
parent.postMessage({ wfeBoast: 1, type: 'height', height: document.documentElement.scrollHeight }, '*')
addEventListener('message', e => { const m = e.data; if (!m || m.wfeBoast !== 1) return
  if (m.type === 'copy-result') document.getElementById('copyres').textContent = m.method
  if (m.type === 'resolve-shared-result') { document.getElementById('resres').textContent = m.state + ' ' + (m.path || ''); if (m.url) document.getElementById('shared').src = m.url } })
document.getElementById('copy').onclick = () => parent.postMessage({ wfeBoast: 1, type: 'copy', id: 1, text: 'D:\\\\builds\\\\playprey\\\\game.exe' }, '*')
document.getElementById('res').onclick = () => parent.postMessage({ wfeBoast: 1, type: 'resolve-shared', id: 2, ref: 'shared://agshare/thumbs/pred.png' }, '*')`

async function project(id: string, gid: number, files: Record<string, string | Buffer> | null) {
  const dir = join(area, `pj-${id}`)
  const c = await createProject({ dir, id, name: `Project ${id.toUpperCase()}`, intent: `Fixture ${id}.`, goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  if (!c.ok) throw new Error(c.message)
  const remote = join(gitea, 'dev', `pj-${id}.git`)
  if (files) {
    await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', remote])
    await gitOk(dir, ['remote', 'add', 'origin', remote])
    for (const [p, t] of Object.entries(files)) { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), t) }
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '--allow-empty', '-m', 'boast']); await gitOk(dir, ['push', '-q', '-u', 'origin', 'HEAD:main'])
  }
  return { id, gid, dir }
}

const clip = join(root, 'clip.mp4')
await exec('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip])
const a = await project('a', 1, { 'boast/index.html': PAGE, 'boast/style.css': 'h1 { color: rgb(200, 0, 0) }', 'boast/app.js': APP, 'boast/media/clip.mp4': await readFile(clip) })
const b = await project('b', 2, {}) // no boast/
const c = await project('c', 3, null) // remote never created: fetch fails, nothing cached
const raw = JSON.parse(await readFile(registry, 'utf8'))
raw.workspaces = raw.workspaces.map((w: { id: string; path: string }) => ({ ...w, project: w.id }))
raw.repositories = [a, b, c].map(p => ({ gitea: { id: p.gid, owner: 'dev', name: `pj-${p.id}` }, category: 'root', description: '' }))
raw.projects = [a, b, c].map(p => ({ id: p.id, root: `gitea:${p.gid}` }))
await writeFile(registry, JSON.stringify(raw, null, 2))
const share = join(root, 'share')
await mkdir(join(share, 'thumbs'), { recursive: true })
await writeFile(join(share, '.wfe-share.json'), '{"share":"agshare"}')
await exec('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:size=40x40', '-frames:v', '1', join(share, 'thumbs', 'pred.png')])
await writeFile(join(area, 'shares.json'), JSON.stringify({ shares: { agshare: { root: share } } }))
setShareArea(area)

const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(gitea, owner, `${name}.git`), htmlUrl: '', description: '', empty: false, defaultBranch: 'main', archived: false })
const names: Record<number, string> = { 1: 'pj-a', 2: 'pj-b', 3: 'pj-c' }
const host: RepoHost = {
  url: 'http://gitea.test', cloneUrl: (o, n) => join(gitea, o, `${n}.git`), gitEnv: async () => ({}),
  repoById: async id => (names[id] ? info(id, 'dev', names[id]) : null),
  repo: async (o, n) => { const id = Number(Object.entries(names).find(([, x]) => x === n)?.[0]); return id ? info(id, o, n) : null },
}
const watcher = new Watcher(500, { gitIntervalMs: 1000, registryFile: registry })
const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], distDir: join(pkg, 'dist'), watcher, gitea: host as unknown as Gitea }))
await new Promise<void>(r => srv.listen(0, '0.0.0.0', r))
const lanName = process.env.WFE_LAN_HOST ?? (hostname().endsWith('.local') ? hostname() : `${hostname().split('.')[0]}.local`)
const BASE = `http://${lanName}:${(srv.address() as { port: number }).port}/`
console.log(`fixture on ${BASE} (${process.env.WFE_BROWSER ?? 'chromium'})`)
const engine = process.env.WFE_BROWSER ?? 'chromium'

const { browser, page, errors } = await open(1400, 1000, { display: 'simple' })
try {
  await page.goto(`${BASE}#/ws/a`)
  const frameEl = page.locator('iframe.boast-frame')
  await frameEl.waitFor({ state: 'visible', timeout: 20_000 })
  const frame = page.frameLocator('iframe.boast-frame')
  await frame.locator('#t').waitFor({ timeout: 20_000 })
  const f = page.frames().find(x => x !== page.mainFrame())!
  check(await f.evaluate(() => getComputedStyle(document.getElementById('t')!).color) === 'rgb(200, 0, 0)', 'the stylesheet of the same commit applies')
  const shownOrigin = await f.evaluate(() => window.origin)
  check(shownOrigin === 'null', `the page runs in an opaque origin (${shownOrigin})`)
  check(await f.evaluate(() => { try { return !!window.parent.document } catch { return false } }) === false, 'the page cannot reach the editor DOM')
  const wrote = await f.evaluate(async (base) => { try { const r = await fetch(`${base}api/workspaces/a/project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }); return r.status } catch (e) { return String(e) } }, BASE)
  check(wrote !== 200, `the page cannot use the write API (${wrote})`)
  await page.waitForTimeout(500)
  const h = await frameEl.evaluate(el => (el as HTMLIFrameElement).getBoundingClientRect().height)
  check(h > 800, `the frame takes the page's reported height (${Math.round(h)} px)`)
  await shot(page, `boast-${engine}-simple`)

  // Playback continuity.
  await f.evaluate(() => (document.getElementById('v') as HTMLVideoElement).play())
  await page.waitForTimeout(1500)
  const loadedAt = await f.evaluate(() => (window as unknown as { __loadedAt: number }).__loadedAt)
  const t0 = await f.evaluate(() => (document.getElementById('v') as HTMLVideoElement).currentTime)
  await page.locator('.display-toggle button[data-display="detail"]').click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Refresh' }).first().click().catch(() => {})
  await writeFile(join(a.dir, 'devdocs', 'touched.md'), 'x') // a git event (dirty)
  await writeFile(join(a.dir, 'project.yaml'), (await readFile(join(a.dir, 'project.yaml'), 'utf8')).replace('Fixture a.', 'Fixture a, edited.')) // a content event
  await page.waitForTimeout(3500)
  const f2 = page.frames().find(x => x !== page.mainFrame())!
  const same = await f2.evaluate(() => (window as unknown as { __loadedAt: number }).__loadedAt).catch(() => null)
  const t1 = await f2.evaluate(() => (document.getElementById('v') as HTMLVideoElement).currentTime).catch(() => -1)
  check(same === loadedAt, 'the frame kept its document across refreshes, events and a mode switch')
  check(t1 > t0 + 2, `the video kept playing (${t0.toFixed(2)} s → ${t1.toFixed(2)} s)`)
  const seeked = await f2.evaluate(() => new Promise<number>(res => { const v = document.getElementById('v') as HTMLVideoElement; v.addEventListener('seeked', () => res(v.currentTime), { once: true }); v.currentTime = 9; setTimeout(() => res(-1), 5000) }))
  check(seeked >= 8.9, `seeking a committed video works (${seeked})`)

  // Copy, with the fallback on an insecure (http) origin.
  await f2.locator('#copy').click()
  await page.waitForTimeout(600)
  const method = await f2.locator('#copyres').textContent()
  const manual = await page.locator('.boast-manual').isVisible()
  check(method === 'execCommand' || method === 'clipboard' || (method === 'manual' && manual), `copy answered: ${method}${manual ? ' (manual dialog shown)' : ''}`)
  if (manual) {
    const sel = await page.locator('.boast-manual-text').evaluate(el => { const t = el as HTMLTextAreaElement; return t.value.slice(t.selectionStart, t.selectionEnd) })
    check(sel === 'D:\\builds\\playprey\\game.exe', 'the manual fallback shows the text selected')
    await shot(page, `boast-${engine}-manual-copy`, false)
    await page.getByRole('button', { name: 'Close' }).click()
  } else {
    const ctx = page.context()
    if (engine === 'chromium') await ctx.grantPermissions(['clipboard-read'], { origin: BASE.replace(/\/$/, '') }).catch(() => {})
    const clip2 = await page.evaluate(() => navigator.clipboard?.readText().catch(() => null) ?? null).catch(() => null)
    console.log(`    clipboard read back: ${clip2 === null ? 'not readable from an insecure origin (expected)' : JSON.stringify(clip2)}`)
  }

  // shared:// resolution and inline display.
  await f2.locator('#res').click()
  await page.waitForTimeout(800)
  check(/^ok /.test(await f2.locator('#resres').textContent() ?? ''), `a shared:// reference resolved (${await f2.locator('#resres').textContent()})`)
  check(await f2.evaluate(() => new Promise<number>(res => { const i = document.getElementById('shared') as HTMLImageElement; if (i.complete && i.naturalWidth) res(i.naturalWidth); else { i.onload = () => res(i.naturalWidth); i.onerror = () => res(0) } })) === 40, 'the shared image displays inline')

  // Update indication: a new published commit is offered, not loaded.
  await writeFile(join(a.dir, 'boast', 'style.css'), 'h1 { color: rgb(0, 0, 200) }')
  await gitOk(a.dir, ['commit', '-qam', 'v2']); await gitOk(a.dir, ['push', '-q', 'origin', 'HEAD:main'])
  await page.waitForTimeout(11_000) // past the access cache's fetch age
  await writeFile(join(a.dir, 'devdocs', 'touched-2.md'), 'y') // a git event (status changes), so the panel checks
  await page.locator('.boast-update').waitFor({ timeout: 15_000 }).catch(() => {})
  check(await page.locator('.boast-update').isVisible(), 'a newer published page is offered')
  const f3 = page.frames().find(x => x !== page.mainFrame())!
  check(await f3.evaluate(() => (window as unknown as { __loadedAt: number }).__loadedAt) === loadedAt, 'and the running page is not reloaded by itself')
  await page.locator('.boast-update button').click()
  await page.waitForTimeout(1500)
  const f4 = page.frames().find(x => x !== page.mainFrame())!
  check(await f4.evaluate(() => getComputedStyle(document.getElementById('t')!).color) === 'rgb(0, 0, 200)', 'showing it loads the new commit')

  // Preview of the working tree.
  await writeFile(join(a.dir, 'boast', 'style.css'), 'h1 { color: rgb(0, 150, 0) }')
  await page.getByRole('button', { name: 'Preview workspace' }).click()
  await page.waitForTimeout(1500)
  const f5 = page.frames().find(x => x !== page.mainFrame())!
  check(await f5.evaluate(() => getComputedStyle(document.getElementById('t')!).color) === 'rgb(0, 150, 0)', 'preview shows the uncommitted working tree')
  check(/preview · a/.test(await page.locator('.boast-meta').textContent() ?? ''), 'preview is labelled as such')
  await page.getByRole('button', { name: 'Published' }).click()
  await page.waitForTimeout(1200)

  // Open in a new tab: still sandboxed.
  const href = await page.locator('.boast-actions a.button').getAttribute('href')
  check(!!href && /\/api\/boast\/a\/c\/[0-9a-f]{40}\/$/.test(href), `open in new tab targets the commit (${href})`)
  const tab = await browser.newPage()
  await tab.goto(href!)
  await tab.locator('#t').waitFor()
  check(await tab.evaluate(() => window.origin) === 'null', 'opened alone, the page is still in an opaque origin')
  await tab.close()

  // Absent and failed states; editing still works.
  await page.locator('.display-toggle button[data-display="simple"]').click()
  await page.goto(`${BASE}#/ws/b`)
  await page.locator('.boast-absent').waitFor({ timeout: 15_000 })
  check(await page.locator('.boast-frame').isHidden(), 'absent: no frame, a compact neutral note')
  check(await page.locator('.boast .banner.error').count() === 0, 'absent is not shown as an error')
  await shot(page, `boast-${engine}-absent`, false)
  await page.goto(`${BASE}#/ws/c`)
  await page.locator('.boast .banner.error').waitFor({ timeout: 30_000 })
  check(/cannot be read/.test(await page.locator('.boast .banner.error').textContent() ?? ''), 'unreadable: a distinct failure')
  check(await page.getByRole('button', { name: 'Project settings' }).isVisible(), 'the project stays editable')

  // Narrow layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}#/ws/a`)
  await page.frameLocator('iframe.boast-frame').locator('#t').waitFor({ timeout: 20_000 })
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  check(overflow <= 0, `no horizontal scroll at 390 px (${overflow})`)
  await shot(page, `boast-${engine}-narrow`, false)
  check(errors.filter(e => !/Failed to load resource|blocked by CORS policy|access control checks|Preflight response/.test(e)).length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  srv.close()
  console.log(`screenshots: ${SHOTS}`)
  await rm(root, { recursive: true, force: true })
}
done()
process.exit()
