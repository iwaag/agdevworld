// Simple and Detail (workflow_editor p8/ex1) in the browser, on the
// representative states of checks/states.ts: a private project, registry,
// area, presentation host and service. It asserts the preference and its
// toggle, what Simple leaves out and Detail keeps, the contextual entries,
// the graph across a switch (selection, place, alignment, Compact/Mini kept)
// and that a switch keeps the person's work and reading context. It never
// touches another registry or workspace.
//
//   npm run build && node checks/displayMode.ts [--port 8214]
//
// Synthetic composition (CDP) is not the native macOS IME.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8214')

const root = await mkdtemp(join(tmpdir(), 'wfe-display-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { buildStates } = await import('./states.ts')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<boolean> {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(40) }
  return false
}

// Every connection starts at its source card's right edge and ends at its
// target's left edge; every report icon sits inside its card.
async function aligned(page: Page): Promise<{ edges: number; ok: number; icons: boolean }> {
  return page.evaluate(() => {
    const surf = (el: HTMLElement) => { let x = 0, y = 0, e: HTMLElement | null = el; while (e && !e.classList.contains('surface')) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent as HTMLElement | null } return { x, y, w: el.offsetWidth, h: el.offsetHeight } }
    const res = [...document.querySelectorAll<SVGGElement>('.edge')].map(g => {
      const nums = g.querySelector('.line')!.getAttribute('d')!.match(/-?[\d.]+/g)!.map(Number)
      const [sx, sy] = nums, [ex, ey] = nums.slice(-2)
      const a = surf(document.querySelector<HTMLElement>(`.node[data-id="${g.dataset.from}"]`)!), b = surf(document.querySelector<HTMLElement>(`.node[data-id="${g.dataset.to}"]`)!)
      return Math.abs(sx - (a.x + a.w)) < 1.5 && Math.abs(sy - (a.y + a.h / 2)) < 1.5 && Math.abs(ex - (b.x - 2)) < 1.5 && Math.abs(ey - (b.y + b.h / 2)) < 1.5
    })
    const icons = [...document.querySelectorAll<HTMLElement>('.report-icon')].every(i => {
      const c = document.querySelector<HTMLElement>(`.node[data-id="${i.dataset.for}"]`)!.getBoundingClientRect(), r = i.getBoundingClientRect()
      return r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5
    })
    return { edges: res.length, ok: res.filter(Boolean).length, icons }
  })
}
const mode = (page: Page) => page.evaluate(() => document.documentElement.dataset.display)
const pressed = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.display-toggle button')].map(b => `${b.dataset.display}:${b.getAttribute('aria-pressed')}`).join(','))
const toggle = (page: Page, d: 'simple' | 'detail') => page.locator(`.display-toggle button[data-display="${d}"]`).click()
// Inside the canvas's visible rectangle.
const inCanvas = (page: Page, sel: string) => page.evaluate(s => { const c = document.querySelector('.canvas')!.getBoundingClientRect(), r = document.querySelector(s)!.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom }, sel)

