// The calmer UI (workflow_editor p8) in the browser, on the representative
// states of checks/states.ts: a private project, registry, area,
// presentation host and service. It asserts behaviour, not styling — what
// the person is shown as their next action, the distinctions between
// recorded progress, decision, executor activity and connection, that
// controls behind panels and disclosures are reachable, that drafts survive
// closing a panel and background updates, and that the graph's connections
// stay attached to their cards. It never touches another registry or workspace.
//
//   npm run build && node checks/simplerUi.ts [--port 8212] [--keep]
//
// Synthetic composition (CDP) is not the native macOS IME (see report6).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Browser, Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8212')

const root = await mkdtemp(join(tmpdir(), 'wfe-simpler-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { buildStates } = await import('./states.ts')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<number | null> {
  const t = performance.now()
  while (performance.now() - t < ms) { if (await fn().catch(() => false)) return performance.now() - t; await sleep(40) }
  return null
}

const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
let states: Awaited<ReturnType<typeof buildStates>> | undefined
let browser: Browser | undefined
try {
  states = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18810, 18819] })
  const S = states
  await service.start()
  const BASE = service.base
  const opened = await open(1440, 1000)
  browser = opened.browser
  const { page, errors } = opened
  const failedUrls: string[] = []
  page.on('response', r => { if (r.status() >= 400) failedUrls.push(`${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`) })
  const runUrl = (k: string, extra = '') => `${BASE}/#/ws/sample/run/${S.runs[k].workflow}/${S.runs[k].run}${extra}`
  const gotoRun = async (k: string, extra = '') => { await page.goto(runUrl(k, extra)); await page.waitForSelector('.run-summary[data-seq], .banner.error'); await sleep(300) }
  const seqShown = () => page.evaluate(() => Number((document.querySelector('.run-summary') as HTMLElement | null)?.dataset.seq ?? -1))
  const text = (sel: string) => page.locator(sel).first().innerText().catch(() => '')
  const visible = (sel: string) => page.locator(sel).first().isVisible().catch(() => false)
  const transform = () => page.evaluate(() => (document.querySelector('.surface') as HTMLElement).style.transform)

  // ==== 1. The definition screen =========================================================
  console.log('definition: default screen')
  await page.goto(`${BASE}/#/ws/sample/wf/improve.yaml`)
  await page.waitForSelector('.node[data-id="present"]')
  await sleep(400)
  check(await page.locator('.inspector').isHidden(), 'nothing selected: the inspector is closed and the canvas has the width')
  check(await page.locator('.wf-name').inputValue() === 'Improve the sample app' && /Agree the scope of the requested change/.test(await text('.wf-purpose')), 'the title band shows the name and the purpose (the intent\'s first line)')
  check(await page.locator('.approval-pill[data-kind="intent"]').getAttribute('data-status') === 'approved' && await page.locator('.approval-pill[data-kind="definition"]').getAttribute('data-status') === 'approved', 'both approval states are visible without opening anything')
  check(await page.getByLabel('Workflow intent').isHidden() && await page.getByRole('button', { name: 'Approve intent' }).isHidden(), 'the authoritative intent and the approval actions are behind "Intent & approvals"')
  check(/^Valid$/.test(await text('.v-summary')), 'the validation summary is visible')
  await shot(page, 'p8-def-default', false)

  console.log('definition: framing and the canvas size')
  const note = await text('.frame-note')
  check(await text('.zoom-level') === '72%' && /of 7 cards fully in view/.test(note), `a graph wider than the canvas opens at the readable scale with an in-view count: ${await text('.zoom-level')}, "${note}"`)
  await page.locator('.frame-note button').click()
  await sleep(150)
  check(await page.locator('.frame-note').isHidden() && Number((await text('.zoom-level')).replace('%', '')) < 72, 'Fit shows every card and the note goes away')
  const fitted = await transform()

  console.log('definition: Add node menu')
  await page.getByRole('button', { name: 'Add node' }).click()
  const menu = page.locator('.palette')
  check(await menu.isVisible() && await menu.locator('button.add-node[aria-label="Add Study node"]').isVisible() && await menu.locator('button.add-node.template[data-template="present"]').isVisible() && await menu.locator('a[href="#/nodes"]').isVisible(),
    'the menu offers the base types, the person\'s templates and the User nodes library')
  check(await page.evaluate(() => document.activeElement?.closest('.palette') !== null), 'opening the menu moves the focus into it')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  check(await menu.isHidden() && await page.evaluate(() => document.activeElement?.classList.contains('add-trigger')), 'Escape closes the menu and returns the focus to "Add node"')

  console.log('definition: node inspector, close and reopen')
  await page.locator('.node[data-id="verify"]').click()
  await page.waitForSelector('.inspector:not([hidden])')
  const fieldOrder = await page.locator('.inspector').evaluate(el => [...el.querySelectorAll('.field > span, .insp-group .group-title')].map(x => x.textContent))
  check(fieldOrder.slice(0, 3).join('|') === 'Name|Description|Type' && fieldOrder.includes('Appearance') && fieldOrder.includes('Repositories') && fieldOrder.includes('Connections'), `the node inspector puts name and description first; appearance, repositories and connections stay reachable: ${fieldOrder.join(', ')}`)
  check(await transform() === fitted, 'opening the inspector does not reset the zoom or pan')
  await page.getByLabel('Node description').fill('A draft description, not saved')
  await page.locator('.insp-group[data-group="appearance"] summary').click()
  await page.getByLabel('Node color').selectOption('rose')
  check(await page.locator('.insp-group[data-group="appearance"]').evaluate(e => (e as HTMLDetailsElement).open), 'a structural edit rebuilds the inspector without folding the group the person opened')
  await page.locator('.insp-close').click()
  check(await page.locator('.inspector').isHidden() && await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id) === 'verify', 'closing returns the focus to the card')
  check(await transform() === fitted, 'closing the inspector does not reset the zoom or pan')
  check(await text('.save-state') === 'Unsaved changes' && await page.locator('.node[data-id="verify"]').evaluate(e => e.classList.contains('color-rose')), 'closing saved and discarded nothing: the draft is still unsaved and still shown')
  await page.locator('.node[data-id="verify"]').click()
  check(await page.getByLabel('Node description').inputValue() === 'A draft description, not saved', 'reopening shows the draft')
  await page.keyboard.press('Escape')

  console.log('definition: intent & approvals')
  await page.getByRole('button', { name: 'Intent & approvals' }).click()
  check(/Agree the scope of the requested change with the person, implement it,\nverify it/.test(await page.getByLabel('Workflow intent').inputValue()) && await page.getByRole('button', { name: 'Approve intent' }).isDisabled(), 'the panel holds the whole intent; approval waits for the save of the draft')
  check(/reflect the unsaved draft/.test(await text('.intent-panel')), 'the panel says why the approvals are disabled')
  await page.getByLabel('Approver').fill('Sample Approver')
  await page.getByRole('button', { name: 'Intent & approvals' }).click()
  await page.getByRole('button', { name: 'Intent & approvals' }).click()
  check(await page.getByLabel('Approver').inputValue() === 'Sample Approver', 'the declared approver survives closing and reopening the panel')
  await page.getByRole('button', { name: 'Intent & approvals' }).click()

  console.log('definition: validation leads to what it is about')
  await page.locator('.node[data-id="check"]').click()
  await page.getByLabel('Node type').selectOption('do')
  await page.keyboard.press('Escape')
  check(/1 error/.test(await text('.v-summary')), 'an error shows in the validation summary')
  await page.locator('.v-summary').click()
  check(await page.locator('.inspector h4.settings-head[data-section="validation"]').evaluate(e => document.activeElement === e), 'the summary opens Workflow settings at the validation list')
  await page.locator('.inspector ul.issues a', { hasText: 'confirms the result' }).click()
  check(/Human check/.test(await text('.inspector .insp-head h3')) && await page.locator('.node[data-id="check"]').evaluate(e => e.classList.contains('selected')), 'the issue selects the node it is about, and its inspector shows it')
  await page.getByLabel('Node type').selectOption('talk')
  await page.keyboard.press('Escape')

  console.log('definition: settings, edges and generated steps')
  await page.getByRole('button', { name: 'Workflow settings' }).click()
  check(await page.getByLabel('Documentation policy', { exact: true }).isVisible() && await page.locator('.binding-row[data-binding="app"]').isVisible(), 'settings hold the documentation policy and the bindings')
  await page.keyboard.press('Escape')
  check(await page.evaluate(() => document.activeElement?.textContent?.includes('Workflow settings')), 'closing settings returns the focus to its button')
  await page.locator('.edge[data-index="1"] .hit').dispatchEvent('pointerdown')
  check(/Connection/.test(await text('.inspector .insp-head h3')) && /Verify/.test(await text('.inspector')), 'a connection is selectable and inspectable')
  await page.locator('[data-step="_report.verify"]').click()
  check(/Generated by the default documentation policy/.test(await text('.inspector')) && await page.locator('.inspector input, .inspector textarea, .inspector select').count() === 0, 'a generated step is inspectable and has no editing control')
  await page.keyboard.press('Escape')

  console.log('definition: connections stay attached to their cards')
  const attached = await page.evaluate(() => {
    const surf = (el: HTMLElement) => { let x = 0, y = 0, e: HTMLElement | null = el; while (e && !e.classList.contains('surface')) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent as HTMLElement | null } return { x, y, w: el.offsetWidth, h: el.offsetHeight } }
    return [...document.querySelectorAll<SVGGElement>('.edge')].map(g => {
      const d = g.querySelector('.line')!.getAttribute('d')!
      const nums = d.match(/-?[\d.]+/g)!.map(Number)
      const [sx, sy] = nums, [ex, ey] = nums.slice(-2)
      const a = surf(document.querySelector<HTMLElement>(`.node[data-id="${g.dataset.from}"]`)!), b = surf(document.querySelector<HTMLElement>(`.node[data-id="${g.dataset.to}"]`)!)
      return Math.abs(sx - (a.x + a.w)) < 1.5 && Math.abs(sy - (a.y + a.h / 2)) < 1.5 && Math.abs(ex - (b.x - 2)) < 1.5 && Math.abs(ey - (b.y + b.h / 2)) < 1.5
    })
  })
  check(attached.length === 4 && attached.every(Boolean), `every connection starts at its source card's right edge and ends at its target's left edge (${attached.filter(Boolean).length}/${attached.length})`)
  const corners = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.report-icon')].every(i => {
    const c = document.querySelector<HTMLElement>(`.node[data-id="${i.dataset.for}"]`)!.getBoundingClientRect(), r = i.getBoundingClientRect()
    return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom
  }))
  check(corners, 'every report icon sits inside its card')
  await page.goto(`${BASE}/#/`) // leave the unsaved draft (the navigation guard is accepted)
  await sleep(300)

  console.log('definition: framing of small and large graphs')
  await page.goto(`${BASE}/#/ws/sample/wf/tidy.yaml`)
  await page.waitForSelector('.node[data-id="links"]')
  await sleep(300)
  check(await text('.zoom-level') === '100%' && await page.locator('.frame-note').isHidden(), 'a small graph opens whole at 100% (not enlarged)')
  await page.goto(`${BASE}/#/ws/sample/wf/pipeline.yaml`)
  await page.waitForSelector('.node[data-id="release"]')
  await sleep(300)
  check(await text('.zoom-level') === '72%' && /of 18 cards fully in view/.test(await text('.frame-note')) && await page.locator('.node[data-id="intake"]').isVisible(), `a large graph opens readable from its start: ${await text('.frame-note')}`)
  await shot(page, 'p8-def-large', false)

  // ==== 2. The run view: the current task, state by state =====================================
  console.log('run view: state matrix')
  const kind = () => page.evaluate(() => (document.querySelector('.focus') as HTMLElement).dataset.kind)
  const focusForms = () => page.locator('.focus textarea, .focus input').count()

  await gotoRun('review')
  const live = page.locator('.focus .review-link a.button.primary')
  check(await kind() === 'review' && await live.isVisible() && /Open the review: Night mode for the settings page/.test(await live.innerText()), 'result review: the focus card leads with the live review link')
  check(await page.getByLabel('Answer to q2').isVisible() && /executor records the decision when it takes the answer up/.test(await text('.focus')), 'its question is answered right there, and an answer is not presented as the decision')
  check(await text('.run-name') === 'Night mode for the settings page' && /Improve the sample app · improve\/run-review/.test(await text('.title-main .wf-file')), 'the title is the presentation\'s; the workflow and run stay beside it')
  check(/Presentations \(1 live\)/.test(await text('.side-sec[data-section="presentations"] .sec-toggle')), 'the presentations section says it is live while closed')
  await shot(page, 'p8-run-review', false)

  await gotoRun('plan')
  check(await kind() === 'question' && await page.getByLabel('Answer to q1').isVisible() && await page.locator('.focus .question[data-question="q1"] .file-link', { hasText: 'plan.md' }).isVisible(), 'plan question: the question, its plan.md and its form')
  check(await text('.run-name') === 'Improve the sample app', 'without a presentation the title is the workflow\'s name')

  await gotoRun('answered')
  check(await kind() === 'answered' && await focusForms() === 0 && /Next move: Sample Agent/.test(await text('.focus')), 'answer recorded: a receipt and who moves next, not an unanswered question')
  await page.locator('.focus button.another').click()
  check(await page.getByLabel('Answer to q1').evaluate(e => document.activeElement === e), '"Record another answer" opens the same form')

  await gotoRun('held')
  check(await kind() === 'held' && await page.getByLabel('Resume instruction').isVisible() && /The tests touch the shared database/.test(await text('.focus')), 'held: the reason and the resume form with its instruction')
  check(await page.locator('.side-sec[data-section="execution"]').getAttribute('data-attention') === 'warn' && /\(held\)/.test(await text('.side-sec[data-section="execution"] .sec-toggle')), 'the closed Execution section says the run is held')

  await gotoRun('failed')
  check(await kind() === 'failed' && /Verify failed/.test(await text('.focus-head')) && /3 of 31 tests fail/.test(await text('.focus')) && !/Report on/.test(await text('.focus-lead')), 'failed: the failure and its reason; the blocked work by name (documentation steps counted, not listed)')
  await page.locator('.focus button', { hasText: 'Adjust future work' }).click()
  check(await page.locator('.side-sec[data-section="definition"] .sec-content').isVisible() && await page.getByLabel('Adjusted definition').evaluate(e => document.activeElement === e), '"Adjust future work" opens the Definition section at the adjustment form')
  check(/Reports and files \(3, 0 missing\)|Reports and files \(3\)/.test(await text('.side-sec[data-section="files"] .sec-toggle')), 'the files section counts what is there')
  await page.locator('.node[data-id="_report.implement"], [data-step="_report.implement"]').first().click()
  check(/the file is gone now/.test(await text('.side-card')), 'a recorded report whose file was deleted says so')

  await gotoRun('accepted')
  check(await kind() === 'accepted' && /Accepted · cleanup pending/.test(await text('.run-facts-row')) && await page.locator('.run-facts-row .state-chip').innerText() !== '✓ Completed', 'accepted while cleaning up: the decision is shown, the run is not called completed')

  await gotoRun('completed')
  const outcomes = await page.locator('.focus .outcome-list:not(.after) li strong').allInnerTexts()
  const after = await page.locator('.focus .outcome-list.after li strong').allInnerTexts()
  check(await kind() === 'completed' && outcomes.join('|') === 'Research contrast|Implement|Verify|Present|Human check' && after.join('|') === 'Clean up', `completed: outcomes in dependency order, each named; cleanup apart after the review: ${outcomes.join(', ')} / ${after.join(', ')}`)
  check(/Accepted by Sample Agent from q2 \(Sample Person's answer\)/.test(await text('.focus')) && /stopped/.test(await text('.focus .review-link')), 'the actual decision and the stopped presentation')
  await page.locator('.focus .file-link', { hasText: 'Read final report' }).click()
  await page.waitForSelector('.file-view pre')
  check(await page.locator('.side-sec[data-section="files"] .sec-content').isVisible() && /Added a night mode toggle/.test(await text('.file-view pre')), '"Read final report" opens the report in the Files section')
  check(/Fixed snapshot · r2 in force/.test(await text('.graph-head')) && await page.locator('.node[data-id="research"]').count() === 1, 'the graph is the definition in force (r2, with its added study)')
  await shot(page, 'p8-run-completed', false)

  await gotoRun('nodecision')
  check(await kind() === 'completed' && await page.locator('.focus input[aria-label="Decision evidence"]').isVisible() && await page.locator('.focus button', { hasText: 'Accept result' }).isEnabled(), 'completed without a decision: the decision is offered in the focus card')
  check(/1 missing/.test(await text('.side-sec[data-section="files"] .sec-toggle')) && await page.locator('.side-sec[data-section="files"]').getAttribute('data-attention') === 'warn', 'a missing artifact is named in the closed Files label')

  await gotoRun('cancelled')
  check(await kind() === 'cancelled' && await focusForms() === 0 && await page.locator('.focus button', { hasText: 'Stop p1' }).isVisible(), 'cancelled: the reason, and the presentation still recorded open with its Stop')

  await gotoRun('branch')
  check(await kind() === 'question' && await page.getByLabel('Answer to q2').isVisible() && await page.getByLabel('Answer to q3').isVisible() && /2 questions wait/.test(await text('.focus-head')), 'two open questions: both forms are reachable')

  await gotoRun('working', `/at/${S.commit}`)
  check(await kind() === 'history' && await page.locator('.run-body textarea:visible, .run-body input:visible').count() === 0 && !(await visible('.run-facts-row [class*="sit-"]')), 'historical: recorded facts only; no forms and no executor activity')

  await gotoRun('broken')
  check(await page.locator('.graph-card').isHidden() && /No usable record/.test(await text('.focus-head')), 'a malformed record: nothing is drawn from it')

  // The working run: this host's facts are synthetic (no executor process exists).
  await page.route('**/api/workspaces/sample/runs/improve/run-working/exec', route => route.fulfill({ json: { attempts: [{ id: 'at-0002', state: 'running', began: new Date().toISOString(), ended: null, exit_code: null, signal: null, outcome: null, backend: 'check-harness', pid: 4242, alive: true, stop_requested: null, log: null }], jobs: [], checkpoints: [{ id: 7, kind: 'node', state: 'failed', created: '', updated: '', error: 'push rejected', steps: [] }], executor: { state: 'available', at: new Date().toISOString() } } }))
  await gotoRun('working')
  await waitFor(async () => /process 4242 alive/.test(await text('.focus')))
  check(await kind() === 'working' && /process 4242 alive/.test(await text('.focus')) && await page.locator('.focus button', { hasText: 'Stop' }).isEnabled(), 'working: active work, this host\'s process, and Stop')
  check(/Executor: executing · process alive/.test(await text('.run-facts-row')) && /In progress/.test(await text('.run-facts-row .state-chip')), 'recorded progress and executor activity are separate facts in the title band')
  check(/Needs attention/.test(await text('.focus')) && await page.locator('.side-sec[data-section="execution"]').getAttribute('data-attention') === 'error', 'a failed publication needs the person: named in the focus card and in the closed section\'s label')

  // ==== 3. Disclosure, drafts and background updates ====================================================
  console.log('disclosure: drafts and updates')
  await gotoRun('branch')
  const sections = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.run-side .side-sec[data-section]')].map(s => [s.dataset.section, s.classList.contains('open')])))
  await page.locator('.side-sec[data-section="definition"] .sec-toggle').click()
  await page.locator('.side-sec[data-section="history"] .sec-toggle').click()
  await page.locator('details.adjust summary').click()
  await page.getByLabel('Adjustment reason').fill('a reason being written')
  await page.getByLabel('Answer to q3').fill('Only test data, please')
  const reasonEl = await page.getByLabel('Adjustment reason').elementHandle()
  await page.locator('.side-sec[data-section="definition"] .sec-toggle').click()
  const before = await sections()
  // Background updates: progress, then the q2 question is withdrawn.
  const s1 = (await S.op(S.runs.branch, { op: 'node.progress', node: 'ask', text: 'a background update' }) as { seq: number }).seq
  await waitFor(async () => (await seqShown()) >= s1)
  const s2 = (await S.op(S.runs.branch, { op: 'question.withdraw', question: 'q2', reason: 'answered elsewhere' }) as { seq: number }).seq
  await waitFor(async () => (await seqShown()) >= s2)
  await sleep(300)
  check(JSON.stringify(await sections()) === JSON.stringify(before), `background updates neither open nor close a section: ${JSON.stringify(before)}`)
  await page.locator('.side-sec[data-section="definition"] .sec-toggle').click()
  check(await reasonEl!.evaluate(e => e.isConnected && (e as HTMLInputElement).value === 'a reason being written'), 'a draft in a closed section is the same control, with its text, when reopened')
  check(await page.getByLabel('Answer to q3').inputValue() === 'Only test data, please' && await page.locator('.focus .question[data-question="q3"]').count() === 1, 'the other question\'s typed answer stays in the focus card')
  check(await page.locator('.focus .question[data-question="q2"]').count() === 0 && /Questions \(2 resolved\)/.test(await text('.side-sec[data-section="questions"] .sec-toggle')), 'the withdrawn question without a draft moved to the resolved records')
  // A question resolved while its answer is being typed stays where it is.
  await page.getByLabel('Answer to q3').click()
  const s3 = (await S.op(S.runs.branch, { op: 'question.withdraw', question: 'q3', reason: 'no longer needed' }) as { seq: number }).seq
  await waitFor(async () => (await seqShown()) >= s3)
  await sleep(300)
  check(await page.locator('.focus .question[data-question="q3"] textarea').evaluate(e => document.activeElement === e && (e as HTMLTextAreaElement).value === 'Only test data, please' && (e as HTMLTextAreaElement).readOnly) && /withdrawn/.test(await text('.focus .question[data-question="q3"] .closed-note')),
    'a question withdrawn while its answer is focused keeps the control in place, read-only, with its text and the reason')
  check(await page.getByLabel('Your name').isVisible(), 'the actor\'s name stays reachable')
  // Reopened sections survive navigation (a per-viewer convenience).
  await gotoRun('branch')
  check((await sections()).definition === true && (await sections()).history === true, 'the person\'s open sections are kept in this browser')

  console.log('connection loss')
  const beforeOutage = errors.length
  await service.stop()
  const lost = await waitFor(async () => /not live/.test(await text('.live-state')) && /Not connected/.test(await text('.banners')), 10_000)
  check(lost !== null && /questions wait|question waits|recorded/.test(await text('.focus')), 'losing the service is shown in the header and a banner; the last facts stay')
  await service.start()
  const back = await waitFor(async () => /live/.test(await text('.live-state')) && !/not live/.test(await text('.live-state')), 12_000)
  check(back !== null, 'the view reconnects by itself')
  // The outage itself makes the browser log the cut stream and refused reads.
  errors.splice(beforeOutage, errors.length - beforeOutage, ...errors.slice(beforeOutage).filter(e => !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|Failed to fetch/.test(e)))

  console.log('smaller desktop')
  await page.setViewportSize({ width: 1280, height: 800 })
  await gotoRun('review')
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  check(fits && await page.locator('.focus .review-link a.button.primary').isVisible() && await page.getByLabel('Answer to q2').isVisible(), 'at 1280 × 800 the review link and the answer form are on the first screen, without horizontal scrolling')
  await shot(page, 'p8-run-review-1280', false)

  check(!failedUrls.length, `no failed reads${failedUrls.length ? `: ${failedUrls.join(', ')}` : ''}`)
  check(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser?.close()
  await states?.stop()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()

export type { Page }
