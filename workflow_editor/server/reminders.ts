// The file layer of the reminders at operation boundaries (workflow_editor
// fix5, shared/reminders.ts): what the run's copy shows of work done, and the
// refusal an agent's operation gets when a reminder applies and it did not
// say --yes. Evaluated inside the operation's own lock, against the record
// the operation would change, before anything is written.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './git.ts'
import { RequestError, type Workspace } from './workspace.ts'
import type { RunCatalog } from '../shared/catalog.ts'
import type { Workflow } from '../shared/model.ts'
import { evaluate, nodeIntervals, reminderText, type Boundary, type Reminder } from '../shared/reminders.ts'
import { endsWork, runFolder, type RunGraph, type RunRecord } from '../shared/run.ts'

// How an operation takes part (CLI and HTTP give it for an agent's or a
// person's operation; absent for WFE's own records: an attempt's end, an
// intake, a discussion's completion on a run's behalf). `yes` continues past
// the reminders of this one operation; `extra` adds checks made elsewhere
// for it; `what` names the operation in the refusal.
// `assess` (fix6): the delegated results this run reports, assessed by the
// caller that can read its children (server/delegate.ts); asked for at an
// outward report and at the completion that completes the run.
// `delegatedOnly` (fix6): an outward message whose own checks are not
// fix5's (a conductor's announcement): only the delegated results it reports
// are assessed.
export interface Advice { yes?: boolean; extra?: Reminder[]; what?: string; assess?: (record: RunRecord) => Promise<Reminder[]>; delegatedOnly?: boolean }

const SIGNAL_PATHS = 5

// A path of the run's copy changed since the run began (in any repository
// it owns: the root and its sub-repositories, fix6 — misc/freework/run-003's
// screenshots were in wedo/wedo-misc), outside its record folder and
// .local/, with when it was last written (null: gone).
export interface ChangedPath { path: string; mtime: number | null }
export async function changedPaths(ws: Workspace, record: RunRecord): Promise<ChangedPath[] | null> {
  if (!ws.copyOf || !record.storage) return null
  const own = `${runFolder(record)}/`
  const out = new Map<string, ChangedPath>()
  const subs = record.storage.repositories.filter(r => r.path !== '.').map(r => r.path)
  for (const repo of record.storage.repositories) {
    if (!repo.base) continue
    const dir = repo.path === '.' ? ws.root : join(ws.root, repo.path)
    const prefix = repo.path === '.' ? '' : `${repo.path}/`
    const changed = new Set<string>()
    const d = await git(dir, ['diff', '--name-only', repo.base, '--'])
    if (d.code === 0) for (const l of d.stdout.split('\n')) if (l.trim()) changed.add(l.trim())
    const u = await git(dir, ['status', '--porcelain', '--untracked-files=all'])
    if (u.code === 0) for (const l of u.stdout.split('\n')) if (l.length > 3) changed.add(l.slice(3).trim().replace(/^"|"$/g, ''))
    for (const rel of changed) {
      const p = `${prefix}${rel}`
      // A sub-repository's own pointer in the root is its files, listed with it.
      if (repo.path === '.' && subs.includes(p)) continue
      if (p.startsWith(own) || p.startsWith('.local/') || rel.startsWith('.local/')) continue
      out.set(p, { path: p, mtime: (await stat(join(ws.root, p)).catch(() => null))?.mtimeMs ?? null })
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path))
}

// When each node was running, from the history's transitions (milliseconds).
export function nodeSpans(record: RunRecord, until = record.updated): { node: string; from: number; to: number }[] {
  const since: Record<string, number> = {}
  const out: { node: string; from: number; to: number }[] = []
  for (const e of record.history) {
    for (const [n, [, to]] of Object.entries(e.change?.nodes ?? {})) {
      const t = Date.parse(e.at)
      if (since[n] !== undefined) { out.push({ node: n, from: since[n], to: t }); delete since[n] }
      if (to === 'running') since[n] = t
    }
  }
  for (const [n, t] of Object.entries(since)) out.push({ node: n, from: t, to: Date.parse(until) })
  return out
}