const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
let states: Awaited<ReturnType<typeof buildStates>> | undefined
let browser: Browser | undefined
try {
  states = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18820, 18829] })
  const S = states
  await service.start()
  const BASE = service.base
  const opened = await open(1440, 1000, { display: null })
  browser = opened.browser
  const { page, errors } = opened
  const runUrl = (k: string, extra = '') => `${BASE}/#/ws/sample/run/${S.runs[k].workflow}/${S.runs[k].run}${extra}`
  const gotoRun = async (k: string, extra = '') => { await page.goto(runUrl(k, extra)); await page.waitForSelector('.run-summary[data-seq], .banner.error'); await sleep(400) }
  const gotoWf = async (f: string) => { await page.goto(`${BASE}/#/ws/sample/wf/${f}`); await page.waitForSelector('.node'); await sleep(400) }

  const bodyText = () => page.evaluate(() => document.body.innerText)
  const kind = () => page.evaluate(() => (document.querySelector('.focus') as HTMLElement | null)?.dataset.kind ?? '')

  // ==== the preference and its toggle ======================================================
  console.log('preference: default, toggle, memory')
  await page.goto(`${BASE}/#/`)
  await page.waitForSelector('.display-toggle')
  check(await mode(page) === 'simple' && await pressed(page) === 'simple:true,detail:false', 'fresh storage starts in Simple; the toggle says so (aria-pressed)')
  check(await page.getByRole('group', { name: 'Display' }).isVisible(), 'the toggle is a labelled group')
  const hashBefore = await page.evaluate(() => location.hash)
  await toggle(page, 'detail')
  check(await mode(page) === 'detail' && await pressed(page) === 'simple:false,detail:true' && await page.evaluate(() => location.hash) === hashBefore, 'one click switches; nothing navigates')
  await page.reload(); await page.waitForSelector('.display-toggle')
  check(await mode(page) === 'detail', 'the choice survives a reload')
  await page.goto(`${BASE}/#/ws/sample`); await page.waitForSelector('.display-toggle')
  check(await mode(page) === 'detail' && await pressed(page) === 'simple:false,detail:true', 'and navigation to another screen')
  await page.evaluate(() => localStorage.setItem('workflow-editor.display', 'banana'))
  await page.reload(); await page.waitForSelector('.display-toggle')
  check(await mode(page) === 'simple', 'a malformed stored value reads as Simple')
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await ctx.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('blocked') }; Storage.prototype.setItem = () => { throw new Error('blocked') } })
    const p2 = await ctx.newPage()
    const errs: string[] = []
    p2.on('pageerror', e => errs.push(String(e)))
    await p2.goto(`${BASE}/#/ws/sample`); await p2.waitForSelector('.display-toggle')
    const m1 = await mode(p2)
    await toggle(p2, 'detail')
    check(m1 === 'simple' && await mode(p2) === 'detail' && !errs.length, `storage that throws: Simple, and the toggle still works for the page (${errs.join('; ')})`)
    await ctx.close()
  }
  await page.locator('.display-toggle button[data-display="simple"]').focus()
  await page.keyboard.press('Tab')
  const tabbed = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.display)
  await page.keyboard.press('Space')
  check(tabbed === 'detail' && await mode(page) === 'detail' && await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.display) === 'detail', 'keyboard: Tab reaches Detail, Space switches, the focus stays on the toggle')
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter')
  check(await mode(page) === 'simple', 'keyboard: Shift+Tab and Enter switch back')
  for (const [what, url] of [['Dashboard', '/'], ['Project', '/ws/sample'], ['Workflow', '/ws/sample/wf/improve.yaml'], ['Run', `/ws/sample/run/improve/run-completed`], ['User nodes', '/nodes']] as const) {
    await page.goto(`${BASE}/#${url}`); await page.waitForSelector('.display-toggle'); await sleep(200)
    const last = await page.evaluate(() => { const t = document.querySelector('.top-actions')!; const kids = [...t.children].filter(c => (c as HTMLElement).offsetParent !== null); return kids.at(-1)?.classList.contains('display-toggle') })
    check(await page.locator('.display-toggle').count() === 1 && last, `${what}: the same toggle, the last item of the top bar`)
  }

  // ==== what Simple leaves out, and Detail keeps ============================================
  console.log('contract: Simple leaves out, Detail keeps')
  await page.goto(`${BASE}/#/ws/sample`); await page.waitForSelector('.project-hero'); await sleep(500)
  let t = await bodyText()
  check(!/\b[0-9a-f]{7}\b/.test(t) && !/uncommitted|unpublished|origin|⑂|Repositories and local areas|devdocs\/|braindump ·/.test(t), 'Project, Simple: no commit ids, Git state, remotes or paths')
  check(/Sample app/.test(await page.locator('.project-hero h1').innerText()) && /synthetic project/.test(t) && await page.getByRole('button', { name: 'Request run' }).isVisible() && /Recent runs/.test(t) && await page.locator('.workflows .wf-row').first().isVisible(), 'Project, Simple: name, purpose, the request form, recent runs, workflows')
  check(await page.locator('.runs-card .run-row:visible').count() === 5 && /All runs \(14\)/.test(t), 'five recent runs, and an entry to all of them')
  await toggle(page, 'detail'); await sleep(200)
  t = await bodyText()
  check(/Repositories and local areas/.test(t) && /# [0-9a-f]{7}/.test(t) && /uncommitted/.test(t) && await page.locator('.runs-card .run-row:visible').count() === 14, 'Project, Detail: repositories with commits and Git state, every run')
  await toggle(page, 'simple')
  await gotoRun('completed')
  t = await bodyText()
  check(!/improve\/run-completed|\d{1,2}:\d{2}:\d{2}|check-harness|Recorded outcomes|History \(|Execution and publication|Fixed snapshot/.test(t), 'completed run, Simple: no reference path, exact times, backend, outcome list or record sections')
  check(/Night mode for the settings page/.test(await page.locator('.run-name').innerText()) && /Completed and accepted/.test(t) && await page.getByRole('link', { name: 'Read final report' }).isVisible(), 'completed run, Simple: the result\'s title, the outcome and the report action')
  await toggle(page, 'detail'); await sleep(200)
  t = await bodyText()
  check(/improve\/run-completed/.test(t) && /Recorded outcomes/.test(t) && /History \(\d+\)/.test(t) && /Execution and publication/.test(t), 'completed run, Detail: the reference, the outcome list and every record section')
  await toggle(page, 'simple')
  await gotoRun('working', `/at/${S.commit}`)
  t = await bodyText()
  check(!new RegExp(S.commit.slice(0, 7)).test(t) && /A past state of this run/.test(t) && await page.locator('.focus textarea, .focus button:has-text("Stop")').count() === 0 && await page.locator('.actor-row').isHidden(), 'historical, Simple: explicit, no commit id, no live controls')

  console.log('contract: contextual entries reveal their target in Detail')
  await page.goto(`${BASE}/#/ws/sample`); await page.waitForSelector('.project-hero')
  await page.getByRole('button', { name: 'Project settings' }).click(); await sleep(250)
  check(await mode(page) === 'detail' && await page.locator('.project-meta').isVisible() && await page.evaluate(() => !!document.activeElement?.closest('.project-meta')), '"Project settings": Detail, the project form, the keyboard in it')
  await toggle(page, 'simple')
  await page.goto(`${BASE}/#/`); await page.waitForSelector('.dash-simple')
  await page.getByRole('button', { name: 'New project' }).click(); await sleep(250)
  check(await mode(page) === 'detail' && await page.getByLabel('Project id').evaluate(e => e === document.activeElement), '"New project": Detail, the creation form');
  await toggle(page, 'simple')
  await gotoWf('improve.yaml')
  await page.locator('.simple-approval').click(); await sleep(250)
  check(await mode(page) === 'detail' && await page.locator('#intent-panel').isVisible() && await page.getByRole('button', { name: 'Approve intent' }).isVisible(), 'the approval state: Detail, Intent & approvals open')
  await page.locator('.panel-toggle', { hasText: 'Intent & approvals' }).click()
  await toggle(page, 'simple')
  await gotoRun('completed')
  await page.locator('.focus-link', { hasText: 'Reports & files' }).click(); await sleep(250)
  check(await mode(page) === 'detail' && await page.locator('.side-sec[data-section="files"] .sec-content').isVisible(), '"Reports & files": Detail, the files section open')
  await toggle(page, 'simple')
  await page.locator('.focus-link', { hasText: 'All records' }).click(); await sleep(250)
  check(await mode(page) === 'detail' && await page.evaluate(() => document.activeElement?.classList.contains('sec-toggle')), '"All records": Detail, the keyboard on the first record section')
  await toggle(page, 'simple')
  await page.goto(`${BASE}/#/nodes`); await page.waitForSelector('.node-list')
  await page.getByRole('button', { name: '+ New template' }).click(); await sleep(250)
  check(await mode(page) === 'detail' && await page.getByLabel('Template id').isVisible(), '"+ New template": Detail, the template form')
  await toggle(page, 'simple')

  // ==== run states in Simple (step 4) ======================================================
  console.log('run states in Simple')
  await gotoRun('plan')
  check(await kind() === 'question' && await page.getByLabel('Answer to q1').isVisible() && await page.getByLabel('Your name').isVisible(), 'open question: the question, its one form and the name it records under')
  await gotoRun('answered')
  check(await kind() === 'answered' && /has not taken it up yet/.test(await page.locator('.focus-lead').innerText()) && await page.getByLabel('Answer to q1').count() === 0 && /Answered/.test(await page.locator('[data-step="_plan"] .run-status').innerText()), 'answer awaiting take-up: the receipt and who moves next, not offered as unanswered')
  await gotoRun('review')
  check(await kind() === 'review' && await page.locator('.review-link a.button.primary').isVisible() && await page.getByLabel('Answer to q2').isVisible(), 'live review: the review link and the answer form')
  await gotoRun('held')
  check(await kind() === 'held' && /tests touch the shared database/.test(await page.locator('.focus-lead').innerText()) && await page.getByLabel('Resume instruction').isVisible() && await page.getByRole('button', { name: 'Resume' }).isVisible(), 'held: the reason, and Resume with its instruction')
  await gotoRun('failed')
  check(await kind() === 'failed' && /3 of 31 tests fail/.test(await page.locator('.focus').innerText()) && await page.getByRole('button', { name: 'Adjust future work' }).isVisible() && await page.getByRole('button', { name: 'Cancel run' }).isVisible(), 'failed: the reason and the supported recovery')
  await gotoRun('accepted')
  check(await kind() === 'accepted' && /Accepted · cleanup pending/.test(await page.locator('.run-facts-row').innerText()) && /In progress/.test(await page.locator('.run-facts-row').innerText()) && await page.getByRole('button', { name: 'Stop' }).isVisible(), 'accepted while cleaning up: acceptance and unfinished cleanup apart; Stop reachable')
  await gotoRun('nodecision')
  check(await kind() === 'completed' && /No decision/.test(await page.locator('.run-facts-row').innerText()) && await page.getByRole('button', { name: 'Accept result' }).isVisible() && await page.getByLabel('Decision evidence').isVisible(), 'completed without a decision: completion apart from the decision, which is offered')
  await gotoRun('cancelled')
  check(await kind() === 'cancelled' && /Cancelled/.test(await page.locator('.run-facts-row').innerText()) && await page.getByRole('button', { name: 'Stop p1' }).isVisible(), 'cancelled: explicit, with the still-recorded presentation\'s stop')
  await gotoRun('branch')
  check(/2 questions wait/.test(await page.locator('.focus-head').innerText()) && await page.getByLabel('Answer to q2').isVisible() && await page.getByLabel('Answer to q3').isVisible(), 'two open questions: both listed, each with its form')
  await gotoRun('broken')
  check(await page.locator('.banner.error').first().isVisible() && await page.locator('.run-side').isHidden(), 'an unusable record: the error, no empty pane')

  console.log('working: what this host observes')
  const execUrl = `**/api/workspaces/sample/runs/${S.runs.working.workflow}/${S.runs.working.run}/exec`
  await page.route(execUrl, route => route.fulfill({ json: { attempts: [{ id: 'at-0002', state: 'running', began: new Date().toISOString(), ended: null, exit_code: null, signal: null, outcome: null, backend: 'check-harness', pid: 4242, alive: true, stop_requested: null, log: null }], jobs: [], checkpoints: [], executor: { state: 'available', at: new Date().toISOString() } } }))
  await gotoRun('working')
  await waitFor(async () => /working on this host/.test(await page.locator('.observation').innerText()))
  check(await kind() === 'working' && /working on this host/.test(await page.locator('.observation').innerText()) && /Running the headless tests/.test(await page.locator('.active-list').innerText()) && /Nothing is needed/.test(await page.locator('.focus-lead').innerText()), 'working: the step, its latest note and a live executor')
  await page.unroute(execUrl)
  await page.route(execUrl, route => route.fulfill({ status: 500, json: { error: 'injected' } }))
  await gotoRun('working')
  await waitFor(async () => /cannot be read/.test(await page.locator('.observation').innerText()))
  check(/cannot be read/.test(await page.locator('.observation').innerText()) && /does not see the work running/.test(await page.locator('.focus-lead').innerText()), 'missing executor facts never read as healthy progress')
  await page.unroute(execUrl)
  await gotoRun('working')
  const beforeOutage = errors.length
  await service.stop()
  const lost = await waitFor(async () => /not live/.test(await page.locator('.live-state').innerText()) && /Not connected/.test(await page.locator('.banners').innerText()), 10_000)
  check(lost && /Not connected/.test(await page.locator('.observation').innerText().catch(() => '')), 'disconnected: the header, a banner with its icon, and the observation say so')
  await service.start()
  check(await waitFor(async () => !/not live/.test(await page.locator('.live-state').innerText()), 12_000), 'it reconnects by itself')
  errors.splice(beforeOutage, errors.length - beforeOutage, ...errors.slice(beforeOutage).filter(e => !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|Failed to fetch/.test(e)))

  // ==== switching keeps the person's work (step 5) ==========================================
  const listeners = () => page.evaluate(() => (window as unknown as { __wfeDisplay: { listeners(): number } }).__wfeDisplay.listeners())
  const dialogs: string[] = []
  page.on('dialog', d => dialogs.push(d.message()))

  console.log('continuity: the workflow editor')
  await page.goto(`${BASE}/#/`); await page.evaluate(() => { localStorage.setItem('workflow-editor.display', 'simple'); localStorage.removeItem('workflow-editor.mode'); localStorage.setItem('workflow-editor.actor', 'Sample Person') })
  await gotoWf('improve.yaml')
  await page.getByLabel('Workflow name').fill('Improve the sample app (draft)')
  await page.locator('.node[data-id="implement"]').click()
  await page.getByLabel('Node description').fill('Implementation draft')
  await toggle(page, 'detail')
  await page.locator('.panel-toggle', { hasText: 'Intent & approvals' }).click()
  await page.getByLabel('Workflow intent').fill('An intent draft.')
  await page.getByLabel('Approver').fill('Draft Approver')
  await toggle(page, 'simple'); await toggle(page, 'detail')
  check(await page.locator('#intent-panel').isVisible() && await page.getByLabel('Workflow intent').inputValue() === 'An intent draft.' && await page.getByLabel('Approver').inputValue() === 'Draft Approver', 'Detail\'s open panel, the intent draft and the approver survive Simple and back')
  check(await page.getByLabel('Workflow name').inputValue() === 'Improve the sample app (draft)' && await page.getByLabel('Node description').inputValue() === 'Implementation draft' && await page.locator('.node[data-id="implement"].selected').count() === 1, 'the name, the node draft and the selection too')
  await toggle(page, 'simple')
  check(await page.locator('.save-state').innerText() === 'Unsaved changes', 'Simple says the draft is unsaved')
  dialogs.length = 0
  await page.locator('.crumbs a', { hasText: 'Projects' }).click(); await sleep(300)
  check(dialogs.some(m => /Discard unsaved changes/.test(m)), 'leaving with the draft asks first, in Simple too')
  check(await listeners() === 0, `the dashboard has no display listener left over (${await listeners()})`)

  console.log('continuity: the project')
  await page.goto(`${BASE}/#/ws/sample`); await page.waitForSelector('.project-hero')
  await page.getByLabel('Request text').fill('A request drafted in Simple')
  await toggle(page, 'detail')
  await page.locator('.project-meta input').nth(1).fill('Sample app (renamed draft)')
  await toggle(page, 'simple'); await sleep(100)
  check(await page.getByLabel('Request text').inputValue() === 'A request drafted in Simple', 'the request draft is the same field in both modes')
  check(/Unsaved changes in Project settings/.test(await page.locator('.project-hero').innerText()), 'Simple\'s hero says Project settings hold unsaved changes')
  await toggle(page, 'detail')
  check(await page.locator('.project-meta input').nth(1).inputValue() === 'Sample app (renamed draft)' && await page.locator('.project-meta .save-row button.primary').isEnabled(), 'the settings draft is still there to save')
  await page.evaluate(() => window.scrollTo(0, 600)); await sleep(50)
  const y = await page.evaluate(() => window.scrollY)
  await toggle(page, 'simple'); await toggle(page, 'detail'); await sleep(50)
  check(Math.abs(await page.evaluate(() => window.scrollY) - y) < 2, `Detail's scroll position is restored on return (${y})`)
  await toggle(page, 'simple')
  await page.goto(`${BASE}/#/`) // leaves the drafts

  console.log('continuity: run drafts, preview and reading place')
  await gotoRun('held')
  await page.getByLabel('Resume instruction').fill('Look at the database first.')
  await toggle(page, 'detail'); await toggle(page, 'simple')
  check(await page.getByLabel('Resume instruction').inputValue() === 'Look at the database first.', 'the resume instruction survives')
  await page.getByLabel('Resume instruction').fill('')
  await gotoRun('nodecision')
  await page.getByLabel('Decision evidence').fill('I read every changed page.')
  await toggle(page, 'detail'); await toggle(page, 'simple')
  check(await page.getByLabel('Decision evidence').inputValue() === 'I read every changed page.', 'the decision evidence survives')
  await page.getByLabel('Decision evidence').fill('')
  await gotoRun('failed')
  await page.getByRole('button', { name: 'Adjust future work' }).click(); await sleep(200)
  check(await mode(page) === 'detail' && await page.getByLabel('Adjusted definition').evaluate(e => e === document.activeElement), '"Adjust future work" from Simple: Detail, the adjustment form focused')
  const yaml = await page.getByLabel('Adjusted definition').inputValue()
  // One more pending step after Clean up, written as the snapshot is.
  const adjusted = yaml.replace('\nedges:', '\n  extra: {type: do, name: Extra check, description: Check once more., repositories: [app]}\nedges:')
    .replace('  - {from: check, to: cleanup}\n', '  - {from: check, to: cleanup}\n  - {from: cleanup, to: extra}\n')
  await page.getByLabel('Adjusted definition').fill(adjusted)
  await page.getByLabel('Adjustment reason').fill('Say it is the fixed result')
  await page.getByRole('button', { name: 'Preview' }).click()
  await waitFor(async () => (await page.locator('.adjust-preview').count()) > 0)
  check(await page.getByRole('button', { name: 'Apply' }).isEnabled(), `a preview of exactly this input enables Apply (${await page.locator('.adjust-preview').innerText().catch(() => '')})`)
  // A composition defers the switch until it ends, and the text stays.
  await page.getByLabel('Adjustment reason').focus()
  await page.getByLabel('Adjustment reason').dispatchEvent('compositionstart')
  await page.evaluate(() => (document.querySelector('.display-toggle button[data-display="simple"]') as HTMLElement).click())
  const during = await mode(page)
  await page.getByLabel('Adjustment reason').dispatchEvent('compositionend')
  await sleep(50)
  check(during === 'detail' && await mode(page) === 'simple', 'a switch asked during a (synthetic) composition waits for it to end')
  check(await page.evaluate(() => document.activeElement?.closest('.display-toggle') !== null), 'a focused control that Simple hides gives the keyboard to the toggle')
  await toggle(page, 'detail'); await sleep(100)
  check(await page.getByLabel('Adjustment reason').inputValue() === 'Say it is the fixed result' && await page.getByLabel('Adjusted definition').inputValue() === adjusted && await page.locator('.side-sec[data-section="definition"] .sec-content').isVisible(), 'the adjustment, its reason and the open section survive')
  check(await page.getByRole('button', { name: 'Apply' }).isEnabled() && await page.locator('.adjust-preview.stale').count() === 0, 'the preview still matches its exact input: Apply stays as it was')
  await S.op(S.runs.failed, { op: 'artifact.attach', path: 'devdocs/stale-pages.md', title: 'A background record' })
  await waitFor(async () => (await page.locator('.adjust-preview.stale').count()) > 0)
  check(await page.getByRole('button', { name: 'Apply' }).isDisabled(), 'the run moving on still invalidates it (the switch restored nothing)')
  await page.getByLabel('Adjusted definition').fill(yaml); await page.getByLabel('Adjustment reason').fill('')
  await toggle(page, 'simple')

  console.log('continuity: Detail sections, the side pane\'s place, the open file')
  const runDir = join(S.dir, 'devdocs', 'runs', S.runs.completed.workflow, S.runs.completed.run)
  await writeFile(join(runDir, 'notes-long.md'), Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'x'.repeat(i % 7 === 0 ? 180 : 20)}`).join('\n'))
  await gotoRun('completed')
  await toggle(page, 'detail')
  for (const k of ['history', 'execution', 'files']) { const sec = page.locator(`.side-sec[data-section="${k}"]`); if (await sec.locator('.sec-content').isHidden()) await sec.locator('.sec-toggle').click() }
  await page.locator('.side-sec[data-section="files"] .file-link', { hasText: 'notes-long.md' }).click()
  await page.waitForSelector('.file-view pre'); await waitFor(async () => /line 300/.test(await page.locator('.file-view pre').innerText()))
  await page.evaluate(() => { const p = document.querySelector('.file-view pre')!; p.scrollTop = 400; p.scrollLeft = 60 })
  await page.evaluate(() => { const p = document.querySelector('.run-side') as HTMLElement; p.scrollTop = 500 })
  const side = await page.evaluate(() => (document.querySelector('.run-side') as HTMLElement).scrollTop)
  const pre = await page.evaluate(() => { const p = document.querySelector('.file-view pre')!; return [p.scrollTop, p.scrollLeft] })
  await toggle(page, 'simple'); await sleep(100)
  check(await page.locator('.file-card').isVisible() && await page.evaluate(() => document.querySelector('.file-view pre')!.scrollTop) === pre[0], 'Simple shows the open file at the same offset')
  await toggle(page, 'detail'); await sleep(100)
  const open3 = await page.evaluate(() => ['history', 'execution', 'files'].every(k => !(document.querySelector(`.side-sec[data-section="${k}"] .sec-content`) as HTMLElement).hidden))
  const back = await page.evaluate(() => (document.querySelector('.run-side') as HTMLElement).scrollTop)
  const pre2 = await page.evaluate(() => { const p = document.querySelector('.file-view pre')!; return [p.scrollTop, p.scrollLeft] })
  check(open3, 'Detail\'s open sections are open again')
  check(Math.abs(back - side) < 2 && side > 0, `the side pane's reading position is restored (${side} → ${back})`)
  check(pre2[0] === pre[0] && pre2[1] === pre[1], `the file keeps its offsets (${pre} → ${pre2})`)
  await toggle(page, 'simple')

  console.log('continuity: background updates and question resolution while switching')
  await gotoRun('branch')
  await page.getByLabel('Answer to q2').fill('No account needed.')
  await page.getByLabel('Answer to q3').fill('Yes, the staging database is fine.')
  const seq0 = Number(await page.locator('.run-summary').getAttribute('data-seq'))
  await S.op(S.runs.branch, { op: 'node.progress', node: 'build', text: 'Halfway through the prototype.' })
  await toggle(page, 'detail')
  await waitFor(async () => Number(await page.locator('.run-summary').getAttribute('data-seq')) > seq0)
  await toggle(page, 'simple')
  check(await page.getByLabel('Answer to q2').inputValue() === 'No account needed.' && await page.getByLabel('Answer to q3').inputValue() === 'Yes, the staging database is fine.', 'two answer drafts survive a background update between switches')
  await S.op(S.runs.branch, { op: 'question.withdraw', question: 'q2', reason: 'answered elsewhere' })
  await waitFor(async () => /withdrawn/.test(await page.locator('.focus').innerText()))
  await toggle(page, 'detail'); await toggle(page, 'simple')
  check(await page.getByLabel('Answer to q2').inputValue() === 'No account needed.' && await page.getByLabel('Answer to q2').evaluate(e => (e as HTMLTextAreaElement).readOnly), 'a withdrawn question keeps its draft, read-only, through switches')
  await page.getByLabel('Answer to q3').locator('xpath=..').getByRole('button', { name: 'Record answer' }).click()
  await waitFor(async () => (await page.getByLabel('Answer to q3').inputValue()) === '')
  const rec = JSON.parse(await (await import('node:fs/promises')).readFile(join(S.dir, 'devdocs', 'runs', S.runs.branch.workflow, S.runs.branch.run, 'run.json'), 'utf8')) as { questions: Record<string, { answers: unknown[] }> }
  check(rec.questions.q3.answers.length === 1 && rec.questions.q2.answers.length === 0, `one answer recorded once (q3 ${rec.questions.q3.answers.length}, q2 ${rec.questions.q2.answers.length})`)

  console.log('continuity: listeners follow the views')
  for (const k of ['completed', 'review', 'working']) await gotoRun(k)
  await gotoWf('explore.yaml')
  await gotoRun('completed')
  check(await listeners() === 1, `after five views, one display listener (${await listeners()})`)

  // ==== the graph across a switch (step 3) =================================================
  console.log('graph: selection, place and Compact/Mini across a switch')
  await page.goto(`${BASE}/#/`)
  await page.evaluate(() => { localStorage.setItem('workflow-editor.display', 'detail'); localStorage.setItem('workflow-editor.mode', 'mini') })
  await gotoWf('improve.yaml')
  check(await page.locator('.mode-switch button.active').innerText() === 'Mini', 'Detail opens in the stored Mini mode')
  await page.locator('.node[data-id="verify"]').click()
  await page.getByLabel('Node description').fill('A draft made in Detail')
  const zoomBefore = await page.locator('.zoom-level').innerText()
  await toggle(page, 'simple')
  await sleep(250)
  check(await mode(page) === 'simple' && await page.locator('.node[data-id="verify"].selected').count() === 1, 'Simple keeps the selected card')
  check(await page.getByLabel('Node description').inputValue() === 'A draft made in Detail' && await page.getByLabel('Node description').isVisible(), 'the selection shows its name and description, with the draft')
  check(await page.getByLabel('Node type').isHidden() && await page.locator('.insp-group[data-group="appearance"]').isHidden() && await page.getByRole('button', { name: 'Delete node' }).isHidden(), 'type, appearance and Delete are Detail\'s')
  check(await page.locator('.inspector .insp-more button').isVisible(), 'the selection offers "More details"')
  check(await page.locator('.zoom-level').innerText() === zoomBefore, `no Fit or reframing on the switch (${zoomBefore})`)
  check(await inCanvas(page, '.node[data-id="verify"]'), 'the selected card is in view after the switch')
  check(await page.locator('.mode-switch').isHidden() && await page.locator('.node[data-id="verify"] .type-label').count() === 0 && await page.locator('.node .node-desc').count() === 0, 'Simple cards: no type label or description; Compact/Mini is not offered')
  check(await page.locator('.node[data-id="verify"]').getAttribute('aria-label') === 'Do node Verify', 'the type stays in the card\'s accessible name')
  let a = await aligned(page)
  check(a.ok === a.edges && a.edges === 4 && a.icons, `Simple: connections attached (${a.ok}/${a.edges}) and report icons in their cards`)
  await page.locator('.inspector .insp-more button').click()
  await sleep(150)
  check(await mode(page) === 'detail' && await page.getByLabel('Node type').isVisible(), '"More details" is the same inspector in Detail')
  check(await page.evaluate(() => document.activeElement?.closest('.insp-head') !== null), 'the keyboard is on the inspector\'s heading')
  check(await page.locator('.mode-switch button.active').innerText() === 'Mini' && await page.evaluate(() => localStorage.getItem('workflow-editor.mode')) === 'mini', 'back in Detail, Mini is still the graph setting (its key untouched)')
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, `Detail (Mini): connections attached (${a.ok}/${a.edges})`)

  console.log('graph: editing in Simple')
  await toggle(page, 'simple')
  await sleep(200)
  await page.keyboard.press('Escape')
  const box = (await page.locator('.node[data-id="present"]').boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 110, { steps: 6 }); await page.mouse.up()
  await sleep(200)
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, 'dragging a Simple card carries its connections and report icon')
  check(await page.locator('.save-state').innerText() === 'Unsaved changes', 'the move is a draft change, saved only by Save')
  const imp = (await page.locator('.node[data-id="implement"] .port').boundingBox())!, chk = (await page.locator('.node[data-id="check"]').boundingBox())!
  await page.locator('.node[data-id="implement"]').hover()
  await page.mouse.move(imp.x + 8, imp.y + 8); await page.mouse.down(); await page.mouse.move(chk.x + 30, chk.y + 30, { steps: 8 }); await page.mouse.up()
  await sleep(200)
  check(await page.locator('.edge.selected').count() === 1 && /Connection/.test(await page.locator('.inspector .insp-head h3').innerText()), 'connecting in Simple selects the new connection')
  check(await page.locator('.inspector .insp-more button').isVisible() && await page.getByRole('button', { name: 'Delete connection' }).isHidden(), 'a connection: its ends, and "More details" for its controls')
  await page.locator('[data-step="_report.verify"]').click()
  await sleep(150)
  check(/Report on Verify/.test(await page.locator('.inspector .insp-head h3').innerText()) && await page.locator('.inspector .insp-more button').isVisible() && await page.locator('.inspector dl.kv').isHidden(), 'a report step stays selectable and inspectable, its waits and instructions in Detail')
  a = await aligned(page)
  check(a.ok === a.edges && a.edges === 5 && a.icons, `after the edits: ${a.ok}/${a.edges} connections attached`)
  await page.goto(`${BASE}/#/`) // leaves the draft (the guard is accepted)

  console.log('graph: branch and join, a run')
  await gotoWf('explore.yaml')
  a = await aligned(page)
  check(a.ok === a.edges && a.edges === 4 && a.icons, `branch and join in Simple: ${a.ok}/${a.edges} attached`)
  await gotoRun('completed')
  check(await page.locator('.run-side').isHidden(), 'a completed, decided run in Simple: the graph has the width (no side pane)')
  await page.locator('.node[data-id="present"]').click()
  await sleep(250)
  check(await page.locator('.run-side').isVisible() && /Presented p1/.test(await page.locator('.side-card .outcome').innerText()), 'selecting a step shows its recorded outcome')
  check(await inCanvas(page, '.node[data-id="present"]'), 'the selected card is in view beside the pane')
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, `run graph in Simple: ${a.ok}/${a.edges} attached`)
  await page.locator('.side-card .insp-more button').click()
  await sleep(200)
  check(await mode(page) === 'detail' && await page.locator('.side-card dl.kv').isVisible() && await page.locator('.node[data-id="present"].selected').count() === 1, '"More details" shows the same node\'s full record in Detail')
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, `run graph in Detail: ${a.ok}/${a.edges} attached`)
  await shot(page, 'p8ex1-run-detail-selected', false)

  check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, `no page errors (${errors.join('; ')})`)
} finally {
  await browser?.close()
  await states?.stop()
  await service.stop()
  await rm(root, { recursive: true, force: true })
}
done()
