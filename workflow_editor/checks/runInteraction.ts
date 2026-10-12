// Input and reading state in the run view across background updates
// (workflow_editor p7/ex2). Builds a private project, registry and service
// with the same server modules as checks/runs.ts, records run operations
// through them, and drives Chromium: an answer being composed with the IME
// keeps its control while SSE progress arrives, nested scrolling survives,
// a heartbeat-only change touches nothing, and the history entry being read
// keeps its place when newer entries are inserted above it. It never touches
// another registry or workspace.
//
//   npm run build && node checks/runInteraction.ts [--port 8202] [--keep]
//
// Synthetic composition (CDP Input.imeSetComposition) is not the macOS
// Japanese IME; native validation is a separate, manual step.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession } from 'playwright-core'
import type { OpInput, RunRef } from '../shared/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, '..', '..', '.local', 'wfe-checks')
process.env.WFE_FIXTURE = OUT_DIR // lib.ts puts screenshots beneath it
const args = process.argv.slice(2)
const option = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const PORT = Number(option('--port', '8202'))

const root = await mkdtemp(join(tmpdir(), 'wfe-interaction-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { createRun, runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

// ---- data ----------------------------------------------------------------------------

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: ship
intent: |
  Interaction check workflow.
repositories:
  docs: {path: devdocs, access: editable}
nodes:
  survey: {type: study, name: survey, description: Survey., repositories: [docs]}
  build: {type: do, name: build, description: Build., repositories: [docs]}
  ask: {type: talk, name: ask, description: Ask., repositories: [docs]}
  join: {type: do, name: join, description: Join., repositories: [docs]}
edges:
  - {from: survey, to: build}
  - {from: survey, to: ask}
  - {from: build, to: join}
  - {from: ask, to: join}
`
const registry = join(root, 'registry.json')
const dir = join(root, 'pj-chk')
const created = await createProject({ dir, id: 'chk', name: 'Interaction check', intent: 'Checks.', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
if (!created.ok) throw new Error(created.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const runDirOf = (r: RunRef) => join(dir, 'devdocs', 'runs', r.workflow, r.run)
const op = async (r: RunRef, input: OpInput) => (await runOp(ws, r, input, { via: 'cli', by: 'Omni Agent' })).record
const executor = { name: 'Omni Agent', backend: 'check-harness' }

const R1 = (await createRun(ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Interaction check.', author: 'Check Person' }, executor, by: 'Omni Agent', via: 'cli' })).ref
await op(R1, { op: 'node.start', node: 'survey' })
await op(R1, { op: 'node.complete', node: 'survey', outcome: 'Surveyed.' })
await op(R1, { op: 'node.start', node: 'build' })
await op(R1, { op: 'node.start', node: 'ask' })
await op(R1, { op: 'question.ask', question: '', node: 'ask', text: 'Which map size?', to: 'Check Person' })
for (let i = 0; i < 40; i++) await op(R1, { op: 'node.progress', node: 'build', text: `history filler ${i + 1}` })
// A stop with no attempt open holds the run at once: the resume form shows.
await op(R1, { op: 'run.stop', reason: 'look before continuing' })
// A run at a node boundary (nothing running), where an adjustment applies.
const R2 = (await createRun(ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Adjustment check.', author: 'Check Person' }, executor, by: 'Omni Agent', via: 'cli' })).ref
await op(R2, { op: 'node.start', node: 'survey' })
await op(R2, { op: 'node.complete', node: 'survey', outcome: 'Surveyed.' })
// A long, wide file (unbreakable lines overflow even pre-wrap): both of its scroll offsets can move.
await writeFile(join(runDirOf(R1), 'long.md'), Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} ${'0123456789'.repeat(30)}`).join('\n') + '\n')

// ---- browser ---------------------------------------------------------------------------

const service = new PrivateService({ registry, area: root, port: PORT })
let browser: Browser | undefined
const result: Record<string, unknown> = { at: new Date().toISOString() }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<number | null> {
  const t = performance.now()
  while (performance.now() - t < ms) { if (await fn()) return performance.now() - t; await sleep(25) }
  return null
}

