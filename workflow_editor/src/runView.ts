// Run view: one workflow run (docs/runs.md) on its fixed definition. It shows
// what the executor and the people involved recorded — node states with ready
// and blocked nodes, waits and who holds the next move, questions and answers,
// relations, reports and history — and offers the person's operations:
// answering a question, deciding on the result, cancelling the run. It never
// edits a definition, and recording an answer does not wake any agent.
//
// Layout (p8): a slim header (crumbs, connection, Refresh); a title band
// that names the run and keeps four facts apart — recorded execution
// progress, the human decision, executor activity and (in the header)
// connection health — with "Run details" for timestamps, backend and
// provenance; the main column with the focus card (the person's current
// task, runSide.ts) above the graph; and the side pane (runSide.ts).
//
// The view is built once (p7/ex2). Reads go through one refresh coordinator
// (runRefresh.ts); each part is brought up to date in place — the header and
// title band by patching, the focus card and the side pane by their
// persistent sections, the canvas only when its graph, states or selection change.
import { backendFact } from '../shared/backend.ts'
import type { RunResponse } from '../shared/api.ts'
import { effectiveOf, holderOf, situation, type RunRecord } from '../shared/run.ts'
import { api, ApiError, type AdjustView, type PresentationView, type RunExecView, type RunNotifyView } from './api.ts'
import { Canvas, STATE_GLYPH } from './canvas.ts'
import { FINAL_STEP, splitCounts } from '../shared/compile.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { live } from './live.ts'
import { patchContent } from './patch.ts'
import { activeWorkflow, ago, chip, fact, line, nodeLabel, nodeLink, runHash, runTitle, STATE_LABEL } from './runCommon.ts'
import { outcome, RefreshCoordinator, type Outcome, type RefreshKind } from './runRefresh.ts'
import { RunSide } from './runSide.ts'
import { displayToggle, isSimple, onDisplay, setDisplay } from './displayMode.ts'
import type { ViewHandle } from './main.ts'

