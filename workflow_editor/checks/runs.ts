// The run UI against its own data and service (p3/pre1 step 3, moved to the
// p4 contract). Builds a temporary directory-mode project with a
// branching/joining workflow and a delegate-holding workflow, starts
// a private service (production build, port 8196 by default, with the bench
// counters), records run operations through the same module the CLI uses,
// and drives the browser. It never touches another registry or workspace.
//
//   npm run build && node checks/runs.ts [--port 8196] [--repeat 20] [--out <file.json>] [--keep]
//
// Screenshots and the JSON record go to agdevworld/.local/wfe-checks/ (ignored).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Page } from 'playwright-core'
import type { OpInput, RunRecord, RunRef } from '../shared/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, '..', '..', '.local', 'wfe-checks')
process.env.WFE_FIXTURE = OUT_DIR // lib.ts puts screenshots beneath it
const args = process.argv.slice(2)
const option = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const PORT = Number(option('--port', '8196'))
const REPEAT = Number(option('--repeat', '20'))
const OUT = resolve(option('--out', join(OUT_DIR, 'checks-runs.json')))

const root = await mkdtemp(join(tmpdir(), 'wfe-runs-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { gitOk } = await import('../server/git.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { createRun, runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

// ---- data ----------------------------------------------------------------------------

const wf = (id: string, nodes: string, edges: string) => `schema: ag.workflow.v2\ndocumentation: {policy: manual}\nid: ${id}\nname: ${id}\nintent: |\n  Check workflow ${id}.\nrepositories:\n  docs: {path: devdocs, access: editable}\nnodes:\n${nodes}edges:\n${edges}\n`
const node = (id: string, type: string, extra = '') => `  ${id}:\n    type: ${type}\n    name: ${id}\n    description: ${id} step as captured\n    repositories: [docs]\n${extra}`
const SHIP = wf('ship', [node('survey', 'study'), node('build', 'do'), node('ask', 'talk'), node('handoff', 'do'), node('join', 'do')].join(''),
  '  - {from: survey, to: build}\n  - {from: survey, to: ask}\n  - {from: survey, to: handoff}\n  - {from: build, to: join}\n  - {from: ask, to: join}\n  - {from: handoff, to: join}')
const SUB = wf('sub', [node('prepare', 'do'), node('pass', 'delegate', '    workflow: ship\n')].join(''), '  - {from: prepare, to: pass}')

const registry = join(root, 'registry.json')
const dir = join(root, 'pj-chk')
const created = await createProject({ dir, id: 'chk', name: 'Run check project', intent: 'Checks.', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
if (!created.ok) throw new Error(created.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), SHIP)
await writeFile(join(dir, 'devdocs', 'workflows', 'sub.yaml'), SUB)
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const runDirOf = (r: RunRef) => join(dir, 'devdocs', 'runs', r.workflow, r.run)
const runJson = (r: RunRef) => join(runDirOf(r), 'run.json')
const record = async (r: RunRef) => JSON.parse(await readFile(runJson(r), 'utf8')) as RunRecord
const op = async (r: RunRef, input: OpInput, by?: string, now?: Date) => (await runOp(ws, r, input, { via: 'cli', by, now })).record
const executor = { name: 'Omni Agent', backend: 'check-harness' }
const input = { kind: 'braindump' as const, text: 'A synthetic braindump for the run check.', author: 'Check Person', recordedBy: 'Omni Agent' }

const R1 = (await createRun(ws, { workflow: 'ship', input, executor, by: 'Omni Agent', via: 'cli' })).ref
const R2 = (await createRun(ws, { workflow: 'ship', input: { ...input, text: 'Second run.' }, executor, by: 'Omni Agent', via: 'cli' })).ref
await op(R1, { op: 'node.start', node: 'survey' })
await op(R1, { op: 'node.complete', node: 'survey', outcome: 'Surveyed the options.' })
await op(R1, { op: 'node.start', node: 'build' })
await op(R1, { op: 'node.start', node: 'ask' })
await op(R1, { op: 'question.ask', question: '', node: 'ask', text: 'Small or large map?', to: 'Check Person' })
await op(R1, { op: 'node.start', node: 'handoff' })
await op(R1, { op: 'node.wait', node: 'handoff', reason: 'release review', holder: 'Release board', external: 'review #7' })
// A run whose last record is five hours old.
const fiveHours = new Date(Date.now() - 5 * 3600 * 1000)
const R3 = (await createRun(ws, { workflow: 'ship', name: 'run-old', input: { ...input, text: 'Old run.' }, executor, by: 'Omni Agent', via: 'cli', now: fiveHours })).ref
await op(R3, { op: 'node.start', node: 'survey' }, undefined, fiveHours)
await op(R3, { op: 'question.ask', question: '', node: 'survey', text: 'Still there?', to: 'Check Person' }, undefined, fiveHours)

// ---- browser ---------------------------------------------------------------------------

const service = new PrivateService({ registry, area: root, port: PORT, counters: true })
await service.start()
const BASE = service.base
const { browser, page, errors } = await open(1440, 1000)
const result: Record<string, unknown> = { at: new Date().toISOString(), repeat: REPEAT, pollMs: 1000 }
const hash = (r: RunRef, extra = '') => `${BASE}/#/ws/chk/run/${r.workflow}/${r.run}${extra}`
const seqShown = (p: Page) => p.evaluate(() => Number((document.querySelector('.run-summary') as HTMLElement | null)?.dataset.seq ?? -1))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<number | null> {
  const t = performance.now()
  while (performance.now() - t < ms) { if (await fn()) return performance.now() - t; await new Promise(r => setTimeout(r, 25)) }
  return null
}
const waitSeq = (n: number, ms = 6000) => waitFor(async () => (await seqShown(page)) >= n, ms)
// The card's state label without its state glyph (p5: shown before the label).
const cardText = (id: string) => page.locator(`.node[data-id="${id}"] .run-status`).innerText().then(t => t.replace(/^[○◇⊘✎⏸✓✕–]\s*/, ''), () => '')
const stats = () => service.stats()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) }

try {
  // 1. Project view lists runs with states and holders.
  console.log('project view')
  await page.goto(`${BASE}/#/ws/chk`)
  await page.waitForSelector('.run-row[data-run="ship/run-001"]')
  const row = await page.locator('.run-row[data-run="ship/run-001"]').innerText()
  check(/In progress/.test(row) && /ask — next move: Check Person/.test(row) && /handoff — next move: Release board/.test(row), 'project view: run row shows state and who holds each wait')
  await shot(page, 'p4-runs-project', false)

  // 2. The run view on the fixed graph.
  console.log('run view')
  await page.goto(hash(R1))
  await page.waitForSelector('.node[data-id="join"] .run-status')
  const labels = Object.fromEntries(await Promise.all(['survey', 'build', 'ask', 'handoff', 'join'].map(async id => [id, await cardText(id)])))
  result.labels = labels
  check(labels.survey === 'Completed' && labels.build === 'Running (reported)' && labels.ask === 'Waiting · Check Person' && labels.handoff === 'Waiting · Release board' && labels.join === 'Pending',
    `node labels as text: ${JSON.stringify(labels)}`)
  const now = await page.locator('.run-now').innerText()
  check(/Active\s*build/.test(now) && /Waiting\s*ask → next move: Check Person, handoff → next move: Release board/.test(now), 'summary: every active and waiting branch is listed')
  check(/the words of Check Person, recorded by Omni Agent/.test(await page.locator('.run-facts').innerText()), 'summary: braindump authorship')
  await shot(page, 'p4-run-view', false)

  // 3. Ordinary progress saves: latency, with the service's work counted.
  console.log('latency')
  await sleep(1500)
  const idle0 = await stats(); await sleep(10_000); const idle1 = await stats()
  const lat: number[] = []
  const busy0 = await stats()
  for (let i = 0; i < REPEAT; i++) {
    const rec = await op(R1, { op: 'node.progress', node: 'build', text: `progress ${i + 1}` })
    const ms = await waitSeq(rec.seq, 8000)
    lat.push(ms ?? 8000)
    await sleep(300 + Math.random() * 700) // off the poll phase
  }
  const busy1 = await stats()
  result.updateSeconds = Math.round(lat.reduce((a, b) => a + b, 0) / 1000 + REPEAT * 0.8)
  const sub = (x: Record<string, number>, y: Record<string, number>) => Object.fromEntries(Object.keys(y).map(k => [k, y[k] - (x[k] ?? 0)]).filter(([, n]) => n))
  const diff = (a: typeof idle0, b: typeof idle0) => ({ counts: sub(a.counts, b.counts), git: sub(a.gitByCommand, b.gitByCommand), cpuMs: Math.round((b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1000) })
  result.latency = { n: lat.length, min: Math.round(Math.min(...lat)), p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: Math.round(Math.max(...lat)), over2s: lat.filter(x => x > 2000).length, all: lat.map(Math.round) }
  result.idle10s = diff(idle0, idle1)
  result.updates = diff(busy0, busy1)
  check(lat.filter(x => x > 2000).length === 0, `progress saves shown within 2 s: ${JSON.stringify(result.latency)}`)

  // 4. A burst of updates ends on the last one.
  console.log('burst')
  let last = 0
  for (let i = 0; i < 5; i++) last = (await op(R1, { op: 'node.progress', node: 'build', text: `burst ${i + 1}` })).seq
  const burst = await waitSeq(last)
  await sleep(1500)
  check(burst !== null && await seqShown(page) === (await record(R1)).seq, `burst of 5: view ends on seq ${last} (${Math.round(burst ?? -1)} ms)`)

  // 5. An answer being typed survives refreshes.
  console.log('draft answer')
  const ta = page.getByLabel('Answer to q1')
  await ta.click()
  await ta.pressSequentially('Small, please')
  const seqBefore = (await op(R1, { op: 'node.progress', node: 'build', text: 'while typing' })).seq
  await waitSeq(seqBefore)
  await sleep(300)
  check(await page.getByLabel('Answer to q1').inputValue() === 'Small, please' && await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Answer to q1',
    'a typed answer keeps its text and focus while the run refreshes')

  // 6. Answer from the browser: recorded, not taken up, node still waiting.
  console.log('answer')
  await page.getByLabel('Your name').fill('Check Person')
  await page.locator('.question[data-question="q1"] button.primary').first().click()
  await waitSeq(seqBefore + 1)
  let rec = await record(R1)
  const a0 = rec.questions.q1.answers[0]
  check(a0?.text === 'Small, please' && a0.from === 'Check Person' && a0.by === 'Check Person' && a0.via === 'browser', 'browser answer recorded with name and route')
  check(rec.nodes.ask.state === 'waiting' && rec.questions.q1.takenUp === null, 'the node still waits; the answer is not taken up')
  await waitFor(async () => /to take up/.test(await cardText('ask')))
  check(await cardText('ask') === 'Answered · Omni Agent to take up' && /ask → next move: Omni Agent \(answer recorded, not yet taken up\)/.test(await page.locator('.run-now').innerText()), `card and summary say who holds the next move: "${await cardText('ask')}"`)
  check(/does not wake the executor/.test(await page.locator('.run-body').innerText()), 'the view says recording does not wake the executor')
  await shot(page, 'p4-run-answered', false)

  // 7. An answer typed against an outdated view is refused, not applied.
  console.log('stale view')
  const viewUrl = `**/api/workspaces/chk/runs/ship/${R1.run}`
  await page.route(viewUrl, r => r.abort())
  const moved = (await op(R1, { op: 'node.progress', node: 'build', text: 'moved on' })).seq
  await sleep(1500)
  await page.locator('.question[data-question="q1"] button.another').click() // an answered question offers its form on request (p8)
  await page.getByLabel('Answer to q1').fill('A late second answer')
  await page.locator('.question[data-question="q1"] button.primary').first().click()
  await waitFor(async () => /changed since this view was read/.test(await page.locator('.banners').innerText()))
  rec = await record(R1)
  check(rec.questions.q1.answers.length === 1 && rec.seq === moved, 'outdated answer refused; run.json unchanged')
  await page.unroute(viewUrl)
  await page.getByRole('button', { name: 'Refresh' }).click()
  await waitSeq(moved)
  check(await page.getByLabel('Answer to q1').inputValue() === 'A late second answer', 'the refused text is kept for another try')
  await page.getByLabel('Answer to q1').fill('')

  // 8. Take-up, completion, a commit; then a failure blocks the join.
  console.log('take-up, completion, failure')
  await op(R1, { op: 'question.take-up', question: 'q1' })
  const atCommit = (await op(R1, { op: 'node.complete', node: 'ask', outcome: 'Small map agreed.' })).seq
  await writeFile(join(runDirOf(R1), 'report-history.md'), 'Report captured at this commit.')
  await gitOk(dir, ['add', '-A', 'devdocs'])
  await gitOk(dir, ['commit', '-q', '-m', 'check: ask completed'])
  const commit = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
  await writeFile(join(runDirOf(R1), 'report-history.md'), 'Current report changed after the commit.')
  await waitSeq(atCommit)
  check(await cardText('ask') === 'Completed' && await cardText('join') === 'Pending', 'take-up then completion shown; the join still waits for build and handoff')
  const failed = (await op(R1, { op: 'node.fail', node: 'build', reason: 'The engine does not compile.' })).seq
  await waitSeq(failed)
  check(await cardText('build') === 'Failed' && await cardText('join') === 'Blocked', `failure is not success and blocks the join: build "${await cardText('build')}", join "${await cardText('join')}"`)
  check(/Failed\s*build/.test(await page.locator('.run-now').innerText()) && /Waiting\s*handoff/.test(await page.locator('.run-now').innerText()), 'a failed branch and a waiting branch are both visible')
  await shot(page, 'p4-run-failed-branch', false)

  // 9. A workflow with a delegate node: definition and display only.
  console.log('delegate unsupported')
  await page.goto(`${BASE}/#/ws/chk/wf/sub.yaml`)
  await page.waitForSelector('.node[data-id="pass"]')
  check(/execution not supported/.test(await page.locator('.node[data-id="pass"]').innerText()), 'the delegate card says execution is not supported')
  check(await createRun(ws, { workflow: 'sub', input, executor, by: 'Omni Agent', via: 'cli' }).then(() => false, (e: Error) => /delegate/.test(e.message)), 'a run of it is refused')
  await shot(page, 'p4-delegate-unsupported', false)
  await page.goto(hash(R1))
  await page.waitForSelector('.run-summary[data-seq]')

  // 10. Editing the source definition does not change the run's graph.
  console.log('source edit')
  await page.waitForSelector('.node[data-id="survey"] .node-desc')
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), SHIP.replace('survey step as captured', 'survey step EDITED LATER'))
  const srcChanged = await waitFor(async () => /changed since this snapshot/.test(await page.locator('.run-title').innerText()))
  check(srcChanged !== null && await page.locator('.node[data-id="survey"] .node-desc').innerText() === 'survey step as captured', 'source edit: run view keeps the snapshot and says the current definition changed')
  await shot(page, 'p4-run-source-changed', false)

  // 11. A malformed record keeps the last valid view and blocks operations; repair recovers.
  console.log('malformed')
  const good = await readFile(runJson(R1), 'utf8')
  await writeFile(runJson(R1), good.slice(0, 120))
  const bad = await waitFor(async () => /run\.json cannot be used/.test(await page.locator('.banners').innerText()))
  check(bad !== null && await page.locator('.node[data-id="join"]').count() === 1, `malformed run.json: error shown in ${Math.round(bad ?? -1)} ms, last valid graph kept`)
  check(await page.getByRole('button', { name: 'Reject result' }).isDisabled(), 'no operations on an unusable record')
  await shot(page, 'p4-run-malformed', false)
  await writeFile(runJson(R1), good)
  const ok = await waitFor(async () => !/cannot be used/.test(await page.locator('.banners').innerText()))
  check(ok !== null, `repaired run.json: recovered in ${Math.round(ok ?? -1)} ms`)
  check(await readFile(runJson(R1), 'utf8') === good, 'the invalid file was never overwritten by the service')

  // 12. A report saved into the run folder appears; its text is readable.
  console.log('report file')
  const t0 = performance.now()
  await writeFile(join(runDirOf(R1), 'report1.md'), '# Report 1\n\nSurvey findings.\n')
  await page.waitForSelector('.run-side .file-link:text("report1.md")', { timeout: 6000 })
  result.reportVisibleMs = Math.round(performance.now() - t0)
  await page.locator('.run-side .file-link', { hasText: 'report1.md' }).first().click()
  await page.waitForSelector('.file-view pre')
  check(/Survey findings/.test(await page.locator('.file-view pre').innerText()), `report saved in the folder appears (${result.reportVisibleMs} ms) and is readable`)

  // 13. Connection loss: visible; a change made meanwhile appears after reconnecting.
  console.log('outage')
  await service.stop()
  const notLive = await waitFor(async () => /not live/.test(await page.locator('.live-state').innerText()), 8000)
  check(notLive !== null && /Not connected/.test(await page.locator('.banners').innerText()), 'outage: "not live" and a banner are shown')
  const during = (await op(R1, { op: 'node.progress', node: 'handoff', text: 'recorded during the outage' })).seq
  await service.start()
  const back = await waitSeq(during, 10_000)
  check(back !== null, `the change made during the outage appears after reconnecting (${Math.round(back ?? -1)} ms after restart)`)

  // 14. Run switching never shows an obsolete response.
  console.log('switching')
  await page.route(`**/api/workspaces/chk/runs/ship/${R1.run}`, async r => { await sleep(1500); await r.continue().catch(() => {}) })
  await page.goto(hash(R1))
  await sleep(100)
  await page.goto(hash(R2))
  await sleep(2500)
  check(await page.locator('.run-ref').innerText() === 'ship/run-002' && await seqShown(page) === (await record(R2)).seq, 'fast switch R1 → R2 ends on R2, the late R1 response is not applied')
  await page.unroute(`**/api/workspaces/chk/runs/ship/${R1.run}`)

  // 15. The definition editor keeps an unsaved draft while runs progress.
  console.log('definition draft')
  await page.goto(`${BASE}/#/ws/chk/wf/ship.yaml`)
  await page.waitForSelector('.node[data-id="build"]')
  await page.locator('.node[data-id="build"]').click()
  await page.getByLabel('Node description').fill('An unsaved draft description')
  for (let i = 0; i < 3; i++) await op(R2, { op: i === 0 ? 'node.start' : 'node.progress', node: 'survey', ...(i ? { text: `p${i}` } : {}) } as OpInput)
  await op(R1, { op: 'node.progress', node: 'handoff', text: 'more' })
  await sleep(2500)
  check(await page.getByLabel('Node description').inputValue() === 'An unsaved draft description' && /Unsaved changes/.test(await page.locator('.save-state').innerText()) && !/changed on disk/.test(await page.locator('.banners').innerText()),
    'run progress leaves an unsaved definition draft alone')

  // 16. A devdocs commit reconstructs the stage at that commit.
  console.log('history view')
  await page.goto(`${hash(R1, `/at/${commit}`)}`)
  await page.waitForSelector('.run-summary[data-seq]')
  check(await seqShown(page) === atCommit && /As committed in the project root/.test(await page.locator('.banners').innerText()) && await cardText('build') === 'Running (reported)' && await cardText('ask') === 'Completed',
    `history view at ${commit.slice(0, 7)}: seq ${atCommit}, build running, ask completed`)
  await page.locator('.run-side .file-link', { hasText: 'report-history.md' }).first().click()
  await page.waitForSelector('.file-view pre')
  check(await page.locator('.file-view pre').innerText() === 'Report captured at this commit.', 'history report uses the displayed commit, not the current file')
  await shot(page, 'p4-run-at-commit', false)
  await page.goto(hash(R1))
  await page.waitForSelector('.run-summary[data-seq]')
  await page.locator('.run-side .file-link', { hasText: 'report-history.md' }).first().click()
  await page.waitForSelector('.file-view pre')
  check(await page.locator('.file-view pre').innerText() === 'Current report changed after the commit.', 'current run report still uses the working tree')

  // 17. Old timestamps are shown as such and change nothing.
  console.log('old timestamps')
  await page.goto(hash(R3))
  await page.waitForSelector('.run-summary[data-seq]')
  const lastUpdate = await page.locator('.fact.last-update').innerText()
  check(/5 h ago/.test(lastUpdate) && await cardText('survey') === 'Waiting · Check Person', `a 5-hour-old wait stays waiting: "${lastUpdate.replace(/\s+/g, ' ')}"`)

  // Chromium logs every aborted request and non-2xx response; the stale-view,
  // outage and switching checks cause those on purpose.
  const pageErrors = errors.filter(e => !/^Failed to load resource/.test(e))
  result.expectedNetworkErrors = errors.length - pageErrors.length
  check(pageErrors.length === 0, `no page errors (${pageErrors.length}; ${errors.length - pageErrors.length} expected network errors from the deliberate aborts, outage and 409)${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(result, null, 2))
  console.log(`record: ${OUT}`)
  if (args.includes('--keep')) console.log(`data kept: ${root}`)
  else await rm(root, { recursive: true, force: true })
  done()
}