// Paths of the run's copy by the node running when each was last written.
// Several nodes running at once share them; a path written while none ran
// is not attributed.
const SLACK_MS = 60_000
export function pathsByNode(paths: ChangedPath[], record: RunRecord, until = new Date().toISOString()): Record<string, string[]> {
  const spans = nodeSpans(record, until)
  const out: Record<string, string[]> = {}
  for (const p of paths) {
    if (p.mtime === null) continue
    for (const s of spans) if (p.mtime >= s.from - SLACK_MS && p.mtime <= s.to + SLACK_MS) (out[s.node] ??= []).push(p.path)
  }
  return out
}

// Paths of the run's own copy changed since it began, outside its record
// folder: a sign that work was done, not where or as which activity.
// A path last written while a node of its own was running (`explained`,
// nodeIntervals) is the graph's; the others are the signal. A path that is
// gone counts as unexplained. gimmickimg/freework/run-011 copied files in
// its present node: explained; run-005…008 wrote theirs during the talk.
export async function workSignals(ws: Workspace, record: RunRecord, explained: [number, number][] = [], paths?: ChangedPath[] | null): Promise<string[]> {
  const out: string[] = []
  const own = `${runFolder(record)}/`
  const found = paths === undefined ? await changedPaths(ws, record) : paths
  if (found) {
    const unexplained = found.filter(p => p.mtime === null || !explained.some(([a, b]) => p.mtime! >= a - SLACK_MS && p.mtime! <= b + SLACK_MS)).map(p => p.path)
    if (unexplained.length) out.push(`the run's copy has ${unexplained.length} changed path${unexplained.length === 1 ? '' : 's'} outside its records, written while no node of its own was running (${unexplained.slice(0, SIGNAL_PATHS).join(', ')}${unexplained.length > SIGNAL_PATHS ? ', …' : ''})`)
  }
  const files = record.artifacts.filter(a => !a.path.startsWith(own)).map(a => a.path)
  if (files.length) out.push(`artifacts outside the run folder are recorded (${[...new Set(files)].slice(0, SIGNAL_PATHS).join(', ')})`)
  const outputs = Object.keys(record.outputs ?? {})
  if (outputs.length) out.push(`outputs ${outputs.join(', ')} were published`)
  return out
}

// Evaluates the boundary and refuses with every reminder at once, unless
// the caller continues (--yes) or is WFE itself (no advice).
// Several boundaries of one operation (a post that reports and completes its
// node) give one response, with the delegated results' reminders (fix6).
export async function adviseOrRefuse(ws: Workspace, advice: Advice | undefined, b: Boundary | Boundary[], f: { record: RunRecord; after: RunRecord; graph: RunGraph; authored: Pick<Workflow, 'nodes'> | undefined; catalog: RunCatalog }): Promise<void> {
  if (!advice || advice.yes) return
  const bs = [b].flat()
  const now = new Date().toISOString()
  const paths = advice.delegatedOnly || bs.every(x => x.kind === 'present') ? null : await changedPaths(ws, f.after)
  const signals = advice.delegatedOnly || bs.every(x => x.kind === 'present') ? [] : await workSignals(ws, f.after, nodeIntervals(f.after, f.graph, f.authored, now), paths)
  const changedByNode = paths ? pathsByNode(paths, f.after, now) : {}
  const reminders: Reminder[] = []
  const put = (r: Reminder) => { if (!reminders.some(y => y.code === r.code && y.refs.join() === r.refs.join())) reminders.push(r) }
  if (!advice.delegatedOnly) for (const x of bs) for (const r of evaluate(x, { ...f, signals, changedByNode, extra: advice.extra })) put(r)
  const completesRun = bs.some(x => x.kind === 'complete') && endsWork(f.record, f.after)
  if (advice.assess && (bs.some(x => x.kind === 'report') || completesRun) && Object.keys(f.after.delegations ?? {}).length) for (const r of await advice.assess(f.after)) put(r)
  if (!reminders.length) return
  const what = advice.what ?? bs.map(describe).join(' and ')
  throw new RequestError(409, reminderText(reminders, what), { code: 'reminder', boundaries: bs.map(x => x.kind), reminders })
}

const describe = (b: Boundary) => b.kind === 'complete' ? `completing ${b.node}` : b.kind === 'ask' ? `asking ${b.to}` : b.kind === 'present' ? `registering a presentation from ${b.node}` : `posting this ${b.kind === 'report' ? b.messageKind : ''}`
