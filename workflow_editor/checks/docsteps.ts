// Documentation steps in the browser (p5 step 3): the compiled preview in the
// workflow editor and the frozen graph in the run view — the plan talk card,
// report icons attached to their cards, the final report endpoint, their
// states without color, selection and details, fit/zoom, dragging, the
// policy switch with its approval effect, and draft preservation while run
// events arrive. Builds its own temporary project and private service.
//
//   npm run build && node checks/docsteps.ts [--port 8197] [--keep]
//
// Screenshots go to agdevworld/.local/wfe-checks/screenshots/ (ignored).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright-core'
import type { OpInput, RunRef } from '../shared/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8197')

const root = await mkdtemp(join(tmpdir(), 'wfe-docsteps-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { createRun, runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

// ---- data ----------------------------------------------------------------------------

const node = (id: string, type: string) => `  ${id}:\n    type: ${type}\n    name: ${id}\n    description: ${id} step\n    repositories: [docs]\n`
const wf = (id: string, policy: string) => `schema: ag.workflow.v2\nid: ${id}\nname: ${id}\nintent: |\n  Check documentation steps.\ndocumentation:\n  policy: ${policy}\nrepositories:\n  docs: {path: devdocs, access: editable}\nnodes:\n${[node('survey', 'study'), node('build', 'do'), node('ask', 'talk'), node('join', 'do')].join('')}edges:\n  - {from: survey, to: build}\n  - {from: survey, to: ask}\n  - {from: build, to: join}\n  - {from: ask, to: join}\n`

const registry = join(root, 'registry.json')
const dir = join(root, 'pj-doc')
const created = await createProject({ dir, id: 'doc', name: 'Documentation check', intent: 'Checks.', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
if (!created.ok) throw new Error(created.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), wf('ship', 'default'))
await writeFile(join(dir, 'devdocs', 'workflows', 'plain.yaml'), wf('plain', 'manual'))
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
for (const kind of ['intent', 'definition'] as const) await ws.approve('ship.yaml', kind, 'Check Person')
const executor = { name: 'Omni Agent', backend: 'check-harness' }
const input = { kind: 'braindump' as const, text: 'A synthetic braindump.', author: 'Check Person' }
const op = async (r: RunRef, i: OpInput, by?: string) => (await runOp(ws, r, i, { via: 'cli', by })).record
const folder = (r: RunRef) => join(dir, 'devdocs', 'runs', r.workflow, r.run)

// R1: plan agreed, survey reported, build done and its report being written.
const R1 = (await createRun(ws, { workflow: 'ship', input, executor, by: 'Omni Agent', via: 'cli' })).ref
await op(R1, { op: 'node.start', node: '_plan' })
await writeFile(join(folder(R1), 'plan.md'), '# Plan\n\nSurvey, build, ask, join.\n')
await op(R1, { op: 'question.ask', question: '', node: '_plan', text: 'Agree to plan.md?', to: 'Check Person' })
await op(R1, { op: 'question.answer', question: 'q1', text: 'Agreed.' }, 'Check Person')
await op(R1, { op: 'question.take-up', question: 'q1' })
await op(R1, { op: 'node.complete', node: '_plan', outcome: 'Plan agreed.' })
await op(R1, { op: 'node.start', node: 'survey' })
await op(R1, { op: 'node.complete', node: 'survey', outcome: 'Surveyed.' })
await op(R1, { op: 'node.start', node: '_report.survey' })
await writeFile(join(folder(R1), 'report-survey.md'), '# survey\n\nThree options read; the second fits.\n')
await op(R1, { op: 'node.complete', node: '_report.survey', outcome: 'Surveyed three options. Next: build.' })
await op(R1, { op: 'node.start', node: 'build' })
await op(R1, { op: 'node.complete', node: 'build', outcome: 'Built.' })
await op(R1, { op: 'node.start', node: '_report.build' })
// R2: the manual workflow.
const R2 = (await createRun(ws, { workflow: 'plain', input, executor, by: 'Omni Agent', via: 'cli' })).ref

// ---- browser ---------------------------------------------------------------------------

const service = new PrivateService({ registry, area: root, port: PORT })
await service.start()
const BASE = service.base
const { browser, page, errors } = await open(1440, 960)

// Surface coordinates (before the canvas transform) of an element.
const box = (p: Page, sel: string) => p.locator(sel).evaluate(el => { const e = el as HTMLElement; return { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight } })
// Whether every card, icon and endpoint lies inside the canvas viewport.
const allVisible = (p: Page) => p.evaluate(() => {
  const c = document.querySelector('.canvas')!.getBoundingClientRect()
  return [...document.querySelectorAll<HTMLElement>('.canvas .node, .canvas .step-card, .canvas .report-icon, .canvas .final-step')].filter(e => !e.hidden)
    .every(e => { const r = e.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1 })
})
// The icon sits inside its card's lower-right corner (p8): 10 px from the
// right edge and 9 px from the bottom, at 26 px, scaled with the view.
async function attached(p: Page, id: string): Promise<boolean> {
  const card = (await p.locator(`.node[data-id="${id}"]`).boundingBox())!, icon = (await p.locator(`.report-icon[data-step="_report.${id}"]`).boundingBox())!
  const k = icon.width / 26
  return Math.abs(icon.x - (card.x + card.width - 36 * k)) <= 1.5 && Math.abs(icon.y - (card.y + card.height - 35 * k)) <= 1.5
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

try {
  // 1. The definition preview.
  console.log('workflow editor: default policy preview')
  await page.goto(`${BASE}/#/ws/doc/wf/ship.yaml`)
  await page.waitForSelector('.report-icon[data-step="_report.join"]')
  check(await page.locator('.report-icon').count() === 4, 'one report icon per authored node (4)')
  check(await page.locator('.step-card.step-plan').count() === 1 && await page.locator('.final-step').count() === 1, 'one plan talk card and one final report endpoint')
  const plan = await box(page, '.step-card.step-plan'), survey = await box(page, '.node[data-id="survey"]')
  check(plan.w === survey.w && plan.x < survey.x, 'the plan talk is a normal-sized card before the entry node')
  const icon = await box(page, '.report-icon[data-step="_report.survey"]')
  check(icon.w < 40 && icon.h < 40, `report icons are small (${icon.w}×${icon.h})`)
  let ok = true
  for (const id of ['survey', 'build', 'ask', 'join']) ok = ok && await attached(page, id)
  check(ok, 'every report icon sits inside its card\'s lower-right corner')
  check(/Report on survey/.test(await page.locator('.report-icon[data-step="_report.survey"]').getAttribute('aria-label') ?? ''), 'report icons have an accessible label')
  check(/plan talk, 4 reports, final report/.test(await page.locator('.policy-state').innerText()), 'the policy chip describes the preview')
  await page.click('button[title="Show the whole graph"]')
  await sleep(150)
  check(await allVisible(page), 'Fit includes the plan card, the icons and the final report')
  await shot(page, 'p5-docsteps-editor-default', false)
  for (let i = 0; i < 3; i++) await page.click('button[title="Zoom in"]')
  await page.click('button[title="Show the whole graph"]')
  await sleep(150)
  check(await allVisible(page), 'zoom then Fit keeps everything visible')

  // 2. Dragging a card carries its report icon.
  console.log('drag')
  const cardEl = page.locator('.node[data-id="build"] .node-title')
  const b = (await cardEl.boundingBox())!
  await page.mouse.move(b.x + 10, b.y + 5)
  await page.mouse.down()
  await page.mouse.move(b.x + 60, b.y + 95, { steps: 8 })
  await page.mouse.up()
  check(await attached(page, 'build'), 'the report icon moved with its card')
  check((await page.locator('.save-state').innerText()) === 'Unsaved changes', 'the move is a draft change (layout only)')
  check(await page.locator('.approval-pill[data-kind="definition"]').getAttribute('data-status') === 'approved', 'a move does not touch definition approval')

  // 3. Selecting a step shows its facts, read-only.
  console.log('step selection')
  await page.locator('.report-icon[data-step="_report.build"]').click()
  const insp = await page.locator('.inspector').innerText()
  check(/Generated by the default documentation policy/.test(insp) && /Waits for\s*build/.test(insp) && /Then\s*join/.test(insp), 'the inspector explains the report step and what waits for it')
  check(await page.locator('.report-icon[data-step="_report.build"]').evaluate(e => e.classList.contains('selected')), 'the selected icon is marked')
  await shot(page, 'p5-docsteps-editor-step', false)

  // 4. Switching the policy changes the preview and the approval state.
  console.log('policy switch')
  await page.locator('.canvas').click({ position: { x: 20, y: 20 } })
  await page.getByRole('button', { name: 'Workflow settings' }).click()
  await page.selectOption('select[aria-label="Documentation policy"]', 'manual')
  await sleep(200)
  check(await page.locator('.report-icon').count() === 0 && await page.locator('.final-step').count() === 0 && await page.locator('.step-card.step-plan').count() === 0, 'manual policy: no generated steps in the preview')
  check(await page.locator('.approval-pill[data-kind="definition"]').getAttribute('data-status') === 'stale', 'the policy change makes definition approval stale')
  check(await page.locator('.approval-pill[data-kind="intent"]').getAttribute('data-status') === 'approved', 'intent approval is unaffected')
  // A run event arrives while the draft is unsaved.
  await op(R1, { op: 'node.progress', node: '_report.build', text: 'writing' })
  await sleep(2500)
  check(await page.locator('select[aria-label="Documentation policy"]').inputValue() === 'manual' && (await page.locator('.save-state').innerText()) === 'Unsaved changes', 'a run event keeps the unsaved draft')
  await shot(page, 'p5-docsteps-editor-manual', false)

  // 5. The run view on the frozen graph.
  console.log('run view')
  await page.goto(`${BASE}/#/ws/doc/run/ship/run-001`)
  await page.waitForSelector('.report-icon[data-step="_report.build"]')
  const writing = page.locator('.report-icon[data-step="_report.build"]')
  check(await writing.evaluate(e => e.classList.contains('run-running')) && /Writing report/.test(await writing.innerText()), 'the report being written is highlighted and labelled “Writing report”')
  check(await page.locator('.node[data-id="build"]').evaluate(e => e.classList.contains('run-completed')), 'its node shows the work as completed')
  check(/Running/.test(await writing.getAttribute('aria-label') ?? ''), 'the state is in the accessible label, not only in color')
  check(/✓/.test(await page.locator('.report-icon[data-step="_report.survey"]').innerText()), 'a completed report shows a check glyph')
  const facts = await page.locator('.run-facts').innerText()
  check(/Work\s*2 completed · 2 pending/.test(facts) && /Documentation steps\s*1 running · 2 completed · 3 pending/.test(facts), `work and documentation are counted apart: ${facts.replace(/\n/g, ' | ')}`)
  check(/Writing report on\s*build/.test(await page.locator('.run-now').innerText()), 'summary: “Writing report on build”')
  check(/Coordination \(Zulip\)\s*Not announced: Zulip coordination is not configured on this host/.test(await page.locator('.run-side').innerText()), 'the run view states its Zulip coordination (here: not configured)')
  await page.click('button[title="Show the whole graph"]')
  await sleep(150)
  check(await allVisible(page), 'run view: Fit includes the generated steps')
  await shot(page, 'p5-docsteps-run', false)
  await writing.click()
  let side = await page.locator('.run-side').innerText()
  check(/report-build\.md: not written yet/.test(side), 'a missing document is shown as missing')
  await writeFile(join(folder(R1), 'report-build.md'), '# build\n\nhalf written')
  await op(R1, { op: 'node.progress', node: '_report.build', text: 'half way' })
  await sleep(2000)
  side = await page.locator('.run-side').innerText()
  check(/report-build\.md: being written — not yet recorded/.test(side), 'an unfinished document is shown as unfinished')
  await page.locator('.report-icon[data-step="_report.survey"]').click()
  side = await page.locator('.run-side').innerText()
  check(/report-survey\.md: checked when recorded/.test(side), 'a recorded document shows its evidence')
  await page.locator('.doc-state a', { hasText: 'Open' }).click()
  await page.waitForSelector('.file-view pre')
  check(/Three options read/.test(await page.locator('.file-view pre').innerText()), 'the document opens from its step')
  await page.locator('.step-card.step-plan').click()
  check(/Agreed: the answer to q1/.test(await page.locator('.run-side').innerText()), 'the plan step names the agreeing question')
  await page.locator('.final-step').click()
  check(/Final report/.test(await page.locator('.run-side').innerText()) && /report\.md: not written yet/.test(await page.locator('.run-side').innerText()), 'the final report endpoint is selectable with its own status')
  await shot(page, 'p5-docsteps-run-detail', false)

  // 6. Manual policy run.
  console.log('manual run')
  await page.goto(`${BASE}/#/ws/doc/run/plain/run-001`)
  await page.waitForSelector('.node[data-id="join"] .run-status')
  check(await page.locator('.report-icon').count() === 0 && await page.locator('.step-card.step-plan').count() === 0, 'a manual run shows no generated steps')
  check(/manual — no generated plan or reports/.test(await page.locator('.run-facts').innerText()), 'the manual policy is stated')
  void R2

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
