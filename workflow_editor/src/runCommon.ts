// What the run view's parts share: state labels, relative times, node
// labels and the small builders of its display. Built display carries no
// listeners; links and buttons name their action in data-action and the
// view handles them in one place (runView.ts), reading its state then.
import type { RunResponse } from '../shared/api.ts'
import type { RunExecView } from './api.ts'
import { holderOf, runDisplayTitle, type RunRecord } from '../shared/run.ts'
import { h, when } from './dom.ts'

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

// The execution node that performs a run (project_migration p7), as the
// coordinator last heard from it. `remote`: its process and live files are on
// that worker; the coordinator shows what it reported and published.
// Contact lost is said as such, never as an ended process.
export interface NodeFacts { node: string; label: string; remote: boolean; state: 'available' | 'unavailable' | 'unknown'; contact: string; line: string; tone: 'ok' | 'warn' | 'muted' }
export function nodeFacts(rec: RunRecord, ev: RunExecView | null | undefined): NodeFacts | null {
  const workers = ev?.workers
  if (!workers?.length) return null
  const node = rec.executor.node ?? workers.find(w => w.default)?.id
  const w = workers.find(x => x.id === node)
  if (!node || !w) return node ? { node, label: node, remote: true, state: 'unknown', contact: 'not a worker of this area', line: `Execution node ${node}: not a worker of this area`, tone: 'warn' } : null
  const contact = !w.at ? 'never reported' : w.state === 'available' ? `last contact ${ago(w.at)}` : `contact lost — last ${ago(w.at)}`
  const line = `Execution node: ${w.id}${w.label && w.label !== w.id ? ` (${w.label})` : ''} — ${w.state === 'available' ? 'available' : w.state === 'unavailable' ? 'unavailable' : 'not reported yet'}, ${contact}`
  return { node: w.id, label: w.label, remote: !w.local, state: w.state, contact, line, tone: w.state === 'available' ? 'ok' : 'warn' }
}

export const runHash = (ws: string, ref: string, rev?: string) =>
  `#/ws/${encodeURIComponent(ws)}/run/${ref.split('/').map(encodeURIComponent).join('/')}${rev ? `/at/${encodeURIComponent(rev)}` : ''}`

// The state a node is shown with: pending splits into ready / blocked / pending.
function shownState(rec: RunRecord, id: string): string {
  const n = rec.nodes[id]
  if (n.state !== 'pending') return n.state
  return rec.execution.ready.includes(id) ? 'ready' : rec.execution.blocked.includes(id) ? 'blocked' : 'pending'
}

export function nodeLabel(rec: RunRecord, id: string): { state: string; label: string; title: string } {
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

// What the run view calls a run (p8): the title of its latest presentation
// when it has one — the result as the executor named it for the person —
// otherwise its workflow's name; the run reference always beside it.
// Recorded data only: nothing is generated or summarised.
export function runTitle(rec: RunRecord, workflowName?: string): { title: string; sub: string } {
  const p = Object.values(rec.presentations ?? {}).at(-1)
  const name = workflowName || rec.workflow
  return { title: runDisplayTitle(rec, workflowName), sub: p ? `${name} · ${rec.workflow}/${rec.run}` : `${rec.workflow}/${rec.run}` }
}

// Authored nodes in dependency order (a stable topological order: file
// order among nodes whose predecessors are all listed).
export function topoOrder(ids: string[], edges: { from: string; to: string }[]): string[] {
  const set = new Set(ids)
  const preds = new Map(ids.map(id => [id, edges.filter(e => e.to === id && set.has(e.from) && e.from !== id).map(e => e.from)]))
  const out: string[] = [], done = new Set<string>()
  while (out.length < ids.length) {
    const next = ids.find(id => !done.has(id) && preds.get(id)!.every(p => done.has(p))) ?? ids.find(id => !done.has(id))! // a cycle: file order
    out.push(next); done.add(next)
  }
  return out
}

// Every node reachable from `from` (its descendants).
export function descendants(from: string, edges: { from: string; to: string }[]): Set<string> {
  const out = new Set<string>(), todo = [from]
  while (todo.length) { const n = todo.pop()!; for (const e of edges) if (e.from === n && !out.has(e.to)) { out.add(e.to); todo.push(e.to) } }
  return out
}

// The authored definition in force (p7): the latest adjusted revision, or
// the snapshot taken at creation.
export function activeWorkflow(r: RunResponse | null, rec: RunRecord) {
  return r?.revisions?.at(-1)?.workflow ?? r?.bundle[rec.definition.root]?.workflow
}

export const chip = (state: string, text = STATE_LABEL[state] ?? state) => h(`span.state-chip.state-${state}`, { dataset: { state } }, text)
export const fact = (k: string, v: string, cls = '') => h(`div.fact${cls ? `.${cls}` : ''}`, h('span.k', k), h('span.v', v))
export const line = (k: string, items: (Node | string | null)[], cls = '') => h(`div.now-line${cls ? `.${cls}` : ''}`, h('span.k', k), h('span.v', ...items.filter((x): x is Node | string => x !== null).flatMap((x, i) => (i ? [', ', x] : [x]))))
export const nodeLink = (id: string, text = id) => h('a.node-link', { href: '#', dataset: { action: 'node', node: id } }, text)
export const fileLink = (path: string, label = path) => h('a.file-link', { href: '#', title: 'Show this file here (read-only)', dataset: { action: 'file', path } }, label)
