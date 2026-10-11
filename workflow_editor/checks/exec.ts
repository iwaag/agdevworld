// p4 stage 3: requests, execution status, answers, stop / resume and
// publication in the browser, against a private service and its own area.
// The executor's steps (claim, reports with the attempt id, process end) are
// driven here through server/exec.ts — the calls autolab's loop makes — so
// no agent is launched. Also measures how soon a recorded step is visible.
//
//   npm run build && node checks/exec.ts [--port 8198] [--keep]
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8198)
const root = await mkdtemp(join(tmpdir(), 'wfe-exec-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[protocol "file"]\n\tallow = always\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { gitOk } = await import('../server/git.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { ExecStore } = await import('../server/exec.ts')
const { readRun, runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

const area = join(root, 'area')
const registry = join(area, 'registry.json')
const dir = join(area, 'pj-chk')
const made = await createProject({ dir, id: 'chk', name: 'Exec check', intent: 'Checks.', goals: [], devdocs: 'directory', registryFile: registry })
if (!made.ok) throw new Error(made.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Agree on a scope, then build it.
repositories:
  root: {path: ., access: editable}
nodes:
  scope: {type: talk, name: Scope, description: Agree on the scope.}
  build: {type: do, name: Build, description: Build it.}
edges:
  - {from: scope, to: build}
`)
const remote = join(area, 'remote.git')
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])

const service = new PrivateService({ registry, area, port: PORT })
await service.start()
const x = new ExecStore({ registryFile: registry, area })
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const ref = { workflow: 'ship', run: 'run-001' }
const report = (attempt: string, op: Parameters<typeof runOp>[2]) => runOp(ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const { browser, page, errors } = await open(1440, 1000)
const B = service.base
const waitText = (sel: string, re: RegExp, ms = 15_000) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source] as const, { timeout: ms }).then(() => true, () => false)
const result: Record<string, unknown> = {}

try {
  console.log('request through the Project Editor')
  // Force the runs response to arrive before the project/workflow data.
  // The retained request card must refresh when the latter finally arrives.
  await page.route('**/api/workspaces/chk/project*', async route => {
    await new Promise(r => setTimeout(r, 1200))
    await route.continue()
  })
  await page.goto(`${B}/#/ws/chk`)
  await page.waitForSelector('.request-run', { timeout: 8000 }).catch(async () => { await shot(page, 'p4-debug-project', true); console.log(await page.locator('main').innerText()) })
  await page.waitForSelector('.workflows .wf-row')
  check(await page.getByLabel('Request workflow').locator('option[value="ship"]').count() === 1,
    'workflow choices appear when project data arrives after the runs')
  await page.getByLabel('Request workflow').selectOption('ship')
  await page.getByLabel('Request author').fill('Check Person')
  await page.getByLabel('Request text').fill('Please build a small thing.')
  await page.unrouteAll({ behavior: 'wait' })
  const refreshed = page.waitForResponse(r => r.url().includes('/api/workspaces/chk/project?refresh=1'))
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await refreshed
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Request workflow"]')?.value === 'ship')
  check(await page.getByLabel('Request author').inputValue() === 'Check Person'
    && await page.getByLabel('Request text').inputValue() === 'Please build a small thing.',
    'refreshing workflow choices preserves the request author, text and selection')
  await page.getByRole('button', { name: 'Request run' }).click()
  check(await waitText('.request-run', /Requested: ship\/run-001/), 'the request creates the run and queues the executor')
  check((await readRun(ws, ref)).record?.input.author === 'Check Person', 'the person\'s words are the braindump, with them as author')
  await page.goto(`${B}/#/ws/chk/run/ship/run-001`)
  await page.waitForSelector('.run-summary[data-seq]')
  check(await waitText('.run-side', /start \(queued\)/), 'the run view shows the queued start')

  console.log('executing, then awaiting a person')
  const c1 = await x.claim('check-harness')
  if (!('attempt' in c1)) throw new Error(JSON.stringify(c1))
  x.started(c1.attempt.id, process.pid)
  await report(c1.attempt.id, { op: 'node.start', node: 'scope' })
  check(await waitText('.run-side', /Executing/) && await waitText('.run-side', /process \d+ alive/), 'executing, with the process this host sees alive')
  // Latency: a recorded step until the view shows it.
  const lat: number[] = []
  for (let i = 0; i < 10; i++) {
    const t = performance.now()
    const rec = (await report(c1.attempt.id, { op: 'node.progress', node: 'scope', text: `progress ${i}` })).record
    await page.waitForFunction(n => Number((document.querySelector('.run-summary') as HTMLElement | null)?.dataset.seq ?? -1) >= n, rec.seq, { timeout: 8000 })
    lat.push(performance.now() - t)
    await new Promise(r => setTimeout(r, 300 + Math.random() * 700))
  }
  result.latency = { n: lat.length, max: Math.round(Math.max(...lat)), p50: Math.round(lat.sort((a, b) => a - b)[5]), all: lat.map(Math.round) }
  check(Math.max(...lat) < 2000, `progress visible within 2 s: ${JSON.stringify(result.latency)}`)
  await report(c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Check Person' })
  await x.finished(c1.attempt.id, { code: 0, signal: null })
  check(await waitText('.run-side', /Awaiting a person — no process runs meanwhile/), 'awaiting a person; the process has ended')
  check(await waitText('.run-side', /published/), 'the human-wait checkpoint is published')
  await shot(page, 'p4-run-awaiting', false)

  console.log('answer in the browser → resumption queued')
  await page.getByLabel('Your name').fill('Check Person')
  await page.getByLabel('Answer to q1').fill('Small, please')
  await page.locator('.question[data-question="q1"] button.primary').first().click()
  check(await waitText('.run-side', /resume \(queued\)/), 'the answer is recorded, then the resumption queued')
  const rec = (await readRun(ws, ref)).record!
  check(rec.nodes.scope.state === 'waiting' && rec.questions.q1.takenUp === null, 'answer recorded, not taken up')

  console.log('stop while executing; confirmed only by the end')
  const c2 = await x.claim('check-harness')
  if (!('attempt' in c2)) throw new Error(JSON.stringify(c2))
  x.started(c2.attempt.id, process.pid)
  await report(c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
  await report(c2.attempt.id, { op: 'node.start', node: 'build' })
  await page.waitForFunction(() => /Executing/.test(document.querySelector('.run-side')?.textContent ?? ''))
  page.removeAllListeners('dialog'); page.on('dialog', d => void d.accept('wrong direction'))
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  check(await waitText('.run-side', /Stop requested — waiting for the process to end/), 'a stop request is shown as a request, not as termination')
  await writeFile(join(dir, 'half.txt'), 'half\n')
  await x.finished(c2.attempt.id, { code: null, signal: 'SIGTERM' })
  check(await waitText('.run-side', /Stopped — resumes only when you resume it/), 'stopped once the process ended')
  check(await report(c2.attempt.id, { op: 'node.progress', node: 'build', text: 'late' }).then(() => false, () => true), 'a late report of the stopped attempt is refused')
  await shot(page, 'p4-run-stopped', false)

  console.log('resume with an instruction; completion; acceptance publishes')
  await page.getByLabel('Resume instruction').fill('half.txt is there; finish build')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  check(await waitText('.run-side', /resume \(queued\) — resume: half.txt is there/), 'the resume instruction reaches the queue')
  const c3 = await x.claim('check-harness')
  if (!('attempt' in c3)) throw new Error(JSON.stringify(c3))
  check(/half.txt is there; finish build/.test(c3.brief), 'and the next attempt\'s brief')
  x.started(c3.attempt.id, process.pid)
  await report(c3.attempt.id, { op: 'node.complete', node: 'build', outcome: 'done', artifacts: ['half.txt'] })
  await x.finished(c3.attempt.id, { code: 0, signal: null })
  check(await waitText('.run-side', /^.*Completed/), 'completed')
  await page.getByLabel('Decision evidence').fill('half.txt looks right')
  await page.getByRole('button', { name: 'Accept result' }).click()
  check(await waitText('.run-side', /result accepted/), 'acceptance is its own publication checkpoint')
  check((await gitOk(remote, ['show', 'main:devdocs/runs/ship/run-001/run.json'])).includes('"decision": "accepted"'), 'the accepted record is on the remote')
  await shot(page, 'p4-run-accepted', false)

  const pageErrors = errors.filter(e => !/^Failed to load resource/.test(e))
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`)
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
  x.close()
  await service.stop()
  if (args.includes('--keep')) console.log(`data kept: ${root}`)
  else await rm(root, { recursive: true, force: true })
  done()
}
