// p13 ex1 browser check, adapted to p14's context blocks: context inside the
// editors, as the person's tasks, against a private fixture on this host's
// LAN name over plain HTTP. Needs a built UI (`vite build`). Starts in
// Simple, as a fresh browser does.
//
//   node checks/contextEditors.ts                 (Chromium, desktop)
//   WFE_BROWSER=webkit node checks/contextEditors.ts
//   WFE_NARROW=1 node checks/contextEditors.ts    (390 px)
//
// Journeys: a block for all projects added from Home (title, kind, manager
// and last editor shown); a project-local block added in the project editor
// and read as inherited, under its scope, in the workflow editor; workflow
// intent and a new local block edited together (separate saves, mode
// switches, a live refresh, navigation protection, a conflicting save of
// the block keeping the draft with both recovery options); the block for
// all projects edited in place from a child editor, the wider scope named;
// a run's request and attempt context in Simple, a workflow block added
// from the run's "Settings for future attempts" and the next-attempt
// difference without starting anything; an additional instruction recorded
// once and kept out of every block; keyboard, labels and layout.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from 'playwright-core'
import type { ScopeTarget } from '../shared/context.ts'
import { createHandler } from '../server/api.ts'
import { ContextStore } from '../server/contextStore.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Watcher } from '../server/watch.ts'
import { check, done, open, shot } from './lib.ts'

const narrow = !!process.env.WFE_NARROW
const tag = `p14ctx-${process.env.WFE_BROWSER === 'webkit' ? 'webkit' : 'chromium'}${narrow ? '-narrow' : ''}`
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'wfe-ctx-editors-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check\n\temail = c@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const area = join(root, 'area'), registry = join(area, 'registry.json')
const dir = join(area, 'pj-p')
const c = await createProject({ dir, id: 'p', name: 'Project P', intent: 'Make small things well.', goals: ['Every thing is checked'], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
if (!c.ok) throw new Error(c.message)
await mkdir(join(dir, 'agent'))
await writeFile(join(dir, 'agent', 'guide.md'), '# P guide\nFacts of P.\n')
await writeFile(join(dir, 'agent', 'make.md'), '# Make guide\nHow Make works.\n')
const wfFile = join(dir, 'devdocs', 'workflows', 'make.yaml')
await writeFile(wfFile, `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make one small thing.
documentation: {policy: manual}
execution:
  agent: p-agent
  guides: [agent/make.md]
repositories:
  root: {path: ., access: editable}
nodes:
  a: {type: do, description: Do it.}
  b: {type: talk, description: Confirm it., confirms: result}
edges:
  - {from: a, to: b}
`)
const y = join(dir, 'project.yaml')
await writeFile(y, `${await readFile(y, 'utf8')}guides: [agent/guide.md]\n`)
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
const store = new ContextStore(area)
const x = new ExecStore({ registryFile: registry, area })
const req = await x.request({ workspace: 'p', workflow: 'make', text: 'Make a tiny tool.\nKeep it under fifty lines.', author: 'Check', receipt: 'ctx-ed-0001', via: 'browser' })
const claim = await x.claim('check', { profiles: {}, contract: { name: 'wfrun/guide.md', sha256: 'c'.repeat(64) } })
if (!('attempt' in claim)) throw new Error(JSON.stringify(claim))
await x.contextDelivery(claim.attempt.id, { delivered: true })
x.started(claim.attempt.id, process.pid)
await x.finished(claim.attempt.id, { code: 0, signal: null })
const runId = req.ref.run

const watcher = new Watcher(500, { gitIntervalMs: 1000, registryFile: registry })
const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], distDir: join(pkg, 'dist'), watcher, exec: x }))
await new Promise<void>(r => srv.listen(0, '0.0.0.0', r))
const port = (srv.address() as { port: number }).port
const host = process.env.WFE_LAN_HOST ?? (hostname().endsWith('.local') ? hostname() : `${hostname().split('.')[0]}.local`)
const base = `http://${host}:${port}/`
console.log(`fixture service at ${base} (${tag})`)

