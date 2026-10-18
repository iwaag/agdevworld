// p14 / p14 ex1 browser check: independently managed context blocks, as
// the person sees them, against a private fixture on this host's LAN name
// over plain HTTP. Needs a built UI (`vite build`). Starts in Simple.
//
//   node checks/contextBlocks.ts                 (Chromium, desktop)
//   WFE_BROWSER=webkit node checks/contextBlocks.ts
//   WFE_NARROW=1 node checks/contextBlocks.ts    (390 px)
//
// Journeys: a compact list in Home — the Developer's short instruction
// readable in its row, cagent's information as a title, its manager and a
// short exception, no audit record or sizes; opening a block in the side
// panel (full text, details, Ask, Edit, Evidence & history) and returning
// focus to its row; a human edit of cagent's block (manager kept, the human
// as last editor) and cagent's later update after reading it; a draft kept
// through closing the panel and a mode switch, then a conflicting save; a
// failed refresh shown with the old content; Detail's diagnostics and
// history; inherited rows naming their scope and one Add in the project
// editor; the run card naming the blocks that changed for the next attempt
// (a check, and opening blocks, change nothing).
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../server/api.ts'
import { ContextStore } from '../server/contextStore.ts'
import { runContextView } from '../server/contextView.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Workspace } from '../server/workspace.ts'
import { loadRegistry } from '../server/registry.ts'
import { Watcher } from '../server/watch.ts'
import { check, done, open, shot } from './lib.ts'

const narrow = !!process.env.WFE_NARROW
const tag = `p14-${process.env.WFE_BROWSER === 'webkit' ? 'webkit' : 'chromium'}${narrow ? '-narrow' : ''}`
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'wfe-ctx-blocks-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check\n\temail = c@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const area = join(root, 'area'), registry = join(area, 'registry.json')
const dir = join(area, 'pj-p')
const c = await createProject({ dir, id: 'p', name: 'Project P', intent: 'Make media assets.', goals: ['Every asset is checked'], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
if (!c.ok) throw new Error(c.message)
await mkdir(join(dir, 'agent'))
await writeFile(join(dir, 'agent', 'guide.md'), '# P guide\n')
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
const y = join(dir, 'project.yaml')
await writeFile(y, `${await readFile(y, 'utf8')}guides: [agent/guide.md]\n`)
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])

const store = new ContextStore(area)
const SYS = { scope: 'system' as const }
const P = { scope: 'project' as const, project: 'p' }
const observed = new Date(Date.now() - 3 * 3600_000).toISOString()
await store.set(SYS, 'developer', { title: 'Developer instructions', kind: 'instruction', manager: 'Developer', body: 'Write produced files in English unless asked otherwise.' }, { by: 'iwaag', base: 0 })
const cl0 = await store.set(SYS, 'cluster', {
  title: 'Cluster summary', kind: 'information', manager: 'cagent',
  body: 'agstudio: large memory, Ollama. agpc: CUDA GPU, ComfyUI.\nDetails: wfe context detail context:system/cluster/hosts.md; ask cagent/consult.',
  evidence: [{ ref: 'context:system/cluster/hosts.md', title: 'scan snapshot', basis: 'observed', status: 'partial', observed, coverage: '6 of 7 hosts; agbach asleep' }],
  details: [{ name: 'hosts.md', text: '# Hosts\nagpc: RTX GPU, ComfyUI\n' }], consult: 'cagent/consult',
}, { by: 'cagent-agent', base: 0, run: 'cagent/context/run-001' })

const x = new ExecStore({ registryFile: registry, area })
const req = await x.request({ workspace: 'p', workflow: 'make', text: 'Make a tiny icon.', author: 'Check', receipt: 'ctx-blk-0001', via: 'browser' })
const claim = await x.claim('check', { profiles: {}, contract: { name: 'wfrun/guide.md', sha256: 'c'.repeat(64) } })
if (!('attempt' in claim)) throw new Error(JSON.stringify(claim))
await x.contextDelivery(claim.attempt.id, { delivered: true })
x.started(claim.attempt.id, process.pid)
await x.finished(claim.attempt.id, { code: 0, signal: null })
const runId = req.ref.run
const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.project === 'p')!)

