// p14 ex1 browser check: the context list under awkward content, against a
// private fixture on this host's LAN name over plain HTTP. Needs a built UI
// (`vite build`). Starts in Simple.
//
//   node checks/contextRows.ts                 (Chromium, desktop)
//   WFE_BROWSER=webkit node checks/contextRows.ts
//   WFE_NARROW=1 node checks/contextRows.ts    (390 px)
//
// Content: a short Japanese instruction (in its row), several long
// Japanese sentences on few lines and a long unbroken line (both opened,
// never cut), multiline information (opened, read as paragraphs), many
// inherited blocks (folded behind "Show all", the short instruction kept),
// an empty workflow scope; keyboard-only open, close and focus return.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator } from 'playwright-core'
import { createHandler } from '../server/api.ts'
import { ContextStore } from '../server/contextStore.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Watcher } from '../server/watch.ts'
import { check, done, open, shot } from './lib.ts'

const narrow = !!process.env.WFE_NARROW
const tag = `p14ex1-rows-${process.env.WFE_BROWSER === 'webkit' ? 'webkit' : 'chromium'}${narrow ? '-narrow' : ''}`
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'wfe-ctx-rows-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check\n\temail = c@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const area = join(root, 'area'), registry = join(area, 'registry.json')
const dir = join(area, 'pj-p')
const c = await createProject({ dir, id: 'p', name: 'Project P', intent: 'Make media assets.', goals: ['Every asset is checked'], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
if (!c.ok) throw new Error(c.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make one asset.
documentation: {policy: manual}
execution:
  agent: p-agent
repositories:
  root: {path: ., access: editable}
nodes:
  a: {type: do, description: Do it.}
`)
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])

const store = new ContextStore(area)
const SYS = { scope: 'system' as const }
const P = { scope: 'project' as const, project: 'p' }
const by = { by: 'iwaag', base: 0 }
const SHORT_JA = '生成するファイルのテキストは特に指定がない場合は英語で作成'
const LONG_JA = 'このプロジェクトで作るアセットは、依頼者が確認しやすいように必ず小さな試作を先に作り、その結果と使った手順を記録してから本番の生成に進むこと。\n生成に使ったモデル、設定、入力ファイルの所在は後から再現できるように記録し、確認できなかった点はそのまま未確認として書くこと。'
const UNBROKEN = `See ${'https://example.invalid/'.padEnd(300, 'x')} before starting.`
await store.set(SYS, 'developer', { title: 'Developer instructions', kind: 'instruction', manager: 'Developer', body: SHORT_JA }, by)
await store.set(SYS, 'long-ja', { title: 'Asset procedure', kind: 'instruction', manager: 'Developer', body: LONG_JA }, by)
await store.set(SYS, 'unbroken', { title: 'Reference link', kind: 'instruction', manager: 'Developer', body: UNBROKEN }, by)
await store.set(SYS, 'cluster', {
  title: 'Cluster overview', kind: 'information', manager: 'cagent',
  body: 'agpc has a GPU and ComfyUI.\nagstudio has a large memory and Ollama.\nagbach was not reachable at the last check.\n- Ask cagent before heavy jobs.\n- Details: `context:system/cluster/hosts.md`.',
  evidence: [{ ref: 'context:system/cluster/hosts.md', basis: 'observed', status: 'unknown' }], details: [{ name: 'hosts.md', text: '# Hosts\n' }], consult: 'cagent/consult',
}, { by: 'cagent-agent', base: 0 })
for (let i = 1; i <= 8; i++) await store.set(P, `note-${i}`, { title: `Project note ${i}`, kind: 'information', manager: 'cagent', body: `Note ${i}: a fact about P that takes more than one row to say when it is written out in full, with its qualification and where it was seen last.`, evidence: [{ ref: `wfe projects show p`, basis: 'observed', status: 'ok', observed: new Date().toISOString() }] }, { by: 'cagent-agent', base: 0 })

const x = new ExecStore({ registryFile: registry, area })
const watcher = new Watcher(500, { gitIntervalMs: 1000, registryFile: registry })
const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], distDir: join(pkg, 'dist'), watcher, exec: x }))
await new Promise<void>(r => srv.listen(0, '0.0.0.0', r))
const port = (srv.address() as { port: number }).port
const host = process.env.WFE_LAN_HOST ?? (hostname().endsWith('.local') ? hostname() : `${hostname().split('.')[0]}.local`)
const base = `http://${host}:${port}/`
console.log(`fixture service at ${base} (${tag})`)

const { browser, page, errors } = await open(narrow ? 390 : 1400, narrow ? 844 : 1000, { display: null })
const failed: string[] = []
page.on('response', r => { if (r.status() >= 400 && !/api\/boast\//.test(r.url())) failed.push(`${r.status()} ${r.url()}`) })
const section = (scope: string) => page.locator(`.ctx-section[data-context-scope="${scope}"]`)
async function openSection(scope: string) {
  const s = section(scope)
  await s.waitFor({ timeout: 10_000 })
  if (await s.locator('.ctx-toggle').getAttribute('aria-expanded') !== 'true') await s.locator('.ctx-toggle').click()
  return s
}
const rowOf = (scope: Locator, title: string) => scope.locator('.ctx-block-row', { has: page.locator('.ctx-row-title', { hasText: title }) }).first()
const panel = page.locator('aside.ctx-reader')
const overflow = (sel: string) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.scrollWidth - e.clientWidth : -1 }, sel)
async function noHScroll(label: string) {
  const over = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  check(over <= 1, `${label}: no horizontal page scroll (overflow ${over})`)
}

try {
  await page.goto(`${base}#/`)
  const home = await openSection('system')
  await rowOf(home, 'Cluster overview').waitFor()
  const dev = rowOf(home, 'Developer instructions'), longJa = rowOf(home, 'Asset procedure'), link = rowOf(home, 'Reference link'), clu = rowOf(home, 'Cluster overview')
  check((await dev.locator('.ctx-row-inline').innerText()).trim() === SHORT_JA && (await dev.locator('.ctx-row-action').innerText()).trim() === 'Edit', 'a short Japanese instruction reads in full in its row')
  check(await longJa.locator('.ctx-row-inline').count() === 0 && (await longJa.locator('.ctx-row-action').innerText()).trim() === 'Open', 'long Japanese sentences on two lines open instead of filling the list')
  check(await link.locator('.ctx-row-inline').count() === 0 && (await link.locator('.ctx-row-action').innerText()).trim() === 'Open', 'a long unbroken line opens instead of filling the list')
  check(await clu.locator('.ctx-row-inline').count() === 0 && /Not verified/.test(await clu.innerText()), 'multiline information opens; its unknown status is a short exception')
  if (narrow) await noHScroll('Home with long content')
  await shot(page, `${tag}-home`)

  // Keyboard only: open, read, close, back on the row.
  await longJa.locator('.ctx-row-action').focus()
  await page.keyboard.press('Enter')
  await panel.waitFor()
  check(await page.evaluate(() => document.activeElement?.classList.contains('ctx-read-title')), 'opening from the keyboard puts focus on the panel\'s title')
  check((await panel.locator('.ctx-read-body').innerText()).replace(/\s/g, '') === LONG_JA.replace(/\s/g, ''), 'the panel shows the whole Japanese text')
  check(await overflow('.ctx-reader-content') <= 1, 'the Japanese text wraps inside the panel')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open Asset procedure'), 'Esc returns focus to the row')
  await link.locator('.ctx-row-action').click()
  await panel.waitFor()
  check((await panel.locator('.ctx-read-body').innerText()).includes('x'.repeat(200)) && await overflow('.ctx-reader-content') <= 1, 'the unbroken line is complete and wraps inside the panel')
  await page.keyboard.press('Escape')
  await clu.locator('.ctx-row-action').click()
  await panel.waitFor()
  check(await panel.locator('.ctx-read-body .ctx-prose p').count() === 3 && await panel.locator('.ctx-read-body .ctx-prose li').count() === 2 && await panel.locator('.ctx-read-body .ctx-prose code').count() === 1, 'multiline information reads as paragraphs and a list, `code` marked')
  await shot(page, `${tag}-home-panel`, false)
  await page.keyboard.press('Escape')

  // Many inherited blocks fold; the short instruction stays.
  await page.goto(`${base}#/ws/p/wf/make.yaml`)
  const wf = await openSection('workflow')
  await wf.locator('.ctx-inherited .ctx-block-row').first().waitFor()
  await page.waitForTimeout(500)
  const inh = wf.locator('.ctx-inherited')
  const all = await inh.locator('.ctx-row').count()
  const visible = await inh.locator('.ctx-row:visible').count()
  check(all === 13 && visible < all, `many inherited rows fold (${visible} of ${all} shown)`)
  check(await rowOf(inh, 'Developer instructions').isVisible(), 'the short inherited instruction is not folded away')
  const more = inh.locator('xpath=..').locator('.ctx-inherited-more')
  check(/Show all 13 inherited/.test(await more.innerText()), 'a direct way to read all inherited blocks')
  await more.click()
  check(await inh.locator('.ctx-row:visible').count() === all, 'Show all shows every inherited row')
  check(/Nothing is set only here/.test(await wf.locator('.ctx-local').innerText()), 'an empty scope says so in one line')
  if (narrow) await noHScroll('workflow editor with many inherited blocks')
  await shot(page, `${tag}-workflow`)

  check(!errors.length, `no page errors (${errors.join(' | ')})`)
  check(!failed.length, `no failed requests (${failed.join(' | ')})`)
} catch (e) {
  check(false, `the journey ran to its end (${(e as Error).message.split('\n')[0]})`)
  await shot(page, `${tag}-failure`).catch(() => {})
} finally {
  await browser.close()
  srv.closeAllConnections(); srv.close(); x.close()
  done()
}
process.exit()