try {
  await service.start()
  const opened = await open(1440, 900)
  browser = opened.browser
  const { page, errors } = opened
  const BASE = service.base
  const seqShown = () => page.evaluate(() => Number((document.querySelector('.run-summary') as HTMLElement | null)?.dataset.seq ?? -1))
  const waitSeq = (n: number, ms = 6000) => waitFor(async () => (await seqShown()) >= n, ms)
  // One SSE-delivered run change, waited for until the view shows it.
  const progress = async (text: string) => { const s = (await op(R1, { op: 'node.progress', node: 'build', text })).seq; const ms = await waitSeq(s); await sleep(300); return ms }

  // Every value assignment to a tracked control is counted (a background
  // update must not write into a control the person owns).
  await page.addInitScript(() => {
    for (const proto of [HTMLTextAreaElement.prototype, HTMLInputElement.prototype]) {
      const d = Object.getOwnPropertyDescriptor(proto, 'value')!
      Object.defineProperty(proto, 'value', { ...d, set(v: string) { const t = this as HTMLElement & { __sets?: number }; if (t.dataset.tracked) t.__sets = (t.__sets ?? 0) + 1; d.set!.call(this, v) } })
    }
  })
  await page.goto(`${BASE}/#/ws/chk/run/${R1.workflow}/${R1.run}`)
  await page.waitForSelector('.run-summary[data-seq]')
  await page.getByLabel('Your name').fill('Check Person')

  // Marks the control and records its composition events; later reads ask
  // whether that same element is still connected and focused.
  const track = (selector: string) => page.evaluate(sel => {
    const el = document.querySelector(sel) as HTMLTextAreaElement
    el.dataset.tracked = '1'
    ;(window as unknown as { __tracked: HTMLTextAreaElement }).__tracked = el
    const log: string[] = []
    ;(window as unknown as { __comp: string[] }).__comp = log
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) el.addEventListener(t, e => log.push(`${t}:${(e as CompositionEvent).data}`))
    return true
  }, selector)
  const tracked = () => page.evaluate(() => {
    const el = (window as unknown as { __tracked: HTMLTextAreaElement & { __sets?: number } }).__tracked
    return { connected: el.isConnected, focused: document.activeElement === el, value: el.value, sets: el.__sets ?? 0, comp: (window as unknown as { __comp: string[] }).__comp.slice(), activeLabel: document.activeElement?.getAttribute('aria-label') ?? null }
  })

  // 1. A real SSE run-progress update while an answer is typed.
  console.log('answer across SSE progress')
  const answer = '.questions .question[data-question="q1"] textarea'
  await page.locator(answer).click()
  await page.keyboard.type('Small ')
  await track(answer)
  await progress('while typing')
  const t1 = await tracked()
  result.sseTyping = t1
  check(t1.connected && t1.focused && t1.value === 'Small ', `the answer textarea stays connected and focused across SSE progress: ${JSON.stringify(t1)}`)

  // 2. Synthetic IME composition across the same kind of update.
  console.log('composition across SSE progress')
  const cdp: CDPSession = await page.context().newCDPSession(page)
  await page.locator(answer).click()
  await page.keyboard.press('End')
  await track(answer)
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
  await progress('while composing')
  const mid = await tracked()
  await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 })
  await progress('while composing 2')
  await cdp.send('Input.insertText', { text: '日本語' })
  await page.keyboard.type(' map')
  const t2 = await tracked()
  result.composition = { mid, end: t2 }
  check(mid.connected && mid.focused, `the composing textarea stays connected and focused after an update: ${JSON.stringify(mid)}`)
  check(t2.connected && t2.focused && t2.value.endsWith('日本語 map') && t2.comp.includes('compositionend:日本語'), `composition completes in the same control and typing continues: ${JSON.stringify(t2)}`)

  // 3. A heartbeat-only change (executor.at) leaves the answer form untouched.
  console.log('heartbeat only')
  let beat = 0
  let hostMode: 'beat' | 'unavailable' | 'fail' = 'beat'
  await page.route(`**/api/workspaces/chk/runs/ship/${R1.run}/exec`, async route => {
    if (hostMode === 'fail') { await route.fulfill({ status: 500, json: { error: 'injected host failure' } }); return }
    const res = await route.fetch()
    const body = await res.json() as { executor: { state: string; detail?: string; at?: string } }
    body.executor = hostMode === 'beat'
      ? { state: 'available', detail: 'check-harness; idle', at: new Date(Date.UTC(2026, 9, 12, 0, 0, beat++)).toISOString() }
      : { state: 'unavailable', detail: 'check-harness last reported 50 s ago', at: new Date(Date.UTC(2026, 9, 12, 0, 0, beat++)).toISOString() }
    await route.fulfill({ response: res, json: body })
  })
  await sleep(4000) // the first intercepted read moves executor state to available
  await track(answer)
  await page.evaluate(() => {
    const form = document.querySelector('.questions .question[data-question="q1"] .answer-form')!
    const log: number[] = []
    ;(window as unknown as { __mut: number[] }).__mut = log
    new MutationObserver(ms => log.push(ms.length)).observe(form, { subtree: true, childList: true, attributes: true, characterData: true })
    // Anywhere in the pane: no element added, removed or re-attributed (relative
    // times may age in their own text nodes when the 30 s clock ticks).
    const pane: string[] = []
    ;(window as unknown as { __pane: string[] }).__pane = pane
    new MutationObserver(ms => { for (const m of ms) pane.push(`${m.type}:${(m.target as Element).className ?? m.target.nodeName}`) }).observe(document.querySelector('.run-side')!, { subtree: true, childList: true, attributes: true })
  })
  const beats0 = beat
  await sleep(7000)
  const t3 = await tracked()
  const mutations = await page.evaluate(() => (window as unknown as { __mut: number[] }).__mut.reduce((a, b) => a + b, 0))
  result.heartbeat = { reads: beat - beats0, mutations, tracked: t3 }
  const paneMutations = await page.evaluate(() => (window as unknown as { __pane: string[] }).__pane)
  check(beat - beats0 >= 2 && t3.connected && t3.sets === 0 && mutations === 0, `heartbeat-only reads (${beat - beats0}) leave the answer form untouched: connected ${t3.connected}, value writes ${t3.sets}, mutations ${mutations}`)
  check(paneMutations.length === 0, `and no element in the pane is added, removed or re-attributed: ${paneMutations.slice(0, 5).join(', ') || 'none'}`)

  // 3b. A meaningful host change shows within the cadence; a failing host
  // read is reported without touching drafts and is retried until it recovers.
  const execText = () => page.locator('.side-sec[data-section="execution"]').innerText()
  hostMode = 'unavailable'
  const unavailable = await waitFor(async () => /Executor: unavailable — check-harness last reported 50 s ago/.test(await execText()), 6000)
  check(unavailable !== null, `an executor that became unavailable is shown within ${Math.round(unavailable ?? -1)} ms`)
  await page.locator(answer).fill('kept through a host failure')
  hostMode = 'fail'
  const failing = await waitFor(async () => /could not be read: injected host failure/.test(await execText()), 6000)
  const duringFailure = { draft: await page.locator(answer).inputValue(), seq: await seqShown(), stillShowsFacts: /Executor: unavailable/.test(await execText()) }
  hostMode = 'beat'
  const recovered = await waitFor(async () => !/could not be read/.test(await execText()) && /Executor: available/.test(await execText()), 8000)
  check(failing !== null && duringFailure.draft === 'kept through a host failure' && duringFailure.seq > 0 && duringFailure.stillShowsFacts && recovered !== null,
    `a host read failure is reported beside the last facts, keeps the draft and the run, and clears on the next good read: ${JSON.stringify({ failing: failing !== null, ...duringFailure, recovered: recovered !== null })}`)
  await page.locator(answer).fill('')
  await page.unroute(`**/api/workspaces/chk/runs/ship/${R1.run}/exec`)

  // 4. File view offsets survive a run update.
  console.log('file scroll')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.locator('.run-side .file-link', { hasText: 'long.md' }).first().click()
  await page.waitForSelector('.file-view pre')
  await waitFor(async () => /line 300/.test(await page.locator('.file-view pre').innerText()))
  const set = await page.evaluate(() => { const pre = document.querySelector('.file-view pre')!; pre.scrollTop = 400; pre.scrollLeft = 80; return { top: pre.scrollTop, left: pre.scrollLeft, sw: pre.scrollWidth, cw: pre.clientWidth } })
  result.fileScrollSet = set
  await progress('while reading the file')
  const pre = await page.evaluate(() => { const p = document.querySelector('.file-view pre')!; return { top: p.scrollTop, left: p.scrollLeft } })
  result.fileScroll = pre
  check(pre.top === 400 && pre.left === 80, `file view keeps its scroll offsets: ${JSON.stringify(pre)}`)

  // 5. The history entry being read keeps its place when newer entries are
  // inserted above it.
  console.log('history anchor')
  await page.locator('.file-view button.icon-btn').click().catch(() => {})
  const pick = await page.evaluate(() => {
    const side = document.querySelector('.run-side') as HTMLElement
    side.scrollTop = side.scrollHeight
    const top = side.getBoundingClientRect().top
    const li = [...side.querySelectorAll('ol.history li')].find(x => x.getBoundingClientRect().top > top + 100) as HTMLLIElement
    ;(li as HTMLLIElement & { __anchor?: boolean }).__anchor = true // a property: patched attributes would not keep a mark
    return { seq: li.value, offset: li.getBoundingClientRect().top - top, scrollTop: side.scrollTop }
  })
  for (let i = 0; i < 3; i++) await op(R1, { op: 'node.progress', node: 'build', text: `newer ${i + 1}` })
  await progress('newer 4')
  const after = await page.evaluate(seq => {
    const side = document.querySelector('.run-side') as HTMLElement
    const li = [...side.querySelectorAll('ol.history li')].find(x => (x as HTMLLIElement).value === seq) as HTMLLIElement
    return { sameElement: (li as HTMLLIElement & { __anchor?: boolean }).__anchor === true, offset: li.getBoundingClientRect().top - side.getBoundingClientRect().top, scrollTop: side.scrollTop }
  }, pick.seq)
  result.history = { before: pick, after }
  check(after.sameElement && Math.abs(after.offset - pick.offset) <= 2, `the visible history entry (seq ${pick.seq}) keeps its element and position: ${JSON.stringify({ before: pick.offset, after: after.offset, same: after.sameElement })}`)
  await shot(page, 'p7ex2-run-interaction', false)

  // 7. The selected node shows its question as a summary; its link reaches
  // the one canonical answer form.
  console.log('canonical answer form')
  await page.locator('.side-sec[data-section="history"]').evaluate(el => el.closest('.run-side')!.scrollTop = 0)
  await page.locator('.node[data-id="ask"]').click()
  await page.waitForSelector('.node-detail[data-node="ask"]')
  const forms = await page.evaluate(() => ({ inDetail: document.querySelectorAll('.node-detail textarea').length, answerControls: document.querySelectorAll('[aria-label="Answer to q1"]').length }))
  await page.locator('.node-detail a[data-action="goto-question"][data-question="q1"]').click()
  const reached = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return { label: a?.getAttribute('aria-label'), inQuestions: !!a?.closest('.questions .question[data-question="q1"]') } })
  result.canonical = { forms, reached }
  check(forms.inDetail === 0 && forms.answerControls === 1 && reached.label === 'Answer to q1' && reached.inQuestions, `one answer form; the selected node's link focuses it under Questions: ${JSON.stringify({ forms, reached })}`)

  // 8. Submission: only the exact submitted, unchanged draft is cleared;
  // text typed while the request is in flight survives; a double click
  // records once; a failure keeps the text.
  console.log('submission ownership')
  const opsUrl = `**/api/workspaces/chk/runs/ship/${R1.run}/ops`
  await page.route(opsUrl, async route => { await sleep(1500); await route.continue() })
  const ans = page.locator(answer)
  await ans.fill('Medium')
  const button = page.locator('.questions .question[data-question="q1"] .answer-form button.primary')
  await button.click()
  await button.click({ force: true }).catch(() => {})
  await ans.press('End')
  await page.keyboard.type(' or large')
  const doubleDisabled = await button.isDisabled()
  await waitFor(async () => !(await button.isDisabled()), 8000)
  await sleep(500)
  let rec = JSON.parse(await (await import('node:fs/promises')).readFile(join(runDirOf(R1), 'run.json'), 'utf8')) as { questions: Record<string, { answers: { text: string }[] }> }
  const afterFlight = { value: await ans.inputValue(), answers: rec.questions.q1.answers.map(a => a.text), disabledDuringFlight: doubleDisabled }
  check(afterFlight.value === 'Medium or large' && afterFlight.answers.length === 1 && afterFlight.answers[0] === 'Medium' && doubleDisabled,
    `text typed during the request survives, the double click records once: ${JSON.stringify(afterFlight)}`)
  await button.click()
  await waitFor(async () => (await ans.inputValue()) === '', 8000)
  rec = JSON.parse(await (await import('node:fs/promises')).readFile(join(runDirOf(R1), 'run.json'), 'utf8'))
  check(await ans.inputValue() === '' && rec.questions.q1.answers.at(-1)?.text === 'Medium or large', 'an unchanged submitted draft is cleared once recorded')
  await page.unroute(opsUrl)
  await page.route(opsUrl, route => route.fulfill({ status: 500, json: { error: 'injected failure' } }))
  await ans.fill('Kept on failure')
  await button.click()
  await waitFor(async () => /injected failure/.test(await page.locator('.banners').innerText()))
  check(await ans.inputValue() === 'Kept on failure' && /Not recorded: injected failure/.test(await page.locator('.banners').innerText()), 'a failed submission keeps the draft and says why')
  await page.unroute(opsUrl)
  await ans.fill('')

  // 9. A question withdrawn while its answer is being composed: status and
  // submission change at once, the control stays editable until the
  // composition ends, then turns read-only with the text kept.
  console.log('withdrawal during composition')
  const q2 = (await op(R1, { op: 'question.ask', question: '', text: 'Any colour preference?', to: 'Check Person' })).seq
  await waitSeq(q2)
  const answer2 = '.questions .question[data-question="q2"] textarea'
  await page.locator(answer2).click()
  await track(answer2)
  await cdp.send('Input.imeSetComposition', { text: 'あお', selectionStart: 2, selectionEnd: 2 })
  const wd = (await op(R1, { op: 'question.withdraw', question: 'q2', reason: 'no longer needed' })).seq
  await waitSeq(wd)
  await sleep(300)
  const during = await page.evaluate(() => {
    const el = (window as unknown as { __tracked: HTMLTextAreaElement }).__tracked
    const card = el.closest('.question') as HTMLElement
    return { connected: el.isConnected, focused: document.activeElement === el, readOnly: el.readOnly, button: (card.querySelector('.answer-form button') as HTMLButtonElement).disabled, state: card.className }
  })
  await cdp.send('Input.insertText', { text: '青' })
  await sleep(100)
  const ended = await page.evaluate(() => {
    const el = (window as unknown as { __tracked: HTMLTextAreaElement }).__tracked
    return { connected: el.isConnected, readOnly: el.readOnly, value: el.value, note: (el.parentElement!.querySelector('.closed-note') as HTMLElement).innerText }
  })
  result.withdrawal = { during, ended }
  check(during.connected && during.focused && !during.readOnly && during.button && /q-withdrawn/.test(during.state), `withdrawn mid-composition: status and submission change, the control stays editable: ${JSON.stringify(during)}`)
  check(ended.connected && ended.readOnly && ended.value === '青' && /withdrawn/.test(ended.note), `after the composition: read-only, text kept, reason shown: ${JSON.stringify(ended)}`)

  // 10. An adjustment preview counts only for what it inspected.
  console.log('adjustment preview binding')
  await page.goto(`${BASE}/#/ws/chk/run/${R2.workflow}/${R2.run}`)
  await page.waitForSelector('.run-summary[data-seq]')
  await page.getByLabel('Your name').fill('Check Person')
  await page.locator('details.adjust summary').click()
  const yaml = page.getByLabel('Adjusted definition')
  const reasonBox = page.getByLabel('Adjustment reason')
  const base = await yaml.inputValue()
  const adjusted = base.replace('edges:\n', '  extra: {type: do, name: extra, description: Extra., repositories: [docs]}\nedges:\n') + '  - {from: join, to: extra}\n'
  await yaml.fill(adjusted)
  await reasonBox.fill('an extra step')
  const apply = page.locator('details.adjust').getByRole('button', { name: 'Apply' })
  const previewBtn = page.locator('details.adjust').getByRole('button', { name: 'Preview' })
  await previewBtn.click()
  await waitFor(async () => !(await apply.isDisabled()), 6000)
  const fresh = !(await apply.isDisabled())
  result.previewText = await page.locator('.adjust-preview').innerText().catch(() => '')
  await reasonBox.fill('an extra step, edited')
  const afterEdit = await apply.isDisabled()
  await reasonBox.fill('an extra step')
  const restored = !(await apply.isDisabled())
  const moved = (await op(R2, { op: 'question.ask', question: '', text: 'Moved past the preview?', to: 'Check Person' })).seq
  await waitSeq(moved)
  await sleep(200)
  const afterMove = { disabled: await apply.isDisabled(), note: await page.locator('.adjust-preview .stale-note').innerText().catch(() => '') }
  const adjustUrl = `**/api/workspaces/chk/runs/ship/${R2.run}/adjust`
  await page.route(adjustUrl, async route => { await sleep(1500); await route.continue() })
  await previewBtn.click()
  await sleep(300)
  await yaml.press('End')
  await page.keyboard.type('# edited while the preview was in flight\n')
  await sleep(2000)
  const late = { disabled: await apply.isDisabled(), preview: await page.locator('.adjust-preview').count() }
  await page.unroute(adjustUrl)
  result.adjustPreview = { fresh, afterEdit, restored, afterMove, late }
  check(fresh && afterEdit && restored && afterMove.disabled && /moved on/.test(afterMove.note), `Apply follows the preview's text, reason, revision and sequence: ${JSON.stringify({ fresh, afterEdit, restored, afterMove })}`)
  check(late.disabled && late.preview === 0, `a preview answered after the draft changed is not shown and enables nothing: ${JSON.stringify(late)}`)
  await yaml.fill(base)
  await reasonBox.fill('')
  await page.goto(`${BASE}/#/ws/chk/run/${R1.workflow}/${R1.run}`)
  await page.waitForSelector('.run-summary[data-seq]')

  // 11. Reading position in the pane: a section growing above the entry being
  // read, the top of the history, and the top of the pane.
  console.log('pane reading position')
  const paneRead = (seq?: number) => page.evaluate(s => {
    const side = document.querySelector('.run-side') as HTMLElement
    const top = side.getBoundingClientRect().top
    const lis = [...side.querySelectorAll('ol.history li')] as HTMLLIElement[]
    const li = s === undefined ? lis.find(x => x.getBoundingClientRect().top > top + 100)! : lis.find(x => x.value === s)!
    const heading = side.querySelector('.side-sec[data-section="history"] h3')!
    return { seq: li.value, offset: li.getBoundingClientRect().top - top, heading: heading.getBoundingClientRect().top - top, first: lis[0].value, scrollTop: side.scrollTop }
  }, seq)
  await page.evaluate(() => { const side = document.querySelector('.run-side') as HTMLElement; side.scrollTop = side.scrollHeight })
  const reading = await paneRead()
  await writeFile(join(runDirOf(R1), 'grown-1.md'), 'a new report\n')
  await writeFile(join(runDirOf(R1), 'grown-2.md'), 'another\n')
  const insSeq = (await op(R1, { op: 'instruction.receive', text: 'Please keep the map small.', from: 'Check Person' })).seq
  await waitSeq(insSeq)
  await waitFor(async () => (await page.locator('.run-side .file-link', { hasText: 'grown-2.md' }).count()) > 0)
  await sleep(300)
  const grown = await paneRead(reading.seq)
  check(Math.abs(grown.offset - reading.offset) <= 2, `sections growing above (files, Instructions) keep the entry being read in place: ${reading.offset.toFixed(1)} → ${grown.offset.toFixed(1)}`)

  await page.evaluate(() => { const side = document.querySelector('.run-side') as HTMLElement; const hd = side.querySelector('.side-sec[data-section="history"] h3') as HTMLElement; side.scrollTop += hd.getBoundingClientRect().top - side.getBoundingClientRect().top - 20 })
  const atHistoryTop = await paneRead()
  const newest = await progress('newest at the top of history')
  const afterTop = await paneRead()
  const newestSeq = (await (await import('node:fs/promises')).readFile(join(runDirOf(R1), 'run.json'), 'utf8').then(t => JSON.parse(t) as { seq: number })).seq
  check(newest !== null && Math.abs(afterTop.heading - atHistoryTop.heading) <= 2 && afterTop.first === newestSeq, `at the top of the history the heading stays and the new entry shows beneath it: heading ${atHistoryTop.heading.toFixed(1)} → ${afterTop.heading.toFixed(1)}, first entry seq ${afterTop.first} (latest ${newestSeq})`)

  await page.evaluate(() => { (document.querySelector('.run-side') as HTMLElement).scrollTop = 0 })
  await progress('at the very top')
  const topNow = await page.evaluate(() => (document.querySelector('.run-side') as HTMLElement).scrollTop)
  check(topNow === 0, `at the top of the pane it stays at the top (${topNow})`)

  // 12. The open file: the same file changing keeps its offsets (clamped),
  // another file starts at the top, and a late response never wins.
  console.log('file content changes')
  const preState = () => page.evaluate(() => { const p = document.querySelector('.file-view pre') as HTMLElement | null; const st = document.querySelector('.file-view p') as HTMLElement | null; return p ? { top: p.scrollTop, left: p.scrollLeft, head: p.textContent!.slice(0, 12), max: p.scrollHeight - p.clientHeight, status: st && !st.hidden ? st.innerText : '' } : null })
  await page.locator('.run-side .file-link', { hasText: 'long.md' }).first().click()
  await waitFor(async () => (await preState())?.head === 'line 001 0123')
  await page.evaluate(() => { const p = document.querySelector('.file-view pre')!; p.scrollTop = 500; p.scrollLeft = 120 })
  await writeFile(join(runDirOf(R1), 'long.md'), Array.from({ length: 300 }, (_, i) => `LINE ${String(i + 1).padStart(3, '0')} ${'abcdefghij'.repeat(30)}`).join('\n') + '\n')
  await waitFor(async () => (await preState())?.head === 'LINE 001 abc', 8000)
  const changed = await preState()
  check(changed?.head === 'LINE 001 abc' && changed.top === 500 && changed.left === 120, `the same file changing shows its new text at the same offsets: ${JSON.stringify(changed)}`)
  await writeFile(join(runDirOf(R1), 'long.md'), Array.from({ length: 30 }, (_, i) => `short ${i + 1} ${'abcdefghij'.repeat(30)}`).join('\n') + '\n')
  await waitFor(async () => (await preState())?.head === 'short 1 abcd', 8000)
  const shrunk = await preState()
  check(shrunk?.head === 'short 1 abcd' && shrunk.top === shrunk.max && shrunk.left === 120, `a shorter version clamps the offset to its end: ${JSON.stringify(shrunk)}`)
  await page.locator('.run-side .file-link', { hasText: 'grown-1.md' }).first().click()
  await waitFor(async () => (await preState())?.head === 'a new report')
  const other = await preState()
  check(other?.top === 0 && other.left === 0, `another file starts at its top: ${JSON.stringify(other)}`)
  const fileUrl = (u: URL) => u.pathname.endsWith('/file') && u.searchParams.get('path') === 'long.md'
  await page.route(fileUrl, async route => { await sleep(1500); await route.continue().catch(() => {}) })
  await page.locator('.run-side .file-link', { hasText: 'long.md' }).first().click()
  await sleep(100)
  await page.locator('.run-side .file-link', { hasText: 'grown-2.md' }).first().click()
  await sleep(2500)
  const raced = await page.evaluate(() => ({ head: document.querySelector('.file-view pre')?.textContent?.slice(0, 7), path: (document.querySelector('.file-view strong') as HTMLElement | null)?.innerText }))
  check(raced.head === 'another' && raced.path === 'grown-2.md', `a late response for the first file does not replace the second: ${JSON.stringify(raced)}`)
  await page.unroute(fileUrl)
  await page.route(u => u.pathname.endsWith('/file') && u.searchParams.get('path') === 'grown-2.md', route => route.fulfill({ status: 500, json: { error: 'injected read failure' } }))
  await writeFile(join(runDirOf(R1), 'grown-2.md'), 'another, changed\n')
  await waitFor(async () => /injected read failure/.test((await preState())?.status ?? ''), 8000)
  const failed = await preState()
  check(failed?.head === 'another\n' && /Could not read it again: injected read failure/.test(failed.status), `a failed re-read keeps the shown text and says so: ${JSON.stringify(failed)}`)
  await page.unroute(u => u.pathname.endsWith('/file'))
  await page.locator('.file-view button.icon-btn').click()

  // 13. Losing and regaining the service while an answer is composed.
  console.log('disconnect and reconnect during composition')
  await page.locator(answer).click()
  await track(answer)
  await cdp.send('Input.imeSetComposition', { text: 'せつぞく', selectionStart: 4, selectionEnd: 4 })
  await service.stop()
  const lost = await waitFor(async () => /not live/.test(await page.locator('.live-state').innerText()), 8000)
  const offline = await tracked()
  const during2 = (await op(R1, { op: 'question.ask', question: '', text: 'Asked while the view was offline?', to: 'Check Person' })).seq
  await service.start()
  const back = await waitSeq(during2, 10_000)
  await cdp.send('Input.insertText', { text: '接続' })
  const online = await tracked()
  result.reconnect = { lost, offline, back, online }
  check(lost !== null && offline.connected && offline.focused && back !== null && online.connected && online.focused && online.value === '接続' && online.comp.includes('compositionend:接続'),
    `disconnect and reconnect keep the composing control; the change made meanwhile shows: ${JSON.stringify({ lost: lost !== null, back: back !== null, value: online.value, connected: online.connected })}`)
  await page.locator(answer).fill('')

  // 6. One refresh lifecycle: slow reads never overlap, the shown sequence
  // never goes back, and a view left behind reads and writes nothing more.
  console.log('refresh lifecycle')
  const runBase = `/api/workspaces/chk/runs/ship/${R1.run}`
  const family = (u: URL) => u.pathname === runBase ? 'run' : u.pathname === `${runBase}/exec` ? 'exec' : u.pathname === `${runBase}/notify` ? 'notify' : null
  const inflight: Record<string, number> = {}, maxInflight: Record<string, number> = {}, reads: { family: string; at: number }[] = []
  let delay = 1200
  const slow = (u: URL) => family(u) !== null
  await page.route(slow, async route => {
    const f = family(new URL(route.request().url()))!
    reads.push({ family: f, at: performance.now() })
    inflight[f] = (inflight[f] ?? 0) + 1
    maxInflight[f] = Math.max(maxInflight[f] ?? 0, inflight[f])
    await sleep(delay)
    inflight[f]--
    await route.continue().catch(() => {})
  })
  await page.evaluate(() => {
    const s = document.querySelector('.run-summary') as HTMLElement
    const log: number[] = [Number(s.dataset.seq)]
    ;(window as unknown as { __seqs: number[] }).__seqs = log
    new MutationObserver(() => log.push(Number(s.dataset.seq))).observe(s, { attributes: true, attributeFilter: ['data-seq'] })
  })
  let lastSeq = 0
  for (let i = 0; i < 6; i++) { lastSeq = (await op(R1, { op: 'node.progress', node: 'build', text: `slow ${i + 1}` })).seq; await sleep(400) }
  const converged = await waitSeq(lastSeq, 15_000)
  await sleep(4000) // a few host-cadence ticks against slow reads
  const seqs = await page.evaluate(() => (window as unknown as { __seqs: number[] }).__seqs)
  result.lifecycle = { maxInflight, seqs, converged }
  check(converged !== null, `slow reads still converge on the latest sequence ${lastSeq} (${Math.round(converged ?? -1)} ms)`)
  check(seqs.every((x, i) => i === 0 || x >= seqs[i - 1]), `the shown sequence never goes back: ${seqs.join(' → ')}`)
  check(Object.values(maxInflight).every(n => n === 1), `no read overlaps another of its kind: ${JSON.stringify(maxInflight)}`)

  delay = 2500
  await op(R1, { op: 'node.progress', node: 'build', text: 'before leaving' })
  await sleep(300) // the change is announced and its read is in flight
  await page.evaluate(() => { location.hash = '#/ws/chk' })
  const left = performance.now()
  await sleep(5000)
  const afterLeaving = reads.filter(r => r.at > left + 100)
  const runViewGone = await page.evaluate(() => !document.querySelector('.run-side') && !document.querySelector('.run-summary'))
  result.leaving = { readsAfter: afterLeaving.length, runViewGone }
  check(runViewGone && afterLeaving.length === 0, `a view left mid-read starts no further reads and leaves nothing behind (${afterLeaving.length} reads after leaving)`)
  await page.unroute(slow)

  const pageErrors = errors.filter(e => !/^Failed to load resource/.test(e))
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser?.close()
  await service.stop()
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'checks-run-interaction.json'), JSON.stringify(result, null, 2))
  if (args.includes('--keep')) console.log(`data kept: ${root}`)
  else await rm(root, { recursive: true, force: true })
  done()
}
