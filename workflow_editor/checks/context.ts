// p13 browser check, adapted to p14's context blocks: the Context view and a
// run's context, against a private fixture on this host's LAN name over
// plain HTTP. Needs a built UI (`vite build`).
//
//   node checks/context.ts            (Chromium)
//   WFE_BROWSER=webkit node checks/context.ts
//   WFE_NARROW=1 node checks/context.ts   (390 px throughout; the last step is 390 px in any case)
//
// Checks: entrances from home, project and workflow views; the matrix with
// defaults and each scope's local blocks; adding a workflow block in Quick
// edit with the unsaved marker; save with its next-attempt explanation and
// the block's revision history; a conflicting edit of the block and taking
// the saved text; removing the block; the resolved preview and the copy
// action; the run view's used-versus-next comparison with a changed source
// marked; a narrow layout.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScopeTarget } from '../shared/context.ts'
import { createHandler } from '../server/api.ts'
import { ContextStore } from '../server/contextStore.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Watcher } from '../server/watch.ts'
import { check, done, open, shot } from './lib.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'wfe-context-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check\n\temail = c@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const area = join(root, 'area'), registry = join(area, 'registry.json')
const dir = join(area, 'pj-p')
const c = await createProject({ dir, id: 'p', name: 'Project P', intent: 'Make small things well.', goals: ['Every thing is checked'], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
if (!c.ok) throw new Error(c.message)
await mkdir(join(dir, 'agent'))
await writeFile(join(dir, 'agent', 'guide.md'), '# P guide\nFacts of P.\n')
await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make one small thing.
documentation: {policy: manual}
execution:
  agent: p-agent
  guides: [agent/guide.md]
repositories:
  root: {path: ., access: editable}
nodes:
  a: {type: do, description: Do it.}
`)
const y = join(dir, 'project.yaml')
await writeFile(y, `${await readFile(y, 'utf8')}guides: [agent/guide.md]\n`)
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
const store = new ContextStore(area)
const WF: ScopeTarget = { scope: 'workflow', project: 'p', workflow: 'make' }
await store.set({ scope: 'system' }, 'english', { title: 'English deliverables', kind: 'instruction', body: 'Write deliverables in English unless asked otherwise.' }, { by: 'Check', base: 0 })
const x = new ExecStore({ registryFile: registry, area })
const req = await x.request({ workspace: 'p', workflow: 'make', text: 'Make it.', author: 'Check', receipt: 'ctx-check-0001', via: 'browser' })
const claim = await x.claim('check', { profiles: {}, contract: { name: 'wfrun/guide.md', sha256: 'c'.repeat(64) } })
if (!('attempt' in claim)) throw new Error(JSON.stringify(claim))
await x.contextDelivery(claim.attempt.id, { delivered: true })
x.started(claim.attempt.id, process.pid)
await x.finished(claim.attempt.id, { code: 0, signal: null })

const watcher = new Watcher(500, { gitIntervalMs: 1000, registryFile: registry })
const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], distDir: join(pkg, 'dist'), watcher, exec: x }))
await new Promise<void>(r => srv.listen(0, '0.0.0.0', r))
const port = (srv.address() as { port: number }).port
const host = process.env.WFE_LAN_HOST ?? (hostname().endsWith('.local') ? hostname() : `${hostname().split('.')[0]}.local`)
const base = `http://${host}:${port}/`
console.log(`fixture service at ${base}`)

const narrow = !!process.env.WFE_NARROW
const { browser, page, errors } = await open(narrow ? 390 : 1400, narrow ? 844 : 1000)
const failed: string[] = []
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })
try {
  await page.goto(`${base}#/`)
  await page.waitForSelector('a[href="#/context"]')
  check(true, 'home has a Context entrance')
  await page.goto(`${base}#/ws/p`)
  await page.waitForSelector('a[href="#/context/p"]')
  check(true, 'the project view has a Context entrance')
  await page.goto(`${base}#/ws/p/wf/make.yaml`)
  await page.waitForSelector('a.button[href="#/context/p/make"]', { timeout: 10_000 })
  check(true, 'the workflow view links to its workflow context')

  await page.goto(`${base}#/context/p/make`)
  await page.waitForSelector('.ctx-table')
  const matrix = await page.locator('.ctx-table').innerText()
  check(/Project P: intent and goals/.test(matrix) && /guide agent\/guide\.md/.test(matrix) && /Make: intent/.test(matrix), 'defaults: project intent and goals, the project guide, the workflow intent')
  check(/declared by project\.yaml guides and workflow execution\.guides; delivered once/.test(matrix), 'a guide declared twice is one source')
  check(/English deliverables/.test(await page.locator('.ctx-override[data-scope="system"]').innerText()) && /managed by Check/.test(await page.locator('.ctx-override[data-scope="system"]').innerText()), 'the system block is listed in its cell, with its manager')
  check(/runs are created, not pre-authored/.test(matrix), 'the run column says there is no run default')
  await shot(page, 'p14-context-matrix')

  // Add a workflow block in Quick edit.
  const quick = page.locator('.ctx-edit')
  await quick.locator('.ctx-add button:has-text("+ Add an instruction")').click()
  const card = quick.locator('article.ctx-block').first()
  await card.locator('input.ctx-block-title').fill('Changelog')
  await card.locator('input[aria-label="Revision author"]').fill('Check Person')
  await card.locator('textarea.context-editor').fill('Make runs keep a CHANGELOG entry.')
  check(await page.locator('text=Unsaved changes').count() === 1, 'an unsaved edit is marked')
  await card.locator('.ctx-save-row button.primary:has-text("Save")').click()
  await card.locator('.banner.ok').waitFor()
  const saved = await card.locator('.banner.ok').innerText()
  check(/next attempt/.test(saved) && /nothing was started/i.test(saved), 'saving says it applies to the next attempt and starts nothing')
  check((await store.read(WF, 'changelog')).block?.body.trim() === 'Make runs keep a CHANGELOG entry.', 'the block is in the store under an id from its title')
  await page.waitForFunction(() => /Make runs keep a CHANGELOG entry/.test(document.querySelector('.ctx-rendered')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {})
  check(/Make runs keep a CHANGELOG entry/.test(await page.locator('.ctx-rendered').innerText()), 'the resolved preview includes the new block')
  check(/Changelog/.test(await page.locator('.ctx-override[data-scope="workflow"]').innerText()), 'the matrix lists the new block in its cell')
  await card.locator('summary:has-text("Revision history")').click()
  await card.locator('.ctx-revisions').waitFor()
  check(/revision 1/.test(await card.locator('.ctx-revisions').innerText()) && /Check Person/.test(await card.locator('.ctx-revisions').innerText()), 'revision history names the author')

  // A conflicting edit: someone else saves after the person started editing.
  await card.locator('button:has-text("Edit")').click()
  await card.locator('textarea.context-editor').fill('My later edit.')
  const cur = await store.read(WF, 'changelog')
  await store.set(WF, 'changelog', { body: 'Edited elsewhere.' }, { by: 'Other', base: cur.base })
  await card.locator('.ctx-save-row button.primary:has-text("Save")').click()
  await card.locator('.ctx-conflict').waitFor()
  check(/Other changed this block/.test(await card.locator('.banner.error').innerText()) && /Edited elsewhere\./.test(await card.locator('.ctx-conflict').innerText()), 'a conflicting edit is refused and shows what is saved now')
  await shot(page, 'p14-context-conflict')
  await card.locator('button:has-text("Use the saved text (discard mine)")').click()
  check(/Edited elsewhere\./.test(await card.locator('.ctx-block-content pre.ctx-text').innerText()) && !(await card.getAttribute('class'))?.includes('editing') && await card.locator('textarea.context-editor').inputValue() === 'Edited elsewhere.\n', 'taking the saved text replaces the draft and closes the edit box')

  // Copy.
  await page.click('button:has-text("Authoring")')
  await page.click('button:has-text("Copy text")')
  await page.waitForTimeout(300)
  const copied = await page.locator('.ctx-resolved .small.muted').last().innerText()
  check(/Copied|selected below/.test(copied) || await page.locator('textarea.context-manual').count() > 0, 'copying works or falls back to a selected text')
  check(/not injected/.test(await page.locator('.ctx-resolved').innerText()), 'authoring context is labelled as available, not injected')

  // The run view: used by the attempt vs next (the Context card, p13 ex1).
  await page.goto(`${base}#/ws/p/run/make/${req.ref.run}`)
  await page.waitForSelector('.run-context .ctx-toggle', { timeout: 15_000 })
  if (await page.getAttribute('.run-context .ctx-toggle', 'aria-expanded') !== 'true') await page.click('.run-context .ctx-toggle')
  await page.waitForSelector('.run-used strong', { timeout: 15_000 })
  const run = await page.locator('.run-context').innerText()
  check(/Attempt \S+ — Prepared/.test(run) && /delivered to the agent/.test(run), 'the attempt\'s context and its delivery are shown')
  check(/Changes for the next attempt/.test(run) && /This attempt keeps what it was given/.test(run), 'the next attempt is labelled as not yet applied')
  check(await page.locator('.run-next .pill.ctx-change-added').count() >= 1 && /Workflow instruction: Changelog/.test(await page.locator('.run-next').innerText()), 'the added workflow block is marked, by name')
  check(/Add an instruction for this run/.test(run), 'current-run steering is offered as an instruction')
  // Cleared: the source is marked removed once.
  const cur2 = await store.read(WF, 'changelog')
  await store.remove(WF, 'changelog', { by: 'Check', base: cur2.base })
  await page.click('.display-toggle button[data-display="detail"]')
  await page.click('.run-ctx-detail > summary')
  await page.click('.run-ctx-detail button:has-text("Read again")')
  await page.waitForTimeout(800)
  check(await page.locator('.run-next .pill.ctx-change-removed').count() === 0, 'a source absent in both the last attempt and now is not marked')
  await shot(page, 'p14-run-context')

  // Narrow layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}#/context/p/make`)
  await page.waitForSelector('.ctx-table')
  const over = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  const wide = over > 1 ? await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`).join(', ')) : ''
  check(over <= 1, `no horizontal page scroll at 390px (overflow ${over}${wide ? `: ${wide}` : ''})`)
  await shot(page, 'p14-context-narrow')
  const unexpected = failed.filter(f => !/^409 .*api\/context\/block/.test(f) && !/^404 .*api\/boast\/p\?/.test(f)) // the conflict on purpose; the fixture has no Boast page
  check(unexpected.length === 0, `no failed request but the expected conflict${unexpected.length ? `: ${unexpected.join(' | ')}` : ''}`)
  check(errors.filter(e => !/status of (404|409)/.test(e)).length === 0, `no console error besides those requests${errors.length ? ` (${errors.filter(e => !/status of (404|409)/.test(e)).join(' | ')})` : ''}`)
} finally {
  await browser.close()
  srv.closeAllConnections(); srv.close(); x.close()
  await rm(root, { recursive: true, force: true })
  done()
}
process.exit()
