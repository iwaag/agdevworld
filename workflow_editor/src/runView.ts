// Run view: one workflow run (docs/runs.md) on its fixed definition. It shows
// what the executor and the people involved recorded — node states with ready
// and blocked nodes, waits and who holds the next move, questions and answers,
// relations, reports and history — and offers the person's operations:
// answering a question, deciding on the result, cancelling the run. It never
// edits a definition, and recording an answer does not wake any agent.
//
// The view is built once (p7/ex2). Reads go through one refresh coordinator
// (runRefresh.ts); each part is brought up to date in place — the header and
// summary by patching, the right pane by its persistent sections
// (runSide.ts), the canvas only when its graph, states or selection change.
import { backendFact } from '../shared/backend.ts'
import type { RunResponse } from '../shared/api.ts'
import { effectiveOf, holderOf, isOpen, runKey, situation, type RunRecord } from '../shared/run.ts'
import { api, ApiError, type AdjustView, type PresentationView, type RunExecView, type RunNotifyView } from './api.ts'
import { Canvas, STATE_GLYPH } from './canvas.ts'
import { splitCounts } from '../shared/compile.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { live } from './live.ts'
import { patchContent } from './patch.ts'
import { activeWorkflow, ago, chip, fact, line, nodeLabel, nodeLink, runHash, STATE_LABEL } from './runCommon.ts'
import { outcome, RefreshCoordinator, type Outcome, type RefreshKind } from './runRefresh.ts'
import { RunSide } from './runSide.ts'
import type { ViewHandle } from './main.ts'

