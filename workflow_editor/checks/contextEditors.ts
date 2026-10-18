// p13 ex1 browser check: context inside the editors, as the person's tasks,
// against a private fixture on this host's LAN name over plain HTTP. Needs
// a built UI (`vite build`). Starts in Simple, as a fresh browser does.
//
//   node checks/contextEditors.ts                 (Chromium, desktop)
//   WFE_BROWSER=webkit node checks/contextEditors.ts
//   WFE_NARROW=1 node checks/contextEditors.ts    (390 px)
//
// Journeys: a project-local instruction saved in the project editor and read
// as inherited in the workflow editor; workflow intent and a local
// instruction edited together (separate saves, mode switches, a live
// refresh, navigation protection, a conflicting save); instructions for all
// projects from Home and from a child editor; a run's request and attempt
// context in Simple, a workflow preference changed from the run and the
// next-attempt difference without starting anything; an additional
// instruction recorded once; keyboard, labels and layout.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright-core'
import { createHandler } from '../server/api.ts'
import { ContextStore } from '../server/contextStore.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Watcher } from '../server/watch.ts'
import { check, done, open, shot } from './lib.ts'

const narrow = !!process.env.WFE_NARROW
const tag = `p13ex1-${process.env.WFE_BROWSER === 'webkit' ? 'webkit' : 'chromium'}${narrow ? '-narrow' : ''}`
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