const ACTOR_KEY = 'workflow-editor.actor'
function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function store(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

const SITUATION: Record<string, string> = {
  executing: 'Executor: executing', stopping: 'Executor: stop requested', 'awaiting-person': 'Executor: idle, waiting for a person',
  stopped: 'Executor: held (stopped)', interrupted: 'Executor: held (interrupted)', unknown: 'Executor: unknown — look before resuming',
  completed: 'Executor: idle', cancelled: 'Executor: idle (cancelled)', 'not-started': 'Executor: not started', idle: 'Executor: idle',
}

export function renderRunView(root: HTMLElement, wsId: string, workflow: string, run: string, rev?: string): ViewHandle {
  const ref = `${workflow}/${run}`
  let resp: RunResponse | null = null
  let shown: RunResponse | null = null // the last reading with a usable record
  let loadError = ''
  let opNotice: { kind: 'ok' | 'error' | 'warn'; text: string } | null = null
  let selection: string | null = null
  let connected = true
  let disposed = false
  let projectName = 'Project'
  let viewing: { path: string; text?: string; error?: string } | null = null
  let fileRequest = 0 // the identity of the latest file read; older responses are dropped
  let execView: RunExecView | null = null
  let notifyView: RunNotifyView | null = null
  let execError = ''
  let presentViews: PresentationView[] = [] // what this host observes of the run's presentations (p7)
  let canvasShown = '' // what the canvas was last drawn from
  let hostShown = '' // the host facts last displayed (without the heartbeat time)

  const crumbs = h('nav.crumbs', { 'aria-label': 'Breadcrumb' })
  const refreshButton = h('button.ghost-dark.d-only', { title: 'Re-read the run now', onclick: () => void refresh.request('full') }, 'Refresh')
  const liveState = h('span.live-state')
  const banners = h('div.banners')
  // The title band; `.run-summary` carries the sequence and state this view shows (checks read them).
  const titleMain = h('div.title-main')
  const titleFacts = h('div.run-facts-row')
  const detailsToggle = h('button.panel-toggle.d-only', { 'aria-expanded': 'false', 'aria-controls': 'run-details', onclick: () => toggleDetails() }, icon('list', 'icon small'), 'Run details')
  const openDefinition = h('a.button.panel-toggle.d-only', { hidden: true }, icon('doc', 'icon small'), 'Open current definition')
  const summary = h('section.title-band.run-summary', titleMain, h('div.title-side', titleFacts, h('div.title-actions', openDefinition, detailsToggle)))
  const details = h('section.run-details.d-only#run-details', { hidden: true, 'aria-label': 'Run details' })
  const canvas = new Canvas({ select: sel => select(sel?.kind === 'node' || sel?.kind === 'step' ? sel.id : null), move: () => {}, connect: () => {} }, { autoHeight: { min: 300, max: 620 } })
  canvas.setMode('compact')
  canvas.setSimple(isSimple())
  const offDisplay = onDisplay(d => {
    canvas.setSimple(d === 'simple')
    canvasShown = ''
    renderCanvas()
    if (selection) requestAnimationFrame(() => { if (!disposed && selection) canvas.reveal(selection) })
  })
  const graphHead = h('div.graph-head')
  const legend = h('div.run-legend.d-only')
  const side = new RunSide({ record, adjust, notice }, stored(ACTOR_KEY, ''))
  const graphCard = h('section.graph-card', graphHead, canvas.el, legend)

  root.append(
    h('header.app-header.run-top', crumbs, h('div.top-actions', liveState, refreshButton, displayToggle())),
    summary, details, banners,
    h('main.run-body',
      h('div.run-col', side.focus, graphCard),
      side.el),
  )

  function toggleDetails(open = details.hidden === true) {
    if (open) setDisplay('detail')
    details.hidden = !open
    detailsToggle.setAttribute('aria-expanded', String(open))
    detailsToggle.classList.toggle('active', open)
  }

  // ---- reading ----------------------------------------------------------------

  // One batch of reads (runRefresh.ts). A full batch reads the run with this
  // host's facts; presentation facts follow the run just read, or the last
  // usable one when the new reading is malformed. A host batch re-reads only
  // the facts that change without a run.json change.
  interface Batch { run?: Outcome<RunResponse>; exec?: Outcome<RunExecView>; notify?: Outcome<RunNotifyView>; presentations?: Outcome<PresentationView[]> }
  async function readBatch(kind: RefreshKind, signal: AbortSignal): Promise<Batch> {
    const [runOut, exec, notify] = await Promise.all([
      kind === 'full' ? outcome(api.run(wsId, workflow, run, rev, signal)) : undefined,
      rev ? undefined : outcome(api.runExec(wsId, workflow, run, signal)),
      rev ? undefined : outcome(api.runNotify(wsId, workflow, run, signal)),
    ])
    const rec = runOut?.ok && runOut.value.record ? runOut.value.record : shown?.record
    const presentations = rev ? undefined : rec?.presentations ? await outcome(api.runPresentations(wsId, workflow, run, signal).then(x => x.presentations)) : { ok: true as const, value: [] }
    return { run: runOut, exec, notify, presentations }
  }
  // A host batch whose facts differ only in the executor's heartbeat time
  // displays nothing new and touches nothing; otherwise only the parts that
  // show host facts are brought up to date. A full batch updates the view.
  const hostFacts = () => JSON.stringify([execView && { ...execView, executor: { ...execView.executor, at: undefined } }, execError, notifyView, presentViews])
  function applyBatch(b: Batch, kind: RefreshKind) {
    const before = resp
    if (b.run?.ok) { resp = b.run.value; loadError = ''; if (b.run.value.record) shown = b.run.value } else if (b.run) loadError = b.run.error
    // A failed host read keeps the last facts beside its error; nothing else is cleared.
    if (b.exec?.ok) { execView = b.exec.value; execError = '' } else if (b.exec) execError = b.exec.error
    if (b.notify?.ok) notifyView = b.notify.value
    if (b.presentations?.ok) presentViews = b.presentations.value
    const facts = hostFacts()
    const hostChanged = facts !== hostShown
    hostShown = facts
    if (kind === 'host') {
      if (hostChanged && !disposed) { renderSummary(); side.updateHost(data()) }
      return
    }
    render()
    // The open file is read again when the run folder says it changed (or,
    // outside the folder, on every full reading); a historical view is fixed.
    if (b.run?.ok && !rev && viewing?.text !== undefined && fileStamp(before, viewing.path) !== fileStamp(resp, viewing.path)) void readFile(viewing.path, false)
  }
  const fileStamp = (r: RunResponse | null, path: string) => {
    const f = r?.files.find(x => x.name === path || `${r.dir}/${x.name}` === path)
    return f ? `${f.size}:${f.modified}` : `unlisted:${Math.random()}`
  }
  const refresh = new RefreshCoordinator<Batch>(readBatch, applyBatch)
  const data = () => ({ wsId, rev, shown, resp, execView, execError, notifyView, presentViews, selection, viewing, connected })

  async function loadProjectName() {
    const p = await api.project(wsId).catch(() => null)
    if (disposed) return
    if (p?.project?.name) projectName = p.project.name
    const list = await api.workspaces().catch(() => null)
    if (disposed) return
    if (list?.approver) side.suggestActor(list.approver)
    renderCrumbs()
  }

  // ---- the person's operations ------------------------------------------------

  function notice(kind: 'ok' | 'error' | 'warn', text: string) { opNotice = { kind, text }; renderBanners() }

  function actorName(what: string): string | null {
    const name = side.actorName.trim()
    if (!name) { notice('error', `Enter your name first (${what}).`); side.focusActor(); return null }
    store(ACTOR_KEY, name)
    return name
  }

  async function record(op: Record<string, unknown> & { op: string }, done: string): Promise<boolean> {
    const rec = shown?.record
    if (!rec) return false
    const name = actorName('who records this')
    if (!name) return false
    let ok = false
    try {
      await api.runOp(wsId, workflow, run, { ...op, by: name, expectSeq: rec.seq })
      opNotice = { kind: 'ok', text: done }
      ok = true
    } catch (e) {
      const err = e as ApiError
      opNotice = err.status === 409 && /changed since/.test(err.message)
        ? { kind: 'warn', text: 'The run changed since this view was read, so nothing was recorded. The view is reloaded; check it and submit again (your text is kept).' }
        : { kind: 'error', text: `Not recorded: ${err.message}` }
    }
    await refresh.request('full')
    return ok
  }

  async function adjust(body: { text: string; reason: string; dryRun: boolean; expectRevision: string; expectSeq: number }): Promise<AdjustView | null> {
    const name = actorName('who adjusts the run')
    if (!name) return null
    let r: AdjustView | null = null
    try {
      r = await api.adjustRun(wsId, workflow, run, { ...body, by: name })
      if (!body.dryRun && r.ok) opNotice = { kind: 'ok', text: `Adjusted: ${r.revision} is in force.` }
    } catch (e) { opNotice = { kind: 'error', text: `Not adjusted: ${(e as Error).message}` } }
    await refresh.request('full')
    return r
  }

  async function presentation(p: string, action: 'start' | 'stop') {
    const name = actorName('who asks for it')
    if (!name) return
    try { await api.presentation(wsId, workflow, run, p, action, name); opNotice = { kind: 'ok', text: action === 'start' ? `Presentation ${p} is served.` : `Presentation ${p}: stop verified.` } } catch (e) { opNotice = { kind: 'error', text: `${action === 'start' ? 'Start' : 'Stop'} of ${p} failed: ${(e as Error).message}` } }
    await refresh.request('full')
  }

  async function retryCheckpoint(id: number) {
    try { await api.retryCheckpoint(wsId, workflow, run, id); opNotice = { kind: 'ok', text: 'Publication retried.' } } catch (e) { opNotice = { kind: 'error', text: `Retry failed: ${(e as Error).message}` } }
    await refresh.request('full')
  }

  function select(id: string | null) {
    selection = id
    renderCanvas()
    renderSide(true)
    // In Simple the side pane may have just appeared and narrowed the canvas.
    if (id) requestAnimationFrame(() => { if (!disposed && selection === id) canvas.reveal(id) })
  }

  // Each read has its own identity: a late response for one file never
  // replaces another file, a newer read of the same file or a disposed view.
  // Opening another file is the person's navigation; reading the open one
  // again (`explicit` false, or the same file clicked again) keeps what is
  // shown until the new text arrives.
  async function readFile(path: string, explicit: boolean) {
    const id = ++fileRequest
    const kept = viewing?.path === path ? viewing.text : undefined
    if (kept === undefined) { viewing = { path }; renderSide(explicit) }
    if (explicit) side.revealFile()
    let next: typeof viewing
    try {
      next = { path, text: (await api.runFile(wsId, workflow, run, path, rev ? shown?.rev ?? rev : undefined)).text }
    } catch (e) {
      next = { path, text: kept, error: (e as Error).message }
    }
    if (disposed || id !== fileRequest) return
    viewing = next
    renderSide(explicit)
  }

  // Links and buttons in built display name their action; it is handled
  // here, with the state of this moment. The listener is on the shared app
  // root, so it is removed with the view: a disposed view must never act on
  // a click in its successor (p8 found a click reaching every run view
  // visited before, with that view's run).
  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-action]')
    if (!el || !root.contains(el)) return
    const d = el.dataset
    e.preventDefault()
    switch (d.action) {
      case 'node': select(d.node!); canvas.reveal(d.node!); break
      case 'close-node': select(null); break
      case 'file': void readFile(d.path!, true); break
      case 'close-file': fileRequest++; viewing = null; renderSide(true); break
      case 'goto-question': side.revealQuestion(d.question!); break
      case 'goto-resume': side.revealResume(); break
      case 'goto-section': setDisplay('detail'); side.revealSection(d.section!, d.focus); break
      case 'more-details': setDisplay('detail'); side.revealSelected(); break
      case 'records': setDisplay('detail'); side.revealRecords(); break
      case 'present-start': void presentation(d.presentation!, 'start'); break
      case 'present-stop': void presentation(d.presentation!, 'stop'); break
      case 'retry-checkpoint': void retryCheckpoint(Number(d.checkpoint)); break
      case 'dismiss': opNotice = null; renderBanners(); break
      case 'details': toggleDetails(true); details.scrollIntoView({ block: 'nearest' }); break
      case 'stop-run': {
        const reason = prompt('Stop this run? It stays resumable. Reason:')
        if (reason?.trim()) void record({ op: 'run.stop', reason }, 'Stop recorded.')
        break
      }
      case 'cancel-run': {
        const why = prompt('Cancel this run? Every pending, running or waiting node is cancelled. Reason:')
        if (why?.trim()) void record({ op: 'run.cancel', reason: why }, 'Recorded: the run is cancelled.')
        break
      }
    }
  }
  root.addEventListener('click', onClick)

  // ---- rendering --------------------------------------------------------------

  function renderCrumbs() {
    patchContent(crumbs,
      h('a', { href: '#/' }, 'Projects'), h('span.sep', '/'),
      h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, projectName), h('span.sep', '/'),
      h('span', 'Run'), h('span.sep.d-only', '/'), h('strong.run-ref.here.d-only', ref),
      rev ? h('span.pill.warn.d-only', `as committed at ${rev.slice(0, 10)}`) : null)
  }

  function renderLive() {
    patchContent(liveState, rev ? h('span.pill', { title: 'A historical reading: nothing here is live' }, 'history') : connected ? h('span.pill.ok', h('span.dot.on'), 'live') : h('span.pill.warn', h('span.dot.off'), 'not live'))
  }

  // The title band: what the run is, and its separate facts.
  function renderSummary() {
    const r = shown
    const rec = r?.record
    detailsToggle.hidden = !rec
    if (!rec) { patchContent(titleMain, h('h1.run-name', ref), h('p.muted', loadError || resp?.problem ? 'No usable record.' : 'Loading run…')); patchContent(titleFacts); patchContent(details); return }
    if (summary.dataset.seq !== String(rec.seq)) summary.dataset.seq = String(rec.seq) // the sequence this view shows (checks read it)
    if (summary.dataset.state !== rec.execution.state) summary.dataset.state = rec.execution.state
    const ex = rec.execution
    const wf = activeWorkflow(r, rec)
    const t = runTitle(rec, wf?.name)
    patchContent(titleMain,
      h('h1.run-name', { title: t.title }, t.title),
      progress(rec),
      h('p.run-lead.d-only', statusLine(rec)),
      h('p.wf-file.d-only', `${t.sub} · ${rec.definition.revisions?.length ? `adjusted, ${rec.definition.active ?? 'r1'} in force` : 'fixed snapshot'}`))
    const last = rec.decisions.at(-1)
    const accepted = last?.decision === 'accepted'
    const sit = situation(rec)
    const open = execView?.attempts.find(a => a.state !== 'ended')
    const process = rev ? '' : open ? (open.alive === true ? ' · process alive' : open.alive === false ? (open.pid ? ' · process not seen alive' : ' · launching') : ' · on another host') : ''
    patchContent(titleFacts,
      chip(ex.state, ex.state === 'completed' ? '✓ Completed' : ex.state === 'stopped' ? 'Nothing can proceed' : STATE_LABEL[ex.state] ?? ex.state),
      last ? h(`span.decision-chip.${accepted ? 'ok' : 'error'}`, { title: `${last.decision} by ${last.by}, ${when(last.at)}${last.confirmation ? ` (from ${last.confirmation.question})` : ''}` },
        accepted ? (ex.state !== 'completed' && !rec.cancelled ? 'Accepted · cleanup pending' : 'Accepted') : 'Rejected') : ex.state === 'completed' ? h('span.decision-chip.none', 'No decision') : null,
      rev ? null : h(`span.chip.d-only.sit-${sit}`, { title: 'What runs now: this host\'s execution facts, separate from the recorded node states' }, `${SITUATION[sit] ?? sit}${process}`))
    const src = r!.sources.find(s => s.workflow === rec.definition.root)
    openDefinition.hidden = !src?.file
    if (src?.file) {
      const href = `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(src.file.replace(/^devdocs\/workflows\//, ''))}`
      if (openDefinition.getAttribute('href') !== href) openDefinition.setAttribute('href', href)
      openDefinition.title = 'The editable, reusable definition in devdocs/workflows; this run follows its own fixed copy'
    }
    renderDetails(rec)
  }

  // Simple (p8/ex1): the authored work done, as a bar and a few words; the
  // documentation steps and every other count are Detail's.
  function progress(rec: RunRecord): HTMLElement {
    const eff = effectiveOf(rec)
    const c = eff?.policy === 'default' ? splitCounts(eff, rec.nodes).work : rec.execution.counts
    const total = Object.values(c).reduce((a, b) => a + b, 0), doneN = c.completed ?? 0
    const pct = total ? Math.round((doneN / total) * 100) : 0
    const bad = rec.execution.failed.length > 0
    return h('div.run-progress.s-only', { role: 'img', 'aria-label': `${doneN} of ${total} work steps completed` },
      h('span.bar', h(`span.fill${bad ? '.bad' : doneN === total && total ? '.full' : ''}`, { style: { width: `${pct}%` } })),
      h('span.bar-text', `${doneN} of ${total} steps done`))
  }

  // One deterministic line from recorded facts: no generated prose.
  function statusLine(rec: RunRecord): string {
    const ex = rec.execution
    const eff = effectiveOf(rec)
    const split = eff?.policy === 'default' ? splitCounts(eff, rec.nodes) : null
    const tally = (c: Record<string, number>) => `${c.completed ?? 0} of ${Object.values(c).reduce((a, b) => a + b, 0)}`
    const counts = split ? `work ${tally(split.work)} completed · documentation ${tally(split.docs)}` : `${tally(ex.counts)} nodes completed`
    if (rec.cancelled) return `Cancelled by ${rec.cancelled.by}: ${rec.cancelled.reason}`
    const parts = [
      ...ex.active.map(n => `${label(rec, n)}: in progress`),
      ...ex.waiting.map(w => `${label(rec, w.node)}: waits for ${holderOf(rec, w.node)}`),
      ...ex.failed.map(n => `${label(rec, n)}: failed`),
    ]
    const text = `${parts.length ? `${parts.join(' · ')} — ` : ''}${counts}`
    return text.charAt(0).toUpperCase() + text.slice(1)
  }
  const label = (rec: RunRecord, id: string) => {
    const wf = activeWorkflow(shown, rec)
    const step = effectiveOf(rec)?.nodes[id]?.step
    return step ? (step.kind === 'plan' ? 'Plan talk' : step.kind === 'report' ? `Report on ${wf?.nodes[step.for ?? '']?.name ?? step.for}` : 'Final report') : wf?.nodes[id]?.name || id
  }

  // Run details: timestamps, backend, provenance and the full position.
  function renderDetails(rec: RunRecord) {
    const r = shown!
    const ex = rec.execution
    const src = r.sources.find(s => s.workflow === rec.definition.root)
    const srcText = !src ? null : src.status === 'same' ? 'current definition: same as this snapshot' : src.status === 'changed' ? 'current definition: changed since this snapshot' : src.status === 'deleted' ? 'current definition: deleted' : `snapshot: ${src.detail}`
    const input = rec.input
    const last = rec.decisions.at(-1)
    patchContent(details,
      h('div.run-facts',
        fact('Input', input.kind === 'braindump' ? `braindump.md — the words of ${input.author}${input.recordedBy ? `, recorded by ${input.recordedBy}` : ''}` : `request.md — by ${input.requester}${input.onBehalfOf ? ` on behalf of ${input.onBehalfOf}` : ''}`),
        fact('Executor', `${rec.executor.name} · ${backendFact(rec.executor.backend, rev || !execView ? null : execView.attempts)}`, 'executor'),
        fact('Created', when(rec.created)), fact('Started', rec.started ? when(rec.started) : '—'), fact('Ended', rec.ended ? when(rec.ended) : '—'),
        fact('Last recorded update', `${when(rec.updated)} (${ago(rec.updated)})`, 'last-update'),
        ...countFacts(rec),
        h(`div.fact.run-title.src-state.${src?.status ?? 'none'}`, h('span.k', 'Definition'), h('span.v', `${rec.definition.root} · ${rec.definition.active ?? 'r1'} in force${srcText ? ` · ${srcText}${src?.renamed ? ` (now ${src.file})` : ''}` : ''}`)),
        rec.control.attempt ? fact('Open attempt', `${rec.control.attempt.id} since ${when(rec.control.attempt.began)}`) : rec.control.last ? fact('Last attempt', `${rec.control.last.id}: ${rec.control.last.outcome}, ${when(rec.control.last.ended)}`) : null),
      h('div.run-now',
        line('Active', ex.active.length ? ex.active.map(n => effectiveOf(rec)?.nodes[n]?.step?.kind === 'report' ? h('span', 'Writing report on ', nodeLink(n, effectiveOf(rec)!.nodes[n].step!.for ?? n)) : nodeLink(n)) : ['—']),
        line('Waiting', ex.waiting.length ? ex.waiting.map(w => h('span', nodeLink(w.node), ` → next move: ${holderOf(rec, w.node)}`)) : ['—']),
        line('Ready', ex.ready.length ? ex.ready.map(n => nodeLink(n)) : ['—']),
        ex.failed.length ? line('Failed', ex.failed.map(n => nodeLink(n)), 'error') : null,
        ex.blocked.length ? line('Blocked', ex.blocked.map(n => nodeLink(n)), 'warn') : null,
        rec.cancelled ? line('Cancelled', [`by ${rec.cancelled.by}: ${rec.cancelled.reason}`], 'error') : null,
        last ? line('Decision', [`${last.decision} by ${last.by}`, ...(last.decision === 'accepted' && rec.execution.state !== 'completed' && !rec.cancelled ? [h('span.chip.warn.cleanup-pending', { title: 'The result is accepted; the run completes after what it serves is stopped and its last steps are done' }, 'accepted · cleanup pending')] : [])], last.decision === 'accepted' ? 'ok' : 'error') : null),
      h('p.run-note', '“Running” on a node means the executor recorded a start. Whether a process is executing now is the execution host\'s fact (the executor chip, and Execution at the side); the time since the last update says neither.'))
  }

  // Authored work and documentation steps are counted apart (p5): "5 of 7"
  // would hide that the work is finished and only reports remain.
  function countFacts(rec: RunRecord): HTMLElement[] {
    const order = ['running', 'waiting', 'completed', 'failed', 'cancelled', 'pending']
    const count = (c: Record<string, number>) => order.filter(k => c[k]).map(k => `${c[k]} ${k}`).join(' · ') || '—'
    const eff = effectiveOf(rec)
    if (!eff) return [fact('Nodes', count(rec.execution.counts)), fact('Documentation', 'none (created before p5)')]
    if (eff.policy !== 'default') return [fact('Nodes', count(rec.execution.counts)), fact('Documentation', 'manual — no generated plan or reports')]
    const split = splitCounts(eff, rec.nodes)
    return [fact('Work', count(split.work)), fact('Documentation steps', count(split.docs), 'doc-counts'), fact('Policy', 'default (frozen at creation)')]
  }

  function renderBanners() {
    const missing = resp?.problem?.code === 'missing'
    patchContent(banners,
      !connected && !rev ? h('div.banner.warn', icon('alert', 'icon small'), h('strong', 'Not connected to the editor service.'), h('span', ' Recorded changes are not shown until it reconnects', h('span.d-only', '; this view re-reads the run when it does'), '.')) : null,
      loadError ? h('div.banner.error', icon('alert', 'icon small'), `Could not read the run: ${loadError}`) : null,
      resp && !resp.record ? h('div.banner.error', h('strong', missing ? `${ref} has no readable run.json` : `run.json cannot be used (${resp.problem?.code ?? resp.problem?.kind})`), ` — ${resp.problem?.message}. `,
        shown ? `Showing the last valid reading (seq ${shown.record!.seq}) read-only; nothing is recorded until the files are fixed. wfe run check names the difference.` : 'Nothing is shown until the files are fixed.') : null,
      rev && resp?.revInfo ? h('div.banner.warn.s-only', icon('history', 'icon small'), h('span', h('strong', 'A past state of this run'), ` — as committed on ${new Date(resp.revInfo.date).toLocaleDateString()}: “${resp.revInfo.subject}”. Read-only.`), h('a.button', { href: runHash(wsId, ref) }, 'Open the current run')) : null,
      rev && resp?.revInfo ? h('div.banner.warn.d-only', `As committed in the ${resp.revInfo.owner === 'root' ? 'project root' : 'devdocs repository'} at ${resp.revInfo.commit.slice(0, 10)}${resp.revInfo.root ? ` (the devdocs gitlink of root commit ${resp.revInfo.root.slice(0, 10)})` : ''} (${when(resp.revInfo.date)}): “${resp.revInfo.subject}”. Read-only. `, h('a.button', { href: runHash(wsId, ref) }, 'Open the current run')) : null,
      opNotice ? h(`div.banner.${opNotice.kind}`, opNotice.text, h('button.icon-btn', { 'aria-label': 'Dismiss', dataset: { action: 'dismiss' } }, '×')) : null)
  }

  // The graph card: the definition in force, the two counts, and a legend of
  // the states this run has.
  function renderGraphHead() {
    const rec = shown?.record
    if (!rec) { patchContent(graphHead); patchContent(legend); return }
    const eff = effectiveOf(rec)
    const split = eff?.policy === 'default' ? splitCounts(eff, rec.nodes) : null
    const tally = (c: Record<string, number>) => `${c.completed ?? 0}/${Object.values(c).reduce((a, b) => a + b, 0)}`
    patchContent(graphHead,
      h('h2', 'Run workflow'),
      h('span.chip.d-only', { title: 'The run follows this fixed copy; editing the reusable workflow does not change it' }, rec.definition.revisions?.length ? `Fixed snapshot · ${rec.definition.active ?? 'r1'} in force` : 'Fixed snapshot · r1'),
      h('span.chip.muted.d-only', icon('lock', 'icon tiny'), 'Read-only'),
      h('span.graph-counts.small.d-only', split ? `Work ${tally(split.work)} completed · Documentation ${tally(split.docs)} completed` : `${tally(rec.execution.counts)} completed · manual documentation`),
      h('span.muted.small.graph-hint.d-only', 'Select a card to inspect its record'))
    const states = new Set(Object.keys(rec.nodes).map(id => nodeLabel(rec, id).state))
    const present = ['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'blocked'].filter(s => states.has(s))
    patchContent(legend, ...present.map(s => chip(s, `${STATE_GLYPH[s]} ${STATE_LABEL[s]}`)),
      eff?.policy === 'default' ? h('span.muted.small.legend-doc', 'The small icon in a card’s corner is its report; “Writing report” marks the one being written.') : null)
  }

  // The canvas is drawn again only when what it shows changed.
  function renderCanvas() {
    const r = shown
    const rec = r?.record
    const wf = rec ? activeWorkflow(r, rec) : undefined
    graphCard.hidden = !wf
    if (!rec || !wf) return
    const status = Object.fromEntries(Object.keys(rec.nodes).map(id => [id, nodeLabel(rec, id)]))
    const eff = effectiveOf(rec)
    const sel = selection && eff?.nodes[selection]?.step ? { kind: 'step' as const, id: selection } : selection && rec.nodes[selection] ? { kind: 'node' as const, id: selection } : null
    const key = JSON.stringify([rec.definition.active ?? 'r1', Object.keys(r!.bundle), status, sel, rec.context.repositories])
    if (key === canvasShown) return
    canvasShown = key
    // Bindings resolve against the repositories recorded at creation.
    const repositories = rec.context.repositories.map(c => ({ path: c.path, name: c.path, kind: c.path === '.' ? 'root' as const : 'submodule' as const, category: 'other' as const, initialized: true, dirty: c.dirty ?? 0 }))
    canvas.render(wf, {
      repositories, readonly: true, errorNodes: new Set(), run: status, effective: eff?.policy === 'default' ? eff : null, focus: focusOf(rec),
      workflows: Object.entries(r!.bundle).filter(([, b]) => b.workflow).map(([id, b]) => ({ file: b.file, id, name: b.workflow!.name, errors: 0, warnings: 0, delegates: [] })),
    }, sel)
  }

  // The run's current position, for the initial view of a large graph:
  // what runs or waits, else what failed, else the end of a completed run,
  // else what is ready.
  function focusOf(rec: RunRecord): string[] {
    const ex = rec.execution
    const now = [...ex.active, ...ex.waiting.map(w => w.node)]
    if (now.length) return now
    if (ex.failed.length) return ex.failed
    if (ex.state === 'completed') { const eff = effectiveOf(rec); return eff?.nodes[FINAL_STEP] ? [FINAL_STEP] : Object.keys(rec.nodes).slice(-1) }
    return ex.ready
  }

  function renderSide(explicit = false) {
    if (disposed) return
    side.update(data(), explicit)
  }

  function render() {
    if (disposed) return
    renderCrumbs()
    renderLive()
    renderBanners()
    renderSummary()
    renderGraphHead()
    // The side first: in Simple it decides whether the canvas has its width
    // when the graph is framed for the first time.
    renderSide()
    renderCanvas()
  }

  // ---- live updates -----------------------------------------------------------

  const related = () => {
    const keys = new Set([ref])
    const rec = shown?.record
    if (rec?.predecessor) keys.add(`${rec.predecessor.workflow}/${rec.predecessor.run}`)
    return keys
  }
  const stream = rev ? null : live(api.eventsUrl(wsId), {
    classify: ev => {
      if (ev.kind === 'run') return ev.run && related().has(ev.run) ? ['content'] : null
      if (ev.kind === 'runs' || ev.kind === 'workflow' || ev.kind === 'workflows') return ['content']
      return null
    },
    flush: () => refresh.request('full'),
    // The side's executor observation says when the connection is lost (p8/ex1).
    state: c => { connected = c; if (!disposed) { renderLive(); renderBanners(); if (shown?.record) side.updateHost(data()) } },
  })
  // Relative times ("5 min ago") age while nothing is recorded.
  const clock = setInterval(() => { if (shown?.record && !disposed) { renderSummary(); renderSide() } }, 30_000)
  // This host's execution facts (process, queue, publication) change without
  // a run.json change; they are re-read every 3 s, never beside another batch.
  const execTimer = rev ? undefined : setInterval(() => { if (shown?.record && !refresh.busy) void refresh.request('host') }, 3000)

  render()
  void refresh.request('full')
  void loadProjectName()
  return {
    dispose: () => { disposed = true; offDisplay(); root.removeEventListener('click', onClick); fileRequest++; refresh.dispose(); stream?.close(); canvas.dispose(); clearInterval(clock); clearInterval(execTimer) },
    isDirty: () => side.isDirty(),
  }
}
