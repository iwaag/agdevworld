// Run view: one workflow run (docs/runs.md) on its fixed definition. It shows
// what the executor and the people involved recorded — node states with ready
// and blocked nodes, waits and who holds the next move, questions and answers,
// relations, reports and history — and offers the person's operations:
// answering a question, deciding on the result, cancelling the run. It never
// edits a definition, and recording an answer does not wake any agent.
import type { RunResponse } from '../shared/api.ts'
import { holderOf, questionState, runKey, situation, type NodeRecord, type Question, type RunRecord } from '../shared/run.ts'
import { api, ApiError, type RunExecView } from './api.ts'
import { Canvas, TYPE_LABEL } from './canvas.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { live, serial } from './live.ts'
import type { ViewHandle } from './main.ts'

const ACTOR_KEY = 'workflow-editor.actor'
function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function store(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

export const STATE_LABEL: Record<string, string> = {
  pending: 'Pending', ready: 'Ready', blocked: 'Blocked', running: 'Running (reported)', waiting: 'Waiting',
  completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  'not-started': 'Not started', 'in-progress': 'In progress', stopped: 'Stopped',
}

export function ago(at: string | null | undefined, now = Date.now()): string {
  if (!at) return '—'
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

export const runHash = (ws: string, ref: string, rev?: string) =>
  `#/ws/${encodeURIComponent(ws)}/run/${ref.split('/').map(encodeURIComponent).join('/')}${rev ? `/at/${encodeURIComponent(rev)}` : ''}`

// The state a node is shown with: pending splits into ready / blocked / pending.
function shownState(rec: RunRecord, id: string): string {
  const n = rec.nodes[id]
  if (n.state !== 'pending') return n.state
  return rec.execution.ready.includes(id) ? 'ready' : rec.execution.blocked.includes(id) ? 'blocked' : 'pending'
}

function nodeLabel(rec: RunRecord, id: string): { state: string; label: string; title: string } {
  const n = rec.nodes[id]
  const state = shownState(rec, id)
  let label = STATE_LABEL[state] ?? state
  let title = label
  if (n.state === 'waiting' && n.wait) {
    const on = n.wait.on
    const q = 'question' in on ? rec.questions[on.question] : undefined
    label = q && q.answers.length && !q.takenUp && !q.withdrawn ? `Answered · ${rec.executor.name} to take up` : `Waiting · ${n.wait.holder}`
    title = `${n.wait.reason}; next move: ${holderOf(rec, id)}`
  } else if (n.state === 'running') title = `The executor recorded a start at ${when(n.started ?? '')}; last update ${ago(n.updated)}. This is reported progress, not a check that anything runs.`
  else if (state === 'blocked') title = 'A predecessor failed or was cancelled; this node cannot become ready.'
  else if (state === 'ready') title = 'Every predecessor completed; the executor can start it.'
  return { state, label, title }
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
  const drafts = new Map<string, string>() // answer and form drafts, kept across reloads
  let actor = stored(ACTOR_KEY, '')
  let execView: RunExecView | null = null
  let execError = ''

  const crumbs = h('div.crumbs')
  const refreshButton = h('button', { title: 'Re-read the run now', onclick: () => void load({}) }, 'Refresh')
  const liveState = h('span.live-state')
  const banners = h('div.banners')
  const summary = h('div.run-summary')
  const canvas = new Canvas({ select: sel => { selection = sel?.kind === 'node' ? sel.id : null; render() }, move: () => {}, connect: () => {} })
  canvas.setMode('compact')
  const legend = h('div.run-legend')
  const side = h('aside.run-side', { 'aria-label': 'Run details' })

  root.append(
    h('header.wf-top.run-top',
      h('div.wf-row1', crumbs, h('div.top-actions', liveState, refreshButton)),
      summary, banners),
    h('main.wf-body', h('div.canvas-col', legend, canvas.el), side),
  )

  // ---- loading ----------------------------------------------------------------

  const load = serial<object>(async () => {
    try {
      const r = await api.run(wsId, workflow, run, rev)
      if (disposed) return
      resp = r
      if (!rev) {
        try { execView = await api.runExec(wsId, workflow, run); execError = '' } catch (e) { execView = null; execError = (e as Error).message }
      }
      loadError = ''
      if (r.record) shown = r
      render()
    } catch (e) {
      if (disposed) return
      loadError = (e as Error).message
      render()
    }
  }, a => a)

  async function loadProjectName() {
    const p = await api.project(wsId).catch(() => null)
    if (p?.project?.name) projectName = p.project.name
    const list = await api.workspaces().catch(() => null)
    if (!actor && list?.approver) actor = list.approver
    renderCrumbs()
  }

  // ---- the person's operations ------------------------------------------------

  async function submit(op: Record<string, unknown> & { op: string }, done: string, clear: string[] = []) {
    const rec = shown?.record
    if (!rec) return
    const name = actor.trim()
    if (!name) { opNotice = { kind: 'error', text: 'Enter your name first (who records this).' }; render(); return }
    store(ACTOR_KEY, name)
    try {
      await api.runOp(wsId, workflow, run, { ...op, by: name, expectSeq: rec.seq })
      for (const k of clear) drafts.delete(k)
      opNotice = { kind: 'ok', text: done }
    } catch (e) {
      const err = e as ApiError
      opNotice = err.status === 409 && /changed since/.test(err.message)
        ? { kind: 'warn', text: 'The run changed since this view was read, so nothing was recorded. The view is reloaded; check it and submit again (your text is kept).' }
        : { kind: 'error', text: `Not recorded: ${err.message}` }
    }
    await load({})
  }

  // ---- rendering --------------------------------------------------------------

  function renderCrumbs() {
    crumbs.replaceChildren(
      h('a', { href: '#/' }, 'Projects'), h('span.sep', '/'),
      h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, projectName), h('span.sep', '/'),
      h('span.muted', 'run'), h('strong.run-ref', ref),
      ...(rev ? [h('span.pill.warn', `as committed at ${rev.slice(0, 10)}`)] : []))
  }

  function chip(state: string, text = STATE_LABEL[state] ?? state) {
    return h(`span.state-chip.state-${state}`, { dataset: { state } }, text)
  }

  function renderSummary(r: RunResponse | null) {
    summary.replaceChildren()
    const rec = r?.record
    if (!rec) { summary.append(h('p.muted', loadError ? '' : 'Loading run…')); return }
    summary.dataset.seq = String(rec.seq) // the sequence this view shows (checks read it)
    summary.dataset.state = rec.execution.state
    const ex = rec.execution
    const src = r!.sources.find(s => s.workflow === rec.definition.root)
    const srcText = !src ? null : src.status === 'same' ? 'current definition: same as this snapshot' : src.status === 'changed' ? 'current definition: changed since this snapshot' : src.status === 'deleted' ? 'current definition: deleted' : `snapshot: ${src.detail}`
    const input = rec.input
    summary.append(
      h('div.run-title',
        chip(ex.state), situationChip(rec), h('span.run-wf', { title: 'The run follows this fixed copy; editing the workflow does not change it.' }, icon('doc', 'icon small'), `Snapshot of ${rec.definition.root}`),
        src?.file ? h('a.button.small-btn', { href: `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(src.file.replace(/^devdocs\/workflows\//, ''))}`, title: 'The editable definition in devdocs/workflows; it may differ from this run' }, 'Open current definition') : null,
        srcText ? h(`span.src-state.${src!.status}`, srcText + (src?.renamed ? ` (now ${src.file})` : '')) : null),
      h('div.run-facts',
        fact('Input', input.kind === 'braindump' ? `braindump.md — the words of ${input.author}${input.recordedBy ? `, recorded by ${input.recordedBy}` : ''}` : `request.md — by ${input.requester}${input.onBehalfOf ? ` on behalf of ${input.onBehalfOf}` : ''}`),
        fact('Executor', `${rec.executor.name} · backend ${rec.executor.backend ?? 'unknown'}`),
        fact('Created', when(rec.created)), fact('Started', rec.started ? when(rec.started) : '—'), fact('Ended', rec.ended ? when(rec.ended) : '—'),
        fact('Last recorded update', `${when(rec.updated)} (${ago(rec.updated)})`, 'last-update'),
        fact('Nodes', Object.entries(ex.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · '))),
      h('div.run-now',
        line('Active', ex.active.length ? ex.active.map(n => nodeLink(n)) : ['—']),
        line('Waiting', ex.waiting.length ? ex.waiting.map(w => h('span', nodeLink(w.node), ` → next move: ${holderOf(rec, w.node)}`)) : ['—']),
        line('Ready', ex.ready.length ? ex.ready.map(n => nodeLink(n)) : ['—']),
        ex.failed.length ? line('Failed', ex.failed.map(n => nodeLink(n)), 'error') : null,
        ex.blocked.length ? line('Blocked', ex.blocked.map(n => nodeLink(n)), 'warn') : null,
        rec.cancelled ? line('Cancelled', [`by ${rec.cancelled.by}: ${rec.cancelled.reason}`], 'error') : null,
        rec.decisions.length ? line('Decision', [`${rec.decisions.at(-1)!.decision} by ${rec.decisions.at(-1)!.by}`], rec.decisions.at(-1)!.decision === 'accepted' ? 'ok' : 'error') : null),
      h('p.run-note', '“Running” on a node means the executor recorded a start. Whether a process is executing now is the execution host\'s fact, shown under Execution; the time since the last update says neither.'),
    )
  }

  function situationChip(rec: RunRecord): HTMLElement | null {
    const sit = situation(rec)
    const LABEL: Record<string, string> = { executing: 'Executing', stopping: 'Stopping', 'awaiting-person': 'Awaiting a person', stopped: 'Stopped', interrupted: 'Interrupted', unknown: 'Unknown — look before resuming' }
    return LABEL[sit] ? h(`span.chip.sit-${sit}`, { title: 'What runs now (Execution, at the side)' }, LABEL[sit]) : null
  }
  const fact = (k: string, v: string, cls = '') => h(`div.fact${cls ? `.${cls}` : ''}`, h('span.k', k), h('span.v', v))
  const line = (k: string, items: (Node | string | null)[], cls = '') => h(`div.now-line${cls ? `.${cls}` : ''}`, h('span.k', k), h('span.v', ...items.filter((x): x is Node | string => x !== null).flatMap((x, i) => (i ? [', ', x] : [x]))))
  const nodeLink = (id: string) => h('a.node-link', { href: '#', onclick: (e: Event) => { e.preventDefault(); selection = id; render(); canvas.reveal(id) } }, id)

  function renderBanners() {
    banners.replaceChildren()
    if (!connected && !rev) banners.append(h('div.banner.warn', h('strong', 'Not connected to the editor service.'), ' Recorded changes are not shown until it reconnects; this view re-reads the run when it does.'))
    if (loadError) banners.append(h('div.banner.error', `Could not read the run: ${loadError}`))
    if (resp && !resp.record) {
      const missing = resp.problem?.code === 'missing'
      banners.append(h('div.banner.error', h('strong', missing ? `${ref} has no readable run.json` : `run.json cannot be used (${resp.problem?.code ?? resp.problem?.kind})`), ` — ${resp.problem?.message}. `,
        shown ? `Showing the last valid reading (seq ${shown.record!.seq}) read-only; nothing is recorded until the files are fixed. wfe run check names the difference.` : 'Nothing is shown until the files are fixed.'))
    }
    if (rev && resp?.revInfo) banners.append(h('div.banner.warn', `As committed in the ${resp.revInfo.owner === 'root' ? 'project root' : 'devdocs repository'} at ${resp.revInfo.commit.slice(0, 10)}${resp.revInfo.root ? ` (the devdocs gitlink of root commit ${resp.revInfo.root.slice(0, 10)})` : ''} (${when(resp.revInfo.date)}): “${resp.revInfo.subject}”. Read-only. `, h('a.button', { href: runHash(wsId, ref) }, 'Open the current run')))
    if (opNotice) banners.append(h(`div.banner.${opNotice.kind}`, opNotice.text, h('button.icon-btn', { onclick: () => { opNotice = null; renderBanners() } }, '×')))
  }

  function renderLegend() {
    legend.replaceChildren(h('span.muted.small', 'Node states:'),
      ...['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'blocked'].map(s => chip(s)),
      h('span.muted.small', ' · the graph is this run’s fixed copy; click a node for details'))
  }

  // ---- side panel -------------------------------------------------------------

  function section(title: string, ...body: (Node | null)[]) {
    return h('section.side-sec', h('h3', title), ...body)
  }

  function nodeDetail(rec: RunRecord, id: string): HTMLElement {
    const n: NodeRecord = rec.nodes[id]
    const def = shown?.bundle[rec.definition.root]?.workflow?.nodes[id]
    const { state, label } = nodeLabel(rec, id)
    const box = h('div.node-detail')
    box.append(h('div.insp-head', icon(def?.type ?? 'unknown', 'icon'), h('h3', def?.name || id), h('code', id), h('button.icon-btn', { title: 'Close', onclick: () => { selection = null; render() } }, '×')))
    box.append(h('div.chips', chip(state, label), h('span.chip', TYPE_LABEL[def?.type ?? ''] ?? def?.type ?? '?')))
    if (def?.description) box.append(h('p.small', def.description))
    const rows: [string, string][] = [['Started', n.started ? when(n.started) : '—'], ['Ended', n.ended ? when(n.ended) : '—'], ['Last update', n.updated ? `${when(n.updated)} (${ago(n.updated)})` : '—']]
    box.append(h('dl.kv', ...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)])))
    if (n.wait) {
      const on = n.wait.on
      box.append(h('div.wait-box', h('strong', 'Waiting: '), n.wait.reason, h('br'), 'Next move: ', h('strong', holderOf(rec, id)),
        'external' in on ? h('div.small', `Awaiting: ${on.external}`) : null))
    }
    if (n.outcome) box.append(h('div.outcome', h('strong', 'Outcome: '), n.outcome.text,
      ...n.outcome.artifacts.map(a => h('div.small', fileButton(a)))))
    if (n.failure) box.append(h('div.banner.error', `Failed (${n.failure.by}, ${when(n.failure.at)}): ${n.failure.reason}`))
    if (n.cancellation) box.append(h('div.banner.warn', `Cancelled (${n.cancellation.by}, ${when(n.cancellation.at)}): ${n.cancellation.reason}`))
    if (n.notes.length) box.append(h('h4', 'Notes'), h('ul.notes', ...n.notes.map(x => h('li', h('span.muted.small', `${when(x.at)} · ${x.by}: `), x.text))))
    const qs = Object.values(rec.questions).filter(q => q.node === id)
    if (qs.length) box.append(h('h4', 'Questions of this node'), ...qs.map(q => questionCard(rec, q)))
    return box
  }

  function questionCard(rec: RunRecord, q: Question): HTMLElement {
    const st = questionState(q)
    const card = h(`div.question.q-${st}`, { dataset: { question: q.id } })
    card.append(h('div.q-head', h('strong', q.id), chip(st === 'open' ? 'waiting' : st === 'answered' ? 'running' : st === 'taken-up' ? 'completed' : 'cancelled', st), h('span.muted.small', ` to ${q.to}${q.node ? ` · node ${q.node}` : ''} · asked by ${q.askedBy}, ${ago(q.asked)}`)))
    card.append(h('p.q-text', q.text))
    q.answers.forEach((a, i) => card.append(h('div.answer', h('span.muted.small', `Answer ${i}${q.takenUp?.answer === i ? ' — taken up' : ''} · from ${a.from}${a.by !== a.from ? `, recorded by ${a.by}` : ''} via ${a.via} · ${when(a.at)}`), h('div', a.text))))
    if (q.takenUp) card.append(h('p.small.ok-text', `Taken up by ${q.takenUp.by} ${ago(q.takenUp.at)}.`))
    if (q.withdrawn) card.append(h('p.small', `Withdrawn by ${q.withdrawn.by}: ${q.withdrawn.reason}`))
    if (st === 'answered') card.append(h('p.small.muted', `The answer is recorded; ${rec.executor.name} has not recorded taking it up yet.`))
    if ((st === 'open' || st === 'answered') && !rev && !rec.cancelled) {
      const key = `answer:${q.id}`
      const ta = h('textarea', { rows: 3, 'aria-label': `Answer to ${q.id}`, placeholder: 'Your answer', value: drafts.get(key) ?? '', dataset: { focusKey: key } })
      ta.addEventListener('input', () => drafts.set(key, ta.value))
      card.append(h('div.answer-form', ta,
        h('div.row.tight', h('button.primary', {
          disabled: !shown?.record || !!(resp && !resp.record),
          onclick: () => { if (ta.value.trim()) void submit({ op: 'question.answer', question: q.id, text: ta.value }, `Answer to ${q.id} recorded in run.json. Continue the conversation with ${rec.executor.name} in VS Code; recording does not notify it.`, [key]) },
        }, st === 'answered' ? 'Record another answer' : 'Record answer')),
        h('p.small.muted', 'Stored in run.json as your answer. It does not start or wake the IDE agent; tell it in VS Code.')))
    }
    return card
  }

  function fileButton(path: string, label = path) {
    return h('a.file-link', { href: '#', title: 'Show this file here (read-only)', onclick: (e: Event) => { e.preventDefault(); void openFile(path) } }, label)
  }

  async function openFile(path: string) {
    viewing = { path }
    render()
    try {
      const r = await api.runFile(wsId, workflow, run, path, rev ? shown?.rev ?? rev : undefined)
      if (viewing?.path === path) viewing = { path, text: r.text }
    } catch (e) {
      if (viewing?.path === path) viewing = { path, error: (e as Error).message }
    }
    render()
  }

  function renderSide() {
    // Keep focus and caret in a form being typed into across the rebuild.
    const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
    const focusKey = active && side.contains(active) ? active.dataset.focusKey : undefined
    const caret = focusKey ? [active!.selectionStart, active!.selectionEnd] : null
    side.replaceChildren()
    const r = shown
    const rec = r?.record
    if (!rec) { side.append(h('p.muted', resp?.problem ? 'No usable record.' : 'Loading…')); return }
    const name = h('input', { value: actor, placeholder: 'your name', 'aria-label': 'Your name', size: 14, dataset: { focusKey: 'actor' } })
    name.addEventListener('input', () => { actor = name.value })
    side.append(h('div.actor-row', h('label.small', 'Recording as ', name), h('span.muted.small', 'declared, like an approver; saved in this browser')))
    if (selection && rec.nodes[selection]) side.append(section('Selected node', nodeDetail(rec, selection)))

    const qs = Object.values(rec.questions)
    side.append(section(`Questions (${qs.filter(q => ['open', 'answered'].includes(questionState(q))).length} open)`,
      qs.length ? h('div.questions', ...qs.slice().reverse().map(q => questionCard(rec, q))) : h('p.muted.small', 'No questions recorded.')))

    const rel: (Node | null)[] = []
    if (r!.predecessor) rel.push(h('div', 'Predecessor: ', h('a', { href: runHash(wsId, r!.predecessor.ref) }, r!.predecessor.ref)))
    const input = rec.input
    if (input.kind === 'request' && input.entrustedBy) rel.push(h('div.small', 'Entrusted by: ', input.entrustedBy.kind === 'run' ? h('a', { href: runHash(wsId, runKey(input.entrustedBy)) }, `${runKey(input.entrustedBy)}${input.entrustedBy.node ? ` node ${input.entrustedBy.node}` : ''}`) : input.entrustedBy.kind === 'file' ? input.entrustedBy.path : input.entrustedBy.text))
    if (rel.length) side.append(section('Related runs', ...rel))

    const files = r!.files
    // Recorded artifacts outside the run folder; the folder's own files are listed above.
    const recorded = r!.artifacts.filter(a => !(a.path.startsWith(`${r!.dir}/`) && !a.path.slice(r!.dir.length + 1).includes('/')))
    side.append(section('Reports and files',
      h('p.small.muted', `${r!.dir}/ — open these in VS Code to edit; here they are read-only.`),
      h('ul.files', ...files.map(f => h('li', fileButton(f.name), h('span.muted.small', ` ${f.size} B${f.modified ? ` · ${ago(f.modified)}` : ''}`)))),
      recorded.length ? h('h4', 'Recorded artifacts') : null,
      recorded.length ? h('ul.files', ...recorded.map(a => h('li', a.exists ? fileButton(a.path) : h('span', a.path), a.exists ? null : h('span.chip.error', 'missing')))) : null,
      viewing ? h('div.file-view', h('div.row.tight', h('strong', viewing.path), h('button.icon-btn', { onclick: () => { viewing = null; render() } }, '×')),
        viewing.error ? h('p.error', viewing.error) : viewing.text === undefined ? h('p.muted', 'Loading…') : h('pre', viewing.text)) : null))

    if (!rev) side.append(section('Execution', ...executionPanel(rec)))
    if (!rev) side.append(section('Result', ...decisionForm(rec)))

    const history = rec.history.slice().reverse()
    side.append(section(`History (${history.length})`, h('ol.history', { reversed: true },
      ...history.map(e => {
        const d = e as unknown as Record<string, unknown>
        const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => `${n}: ${a ?? '—'} → ${b}`)
        if (e.change.execution) moves.push(`run: ${e.change.execution[0] ?? '—'} → ${e.change.execution[1]}`)
        const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.external ?? d.path ?? '') as string
        return h('li', { value: e.seq }, h('div', h('code', e.op), ` ${d.node ? `${d.node} ` : ''}${d.question ? `${d.question} ` : ''}`, h('span.muted.small', `· ${e.by} via ${e.via} · ${when(e.at)}`)),
          moves.length ? h('div.small', moves.join('; ')) : null, detail ? h('div.small.muted', detail.split('\n')[0].slice(0, 200)) : null)
      }))))

    if (focusKey) {
      const el = side.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      if (el) { el.focus(); if (caret && caret[0] !== null) el.setSelectionRange(caret[0], caret[1]) }
    }
  }

  // What runs, what waits and what is published: the record's control state
  // with this host's facts (process, queue, checkpoints) beside it.
  function executionPanel(rec: RunRecord): (Node | null)[] {
    const out: (Node | null)[] = []
    const sit = situation(rec)
    const open = execView?.attempts.find(a => a.state !== 'ended')
    const SIT: Record<string, string> = {
      executing: 'Executing', stopping: 'Stop requested — waiting for the process to end', 'awaiting-person': 'Awaiting a person — no process runs meanwhile',
      stopped: 'Stopped — resumes only when you resume it', interrupted: 'Interrupted — look at the working tree, then resume', unknown: 'Unknown — the process was lost; look, then resume',
      completed: 'Completed', cancelled: 'Cancelled', 'not-started': 'Not started', idle: 'Idle',
    }
    const process = open ? (open.alive === true ? `process ${open.pid} alive` : open.alive === false ? (open.pid ? `process ${open.pid} not seen alive` : 'launching') : 'process on another host') : ''
    out.push(h('div.row.tight', h(`span.chip.sit-${sit}`, SIT[sit] ?? sit), process ? h('span.muted.small', process) : null))
    if (rec.control.hold) out.push(h('p.small', `Held (${rec.control.hold.kind}) since ${when(rec.control.hold.since)} by ${rec.control.hold.by}: ${rec.control.hold.reason}`))
    if (execError) out.push(h('div.banner.warn', `Execution facts of this host could not be read: ${execError}`))
    else if (execView) out.push(h('p.small.muted', `Executor: ${execView.executor.state}${execView.executor.detail ? ` — ${execView.executor.detail}` : ''}`))
    const frozen = !!(resp && !resp.record) || !!rec.cancelled
    const instruction = h('textarea', { rows: 2, placeholder: 'what the executor should do now (after looking at the working tree)', 'aria-label': 'Resume instruction', value: drafts.get('resume') ?? '', dataset: { focusKey: 'resume' } })
    instruction.addEventListener('input', () => drafts.set('resume', instruction.value))
    out.push(h('div.row.tight',
      h('button', {
        disabled: frozen || !!rec.control.hold || !!rec.control.stop || sit === 'completed', title: 'Stop execution; the run stays resumable',
        onclick: () => { const reason = prompt('Stop this run? It stays resumable. Reason:'); if (reason?.trim()) void submit({ op: 'run.stop', reason }, 'Stop recorded.') },
      }, 'Stop'),
      rec.control.hold ? h('button.primary', {
        disabled: frozen, onclick: () => {
          if (!instruction.value.trim()) { opNotice = { kind: 'error', text: 'A resume needs your instruction.' }; renderBanners(); return }
          void submit({ op: 'run.resume', reason: instruction.value }, 'Resumed: the executor is queued.', ['resume'])
        },
      }, 'Resume') : null))
    if (rec.control.hold) out.push(instruction)
    if (execView?.jobs.some(j => j.state === 'queued' || j.state === 'claimed')) out.push(h('p.small', 'Queued: ', ...execView.jobs.filter(j => j.state === 'queued' || j.state === 'claimed').map(j => `${j.kind} (${j.state}) — ${j.reason}`)))
    if (execView?.attempts.length) {
      out.push(h('h4', `Attempts (${execView.attempts.length})`), h('ul.attempts', ...execView.attempts.slice().reverse().map(a => h('li.small',
        h('code', a.id), ` ${a.state === 'ended' ? `${a.outcome}${a.exit_code !== null ? ` (exit ${a.exit_code})` : a.signal ? ` (${a.signal})` : ''}` : a.state}`,
        h('span.muted', ` · ${when(a.began)}${a.ended ? ` → ${when(a.ended)}` : ''}${a.backend ? ` · ${a.backend}` : ''}${a.stop_requested ? ' · stop requested' : ''}`)))))
    }
    if (execView?.checkpoints.length) {
      out.push(h('h4', 'Publication'))
      for (const c of execView.checkpoints.slice().reverse().slice(0, 6)) {
        out.push(h('div.checkpoint.small',
          h(`span.chip.${c.state === 'published' || c.state === 'nothing' ? 'ok' : c.state === 'pending' ? 'muted' : 'warn'}`, c.state === 'nothing' ? 'nothing to publish' : c.state), ` ${c.kind}`,
          ...c.steps.map(st => h('div.muted', `${st.repo === '.' ? 'root' : st.repo}: ${st.commit ? `${st.commit.slice(0, 7)} ${st.pushed ? `pushed to ${st.branch}` : 'not pushed'}` : 'no commit'}${st.excluded.length ? `; left out (already changed before): ${st.excluded.join(', ')}` : ''}${st.conflicts.length ? `; needs you: ${st.conflicts.join(', ')} changed before the run and again by it` : ''}${st.error ? `; ${st.error}` : ''}`)),
          c.error ? h('div.error', c.error) : null,
          c.state === 'failed' || c.state === 'attention' ? h('button', { onclick: async () => { try { await api.retryCheckpoint(wsId, workflow, run, c.id); opNotice = { kind: 'ok', text: 'Publication retried.' } } catch (e) { opNotice = { kind: 'error', text: `Retry failed: ${(e as Error).message}` } } await load({}) } }, 'Retry publication') : null))
      }
    }
    return out
  }

  function decisionForm(rec: RunRecord): (Node | null)[] {
    const out: (Node | null)[] = []
    for (const d of rec.decisions) out.push(h(`div.banner.${d.decision === 'accepted' ? 'ok' : 'error'}`, `${d.decision} by ${d.by} (${when(d.at)}) — evidence: ${d.evidence}${d.note ? ` — ${d.note}` : ''}`))
    const completed = rec.execution.state === 'completed'
    out.push(h('p.small.muted', completed
      ? 'Execution completed: every node recorded completion. Accepting the result is your separate decision.'
      : `Execution is ${rec.execution.state}. A result can be accepted once every node is completed; it can be rejected at any time.`))
    const evidence = h('input', { placeholder: 'evidence: what you checked (report, commit, demo…)', 'aria-label': 'Decision evidence', value: drafts.get('evidence') ?? '', dataset: { focusKey: 'evidence' } })
    evidence.addEventListener('input', () => drafts.set('evidence', evidence.value))
    const decide = (decision: 'accepted' | 'rejected') => {
      if (!evidence.value.trim()) { opNotice = { kind: 'error', text: 'A decision needs its evidence.' }; renderBanners(); return }
      void submit({ op: 'run.decide', decision, evidence: evidence.value }, `Recorded: result ${decision}.`, ['evidence'])
    }
    const frozen = !!(resp && !resp.record)
    out.push(h('div.decide', evidence, h('div.row.tight',
      h('button.primary', { disabled: !completed || frozen, onclick: () => decide('accepted') }, 'Accept result'),
      h('button.danger', { disabled: frozen, onclick: () => decide('rejected') }, 'Reject result'),
      h('button', {
        disabled: !!rec.cancelled || frozen, title: 'Discontinue the run: every pending, running or waiting node is cancelled',
        onclick: () => {
          const reason = prompt('Cancel this run? Every pending, running or waiting node is cancelled. Reason:')
          if (reason?.trim()) void submit({ op: 'run.cancel', reason }, 'Recorded: the run is cancelled.')
        },
      }, 'Cancel run'))))
    return out
  }

  function render() {
    if (disposed) return
    renderCrumbs()
    renderBanners()
    liveState.replaceChildren(rev ? h('span.pill', 'history') : connected ? h('span.pill.ok', 'live') : h('span.pill.warn', 'not live'))
    const r = shown
    renderSummary(r)
    const rec = r?.record
    const wf = rec ? r!.bundle[rec.definition.root]?.workflow : undefined
    canvas.el.hidden = !wf
    if (rec && wf) {
      const status = Object.fromEntries(Object.keys(rec.nodes).map(id => [id, nodeLabel(rec, id)]))
      const sel = selection && rec.nodes[selection] ? { kind: 'node' as const, id: selection } : null
      // Bindings resolve against the repositories recorded at creation.
      const repositories = rec.context.repositories.map(c => ({ path: c.path, name: c.path, kind: c.path === '.' ? 'root' as const : 'submodule' as const, category: 'other' as const, initialized: true, dirty: c.dirty ?? 0 }))
      canvas.render(wf, {
        repositories, readonly: true, errorNodes: new Set(), run: status,
        workflows: Object.entries(r!.bundle).filter(([, b]) => b.workflow).map(([id, b]) => ({ file: b.file, id, name: b.workflow!.name, errors: 0, warnings: 0, delegates: [] })),
      }, sel)
    }
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
    flush: () => load({}),
    state: c => { connected = c; render() },
  })
  // Relative times ("5 min ago") age while nothing is recorded.
  const clock = setInterval(() => { if (shown?.record) renderSummary(shown) }, 30_000)
  // This host's execution facts (process, queue, publication) change without
  // a run.json change; they are re-read every 3 s.
  const execTimer = rev ? undefined : setInterval(async () => {
    if (disposed || !shown?.record) return
    try {
      const v = await api.runExec(wsId, workflow, run)
      if (JSON.stringify(v) !== JSON.stringify(execView)) { execView = v; execError = ''; renderSide() }
    } catch (e) { if (!execError) { execError = (e as Error).message; renderSide() } }
  }, 3000)

  renderCrumbs()
  render()
  void load({}).then(() => canvas.fit())
  void loadProjectName()
  return {
    dispose: () => { disposed = true; stream?.close(); clearInterval(clock); clearInterval(execTimer) },
    isDirty: () => [...drafts.values()].some(v => v.trim() !== ''),
  }
}