try {
  await page.goto(`${base}#/`)
  await page.evaluate(() => localStorage.setItem('workflow-editor.actor', 'Check Person'))

  // ---- 3: instructions for all projects from Home, no project chosen ----
  await page.reload()
  const home = await openSection('system')
  check(await mode() === 'simple', 'Home starts in Simple and the Context section opens there')
  check(/no instructions for all projects/.test(await home.locator('.ctx-summary').innerText()), 'Home\'s summary says no instructions for all projects are set')
  await home.locator('textarea.context-editor').fill('Write produced text in English unless a request asks otherwise.')
  check(/unsaved changes/.test(await home.locator('.ctx-summary').innerText()), 'an unsaved instruction shows in the summary')
  await home.locator('.ctx-save-row button.primary').click()
  await home.locator('.banner.ok').waitFor()
  check(/Saved for all projects/.test(await home.locator('.banner.ok').innerText()) && /nothing was started/.test(await home.locator('.banner.ok').innerText()), 'saving names the scope and says nothing was started')
  check((await store.read({ scope: 'system' })).text?.startsWith('Write produced text in English') === true, 'the system instruction is in the store')
  check(await mode() === 'simple', 'saving kept Simple')
  await shot(page, `${tag}-home`)
  if (narrow) await noHScroll('Home')

  // ---- 1: a project-local instruction, read as inherited in the workflow ----
  await page.goto(`${base}#/ws/p`)
  const proj = await openSection('project')
  check(await mode() === 'simple', 'the project editor\'s Context opens in Simple')
  await page.waitForFunction(() => (document.querySelector('.ctx-shared textarea') as HTMLTextAreaElement | null)?.value)
  await proj.locator('.ctx-inherited .ctx-src').first().waitFor()
  check(await proj.locator('.ctx-shared textarea').inputValue() === 'Make small things well.', 'the purpose is editable in the section (one control)')
  check(await page.locator('textarea[aria-label="Project purpose"]').count() === 1, 'the purpose has exactly one editor in the page')
  check(/Instructions for all projects/.test(await proj.locator('.ctx-inherited').innerText()) && /Write produced text in English/.test(await proj.locator('.ctx-inherited').innerText()), 'the system instruction is shown as inherited, with its scope named')
  await proj.locator('.ctx-local textarea.context-editor').waitFor()
  await proj.locator('.ctx-local textarea.context-editor').fill('P notes start with the line "Project: P".')
  await proj.locator('.ctx-local .ctx-save-row button.primary').click()
  await proj.locator('.ctx-local .banner.ok').waitFor()
  check(/every workflow of project p/.test(await proj.locator('.ctx-local .banner.ok').innerText()), 'the project instruction is saved for every workflow of the project')
  // Typing while the view refreshes in the background keeps the keyboard and the caret.
  const purpose = proj.locator('.ctx-shared textarea')
  await purpose.click(); await page.keyboard.press('End'); await page.keyboard.type(' Draft words')
  await writeFile(join(dir, 'agent', 'guide.md'), '# P guide\nFacts of P, refreshed.\n')
  await settle(page, 2200)
  const kept = await page.evaluate(() => { const a = document.activeElement as HTMLTextAreaElement | null; return { label: a?.getAttribute('aria-label'), at: a?.selectionStart, len: a?.value.length } })
  check(kept.label === 'Project purpose' && kept.at === kept.len, `a background refresh keeps focus and caret in the purpose (${JSON.stringify(kept)})`)
  await purpose.fill('Make small things well.')
  await shot(page, `${tag}-project`)
  if (narrow) await noHScroll('project editor')

  await page.goto(`${base}#/ws/p/wf/make.yaml`)
  const wf = await openSection('workflow')
  check(await mode() === 'simple', 'the workflow editor\'s Context opens in Simple')
  await wf.locator('.ctx-inherited .ctx-src').first().waitFor()
  const inherited = await wf.locator('.ctx-inherited').innerText()
  check(/Instructions for project p/.test(inherited) && /Project: P/.test(inherited), 'the project instruction is read as inherited in the workflow')
  check(/Project purpose and goals/.test(inherited) && /Project guide agent\/guide\.md/.test(inherited), 'project purpose and guide are shown as inherited')
  check(await page.locator('.canvas').isVisible(), 'the graph stays on the page with Context open')

  // ---- 2: workflow intent and a local instruction together ----
  const intent = wf.locator('.ctx-shared textarea')
  await intent.fill('Make one small, tested thing.')
  const local = wf.locator('.ctx-local textarea.context-editor')
  await local.fill('Make keeps a CHANGELOG entry.')
  check(/unsaved changes/.test(await wf.locator('.ctx-summary').innerText()), 'both drafts show as unsaved in the summary')
  // Display switches keep both drafts.
  await page.click('.display-toggle button[data-display="detail"]')
  await page.click('.display-toggle button[data-display="simple"]')
  check(await intent.inputValue() === 'Make one small, tested thing.' && await local.inputValue() === 'Make keeps a CHANGELOG entry.', 'mode switches keep both drafts')
  // A live refresh: the project file changes on disk.
  await writeFile(y, (await readFile(y, 'utf8')).replace('Make small things well.', 'Make small things very well.'))
  await settle(page, 1800)
  check(await intent.inputValue() === 'Make one small, tested thing.' && await local.inputValue() === 'Make keeps a CHANGELOG entry.', 'a live refresh keeps both drafts')
  check(/very well/.test(await wf.locator('.ctx-inherited').innerText()), 'the refresh shows the project\'s new purpose as inherited')
  // Navigation protection counts the local draft.
  dialogs.length = 0
  page.once('dialog', d => void d.dismiss().catch(() => {}))
  await page.evaluate(() => { location.hash = '#/ws/p' })
  await settle(page)
  check(dialogs.some(m => /Discard unsaved changes/.test(m)), 'leaving with drafts asks first')
  // Save the local instruction alone: the definition stays unsaved.
  await page.goto(`${base}#/ws/p/wf/make.yaml`).catch(() => {})
  await settle(page)
  const wf2 = await openSection('workflow')
  if (await wf2.locator('.ctx-shared textarea').inputValue() !== 'Make one small, tested thing.') await wf2.locator('.ctx-shared textarea').fill('Make one small, tested thing.')
  if (await wf2.locator('.ctx-local textarea.context-editor').inputValue() !== 'Make keeps a CHANGELOG entry.') await wf2.locator('.ctx-local textarea.context-editor').fill('Make keeps a CHANGELOG entry.')
  await wf2.locator('.ctx-local .ctx-save-row button.primary').click()
  await wf2.locator('.ctx-local .banner.ok').waitFor()
  check(/every run of workflow make/.test(await wf2.locator('.ctx-local .banner.ok').innerText()), 'the workflow instruction saves on its own, naming its scope')
  check(/Unsaved changes/.test(await wf2.locator('.ctx-shared .ctx-save-state').innerText()), 'the definition draft is still unsaved after the local save')
  check(/unsaved changes in project.yaml|Saved context only/.test(await wf2.locator('.ctx-preview-note').textContent() ?? ''), 'the preview says unsaved definition edits are not included')
  await wf2.locator('.ctx-shared button.primary:has-text("Save workflow")').click()
  await settle(page, 800)
  check(/Make one small, tested thing\./.test(await readFile(wfFile, 'utf8')), 'the definition saves through the workflow\'s own save')
  // A conflicting save of the local instruction.
  const cur = await store.read({ scope: 'workflow', project: 'p', workflow: 'make' })
  await store.write({ scope: 'workflow', project: 'p', workflow: 'make' }, 'Edited elsewhere.', { by: 'Other', base: cur.sha256 })
  await wf2.locator('.ctx-local textarea.context-editor').fill('My later edit.')
  await wf2.locator('.ctx-local .ctx-save-row button.primary').click()
  await wf2.locator('.ctx-local .ctx-conflict').waitFor()
  check(/Edited elsewhere\./.test(await wf2.locator('.ctx-local .ctx-conflict').innerText()) && await wf2.locator('.ctx-local textarea.context-editor').inputValue() === 'My later edit.', 'a conflicting save is refused, shows what is saved, keeps the draft')
  await shot(page, `${tag}-workflow-conflict`)
  await wf2.locator('.ctx-local button:has-text("Save mine over it")').click()
  await wf2.locator('.ctx-local .banner.ok').waitFor()
  check((await store.read({ scope: 'workflow', project: 'p', workflow: 'make' })).text?.trim() === 'My later edit.', 'saving over it after seeing the conflict works')

  // ---- 3 (child editor): instructions for all projects from the workflow ----
  await wf2.locator('button:has-text("Edit instructions for all projects")').click()
  const widerBox = wf2.locator('.ctx-wider:not([hidden])')
  await widerBox.waitFor()
  check(/wider scope: this applies to all projects/.test(await widerBox.innerText()), 'editing from a child editor names the wider scope')
  await widerBox.locator('textarea.context-editor').fill('Write produced text in English unless a request asks otherwise.\nKeep notes short.')
  await widerBox.locator('.ctx-save-row button.primary').click()
  await widerBox.locator('.banner.ok').waitFor()
  check(/Saved for all projects/.test(await widerBox.locator('.banner.ok').innerText()) && /every affected run/.test(await widerBox.locator('.banner.ok').innerText()), 'saving the wider scope says it affects every affected run')
  check((await store.read({ scope: 'workflow', project: 'p', workflow: 'make' })).text?.trim() === 'My later edit.', 'no narrower override was created by the wider save')
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
  check(/Instructions for all projects/.test(used) === false, 'the attempt lists what it was given then (no instruction for all projects existed)')
  check(/Settings changed since attempt/.test(await card.locator('.run-next').innerText()) && /Instructions for all projects/.test(await card.locator('.run-next').innerText()), 'settings saved since are shown as changes for the next attempt')
  await card.locator('.run-settings button:has-text("Edit workflow instructions")').click()
  const wbox = card.locator('.run-settings .ctx-wider:not([hidden])')
  await wbox.waitFor()
  check(/future attempts of every run of workflow make, this run included/.test(await wbox.innerText()) && /sends nothing to this run/.test(await wbox.innerText()), 'editing a preference from a run says it applies to future attempts of all affected runs and sends nothing')
  await page.locator('.node').first().click()
  const selected = await page.locator('.node.selected').getAttribute('data-id')
  await wbox.locator('textarea.context-editor').fill('Make keeps a CHANGELOG entry, dated.')
  await wbox.locator('.ctx-save-row button.primary').click()
  await wbox.locator('.banner.ok').waitFor()
  await page.waitForFunction(() => /Instructions for the workflow/.test(document.querySelector('.run-next')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  check(/Instructions for the workflow/.test(await card.locator('.run-next').innerText()), 'the saved workflow preference shows as a next-attempt change')
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
  check(!(await store.read({ scope: 'workflow', project: 'p', workflow: 'make' })).text?.includes('plain words'), 'the instruction is not a preference: no override holds it')
  check(!/plain words/.test(await card.locator('.run-next').innerText()), 'and it is not listed among next-attempt settings')
  check(await card.locator('textarea[aria-label="Instruction for this run"]').inputValue() === '', 'the sent text leaves the form')

  // ---- 6: keyboard and labels ----
  await card.locator('.ctx-toggle').focus()
  await page.keyboard.press('Enter')
  check(await card.locator('.ctx-toggle').getAttribute('aria-expanded') === 'false', 'the section toggles from the keyboard')
  await page.keyboard.press('Enter')
  const unlabelled = await page.evaluate(() => [...document.querySelectorAll('.ctx-section textarea, .ctx-section input')].filter(e => !(e.getAttribute('aria-label') || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.closest('label'))).length)
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
  await page.click('.ctx-override[data-scope="project"] a.button')
  await section('project').waitFor()
  await settle(page, 600)
  check(/#\/ws\/p\/context$/.test(page.url()) && await section('project').locator('.ctx-toggle').getAttribute('aria-expanded') === 'true', 'a matrix link opens the project editor\'s Context section')
} catch (e) {
  check(false, `the journey ran to its end (${(e as Error).message.split('\n')[0]})`)
  await shot(page, `${tag}-failure`).catch(() => {})
} finally {
  const unexpected = failed.filter(f => !/^409 .*api\/context\/override/.test(f) && !/^404 .*api\/boast\/p\?/.test(f))
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
