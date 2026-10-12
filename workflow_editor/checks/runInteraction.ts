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
  await page.route(`**/api/workspaces/chk/runs/ship/${R1.run}/exec`, async route => {
    const res = await route.fetch()
    const body = await res.json() as { executor: { state: string; detail?: string; at?: string } }
    body.executor = { state: 'available', detail: 'check-harness; idle', at: new Date(Date.UTC(2026, 9, 12, 0, 0, beat++)).toISOString() }
    await route.fulfill({ response: res, json: body })
  })
  await sleep(4000) // the first intercepted read moves executor state to available
  await track(answer)
  await page.evaluate(() => {
    const form = document.querySelector('.questions .question[data-question="q1"] .answer-form')!
    const log: number[] = []
    ;(window as unknown as { __mut: number[] }).__mut = log
    new MutationObserver(ms => log.push(ms.length)).observe(form, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  const beats0 = beat
  await sleep(7000)
  const t3 = await tracked()
  const mutations = await page.evaluate(() => (window as unknown as { __mut: number[] }).__mut.reduce((a, b) => a + b, 0))
  result.heartbeat = { reads: beat - beats0, mutations, tracked: t3 }
  check(beat - beats0 >= 2 && t3.connected && t3.sets === 0 && mutations === 0, `heartbeat-only reads (${beat - beats0}) leave the answer form untouched: connected ${t3.connected}, value writes ${t3.sets}, mutations ${mutations}`)
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
