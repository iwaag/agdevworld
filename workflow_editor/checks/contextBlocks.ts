// p14 browser check: independently managed context blocks, as the person
// sees them, against a private fixture on this host's LAN name over plain
// HTTP. Needs a built UI (`vite build`). Starts in Simple.
//
//   node checks/contextBlocks.ts                 (Chromium, desktop)
//   WFE_BROWSER=webkit node checks/contextBlocks.ts
//   WFE_NARROW=1 node checks/contextBlocks.ts    (390 px)
//
// Journeys: separate cards for the Developer's instruction and cagent's
// environment information in Home, with kind, manager, last editor,
// freshness and size in Simple; a human edit of cagent's block (manager
// kept, the human as last editor) and cagent's later update after reading
// it; a conflicting save keeping the draft; a failed refresh shown with the
// old content; inherited cards naming their scope in the project editor
// and a project block added there; the run card naming the blocks that
// changed for the next attempt (a check changes nothing); Detail's
// evidence, detail link and history.
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
const card = (scope: ReturnType<typeof section>, title: string) => scope.locator('article.ctx-block', { has: page.locator('.ctx-block-name', { hasText: title }) }).first()

try {
  await page.goto(`${base}#/`)
  await page.evaluate(() => localStorage.setItem('workflow-editor.actor', 'Check Person'))
  await page.reload()

  // ---- separate cards in Home, readable in Simple ----
  const home = await openSection('system')
  check(await mode() === 'simple', 'Home starts in Simple')
  await card(home, 'Cluster summary').waitFor()
  const dev = card(home, 'Developer instructions'), clu = card(home, 'Cluster summary')
  check(await home.locator('.ctx-local article.ctx-block').count() === 2, 'two separate cards: the Developer\'s and cagent\'s')
  check(await dev.getAttribute('data-kind') === 'instruction' && await clu.getAttribute('data-kind') === 'information', 'kinds: instruction and environment information')
  const cluText = await clu.innerText()
  check(/Environment information/.test(cluText) && /Managed by\s*cagent/.test(cluText) && /Last edited by cagent-agent/.test(cluText), `the cagent card names kind, manager and last editor in Simple (${cluText.split('\n').slice(0, 4).join(' | ')})`)
  check(/observed 3 h ago/.test(cluText) && /partial/.test(cluText), 'freshness: observation age and partial coverage are visible in Simple')
  check(/2 lines · \d+ bytes delivered/.test(cluText), 'the size of the delivered section is visible')
  check(/Managed by\s*Developer/.test(await dev.innerText()) && /Last edited by iwaag/.test(await dev.innerText()), 'the Developer card names its manager and last editor')
  check(/nothing set|for all projects: 1 instruction, 1 environment note/.test(await home.locator('.ctx-summary').innerText()), `the summary counts both kinds (${await home.locator('.ctx-summary').innerText()})`)
  await shot(page, `${tag}-home`)
  if (narrow) await noHScroll('Home')

  // ---- a human edits cagent's block ----
  await clu.locator('button', { hasText: 'Edit' }).click()
  check(/managed by cagent\. Your edit is kept in its history/.test(await clu.locator('.ctx-theirs').innerText()), 'editing someone else\'s block says whose it is, without a permission dialog')
  await clu.locator('textarea.context-editor').fill('agstudio: large memory, Ollama (ask the Developer before heavy jobs). agpc: CUDA GPU, ComfyUI.')
  await clu.locator('.ctx-save-row button.primary').click()
  await clu.locator('.banner.ok').waitFor()
  const afterHuman = await store.read(SYS, 'cluster')
  check(afterHuman.block!.manager === 'cagent' && afterHuman.block!.editor.by === 'Check Person' && afterHuman.block!.editor.via === 'browser', 'saved: manager stays cagent, the human is the last editor, via the browser')
  check(/Managed by\s*cagent/.test(await clu.innerText()) && /Last edited by Check Person/.test(await clu.innerText()), 'the card shows the human as last editor under cagent\'s management')
  // cagent's next publication from the revision it read before is refused; after reading, it revises deliberately.
  const stale = await store.set(SYS, 'cluster', { body: 'agstudio: large memory.' }, { by: 'cagent-agent', base: cl0.state.base }).then(() => 'saved', e => (e as { detail?: { code?: string } }).detail?.code ?? String(e))
  check(stale === 'context-conflict', 'cagent writing from an unseen revision gets a conflict')
  await store.set(SYS, 'cluster', { body: `${afterHuman.block!.body.trim()}\nSwarmUI runs on agpc too.` }, { by: 'cagent-agent', base: afterHuman.base, run: 'cagent/context/run-002' })
  await page.reload()
  const home2 = await openSection('system')
  const clu2 = card(home2, 'Cluster summary')
  await clu2.waitFor()
  check(/Last edited by cagent-agent/.test(await clu2.innerText()) && /ask the Developer before heavy jobs/.test(await clu2.innerText()) && /SwarmUI/.test(await clu2.innerText()), 'cagent\'s later update keeps the human\'s words it read')

  // ---- a conflicting save keeps the draft ----
  const dev2 = card(home2, 'Developer instructions')
  await dev2.locator('button', { hasText: 'Edit' }).click()
  await dev2.locator('textarea.context-editor').fill('My draft instruction.')
  const d0 = await store.read(SYS, 'developer')
  await store.set(SYS, 'developer', { body: 'Edited elsewhere.' }, { by: 'Other', base: d0.base })
  await page.click('.display-toggle button[data-display="detail"]')
  await page.click('.display-toggle button[data-display="simple"]')
  check(await dev2.locator('textarea.context-editor').inputValue() === 'My draft instruction.', 'a mode switch keeps the draft')
  await dev2.locator('.ctx-save-row button.primary').click()
  await dev2.locator('.ctx-conflict').waitFor()
  check(/Edited elsewhere\./.test(await dev2.locator('.ctx-conflict').innerText()) && await dev2.locator('textarea.context-editor').inputValue() === 'My draft instruction.', 'a conflicting save is refused, shows the saved text and keeps the draft')
  await dev2.locator('button', { hasText: 'Save mine over it' }).click()
  await dev2.locator('.banner.ok').waitFor()
  check((await store.read(SYS, 'developer')).block!.body === 'My draft instruction.\n', 'saving over it after seeing the other version works')
  await shot(page, `${tag}-home-conflict`)

  // ---- a failed refresh keeps the old content and is shown ----
  await store.refreshFailed(SYS, 'cluster', { by: 'cagent-agent', outcome: 'failed', detail: 'agpc did not answer the ComfyUI probe', run: 'cagent/context/run-003' })
  await page.reload()
  const home3 = await openSection('system')
  const clu3 = card(home3, 'Cluster summary')
  await clu3.waitFor()
  check(/refresh failed .*agpc did not answer/.test(await clu3.innerText()) && /SwarmUI/.test(await clu3.innerText()), 'a failed refresh is shown in Simple; the last content stays')

  // ---- Detail: evidence, detail link, history ----
  await page.click('.display-toggle button[data-display="detail"]')
  const detailText = await clu3.innerText()
  check(/Evidence/.test(detailText) && /6 of 7 hosts; agbach asleep/.test(detailText), 'Detail lists the evidence with its coverage')
  const href = await clu3.locator('.ctx-evidence a').first().getAttribute('href')
  const raw = href ? await (await fetch(new URL(href, base))).text() : ''
  check(raw === '# Hosts\nagpc: RTX GPU, ComfyUI\n', 'the evidence link reads the detail by its logical reference')
  await clu3.locator('details.ctx-history summary').click()
  await clu3.locator('.ctx-revisions li').first().waitFor()
  const hist = await clu3.locator('.ctx-revisions').innerText()
  check(/refresh/.test(hist) && /Check Person/.test(hist) && /cagent\/context\/run-002/.test(hist), 'history shows the human edit, cagent\'s runs and the refresh')
  await shot(page, `${tag}-home-detail`)
  await page.click('.display-toggle button[data-display="simple"]')

  // ---- project editor: inherited cards name their scope; a project block ----
  await page.goto(`${base}#/ws/p`)
  const proj = await openSection('project')
  await proj.locator('.ctx-inherited article.ctx-block').first().waitFor()
  const inh = proj.locator('.ctx-inherited')
  check(/All projects/.test(await inh.innerText()) && await inh.locator('article.ctx-block').count() === 2, 'the project editor shows both system cards as inherited')
  check(/all projects/.test(await card(proj, 'Cluster summary').locator('.ctx-block-scope').innerText()), 'an inherited card names its actual scope')
  await proj.locator('.ctx-local button', { hasText: '+ Add environment information' }).click()
  const fresh = proj.locator('.ctx-local article.ctx-block.editing')
  await fresh.locator('input.ctx-block-title').fill('Resources for P')
  await fresh.locator('textarea.context-editor').fill('ComfyUI on agpc has the models P uses.')
  await fresh.locator('.ctx-save-row button.primary').click()
  await proj.locator('.ctx-local .banner.ok').waitFor()
  check(/every workflow of project p/.test(await proj.locator('.ctx-local .banner.ok').innerText()), 'a project block is saved for every workflow of the project')
  const pb = await store.read(P, 'resources-for-p')
  check(pb.block?.kind === 'information' && pb.block.manager === 'Check Person', 'the new block has its kind and its first writer as manager')
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
  await run.locator('div.ctx-wider[data-settings="system"] article.ctx-block').first().waitFor()
  check(await run.locator('div.ctx-wider[data-settings="system"] article.ctx-block').count() === 2, 'the run card shows the system blocks for future attempts in place')
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
