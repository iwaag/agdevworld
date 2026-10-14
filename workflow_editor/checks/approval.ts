// The approval path in the browser (project_migration p3/ex1). A private
// project, registry, execution store and service: a result review answered
// through a failing, then a slow, then a successful submission (the form
// says each beside its button, keeps the text on failure, and a recorded
// answer reads differently from a failed one), and a result changed after
// its acceptance (the header says so, the focus card offers the renewed
// acceptance with the changed file, a double click records one decision and
// the control is gone afterwards). It never touches another registry.
//
//   npm run build && node checks/approval.ts [--port 8203]
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright-core'
import type { OpInput, RunRef } from '../shared/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8203')

const root = await mkdtemp(join(tmpdir(), 'wfe-approval-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { ExecStore } = await import('../server/exec.ts')
const { gitOk, LOCAL_TRANSPORT } = await import('../server/git.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { readRun, runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Build it and confirm it with the person.
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, name: Build, description: Build.}
  confirm: {type: talk, name: Confirm, confirms: result, description: Present the result.}
edges:
  - {from: build, to: confirm}
`
const registry = join(root, 'registry.json')
const dir = join(root, 'pj-ap')
const made = await createProject({ dir, id: 'ap', name: 'Approval check', intent: 'Checks.', goals: [], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
if (!made.ok) throw new Error(made.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
await writeFile(join(dir, 'app.txt'), 'start\n')
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
const remote = join(root, 'remotes', 'pj-ap.git')
await gitOk(root, ['init', '-q', '--bare', '--initial-branch=main', remote])
await gitOk(dir, ['remote', 'add', 'origin', remote], { config: LOCAL_TRANSPORT }); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const x = new ExecStore({ registryFile: registry, area: root })

// A run asking for the result review; `accepted` carries it on to an
// acceptance from the answer and a report written after it.
async function asking(receipt: string, accepted: boolean): Promise<RunRef> {
  const { ref } = await x.request({ workspace: 'ap', workflow: 'ship', text: 'Build it.', author: 'Check Person', receipt, via: 'browser' })
  const c = await x.claim('t')
  if (!('attempt' in c)) throw new Error(JSON.stringify(c))
  x.started(c.attempt.id, process.pid)
  const op = (o: OpInput) => runOp(ws, ref, { ...o, attempt: c.attempt.id }, { by: 'autolab', via: 'cli' })
  await op({ op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'app.txt'), 'built\n')
  await op({ op: 'node.complete', node: 'build', outcome: 'built' })
  await op({ op: 'node.start', node: 'confirm' })
  await op({ op: 'question.ask', question: '', node: 'confirm', text: 'Is app.txt right?', to: 'Check Person', subjects: ['app.txt'] })
  if (accepted) {
    await runOp(ws, ref, { op: 'question.answer', question: 'q1', text: 'ok' }, { by: 'Check Person', via: 'browser' })
    await op({ op: 'question.take-up', question: 'q1' })
    await op({ op: 'run.decide', decision: 'accepted', question: 'q1' })
    await writeFile(join(c.cwd, 'devdocs/runs', ref.workflow, ref.run, 'report.md'), 'A report written after the acceptance.\n')
    await op({ op: 'node.complete', node: 'confirm', outcome: 'confirmed' })
  }
  await x.finished(c.attempt.id, { code: 0, signal: null })
  return ref
}
const A = await asking('apc-answer-0001', false)
const B = await asking('apc-renew-0001', true)
await x.integrateDue() // B: needs agreement

const service = new PrivateService({ registry, area: root, port: PORT })
let browser: Browser | undefined
try {
  await service.start()
  const opened = await open(1440, 900, { display: null }) // a fresh browser: Simple, as the person sees it
  browser = opened.browser
  const { page, errors } = opened
  const runUrl = (r: RunRef) => `${service.base}/#/ws/ap/run/${r.workflow}/${r.run}`

  console.log('Answer feedback')
  await page.goto(runUrl(A))
  await page.waitForSelector('.run-summary[data-seq]')
  check(await page.locator('.decision-chip[data-approval="review"]').innerText() === 'Review needed', 'the header says the review is needed, not Accepted')
  await page.getByLabel('Your name').fill('Check Person')
  const box = page.getByLabel('Answer to q1')
  const send = page.locator('.focus .answer-form button.primary')
  // 1. The service fails: the reason is beside the button, the text kept.
  await page.route('**/runs/ship/run-001/ops', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated failure' }) }))
  await box.fill('ok')
  await send.click()
  await page.waitForSelector('.focus .answer-form .submit-state.s-error')
  check(/Not recorded: simulated failure/.test(await page.locator('.focus .answer-form .submit-state').innerText()), 'a failed submission says why beside its button')
  check(await box.inputValue() === 'ok', 'the text is kept after a failure')
  check(await page.locator('.focus .receipt.recorded').count() === 0, 'a failure is not shown as recorded')
  await shot(page, 'approval-answer-failed', false)
  await page.unroute('**/runs/ship/run-001/ops')
  // 2. A slow service: sending is said, and a second click sends nothing.
  let posts = 0
  await page.route('**/runs/ship/run-001/ops', async r => { posts++; await new Promise(res => setTimeout(res, 1200)); await r.continue() })
  await send.click()
  await page.waitForSelector('.focus .answer-form .submit-state.s-pending')
  check(await send.isDisabled(), 'the button is disabled while the answer is in flight')
  await send.click({ force: true }).catch(() => undefined)
  await shot(page, 'approval-answer-pending', false)
  // 3. Recorded: the question says so, apart from any failure.
  await page.waitForSelector('.focus .receipt.recorded', { timeout: 8000 })
  check(posts === 1, `one submission reached the service (${posts})`)
  check(/Recorded .*Waiting for autolab to take it up/.test(await page.locator('.focus .receipt.recorded').innerText()), 'a recorded answer says it waits for the agent')
  check(await page.locator('.decision-chip').innerText() === 'Answer recorded · waiting for autolab', 'the header says the answer waits for the agent')
  const recA = (await readRun(ws, A)).record!
  check(recA.questions.q1.answers.length === 1, 'exactly one answer was recorded')
  await shot(page, 'approval-answer-recorded', false)
  await page.unroute('**/runs/ship/run-001/ops')

  console.log('Renewed acceptance')
  await page.goto(runUrl(B))
  await page.waitForSelector('.focus[data-kind="reaccept"]')
  check(await page.locator('.decision-chip').innerText() === 'Changed since acceptance — accept again', 'the header asks for renewed acceptance, not an unqualified Accepted')
  check((await page.locator('.focus .changed-since').innerText()).includes('report.md'), 'the changed file is listed beside the status')
  const acceptBtn = page.locator('.focus .decide-slot button.primary')
  check(await acceptBtn.innerText() === 'Accept the changed result', 'the renewed-acceptance control sits in the focus card')
  await shot(page, 'approval-reaccept', false)
  await page.getByLabel('Your name').fill('Check Person')
  await acceptBtn.dblclick()
  await page.waitForSelector('.decide .submit-state.s-ok, .decide .submit-state.s-warn, .decide .submit-state.s-error', { state: 'attached', timeout: 8000 })
  await page.waitForFunction(() => document.querySelector('.decision-chip')?.textContent === 'Accepted · integrating', undefined, { timeout: 8000 })
  const recB = (await readRun(ws, B)).record!
  check(recB.decisions.length === 2, `a double click recorded one renewed acceptance (${recB.decisions.length - 1})`)
  check(x.integrations('ap', B).filter(i => i.state === 'queued').length === 1, 'one integration is queued for it')
  check(await page.locator('.decide button.primary:visible').count() === 0, 'no acceptance is offered for the accepted result')
  await x.integrateDue()
  await page.waitForFunction(() => document.querySelector('.decision-chip')?.textContent === 'Accepted · integrated', undefined, { timeout: 10000 })
  check(true, 'after the executor\'s pass the header says integrated')
  await shot(page, 'approval-integrated', false)
  const unexpected = errors.filter(e => !/status of 500/.test(e)) // the simulated failure's own console line
  check(unexpected.length === 0, `no page errors (${unexpected.join(' | ')})`)
} finally {
  await browser?.close()
  await service.stop()
  x.close()
  await rm(root, { recursive: true, force: true })
}
done()
