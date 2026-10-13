// workflow_editor p8/ex2 in the browser: creating a workflow from Simple,
// the run view's activity line, the documentation settings and the
// freework template. A private project (checks/states.ts), a second empty
// project, registry, area and service; nothing else is touched.
//
//   npm run build && node checks/freework.ts [--port 8216] [--keep] [--shots <dir>]
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Browser, Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8216')
const SHOTS = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null

const root = await mkdtemp(join(tmpdir(), 'wfe-freework-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { buildStates } = await import('./states.ts')
const { createProject } = await import('../server/create.ts')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<number | null> {
  const t = performance.now()
  while (performance.now() - t < ms) { if (await fn().catch(() => false)) return performance.now() - t; await sleep(40) }
  return null
}
async function capture(page: Page, name: string) {
  if (!SHOTS) return
  const { mkdir } = await import('node:fs/promises')
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
let browser: Browser | undefined
let S: Awaited<ReturnType<typeof buildStates>> | undefined
try {
  S = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18840, 18849] })
  const blank = await createProject({ dir: join(root, 'pj-blank'), id: 'blank', name: 'Blank project', intent: 'A project without workflows.', goals: [], sourcesDir: join(root, 'sources'), registryFile: join(root, 'registry.json') })
  if (!blank.ok) throw new Error(blank.message)
  // A project from before p8/ex2: no workflow at all (new projects now start with freework).
  await rm(join(root, 'pj-blank', 'devdocs', 'workflows', 'freework.yaml'))
  await service.start()
  const BASE = service.base
  const opened = await open(1440, 1000, { display: 'simple' })
  browser = opened.browser
  const { page, errors } = opened
  const text = (sel: string) => page.locator(sel).first().innerText().catch(() => '')
  const visible = (sel: string) => page.locator(sel).first().isVisible().catch(() => false)

  // ==== 1. Creating a workflow from Simple ====================================================
  console.log('create: an empty project in Simple')
  await page.goto(`${BASE}/#/ws/blank`)
  await page.waitForSelector('.workflows .create-wf-open')
  check(await page.evaluate(() => document.documentElement.dataset.display) === 'simple', 'the page is in Simple')
  check(await visible('.workflows .create-wf-open') && /Create workflow/.test(await text('.workflows .create-wf-open')), 'the workflow list has "Create workflow" in Simple')
  check(/No workflow yet/.test(await text('.workflows')) && await visible('.empty-workflows .link-btn'), 'an empty list says so and offers the same entry')
  await page.locator('.empty-workflows .link-btn').click()
  check(await visible('form.create-wf') && await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Name of the new workflow', 'the form opens with the keyboard in Name')
  check(!(await visible('form.create-wf .create-more label')), 'id and documents are behind "More settings"')
  await capture(page, 'create-open-simple')

  console.log('create: errors stay beside their field, input is kept')
  await page.locator('form.create-wf button[type=submit]').click()
  check(/Give the workflow a name/.test(await text('#create-wf-name-error')) && await page.getByLabel('Name of the new workflow').getAttribute('aria-invalid') === 'true', 'an empty name is refused beside Name')
  await page.getByLabel('Name of the new workflow').fill('Release Check')
  check(!(await visible('#create-wf-name-error')), 'typing clears the error')
  check(await page.getByLabel('Id of the new workflow').inputValue() === 'release-check', 'the id follows the name')
  // A switch to Detail and back keeps everything.
  await page.locator('.display-toggle button[data-display="detail"]').click()
  check(await visible('form.create-wf') && await page.getByLabel('Name of the new workflow').inputValue() === 'Release Check', 'Detail shows the same open form with the typed name')
  await page.locator('.display-toggle button[data-display="simple"]').click()
  // A background reload (a file appears) keeps the form, the text and the keyboard.
  await page.getByLabel('Name of the new workflow').click()
  await page.keyboard.press('End')
  await writeFile(join(root, 'pj-blank', 'devdocs', 'workflows', 'release-check.yaml'), 'schema: ag.workflow.v2\nid: release-check\nname: Taken\nintent: x\ndocumentation: {policy: manual}\nnodes: {a: {type: do, description: x}}\n')
  const reloaded = await waitFor(async () => /Taken/.test(await text('.workflows')))
  check(reloaded !== null, 'the list reloads while the form is open')
  check(await page.getByLabel('Name of the new workflow').inputValue() === 'Release Check' && await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Name of the new workflow', 'the reload keeps the text and the keyboard in Name')
  check(await page.getByLabel('Id of the new workflow').inputValue() === 'release-check-2', 'the derived id moves past the id that appeared')
  await page.locator('form.create-wf .create-more > summary').click()
  await page.getByLabel('Id of the new workflow').fill('release-check')
  await page.locator('form.create-wf button[type=submit]').click()
  check(/already used/.test(await text('#create-wf-id-error')) && await page.locator('form.create-wf .create-more').getAttribute('open') !== null, 'a taken id is refused beside Id, with More settings opened')
  await page.getByLabel('Id of the new workflow').fill('Bad Id')
  await page.locator('form.create-wf button[type=submit]').click()
  check(/lowercase/.test(await text('#create-wf-id-error')), 'a malformed id is refused beside Id')
  await capture(page, 'create-error-simple')
  await page.getByLabel('Id of the new workflow').fill('release-check-2')
  await page.locator('form.create-wf button[type=submit]').click()
  await page.waitForURL(/\/wf\/release-check-2\.yaml$/)
  check(true, 'Create opens the new workflow in the editor')
  await waitFor(async () => await page.locator('.wf-name').inputValue() !== '')
  check(await page.evaluate(() => document.documentElement.dataset.display) === 'simple' && await page.locator('.wf-name').inputValue() === 'Release Check', `the editor opens in Simple with the name given (${await page.locator('.wf-name').inputValue()})`)

  console.log('create: a project with workflows')
  await page.goto(`${BASE}/#/ws/sample`)
  await page.waitForSelector('.workflows .wf-row')
  check(await visible('.workflows .create-wf-open') && !(await visible('form.create-wf')), 'a list with workflows keeps the entry in its head, the form closed')
  check(S!.ws !== undefined, 'fixture ready')

  // ==== 2. The run view's activity line =======================================================
  console.log('activity: a working session')
  const { ExecStore } = await import('../server/exec.ts')
  const { runOp } = await import('../server/runs.ts')
  const { Workspace } = await import('../server/workspace.ts')
  const { loadRegistry } = await import('../server/registry.ts')
  const { spawn } = await import('node:child_process')
  const { appendFile } = await import('node:fs/promises')
  await writeFile(join(root, 'pj-blank', 'devdocs', 'workflows', 'work.yaml'), 'schema: ag.workflow.v2\nid: work\nname: Work\nintent: Do the work.\ndocumentation: {policy: manual}\nnodes:\n  implement: {type: do, name: Implement, description: Implement it.}\n  verify: {type: do, name: Verify, description: Verify it.}\nedges:\n  - {from: implement, to: verify}\n')
  const x = new ExecStore({ registryFile: join(root, 'registry.json'), area: root })
  const blankWs = new Workspace((await loadRegistry(join(root, 'registry.json'))).workspaces.find(w => w.id === 'blank')!)
  const req = await x.request({ workspace: 'blank', workflow: 'work', text: 'Make it work.', author: 'Sample Person', receipt: 'check-activity-0001', via: 'cli' })
  const runUrl = `${BASE}/#/ws/blank/run/${req.ref.workflow}/${req.ref.run}`
  await page.goto(runUrl)
  await page.waitForSelector('.run-summary[data-seq]')
  check(await waitFor(async () => /^Queued/.test(await text('.run-activity'))) !== null, `a queued run says so: "${await text('.run-activity')}"`)
  const claimed = await x.claim(null)
  if ('idle' in claimed) throw new Error(claimed.idle)
  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore' })
  x.started(claimed.attempt.id, sleeper.pid!)
  const log = join(root, '.local', 'exec', 'logs', `${claimed.attempt.id}.jsonl`)
  const evline = (o: unknown) => `${JSON.stringify(o)}\n`
  await writeFile(log, evline({ type: 'system', subtype: 'init' }))
  check(await waitFor(async () => /Between steps/.test(await text('.run-activity')) && /0 turns this session/.test(await text('.run-activity'))) !== null, `a session that recorded no start yet: "${await text('.run-activity')}"`)
  await runOp(blankWs, req.ref, { op: 'node.start', node: 'implement', attempt: claimed.attempt.id }, { via: 'cli', by: 'autolab' })
  for (let i = 1; i <= 3; i++) await appendFile(log, evline({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'thinking' }] } }) + evline({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use' }] } }) + evline({ type: 'user', message: {} }))
  check(await waitFor(async () => /^Working on Implement · 3 turns this session · last activity \d+ s ago/.test(await text('.run-activity'))) !== null, `the current work, its turns and the last activity: "${await text('.run-activity')}"`)
  check(await page.locator('.run-activity').getAttribute('data-tone') === 'working', 'the line has the working tone')
  await capture(page, 'activity-working-simple')
  // The age moves on its own; the count does not move without output.
  const age1 = await text('.run-activity .act-last')
  await sleep(2200)
  check(await text('.run-activity .act-last') !== age1 && /3 turns/.test(await text('.run-activity')), `the age updates by itself, the count stays (${age1} → ${await text('.run-activity .act-last')})`)
  // A reload counts the same: nothing is counted twice.
  await page.reload()
  await page.waitForSelector('.run-summary[data-seq]')
  check(await waitFor(async () => /3 turns this session/.test(await text('.run-activity'))) !== null, `a reload shows the same count: "${await text('.run-activity')}"`)
  // New output: the count grows and the line pulses once.
  await page.evaluate(() => { (window as unknown as { __bumps: number }).__bumps = 0; new MutationObserver(() => { if (document.querySelector('.run-activity')?.classList.contains('bump')) (window as unknown as { __bumps: number }).__bumps++ }).observe(document.querySelector('.run-activity')!, { attributes: true, attributeFilter: ['class'] }) })
  await appendFile(log, evline({ type: 'assistant', message: { id: 'm4', content: [] } }))
  check(await waitFor(async () => /4 turns this session/.test(await text('.run-activity'))) !== null, 'new output raises the count')
  check(await page.evaluate(() => (window as unknown as { __bumps: number }).__bumps) > 0, 'the line pulses when the count grows')
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.run-activity')!).getPropertyValue('aria-live') === '' && !document.querySelector('.run-activity')!.hasAttribute('aria-live')), 'the line is not a live region (no per-second announcements)')
  // Detail lists the session's turns with the attempt.
  await page.locator('.display-toggle button[data-display="detail"]').click()
  await page.evaluate(() => { for (const d of document.querySelectorAll('details')) (d as HTMLDetailsElement).open = true })
  check(await waitFor(async () => /4 turns, last output/.test(await page.locator('.attempt-activity').first().innerText().catch(() => ''))) !== null, `Detail's attempt list has the turns: "${await page.locator('.attempt-activity').first().innerText().catch(() => '')}"`)
  await page.locator('.display-toggle button[data-display="simple"]').click()
  // The process ends without a record: the line says so instead of a count.
  sleeper.kill()
  await sleep(300)
  check(await waitFor(async () => /process is not running/.test(await text('.run-activity'))) !== null && !/turns/.test(await text('.run-activity')), `a session whose process is gone shows no count: "${await text('.run-activity')}"`)
  // Disconnected: nothing current is claimed. The outage is deliberate: the
  // browser's errors about the cut stream and refused requests are expected.
  const beforeOutage = errors.length
  await service.stop()
  check(await waitFor(async () => /^Not connected/.test(await text('.run-activity')), 15000) !== null, `while disconnected the line says so: "${await text('.run-activity')}"`)
  await capture(page, 'activity-disconnected-simple')
  await service.start()
  check(await waitFor(async () => !/^Not connected/.test(await text('.run-activity')), 20000) !== null, `after reconnecting the line is current again: "${await text('.run-activity')}"`)
  errors.splice(beforeOutage, errors.length - beforeOutage, ...errors.slice(beforeOutage).filter(e => !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED/.test(e)))
  // The session ends; the node waits on the person: waiting, no count.
  await runOp(blankWs, req.ref, { op: 'question.ask', node: 'implement', text: 'Which option?', to: 'Sample Person', attempt: claimed.attempt.id } as never, { via: 'cli', by: 'autolab' })
  await runOp(blankWs, req.ref, { op: 'node.wait', node: 'implement', reason: 'asked', holder: 'Sample Person', external: 'q1', attempt: claimed.attempt.id } as never, { via: 'cli', by: 'autolab' }).catch(() => null)
  await x.finished(claimed.attempt.id, { code: 0, signal: null })
  check(await waitFor(async () => /^Waiting for/.test(await text('.run-activity'))) !== null, `a run waiting on the person says so: "${await text('.run-activity')}"`)
  // A history view shows no current activity.
  await page.goto(`${runUrl}/at/HEAD`)
  await sleep(800)
  check(!(await visible('.run-activity')), 'a history view has no activity line')

  // ==== 3. Documentation settings: custom ====================================================
  console.log('policy: custom in the workflow settings')
  const { readFile } = await import('node:fs/promises')
  await page.goto(`${BASE}/#/ws/blank/wf/work.yaml`)
  await page.locator('.display-toggle button[data-display="detail"]').click()
  await page.waitForSelector('.node[data-id="verify"]')
  check(/Manual documentation: no plan or reports/.test(await text('.policy-state')), `a manual workflow says so: "${await text('.policy-state')}"`)
  check(await page.locator('.final-step, .step-plan, .report-icon').count() === 0, 'manual: nothing generated is drawn')
  await page.getByRole('button', { name: 'Workflow settings' }).click()
  await page.selectOption('select[aria-label="Documentation policy"]', 'custom')
  const boxes = page.locator('.inspector .doc-steps input[type=checkbox]')
  check(await visible('.inspector .doc-steps') && await boxes.count() === 3 && (await boxes.evaluateAll(b => b.map(x => (x as HTMLInputElement).checked))).every(c => !c), 'custom starts from what manual generated: three unchecked documents')
  await page.getByLabel('Final report').check()
  await sleep(250)
  check(/Custom documentation: final report$/.test(await text('.policy-state')), `the chip follows: "${await text('.policy-state')}"`)
  check(await page.locator('.final-step').count() === 1 && await page.locator('.step-plan, .report-icon').count() === 0, 'the preview draws the final report only')
  check(await page.locator('svg .step-edge title').evaluateAll(t => t.map(x => x.textContent)).then(t => t.includes('verify → final report')), 'the final report is connected to the last card itself')
  await capture(page, 'policy-custom-final')
  await page.getByLabel('A report after every step').check()
  await sleep(250)
  check(/Custom documentation: 2 reports, final report/.test(await text('.policy-state')) && await page.locator('.report-icon').count() === 2, `reports appear on each card: "${await text('.policy-state')}"`)
  await page.getByLabel('A report after every step').uncheck()
  await page.getByRole('button', { name: 'Save' }).click()
  await waitFor(async () => (await text('.save-state')) === 'Saved')
  const saved = await readFile(join(root, 'pj-blank', 'devdocs', 'workflows', 'work.yaml'), 'utf8')
  const { parseWorkflow } = await import('../server/yamlDoc.ts')
  const savedModel = parseWorkflow(saved)
  check(savedModel.ok && JSON.stringify(savedModel.model.documentation) === JSON.stringify({ policy: 'custom', plan: false, reports: false, final: true }), `Save writes the three documents to the file (in the file's own flow style): ${saved.split('\n').find(l => l.startsWith('documentation'))}`)
  await page.selectOption('select[aria-label="Documentation policy"]', 'default')
  check(!(await visible('.inspector .doc-steps')) && /Default documentation: plan talk, 2 reports, final report/.test(await text('.policy-state')), 'back to default: the choices go away, the chip says what default makes')
  await page.selectOption('select[aria-label="Documentation policy"]', 'custom')
  check((await boxes.evaluateAll(b => b.map(x => (x as HTMLInputElement).checked))).every(c => c), 'custom from default starts with all three')
  await page.reload()
  await page.waitForSelector('.node[data-id="verify"]')

  console.log('policy: custom from the creation form')
  await page.goto(`${BASE}/#/ws/blank`)
  await page.locator('.display-toggle button[data-display="simple"]').click()
  await page.locator('.workflows .create-wf-open').click()
  await page.getByLabel('Name of the new workflow').fill('Final only')
  await page.locator('form.create-wf .create-more > summary').click()
  await page.selectOption('select[aria-label="Documentation policy of the new workflow"]', 'custom')
  for (const l of ['Plan talk first', 'A report after every step']) await page.locator('form.create-wf .doc-step', { hasText: l }).locator('input').uncheck()
  await capture(page, 'create-custom-simple')
  await page.locator('form.create-wf button[type=submit]').click()
  await page.waitForURL(/\/wf\/final-only\.yaml$/)
  const created = await readFile(join(root, 'pj-blank', 'devdocs', 'workflows', 'final-only.yaml'), 'utf8')
  check(/policy: custom\n {2}plan: false\n {2}reports: false\n {2}final: true/.test(created), `the created file declares the chosen documents:\n${created}`)

  // ==== 4. freework: placed, chosen and started from Simple ========================================
  console.log('freework: added to an existing project, started from Simple')
  const { placeBasics } = await import('../server/basics.ts')
  const [placed] = await placeBasics(blankWs)
  check(placed.status === 'added', `the supplement adds it to the project without it: ${placed.status} ${placed.reason}`)
  await page.goto(`${BASE}/#/ws/blank`)
  await page.locator('.display-toggle button[data-display="simple"]').click()
  check(await waitFor(async () => /Free work/.test(await text('.workflows'))) !== null, 'the workflow list shows Free work')
  check(await page.locator('select[aria-label="Request workflow"] option', { hasText: 'Free work' }).count() === 1, 'the request form offers it')
  const before = (await import('node:fs/promises')).readdir(join(root, 'pj-blank', 'devdocs', 'workflows'))
  await page.selectOption('select[aria-label="Request workflow"]', 'freework')
  await page.getByLabel('Request author').fill('Sample Person')
  await page.getByLabel('Request text').fill('I want a tiny word counter. Ask me what you need first.')
  await capture(page, 'freework-request-simple')
  // The run in the previous section holds this workspace until it is cancelled.
  await (await import('../server/runs.ts')).runOp(blankWs, req.ref, { op: 'run.cancel', reason: 'the check moves on' }, { via: 'cli', by: 'Sample Person' })
  await page.getByRole('button', { name: 'Request run' }).click()
  check(await waitFor(async () => /Requested/.test(await text('.request-run'))) !== null, `the run is requested: ${await text('.request-run .banner')}`)
  check(JSON.stringify((await before).sort()) === JSON.stringify((await (await import('node:fs/promises')).readdir(join(root, 'pj-blank', 'devdocs', 'workflows'))).sort()), 'starting a run copies no definition into devdocs/workflows')
  const fwRun = (await (await import('../server/runs.ts')).listRuns(blankWs)).find(r => r.workflow === 'freework')!
  const fwRef = { workflow: 'freework', run: fwRun.run }
  await page.goto(`${BASE}/#/ws/blank/run/freework/${fwRun.run}`)
  await page.waitForSelector('.run-summary[data-seq]')
  check(/0 of 1 steps done/.test(await text('.run-progress')), `a fresh freework run: one step of work (${await text('.run-progress')})`)
  check(await page.locator('.node[data-id="talk"]').count() === 1 && await page.locator('.final-step').count() === 1, 'its graph: the talk and the final report')
  // The executor's session: the talk asks.
  const fwClaim = await x.claim(null)
  if ('idle' in fwClaim) throw new Error(fwClaim.idle)
  const s2 = spawn('sleep', ['600'], { stdio: 'ignore' })
  x.started(fwClaim.attempt.id, s2.pid!)
  const A = fwClaim.attempt.id
  const agentOp = (i: Record<string, unknown>) => runOp(blankWs, fwRef, { ...i, attempt: A } as never, { via: 'cli', by: 'autolab' })
  await agentOp({ op: 'node.start', node: 'talk' })
  await agentOp({ op: 'question.ask', node: 'talk', text: 'Which counts do you want: words, lines, characters?', to: 'Sample Person' })
  s2.kill()
  await x.finished(A, { code: 0, signal: null })
  check(await waitFor(async () => /question waits for your answer/i.test(await text('section.focus'))) !== null, 'Simple shows the talk\'s question as the person\'s task')
  check(/Your answer lets it continue/.test(await text('section.focus')), `and says the answer lets the run continue: "${(await text('section.focus')).split('\n').slice(0, 3).join(' / ')}"`)
  await page.locator('section.focus .answer-form textarea').first().fill('Words and lines, please.')
  await page.locator('section.focus .answer-form button.primary').first().click()
  check(await waitFor(async () => /answer is recorded/i.test(await text('section.focus'))) !== null, 'the answer is recorded from Simple')
  check(/continues the run \(its resumption is queued on this host\)/.test(await text('.banners')), `the confirmation says the run continues: "${await text('.banners')}"`)
  // The next session: take up, complete the talk, add the work, start it.
  const c2 = await x.claim(null)
  if ('idle' in c2) throw new Error(c2.idle)
  const s3 = spawn('sleep', ['600'], { stdio: 'ignore' })
  x.started(c2.attempt.id, s3.pid!)
  const B = c2.attempt.id
  const bOp = (i: Record<string, unknown>) => runOp(blankWs, fwRef, { ...i, attempt: B } as never, { via: 'cli', by: 'autolab' })
  await bOp({ op: 'question.take-up', question: 'q1' })
  await bOp({ op: 'node.complete', node: 'talk', outcome: 'Agreed: count words and lines.' })
  const { adjustRun } = await import('../server/runs.ts')
  const { runSpace } = await import('../server/runspace.ts')
  const r1 = await readFile(join((await runSpace(blankWs, fwRef)).root, 'devdocs', 'runs', 'freework', fwRun.run, 'definition', 'freework.yaml'), 'utf8') // the run's own copy (p9)
  const grownText = r1.replace('nodes:\n', 'nodes:\n  count:\n    type: do\n    name: Count words and lines\n    description: Write the counter and run it.\n') + 'edges:\n  - {from: talk, to: count}\n'
  const adj = await adjustRun(blankWs, fwRef, { text: grownText, reason: 'q1 agreed the counter', source: { kind: 'answer', question: 'q1' } }, { via: 'cli', by: 'autolab', attempt: B })
  check(adj.ok, `the agreed work is added at the boundary: ${JSON.stringify(adj.problems)}`)
  await bOp({ op: 'node.start', node: 'count' })
  const fwLog = join(root, '.local', 'exec', 'logs', `${B}.jsonl`)
  await writeFile(fwLog, evline({ type: 'system', subtype: 'init' }) + evline({ type: 'assistant', message: { id: 'b1', content: [] } }) + evline({ type: 'assistant', message: { id: 'b2', content: [] } }))
  check(await waitFor(async () => /1 step done · the plan of this run has grown once/.test(await text('.run-progress'))) !== null, `the progress counts done steps without a fraction once the plan grew: "${await text('.run-progress')}"`)
  check(await waitFor(async () => /^Working on Count words and lines · 2 turns this session/.test(await text('.run-activity'))) !== null, `the activity line names the added work: "${await text('.run-activity')}"`)
  check(await waitFor(async () => await page.locator('.node[data-id="count"]').count() === 1) !== null, 'the graph shows the added work')
  await capture(page, 'freework-grown-simple')
  s3.kill()

  // ==== 5. Both sizes: no horizontal scroll; Simple shows no ids, paths or log ===========================
  console.log('sizes: 1440 × 1000 and 1280 × 800')
  const simpleText = () => page.evaluate(() => {
    // Visible text only (Detail's elements are hidden in Simple).
    const out: string[] = []
    const walk = (el: Element) => { if ((el as HTMLElement).checkVisibility && !(el as HTMLElement).checkVisibility()) return; for (const n of el.childNodes) n.nodeType === 3 ? out.push(n.textContent ?? '') : n.nodeType === 1 && walk(n as Element) }
    walk(document.body)
    return out.join(' ')
  })
  for (const [w, h] of [[1440, 1000], [1280, 800]] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const [name, url] of [['project', `${BASE}/#/ws/blank`], ['freework-run', `${BASE}/#/ws/blank/run/freework/${fwRun.run}`]] as const) {
      await page.goto(url)
      await page.locator('.display-toggle button[data-display="simple"]').click()
      await sleep(900)
      if (name === 'project') await page.locator('.workflows .create-wf-open').click()
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      check(over <= 0, `${name} at ${w} × ${h}: no horizontal scroll (${over})`)
      const t = await simpleText()
      check(!/devdocs\/|\.jsonl|\.yaml|run-0\d\d|\ba[a-z0-9]{8}-[0-9a-f]{6}\b|"type":/.test(t), `${name} at ${w} × ${h}: Simple shows no paths, run ids, attempt ids or log text`)
      await capture(page, `${name}-${w}x${h}-simple`)
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  x.close()
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser?.close()
  await S?.stop()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