const watcher = new Watcher(500, { gitIntervalMs: 1000, registryFile: registry })
const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], distDir: join(pkg, 'dist'), watcher, exec: x }))
await new Promise<void>(r => srv.listen(0, '0.0.0.0', r))
const port = (srv.address() as { port: number }).port
const host = process.env.WFE_LAN_HOST ?? (hostname().endsWith('.local') ? hostname() : `${hostname().split('.')[0]}.local`)
const base = `http://${host}:${port}/`
console.log(`fixture service at ${base} (${tag})`)

const { browser, page, errors } = await open(narrow ? 390 : 1400, narrow ? 844 : 1000, { display: null })
const failed: string[] = []
// The conflict journey answers 409 on purpose; the fixture project has no boast page.
const expected = (u: string, st: number) => (st === 409 && /api\/context\/block$/.test(u)) || /api\/boast\//.test(u)
page.on('response', r => { if (r.status() >= 400 && !expected(r.url(), r.status())) failed.push(`${r.status()} ${r.url()}`) })
const mode = () => page.evaluate(() => document.documentElement.dataset.display)
const section = (scope: string) => page.locator(`.ctx-section[data-context-scope="${scope}"]`)
async function openSection(scope: string) {
  const s = section(scope)
  await s.waitFor({ timeout: 10_000 })
  if (await s.locator('.ctx-toggle').getAttribute('aria-expanded') !== 'true') await s.locator('.ctx-toggle').click()
  return s
}
async function noHScroll(label: string) {
  const over = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  check(over <= 1, `${label}: no horizontal page scroll (overflow ${over})`)
}
const row = (scope: ReturnType<typeof section>, title: string) => scope.locator('.ctx-row.ctx-block-row', { has: page.locator('.ctx-row-title', { hasText: title }) }).first()
const panel = page.locator('aside.ctx-reader')
const panelBlock = panel.locator('article.ctx-block')
async function openRow(scope: ReturnType<typeof section>, title: string) {
  await row(scope, title).locator('.ctx-row-action').click()
  await panel.waitFor({ state: 'visible' })
  await panel.locator('.ctx-read-title', { hasText: title }).waitFor()
}
async function closePanel() { await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' }) }

try {
  await page.goto(`${base}#/`)
  await page.evaluate(() => localStorage.setItem('workflow-editor.actor', 'Check Person'))
  await page.reload()

  // ---- a compact list in Home, readable in Simple ----
  const home = await openSection('system')
  check(await mode() === 'simple', 'Home starts in Simple')
  await row(home, 'Cluster summary').waitFor()
  const dev = row(home, 'Developer instructions'), clu = row(home, 'Cluster summary')
  check(await home.locator('.ctx-local .ctx-block-row').count() === 2, 'two separate rows: the Developer\'s and cagent\'s')
  check(await dev.getAttribute('data-kind') === 'instruction' && await clu.getAttribute('data-kind') === 'information', 'kinds: instruction and environment information')
  const devText = await dev.innerText(), cluText = await clu.innerText()
  check(/Write produced files in English/.test(devText) && (await dev.locator('.ctx-row-action').innerText()).trim() === 'Edit', `a short human instruction reads in full in its row, with Edit (${devText.replace(/\n/g, ' | ')})`)
  check(/cagent/.test(cluText) && /Partly verified/.test(cluText) && (await clu.locator('.ctx-row-action').innerText()).trim() === 'Open', `cagent's row: title, manager, a short exception and Open (${cluText.replace(/\n/g, ' | ')})`)
  check(!/agstudio: large memory/.test(cluText), 'longer environment information is not spread over the list')
  const listText = await home.locator('.ctx-local').innerText()
  check(!/bytes|Last edited|observed|checked|run-00/.test(listText), 'no sizes, editors, times or runs in the list')
  check(!/Remove/.test(listText), 'no Remove on rows')
  check(await home.locator('.ctx-local .ctx-add-button').count() === 1, 'one Add entry for the list')
  await shot(page, `${tag}-home`)
  if (narrow) await noHScroll('Home')

  // ---- open: read, details, evidence; focus returns ----
  await openRow(home, 'Cluster summary')
  const pt = await panelBlock.innerText()
  check(/Environment information · Managed by cagent · All projects/.test(pt), `the panel names kind, manager and scope (${pt.split('\n').slice(0, 2).join(' | ')})`)
  check(await panelBlock.locator('.ctx-read-body .ctx-prose p').count() >= 2 && !(await panelBlock.locator('.ctx-read-body pre').count()), 'the full text reads as prose, not a preformatted block')
  const det = await panelBlock.locator('a.ctx-detail-link').getAttribute('href')
  const raw0 = det ? await (await fetch(new URL(det, base))).text() : ''
  check(raw0 === '# Hosts\nagpc: RTX GPU, ComfyUI\n', 'View resource details reads the detail by its logical reference')
  check(/Ask cagent/.test(await panelBlock.locator('.ctx-read-actions').innerText()) && await panelBlock.locator('.ctx-read-actions button', { hasText: 'Edit' }).count() === 1, 'Ask cagent and Edit are next to the text')
  await panelBlock.locator('details.ctx-evidence-box > summary').click()
  await panelBlock.locator('.ctx-revisions li').first().waitFor()
  const ev = await panelBlock.locator('details.ctx-evidence-box').innerText()
  check(/Last edited by cagent-agent/.test(ev) && /cagent\/context\/run-001/.test(ev) && /6 of 7 hosts; agbach asleep/.test(ev) && /partly verified/.test(ev) && /3 h ago/.test(ev), 'Evidence & history: last editor, run, observation, coverage and status')
  await shot(page, `${tag}-home-panel`, false)
  if (narrow) check((await panel.boundingBox())!.width >= 389, 'the panel uses the full width on a phone')
  await closePanel()
  check(await page.evaluate(() => document.activeElement?.classList.contains('ctx-row-action') && document.activeElement.closest('.ctx-row')?.textContent?.includes('Cluster summary')), 'closing returns focus to the row')

  // ---- a human edits cagent's block ----
  await openRow(home, 'Cluster summary')
  await panelBlock.locator('.ctx-read-actions button', { hasText: 'Edit' }).click()
  check(/managed by cagent\. Your edit is kept in its history/.test(await panelBlock.locator('.ctx-theirs').innerText()), 'editing someone else\'s block says whose it is, without a permission dialog')
  check(await panelBlock.locator('.ctx-remove').count() === 1, 'Remove is in the editing surface')
  await panelBlock.locator('textarea.context-editor').fill('agstudio: large memory, Ollama (ask the Developer before heavy jobs). agpc: CUDA GPU, ComfyUI.')
  await panelBlock.locator('.ctx-save-row button.primary').click()
  await panelBlock.locator('.banner.ok').waitFor()
  const afterHuman = await store.read(SYS, 'cluster')
  check(afterHuman.block!.manager === 'cagent' && afterHuman.block!.editor.by === 'Check Person' && afterHuman.block!.editor.via === 'browser', 'saved: manager stays cagent, the human is the last editor, via the browser')
  check(/Managed by cagent/.test(await panelBlock.innerText()) && /ask the Developer/.test(await panelBlock.locator('.ctx-read-body').innerText()), 'the panel shows the saved text under cagent\'s management')
  await closePanel()
  // cagent's next publication from the revision it read before is refused; after reading, it revises deliberately.
  const stale = await store.set(SYS, 'cluster', { body: 'agstudio: large memory.' }, { by: 'cagent-agent', base: cl0.state.base }).then(() => 'saved', e => (e as { detail?: { code?: string } }).detail?.code ?? String(e))
  check(stale === 'context-conflict', 'cagent writing from an unseen revision gets a conflict')
  await store.set(SYS, 'cluster', { body: `${afterHuman.block!.body.trim()}\nSwarmUI runs on agpc too.` }, { by: 'cagent-agent', base: afterHuman.base, run: 'cagent/context/run-002' })
  await page.reload()
  const home2 = await openSection('system')
  await row(home2, 'Cluster summary').waitFor()
  await openRow(home2, 'Cluster summary')
  const body2 = await panelBlock.locator('.ctx-read-body').innerText()
  check(/ask the Developer before heavy jobs/.test(body2) && /SwarmUI/.test(body2), 'cagent\'s later update keeps the human\'s words it read')
  await closePanel()

  // ---- a draft survives closing the panel and a mode switch; a conflicting save keeps it ----
  const dev2 = row(home2, 'Developer instructions')
  await dev2.locator('.ctx-row-action').click()
  await panelBlock.locator('textarea.context-editor').fill('My draft instruction.')
  const d0 = await store.read(SYS, 'developer')
  await store.set(SYS, 'developer', { body: 'Edited elsewhere.' }, { by: 'Other', base: d0.base })
  await closePanel()
  check(/Unsaved changes/.test(await dev2.innerText()), 'the row says a draft is waiting')
  await page.click('.display-toggle button[data-display="detail"]')
  await page.click('.display-toggle button[data-display="simple"]')
  await dev2.locator('.ctx-row-action').click()
  check(await panelBlock.locator('textarea.context-editor').inputValue() === 'My draft instruction.', 'closing the panel and a mode switch keep the draft')
  await panelBlock.locator('.ctx-save-row button.primary').click()
  await panelBlock.locator('.ctx-conflict').waitFor()
  check(/Edited elsewhere\./.test(await panelBlock.locator('.ctx-conflict').innerText()) && await panelBlock.locator('textarea.context-editor').inputValue() === 'My draft instruction.', 'a conflicting save is refused, shows the saved text and keeps the draft')
  await panelBlock.locator('button', { hasText: 'Save mine over it' }).click()
  await panelBlock.locator('.banner.ok').waitFor()
  check((await store.read(SYS, 'developer')).block!.body === 'My draft instruction.\n', 'saving over it after seeing the other version works')
  await shot(page, `${tag}-home-conflict`)
  await closePanel()

  // ---- a failed refresh keeps the old content and is shown ----
  await store.refreshFailed(SYS, 'cluster', { by: 'cagent-agent', outcome: 'failed', detail: 'agpc did not answer the ComfyUI probe', run: 'cagent/context/run-003' })
  await page.reload()
  const home3 = await openSection('system')
  const clu3 = row(home3, 'Cluster summary')
  await clu3.waitFor()
  check(/Last refresh failed/.test(await clu3.innerText()), 'a failed refresh is a short exception in the row')
  await openRow(home3, 'Cluster summary')
  check(/Refresh failed .*agpc did not answer/.test(await panelBlock.locator('.ctx-refresh').innerText()) && /SwarmUI/.test(await panelBlock.locator('.ctx-read-body').innerText()), 'the panel explains the failed refresh beside the last content')

  // ---- Detail: diagnostics and history ----
  await page.click('.display-toggle button[data-display="detail"]')
  check(/section sha256 [0-9a-f]{12}/.test(await panelBlock.locator('.ctx-block-detail').innerText()) && /bytes delivered/.test(await panelBlock.locator('.ctx-block-detail').innerText()), 'Detail adds the hash and the delivered size')
  await panelBlock.locator('details.ctx-evidence-box > summary').click()
  await panelBlock.locator('.ctx-revisions li').first().waitFor()
  const hist = await panelBlock.locator('.ctx-revisions').innerText()
  check(/refresh/.test(hist) && /Check Person/.test(hist) && /cagent\/context\/run-002/.test(hist), 'history shows the human edit, cagent\'s runs and the refresh')
  await shot(page, `${tag}-home-detail`)
  await page.click('.display-toggle button[data-display="simple"]')
  await closePanel()

  // ---- project editor: inherited rows name their scope; one Add ----
  await page.goto(`${base}#/ws/p`)
  const proj = await openSection('project')
  await proj.locator('.ctx-inherited .ctx-block-row').first().waitFor()
  const inh = proj.locator('.ctx-inherited')
  check(await inh.locator('.ctx-block-row').count() === 2, 'the project editor shows both system blocks as inherited')
  check(/All projects/.test(await row(proj, 'Cluster summary').locator('.ctx-row-scope').innerText()), 'an inherited row names its actual scope')
  await proj.locator('.ctx-local .ctx-add-button').click()
  await proj.locator('.ctx-local .ctx-add-choice', { hasText: 'Environment information' }).click()
  await panel.waitFor({ state: 'visible' })
  await panelBlock.locator('input.ctx-block-title').fill('Resources for P')
  await panelBlock.locator('textarea.context-editor').fill('ComfyUI on agpc has the models P uses.')
  await panelBlock.locator('.ctx-save-row button.primary').click()
  await panelBlock.locator('.banner.ok').waitFor()
  check(/every workflow of project p/.test(await panelBlock.locator('.banner.ok').innerText()), 'a project block is saved for every workflow of the project')
  const pb = await store.read(P, 'resources-for-p')
  check(pb.block?.kind === 'information' && pb.block.manager === 'Check Person', 'the new block has its kind and its first writer as manager')
  await closePanel()
  await row(proj, 'Resources for P').waitFor()
  await shot(page, `${tag}-project`)
  if (narrow) await noHScroll('project editor')

  // ---- the run card names the blocks that differ for the next attempt ----
  const before = await runContextView(x, ws, req.ref)
  await store.check(SYS, 'developer', { by: 'cagent-agent', base: (await store.read(SYS, 'developer')).base })
  const afterCheck = await runContextView(x, ws, req.ref)
  check(before.next.fingerprint === afterCheck.next.fingerprint, 'a check changes nothing the next attempt is given')
  await page.goto(`${base}#/ws/p/run/make/${runId}`)
  const run = page.locator('.run-context')
  await run.waitFor({ timeout: 15_000 })
  if (await run.locator('.ctx-toggle').getAttribute('aria-expanded') !== 'true') await run.locator('.ctx-toggle').click()
  await run.locator('.run-ctx-changes li').first().waitFor({ timeout: 15_000 })
  const changes = await run.locator('.run-ctx-changes').innerText()
  check(/Cluster summary \(managed by cagent\)/.test(changes) && /Developer instructions/.test(changes) && /Resources for P/.test(changes), `the next-attempt changes name the particular blocks (${changes.replace(/\n/g, ' | ')})`)
  await run.locator('button', { hasText: 'Context for all projects' }).click()
  await run.locator('div.ctx-wider[data-settings="system"] .ctx-block-row').first().waitFor()
  check(await run.locator('div.ctx-wider[data-settings="system"] .ctx-block-row').count() === 2, 'the run card lists the system blocks for future attempts in place')
  const rev0 = (await store.read(SYS, 'cluster')).revision
  await row(run.locator('div.ctx-wider[data-settings="system"]'), 'Cluster summary').locator('.ctx-row-action').click()
  await panel.waitFor({ state: 'visible' })
  check(await page.locator('.run-context').isVisible() && /\/run\/make\//.test(page.url()), 'a block opens beside the run, which stays in place')
  await closePanel()
  const afterOpen = await runContextView(x, ws, req.ref)
  check(afterOpen.next.fingerprint === afterCheck.next.fingerprint && (await store.read(SYS, 'cluster')).revision === rev0, 'opening and closing a block changes no block and nothing the next attempt is given')
  await shot(page, `${tag}-run`)
  if (narrow) await noHScroll('run view')

  const unexpected = errors.filter(e => !/status of (409|404)/.test(e))
  check(!unexpected.length, `no page errors (${unexpected.join(' | ')})`)
  check(!failed.length, `no failed requests (${failed.join(' | ')})`)
} finally {
  await browser.close()
  srv.closeAllConnections(); srv.close(); x.close()
  done()
}