const { browser, page, errors } = await open(narrow ? 390 : 1400, narrow ? 844 : 1000, { display: null })
const failed: string[] = []
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })
const dialogs: string[] = []
page.on('dialog', d => { dialogs.push(d.message()) })
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
  const wide = over > 1 ? await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}${e.parentElement ? ` in ${e.parentElement.className}` : ''} "${(e.textContent ?? '').slice(0, 30)}"`).join(', ')) : ''
  check(over <= 1, `${label}: no horizontal page scroll (overflow ${over}${wide ? `: ${wide}` : ''})`)
}
const settle = (p: Page, ms = 400) => p.waitForTimeout(ms)
const SYS: ScopeTarget = { scope: 'system' }
const PRJ: ScopeTarget = { scope: 'project', project: 'p' }
const WF: ScopeTarget = { scope: 'workflow', project: 'p', workflow: 'make' }
// The page's reading panel and the block or item shown in it (p14 ex1).
const panel = page.locator('aside.ctx-reader')
const pb = panel.locator('article.ctx-block')
const rowOf = (scope: Locator, title: string) => scope.locator('.ctx-block-row', { has: page.locator('.ctx-row-title', { hasText: title }) }).first()
async function closePanel() { await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' }) }
// One Add per list, with the kind chosen in its menu; the new block opens in the panel.
async function addNew(list: Locator, kind: 'Instruction' | 'Environment information') {
  await list.locator('.ctx-add-button').click()
  await list.locator('.ctx-add-choice', { hasText: kind }).first().click()
  await panel.waitFor()
}
async function addBlock(title: string, text: string) {
  await pb.locator('.ctx-block-edit:not([hidden])').waitFor()
  await pb.locator('input.ctx-block-title').fill(title)
  await pb.locator('textarea.context-editor').fill(text)
}
// The repository-owned controls open from their row.
async function openShared(s: Locator) { await s.locator('.ctx-shared-row .ctx-row-action').click(); await panel.locator('.ctx-shared-panel').waitFor() }

try {
  await page.goto(`${base}#/`)
  await page.evaluate(() => localStorage.setItem('workflow-editor.actor', 'Check Person'))

  // ---- 3: an instruction for all projects from Home, no project chosen ----
  await page.reload()
  const home = await openSection('system')
  check(await mode() === 'simple', 'Home starts in Simple and the Context section opens there')
  check(/nothing set for all projects/.test(await home.locator('.ctx-summary').innerText()), 'Home\'s summary says nothing is set for all projects')
  await addNew(home.locator('.ctx-local'), 'Instruction')
  await addBlock('English by default', 'Write produced text in English unless a request asks otherwise.')
  check(/unsaved changes/.test(await home.locator('.ctx-summary').innerText()), 'an unsaved instruction shows in the summary')
  await pb.locator('.ctx-save-row button.primary').click()
  await pb.locator('.banner.ok').waitFor()
  check(/Saved for all projects/.test(await pb.locator('.banner.ok').innerText()) && /nothing was started/.test(await pb.locator('.banner.ok').innerText()), 'saving names the scope and says nothing was started')
  check((await store.read(SYS, 'english-by-default')).block?.body.startsWith('Write produced text in English') === true, 'the system instruction is a block in the store, its id from its title')
  check(await pb.getAttribute('data-kind') === 'instruction' && /Instruction · Managed by Check Person/.test(await pb.locator('.ctx-read-sub').innerText()) && /Last edited by Check Person/.test(await pb.locator('.ctx-evidence-box').textContent() ?? ''), 'the saved block says its kind, its manager and (in its evidence) its last editor')
  await closePanel()
  check(/Write produced text in English/.test(await rowOf(home, 'English by default').innerText()), 'the short instruction reads in its row')
  check(await mode() === 'simple', 'saving kept Simple')
  await shot(page, `${tag}-home`)
  if (narrow) await noHScroll('Home')

  // ---- 1: a project-local instruction, read as inherited in the workflow ----
  await page.goto(`${base}#/ws/p`)
  const proj = await openSection('project')
  check(await mode() === 'simple', 'the project editor\'s Context opens in Simple')
  await proj.locator('.ctx-inherited .ctx-block-row').first().waitFor()
  check(/purpose set · 1 goal · 1 guide/.test(await proj.locator('.ctx-shared-row').innerText()), 'the repository-owned part is one row with a short summary')
  await openShared(proj)
  await page.waitForFunction(() => (document.querySelector('.ctx-reader textarea[aria-label="Project purpose"]') as HTMLTextAreaElement | null)?.value)
  check(await panel.locator('textarea[aria-label="Project purpose"]').inputValue() === 'Make small things well.', 'the purpose is editable from the section, in the panel')
  check(await page.locator('textarea[aria-label="Project purpose"]').count() === 1, 'the purpose has exactly one editor in the page')
  await closePanel()
  const projInherited = await proj.locator('.ctx-inherited').innerText()
  check(/All projects/.test(projInherited) && /English by default/.test(projInherited) && /Write produced text in English/.test(projInherited), 'the system block is shown as inherited, naming its scope, the short text readable')
  await addNew(proj.locator('.ctx-local'), 'Instruction')
  await addBlock('P notes', 'P notes start with the line "Project: P".')
  await pb.locator('.ctx-save-row button.primary').click()
  await pb.locator('.banner.ok').waitFor()
  check(/every workflow of project p/.test(await pb.locator('.banner.ok').innerText()), 'the project instruction is saved for every workflow of the project')
  check((await store.read(PRJ, 'p-notes')).block?.body.includes('Project: P') === true, 'the project block is in the store')
  await closePanel()
  // Typing while the view refreshes in the background keeps the keyboard and the caret.
  await openShared(proj)
  const purpose = panel.locator('textarea[aria-label="Project purpose"]')
  await purpose.click(); await page.keyboard.press('End'); await page.keyboard.type(' Draft words')
  await writeFile(join(dir, 'agent', 'guide.md'), '# P guide\nFacts of P, refreshed.\n')
  await settle(page, 2200)
  const kept = await page.evaluate(() => { const a = document.activeElement as HTMLTextAreaElement | null; return { label: a?.getAttribute('aria-label'), at: a?.selectionStart, len: a?.value.length } })
  check(kept.label === 'Project purpose' && kept.at === kept.len, `a background refresh keeps focus and caret in the purpose (${JSON.stringify(kept)})`)
  await purpose.fill('Make small things well.')
  await closePanel()
  await shot(page, `${tag}-project`)
  if (narrow) await noHScroll('project editor')

  await page.goto(`${base}#/ws/p/wf/make.yaml`)
  const wf = await openSection('workflow')
  check(await mode() === 'simple', 'the workflow editor\'s Context opens in Simple')
  await wf.locator('.ctx-inherited .ctx-source-row').first().waitFor()
  await wf.locator('.ctx-inherited .ctx-block-row').first().waitFor()
  const inherited = await wf.locator('.ctx-inherited').innerText()
  check(/Project p/.test(await rowOf(wf.locator('.ctx-inherited'), 'P notes').innerText()) && /Project: P/.test(inherited), 'the project block is read as inherited in the workflow, its scope named')
  check(/Project purpose and goals/.test(inherited) && /Project guide agent\/guide\.md/.test(inherited), 'project purpose and guide are shown as inherited')
  check(await page.locator('.canvas').isVisible(), 'the graph stays on the page with Context open')

  // ---- 2: workflow intent and a local block together ----
  await openShared(wf)
  const intent = page.locator('textarea[aria-label="Workflow intent"]')
  await intent.fill('Make one small, tested thing.')
  await closePanel()
  check(/Unsaved changes/.test(await wf.locator('.ctx-shared-row').innerText()), 'the closed purpose row says it has unsaved changes')
  await addNew(wf.locator('.ctx-local'), 'Instruction')
  await addBlock('Changelog', 'Make keeps a CHANGELOG entry.')
  const local = pb.locator('textarea.context-editor')
  check(/unsaved changes/.test(await wf.locator('.ctx-summary').innerText()), 'both drafts show as unsaved in the summary')
  // Display switches keep both drafts.
  await page.click('.display-toggle button[data-display="detail"]')
  await page.click('.display-toggle button[data-display="simple"]')
  check(await local.inputValue() === 'Make keeps a CHANGELOG entry.' && await pb.locator('input.ctx-block-title').inputValue() === 'Changelog', 'mode switches keep the new block\'s draft (title and text), the panel open')
  await closePanel()
  check(/Unsaved changes/.test(await rowOf(wf, 'Changelog').innerText()), 'closing the panel keeps the new block as a row with unsaved changes')
  await openShared(wf)
  check(await intent.inputValue() === 'Make one small, tested thing.', 'the intent draft is kept too')
  await closePanel()
  // A live refresh: the project file changes on disk.
  await writeFile(y, (await readFile(y, 'utf8')).replace('Make small things well.', 'Make small things very well.'))
  await settle(page, 1800)
  await rowOf(wf, 'Changelog').locator('.ctx-row-action').click()
  check(await local.inputValue() === 'Make keeps a CHANGELOG entry.' && await pb.locator('input.ctx-block-title').inputValue() === 'Changelog', 'a live refresh keeps the block draft')
  await closePanel()
  await openShared(wf)
  check(await intent.inputValue() === 'Make one small, tested thing.', 'a live refresh keeps the intent draft')
  await closePanel()
  await wf.locator('.ctx-inherited .ctx-source-row', { hasText: 'Project purpose and goals' }).locator('.ctx-row-action').click()
  check(/very well/.test(await panel.innerText()), 'the refresh shows the project\'s new purpose as inherited')
  await closePanel()
  // Navigation protection counts the new block's draft.
  dialogs.length = 0
  page.once('dialog', d => void d.dismiss().catch(() => {}))
  await page.evaluate(() => { location.hash = '#/ws/p' })
  await settle(page)
  check(dialogs.some(m => /Discard unsaved changes/.test(m)), 'leaving with drafts asks first')
  // Save the local block alone: the definition stays unsaved.
  await page.goto(`${base}#/ws/p/wf/make.yaml`).catch(() => {})
  await settle(page)
  const wf2 = await openSection('workflow')
  await wf2.locator('.ctx-inherited .ctx-block-row').first().waitFor()
  await settle(page)
  // The guard may have let the page go (the shared dialog handler accepts):
  // start both drafts again once the section has read its scope.
  await openShared(wf2)
  if (await intent.inputValue() !== 'Make one small, tested thing.') await intent.fill('Make one small, tested thing.')
  await closePanel()
  if (await wf2.locator('.ctx-local .ctx-block-row.editing').count() === 0) await addNew(wf2.locator('.ctx-local'), 'Instruction')
  else await rowOf(wf2, 'Changelog').locator('.ctx-row-action').click()
  if (await local.inputValue() !== 'Make keeps a CHANGELOG entry.') await addBlock('Changelog', 'Make keeps a CHANGELOG entry.')
  await pb.locator('.ctx-save-row button.primary').click()
  await pb.locator('.banner.ok').waitFor()
  check(/every run of workflow make/.test(await pb.locator('.banner.ok').innerText()), 'the workflow block saves on its own, naming its scope')
  check((await store.read(WF, 'changelog')).block?.body.trim() === 'Make keeps a CHANGELOG entry.', 'the workflow block is in the store')
  await closePanel()
  check(/Unsaved changes/.test(await wf2.locator('.ctx-shared-row').innerText()), 'the definition draft is still unsaved after the local save')
  await page.waitForFunction(() => /Saved settings only/.test(document.querySelector('.ctx-preview')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  check(/Saved settings only/.test(await wf2.locator('.ctx-preview').innerText()), 'the preview says unsaved definition edits are not included')
  await openShared(wf2)
  await panel.locator('button.primary:has-text("Save workflow")').click()
  await settle(page, 800)
  check(/Make one small, tested thing\./.test(await readFile(wfFile, 'utf8')), 'the definition saves through the workflow\'s own save')
  await closePanel()
  // A conflicting save: someone else saves the block after the person started editing it.
  check((await rowOf(wf2, 'Changelog').locator('.ctx-row-action').innerText()).trim() === 'Edit', 'the short saved instruction reads in its row and edits from there')
  await rowOf(wf2, 'Changelog').locator('.ctx-row-action').click()
  await local.fill('My later edit.')
  const cur = await store.read(WF, 'changelog')
  await store.set(WF, 'changelog', { body: 'Edited elsewhere.' }, { by: 'Other', base: cur.base })
  await pb.locator('.ctx-save-row button.primary').click()
  await pb.locator('.ctx-conflict').waitFor()
  check(/Other changed this block/.test(await pb.locator('.banner.error').innerText()) && /Edited elsewhere\./.test(await pb.locator('.ctx-conflict').innerText()) && await local.inputValue() === 'My later edit.', 'a conflicting save is refused, names who saved, shows what is saved, keeps the draft')
  check(await pb.locator('button:has-text("Use the saved text (discard mine)")').count() === 1 && await pb.locator('button:has-text("Save mine over it")').count() === 1, 'the conflict offers both ways out')
  await shot(page, `${tag}-workflow-conflict`)
  await pb.locator('button:has-text("Save mine over it")').click()
  await pb.locator('.banner.ok').waitFor()
  check((await store.read(WF, 'changelog')).block?.body.trim() === 'My later edit.', 'saving over it after seeing the conflict works')
  await closePanel()

  // ---- 3 (child editor): the block for all projects edited from the workflow ----
  const sysRow = rowOf(wf2.locator('.ctx-inherited'), 'English by default')
  check(/All projects/.test(await sysRow.locator('.ctx-row-scope').innerText()), 'the inherited block names its scope: all projects')
  await sysRow.locator('.ctx-row-action').click()
  await pb.locator('.ctx-block-edit:not([hidden])').waitFor()
  check(/wider scope: this applies to all projects/.test(await pb.locator('.ctx-wider-note').innerText()), 'editing from a child editor names the wider scope')
  await local.fill('Write produced text in English unless a request asks otherwise.\nKeep notes short.')
  await pb.locator('.ctx-save-row button.primary').click()
  await pb.locator('.banner.ok').waitFor()
  check(/Saved for all projects/.test(await pb.locator('.banner.ok').innerText()) && /every affected run/.test(await pb.locator('.banner.ok').innerText()), 'saving the wider scope says it affects every affected run')
  check((await store.read(SYS, 'english-by-default')).block?.body.includes('Keep notes short.') === true, 'the wider save changed the system block')
  const wfBlocks = (await store.blocks(WF)).filter(s => s.block)
  check(wfBlocks.length === 1 && wfBlocks[0].block?.body.trim() === 'My later edit.', 'no narrower block was created by the wider save')
  await closePanel()
  check(await mode() === 'simple', 'all of it happened in Simple')
  await shot(page, `${tag}-workflow`)
  if (narrow) await noHScroll('workflow editor')

  // ---- 4: a run's request and attempt context, a preference for the next attempt ----
  const runJson = async () => (await (await fetch(`${base}api/workspaces/p/runs/make/${runId}`)).json()) as { record: { seq: number; history: { op: string }[]; instructions?: Record<string, { text: string; from: string }>; control: { attempt: unknown } } }
  const before = await runJson()
  await page.goto(`${base}#/ws/p/run/make/${runId}`)
  const card = await openSection('run')
  check(await mode() === 'simple', 'the run\'s Context opens in Simple')
  await card.locator('.run-request-text').waitFor()
  check(/Make a tiny tool\.\nKeep it under fifty lines\./.test(await card.locator('.run-request-text').innerText()), 'the original request is readable in place')
  await card.locator('.run-used strong').waitFor()
  const used = await card.locator('.run-used').innerText()
  check(/Attempt \S+ — Prepared/.test(used) && /delivered to the agent/.test(used), 'the attempt\'s context and its delivery are said in Simple')
  check(/All projects instruction/.test(used) === false, 'the attempt lists what it was given then (no block for all projects existed)')
  check(/Settings changed since attempt/.test(await card.locator('.run-next').innerText()) && /All projects instruction: English by default/.test(await card.locator('.run-next').innerText()), 'blocks saved since are shown, by name, as changes for the next attempt')
  await card.locator('.run-settings button:has-text("Workflow context")').click()
  const wbox = card.locator('.run-settings .ctx-wider[data-settings="workflow"]:not([hidden])')
  await wbox.waitFor()
  check(/every run of workflow make, from the next attempt/.test(await wbox.innerText()) && /sends nothing to this run/.test(await wbox.locator('.ctx-hint span').getAttribute('title') ?? ''), 'editing a preference from a run says it applies from the next attempt and sends nothing')
  await wbox.locator('.ctx-block-row').first().waitFor()
  check(/Changelog/.test(await wbox.innerText()), 'the workflow\'s blocks are listed in the run\'s settings')
  await page.locator('.node').first().click()
  const selected = await page.locator('.node.selected').getAttribute('data-id')
  await addNew(wbox, 'Instruction')
  await addBlock('Dated entries', 'Date every CHANGELOG entry.')
  await pb.locator('.ctx-save-row button.primary').click()
  await pb.locator('.banner.ok').waitFor()
  check((await store.read(WF, 'dated-entries')).block?.body.trim() === 'Date every CHANGELOG entry.', 'the preference saved from the run is a workflow block')
  await closePanel()
  await page.waitForFunction(() => /Workflow instruction: Dated entries/.test(document.querySelector('.run-next')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  check(/Workflow instruction: Dated entries/.test(await card.locator('.run-next').innerText()), 'the saved workflow preference shows as a next-attempt change')
  check(await card.locator('.run-used').innerText() === used, 'what the current attempt was given is unchanged')
  const after = await runJson()
  check(after.record.seq === before.record.seq && after.record.history.filter(e => e.op === 'attempt.begin').length === before.record.history.filter(e => e.op === 'attempt.begin').length, 'saving a preference recorded nothing in the run and started no attempt')
  check(await page.locator('.node.selected').getAttribute('data-id') === selected, 'the graph selection is kept through the preference save')
  await shot(page, `${tag}-run`)
  if (narrow) await noHScroll('run view')

  // ---- 5: an instruction for this run, recorded once ----
  await card.locator('textarea[aria-label="Instruction for this run"]').fill('Use plain words in the summary.')
  await card.locator('button:has-text("Send to this run")').click()
  await card.locator('.run-instruct-form .banner.ok').waitFor({ timeout: 10_000 })
  await card.locator('.run-instruction[data-instruction="i1"]').waitFor({ timeout: 10_000 })
  const recd = await runJson()
  const ins = Object.values(recd.record.instructions ?? {})
  check(ins.length === 1 && ins[0].text === 'Use plain words in the summary.' && ins[0].from === 'Check Person', 'the instruction is recorded once, with whose words it is')
  const anyBlock = [...await store.blocks(SYS), ...await store.blocks(PRJ), ...await store.blocks(WF)]
  check(!anyBlock.some(s => s.block?.body.includes('plain words')), 'the instruction is not a preference: no block holds it')
  check(!/plain words/.test(await card.locator('.run-next').innerText()), 'and it is not listed among next-attempt settings')
  check(await card.locator('textarea[aria-label="Instruction for this run"]').inputValue() === '', 'the sent text leaves the form')

  // ---- 6: keyboard and labels ----
  await card.locator('.ctx-toggle').focus()
  await page.keyboard.press('Enter')
  check(await card.locator('.ctx-toggle').getAttribute('aria-expanded') === 'false', 'the section toggles from the keyboard')
  await page.keyboard.press('Enter')
  const unlabelled = await page.evaluate(() => [...document.querySelectorAll('.ctx-section textarea, .ctx-section input, .ctx-section select, .ctx-reader textarea, .ctx-reader input, .ctx-reader select')].filter(e => !(e.getAttribute('aria-label') || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.closest('label'))).length)
  check(unlabelled === 0, `every context control has a label (${unlabelled} without)`)
  await page.click('.display-toggle button[data-display="detail"]')
  await card.locator('.run-ctx-detail > summary').click()
  check(/Attempt \S+/.test(await card.locator('.run-ctx-detail').innerText()) && /snapshot ctx-/.test(await card.locator('.run-ctx-detail').innerText()), 'Detail adds every attempt with its snapshot and provenance')
  await page.click('.display-toggle button[data-display="simple"]')

  // ---- edge states: an unavailable snapshot, no attempt yet, a cancelled run ----
  const { readdir, rm: rmFile } = await import('node:fs/promises')
  const snaps = join(area, '.local', 'contexts', 'snapshots')
  for (const f of await readdir(snaps)) await rmFile(join(snaps, f))
  await page.goto(`${base}#/ws/p`); await page.goto(`${base}#/ws/p/run/make/${runId}`)
  const card2 = await openSection('run')
  await card2.locator('.run-used strong').waitFor()
  check(/exact context is unavailable/.test(await card2.locator('.run-used').innerText()), 'a deleted snapshot is said to be unavailable, nothing invented')
  const req2 = await x.request({ workspace: 'p', workflow: 'make', text: 'A second request.', author: 'Check', receipt: 'ctx-ed-0002', via: 'browser' })
  await page.goto(`${base}#/ws/p/run/make/${req2.ref.run}`)
  const card3 = await openSection('run')
  await page.waitForFunction(() => /No attempt has started yet/.test(document.querySelector('.run-used')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {})
  check(/No attempt has started yet/.test(await card3.locator('.run-used').innerText()) && /first attempt will be prepared/.test(await card3.locator('.run-next').innerText()), 'a run before its first attempt says so')
  await fetch(`${base}api/workspaces/p/runs/make/${req2.ref.run}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'run.cancel', reason: 'check', by: 'Check' }) })
  await page.waitForFunction(() => /cancelled: it takes no more instructions/.test(document.querySelector('.run-context')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {})
  check(/cancelled: it takes no more instructions/.test(await card3.innerText()) && await card3.locator('textarea[aria-label="Instruction for this run"]').isHidden(), 'a cancelled run offers no instruction form and says why')

  // Matrix links reach the editors' sections.
  await page.goto(`${base}#/context/p/make`)
  await page.waitForSelector('.ctx-table')
  check(/P notes/.test(await page.locator('.ctx-override[data-scope="project"]').innerText()) && /Changelog/.test(await page.locator('.ctx-override[data-scope="workflow"]').innerText()), 'the matrix lists each scope\'s blocks')
  await page.click('.ctx-override[data-scope="project"] a.button')
  await section('project').waitFor()
  await settle(page, 600)
  check(/#\/ws\/p\/context$/.test(page.url()) && await section('project').locator('.ctx-toggle').getAttribute('aria-expanded') === 'true', 'a matrix link opens the project editor\'s Context section')
} catch (e) {
  check(false, `the journey ran to its end (${(e as Error).message.split('\n')[0]})`)
  await shot(page, `${tag}-failure`).catch(() => {})
} finally {
  const unexpected = failed.filter(f => !/^409 .*api\/context\/block/.test(f) && !/^404 .*api\/boast\/p\?/.test(f))
  check(unexpected.length === 0, `no failed request but the expected conflict${unexpected.length ? `: ${unexpected.join(' | ')}` : ''}`)
  // WebKit reports a fetch cut short by page.reload() as an access-control failure.
  const errs = errors.filter(e => !/status of (404|409)/.test(e) && !/due to access control checks/.test(e))
  check(errs.length === 0, `no console error besides those requests${errs.length ? ` (${errs.join(' | ')})` : ''}`)
  await browser.close()
  srv.closeAllConnections(); srv.close(); x.close()
  await rm(root, { recursive: true, force: true })
  done()
}
process.exit()