const ACTOR_KEY = 'workflow-editor.actor'
function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function store(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

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

  const crumbs = h('div.crumbs')
  const refreshButton = h('button', { title: 'Re-read the run now', onclick: () => void refresh.request('full') }, 'Refresh')
  const liveState = h('span.live-state')
  const banners = h('div.banners')
  const summary = h('div.run-summary')
  const canvas = new Canvas({ select: sel => select(sel?.kind === 'node' || sel?.kind === 'step' ? sel.id : null), move: () => {}, connect: () => {} })
  canvas.setMode('compact')
  const legend = h('div.run-legend')
  const side = new RunSide({ record, adjust, notice }, stored(ACTOR_KEY, ''))

  root.append(
    h('header.wf-top.run-top',
      h('div.wf-row1', crumbs, h('div.top-actions', liveState, refreshButton)),
      summary, banners),
    h('main.wf-body', h('div.canvas-col', legend, canvas.el), side.el),
  )

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
  function applyBatch(b: Batch) {
    if (b.run?.ok) { resp = b.run.value; loadError = ''; if (b.run.value.record) shown = b.run.value } else if (b.run) loadError = b.run.error
    // A failed host read keeps the last facts beside its error; nothing else is cleared.
    if (b.exec?.ok) { execView = b.exec.value; execError = '' } else if (b.exec) execError = b.exec.error
    if (b.notify?.ok) notifyView = b.notify.value
    if (b.presentations?.ok) presentViews = b.presentations.value
    render()
  }
  const refresh = new RefreshCoordinator<Batch>(readBatch, applyBatch)

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
    if (!name) { notice('error', `Enter your name first (${what}).`); return null }
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
    renderSide()
  }

  // Each read has its own identity: a late response for one file never
  // replaces another file, a newer read of the same file or a disposed view.
  async function openFile(path: string) {
    const id = ++fileRequest
    viewing = { path }
    renderSide()
    let next: typeof viewing
    try {
      next = { path, text: (await api.runFile(wsId, workflow, run, path, rev ? shown?.rev ?? rev : undefined)).text }
    } catch (e) {
      next = { path, error: (e as Error).message }
    }
    if (disposed || id !== fileRequest) return
    viewing = next
    renderSide()
  }

  // Links and buttons in built display name their action; it is handled
  // here, with the state of this moment.
  root.addEventListener('click', e => {
    const el = (e.target as Element).closest<HTMLElement>('[data-action]')
    if (!el || !root.contains(el)) return
    const d = el.dataset
    e.preventDefault()
    switch (d.action) {
      case 'node': select(d.node!); canvas.reveal(d.node!); break
      case 'close-node': select(null); break
      case 'file': void openFile(d.path!); break
      case 'close-file': fileRequest++; viewing = null; renderSide(); break
      case 'goto-question': side.revealQuestion(d.question!); break
      case 'present-start': void presentation(d.presentation!, 'start'); break
      case 'present-stop': void presentation(d.presentation!, 'stop'); break
      case 'retry-checkpoint': void retryCheckpoint(Number(d.checkpoint)); break
      case 'dismiss': opNotice = null; renderBanners(); break
      case 'stop-run': {
        const reason = prompt('Stop this run? It stays resumable. Reason:')
        if (reason?.trim()) void record({ op: 'run.stop', reason }, 'Stop recorded.')
        break
      }
    }
  })

  // ---- rendering --------------------------------------------------------------

  function renderCrumbs() {
    patchContent(crumbs,
      h('a', { href: '#/' }, 'Projects'), h('span.sep', '/'),
      h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, projectName), h('span.sep', '/'),
      h('span.muted', 'run'), h('strong.run-ref', ref),
      rev ? h('span.pill.warn', `as committed at ${rev.slice(0, 10)}`) : null)
  }

  function renderLive() {
    patchContent(liveState, rev ? h('span.pill', 'history') : connected ? h('span.pill.ok', 'live') : h('span.pill.warn', 'not live'))
  }

  function renderSummary() {
    const r = shown
    const rec = r?.record
    if (!rec) { patchContent(summary, h('p.muted', loadError ? '' : 'Loading run…')); return }
    if (summary.dataset.seq !== String(rec.seq)) summary.dataset.seq = String(rec.seq) // the sequence this view shows (checks read it)
    if (summary.dataset.state !== rec.execution.state) summary.dataset.state = rec.execution.state
    const ex = rec.execution
    const src = r!.sources.find(s => s.workflow === rec.definition.root)
    const srcText = !src ? null : src.status === 'same' ? 'current definition: same as this snapshot' : src.status === 'changed' ? 'current definition: changed since this snapshot' : src.status === 'deleted' ? 'current definition: deleted' : `snapshot: ${src.detail}`
    const input = rec.input
    const last = rec.decisions.at(-1)
    patchContent(summary,
      h('div.run-title',
        chip(ex.state), situationChip(rec), h('span.run-wf', { title: 'The run follows this fixed copy; editing the workflow does not change it.' }, icon('doc', 'icon small'), `Snapshot of ${rec.definition.root}`),
        src?.file ? h('a.button.small-btn', { href: `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(src.file.replace(/^devdocs\/workflows\//, ''))}`, title: 'The editable definition in devdocs/workflows; it may differ from this run' }, 'Open current definition') : null,
        srcText ? h(`span.src-state.${src!.status}`, srcText + (src?.renamed ? ` (now ${src.file})` : '')) : null),
      h('div.run-facts',
        fact('Input', input.kind === 'braindump' ? `braindump.md — the words of ${input.author}${input.recordedBy ? `, recorded by ${input.recordedBy}` : ''}` : `request.md — by ${input.requester}${input.onBehalfOf ? ` on behalf of ${input.onBehalfOf}` : ''}`),
        fact('Executor', `${rec.executor.name} · ${backendFact(rec.executor.backend, rev || !execView ? null : execView.attempts)}`, 'executor'),
        fact('Created', when(rec.created)), fact('Started', rec.started ? when(rec.started) : '—'), fact('Ended', rec.ended ? when(rec.ended) : '—'),
        fact('Last recorded update', `${when(rec.updated)} (${ago(rec.updated)})`, 'last-update'),
        ...countFacts(rec)),
      h('div.run-now',
        line('Active', ex.active.length ? ex.active.map(n => effectiveOf(rec)?.nodes[n]?.step?.kind === 'report' ? h('span', 'Writing report on ', nodeLink(n, effectiveOf(rec)!.nodes[n].step!.for ?? n)) : nodeLink(n)) : ['—']),
        line('Waiting', ex.waiting.length ? ex.waiting.map(w => h('span', nodeLink(w.node), ` → next move: ${holderOf(rec, w.node)}`)) : ['—']),
        line('Ready', ex.ready.length ? ex.ready.map(n => nodeLink(n)) : ['—']),
        ex.failed.length ? line('Failed', ex.failed.map(n => nodeLink(n)), 'error') : null,
        ex.blocked.length ? line('Blocked', ex.blocked.map(n => nodeLink(n)), 'warn') : null,
        rec.cancelled ? line('Cancelled', [`by ${rec.cancelled.by}: ${rec.cancelled.reason}`], 'error') : null,
        last ? line('Decision', [`${last.decision} by ${last.by}`, ...(last.decision === 'accepted' && rec.execution.state !== 'completed' && !rec.cancelled ? [h('span.chip.warn.cleanup-pending', { title: 'The result is accepted; the run completes after what it serves is stopped and its last steps are done' }, 'accepted · cleanup pending')] : [])], last.decision === 'accepted' ? 'ok' : 'error') : null),
      reviewLink(rec),
      h('p.run-note', '“Running” on a node means the executor recorded a start. Whether a process is executing now is the execution host\'s fact, shown under Execution; the time since the last update says neither.'),
    )
  }

  // The one-click review (p7): the latest live presentation, prominently;
  // a recorded but not served one says so instead of offering a dead link.
  function reviewLink(rec: RunRecord): HTMLElement | null {
    if (rev || !rec.presentations) return null
    const live = presentViews.filter(v => v.live).at(-1)
    if (live) return h('div.review-link', h('a.button.primary', { href: live.url!, target: '_blank', rel: 'noopener', dataset: { presentation: live.id } }, icon('present', 'icon small'), `Open the review: ${live.title}`),
      h('span.small', ` ${live.id} · revision ${live.revision.slice(7, 19)}${live.local ? ' · opens on this host' : ''}`))
    const open = Object.values(rec.presentations).filter(isOpen)
    if (open.length) return h('div.review-link.not-live', h('span.chip.warn', `${open.map(p => p.id).join(', ')} recorded as ${open[0].state}, but not served now`), h('span.small', ' — see Presentations to start it again or record its stop'))
    const last = Object.values(rec.presentations).at(-1)!
    return h('div.review-link.stopped', h('span.chip', `${last.id} ${last.state}`), h('span.small.muted', last.state === 'stopped' ? ' — no longer served; its files and decision stay in the run folder' : ''))
  }

  function situationChip(rec: RunRecord): HTMLElement | null {
    const sit = situation(rec)
    const LABEL: Record<string, string> = { executing: 'Executing', stopping: 'Stopping', 'awaiting-person': 'Awaiting a person', stopped: 'Stopped', interrupted: 'Interrupted', unknown: 'Unknown — look before resuming' }
    return LABEL[sit] ? h(`span.chip.sit-${sit}`, { title: 'What runs now (Execution, at the side)' }, LABEL[sit]) : null
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
      !connected && !rev ? h('div.banner.warn', h('strong', 'Not connected to the editor service.'), ' Recorded changes are not shown until it reconnects; this view re-reads the run when it does.') : null,
      loadError ? h('div.banner.error', `Could not read the run: ${loadError}`) : null,
      resp && !resp.record ? h('div.banner.error', h('strong', missing ? `${ref} has no readable run.json` : `run.json cannot be used (${resp.problem?.code ?? resp.problem?.kind})`), ` — ${resp.problem?.message}. `,
        shown ? `Showing the last valid reading (seq ${shown.record!.seq}) read-only; nothing is recorded until the files are fixed. wfe run check names the difference.` : 'Nothing is shown until the files are fixed.') : null,
      rev && resp?.revInfo ? h('div.banner.warn', `As committed in the ${resp.revInfo.owner === 'root' ? 'project root' : 'devdocs repository'} at ${resp.revInfo.commit.slice(0, 10)}${resp.revInfo.root ? ` (the devdocs gitlink of root commit ${resp.revInfo.root.slice(0, 10)})` : ''} (${when(resp.revInfo.date)}): “${resp.revInfo.subject}”. Read-only. `, h('a.button', { href: runHash(wsId, ref) }, 'Open the current run')) : null,
      opNotice ? h(`div.banner.${opNotice.kind}`, opNotice.text, h('button.icon-btn', { dataset: { action: 'dismiss' } }, '×')) : null)
  }

  function renderLegend() {
    patchContent(legend, h('span.muted.small', 'Node states:'),
      ...['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'blocked'].map(s => chip(s, `${STATE_GLYPH[s]} ${STATE_LABEL[s]}`)),
      h('span.muted.small', ' · the graph is this run’s fixed copy; click a node for details'),
      (shown?.record ? effectiveOf(shown.record)?.policy : undefined) === 'default' ? h('span.muted.small.legend-doc', ' · the small icon on a card is its report; “Writing report” marks the one being written') : null)
  }

  // The canvas is drawn again only when what it shows changed.
  function renderCanvas() {
    const r = shown
    const rec = r?.record
    const wf = rec ? activeWorkflow(r, rec) : undefined
    canvas.el.hidden = !wf
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
      repositories, readonly: true, errorNodes: new Set(), run: status, effective: eff?.policy === 'default' ? eff : null,
      workflows: Object.entries(r!.bundle).filter(([, b]) => b.workflow).map(([id, b]) => ({ file: b.file, id, name: b.workflow!.name, errors: 0, warnings: 0, delegates: [] })),
    }, sel)
  }

  function renderSide() {
    if (disposed) return
    side.update({ wsId, rev, shown, resp, execView, execError, notifyView, presentViews, selection, viewing })
  }

  function render() {
    if (disposed) return
    renderCrumbs()
    renderLive()
    renderBanners()
    renderSummary()
    renderCanvas()
    renderLegend()
    renderSide()
  }

  // ---- live updates -----------------------------------------------------------

  const related = () => {
    const keys = new Set([ref])
    const rec = shown?.record
    if (rec?.predecessor) keys.add(runKey(rec.predecessor))
    return keys
  }
  const stream = rev ? null : live(api.eventsUrl(wsId), {
    classify: ev => {
      if (ev.kind === 'run') return ev.run && related().has(ev.run) ? ['content'] : null
      if (ev.kind === 'runs' || ev.kind === 'workflow' || ev.kind === 'workflows') return ['content']
      return null
    },
    flush: () => refresh.request('full'),
    state: c => { connected = c; if (!disposed) { renderLive(); renderBanners() } },
  })
  // Relative times ("5 min ago") age while nothing is recorded.
  const clock = setInterval(() => { if (shown?.record && !disposed) { renderSummary(); renderSide() } }, 30_000)
  // This host's execution facts (process, queue, publication) change without
  // a run.json change; they are re-read every 3 s, never beside another batch.
  const execTimer = rev ? undefined : setInterval(() => { if (shown?.record && !refresh.busy) void refresh.request('host') }, 3000)

  render()
  void refresh.request('full').then(() => { if (!disposed) canvas.fit() })
  void loadProjectName()
  return {
    dispose: () => { disposed = true; fileRequest++; refresh.dispose(); stream?.close(); clearInterval(clock); clearInterval(execTimer) },
    isDirty: () => side.isDirty(),
  }
}
