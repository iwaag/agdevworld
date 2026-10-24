// The file layer of the reminders at operation boundaries (workflow_editor
// fix5, shared/reminders.ts): what the run's copy shows of work done, and the
// refusal an agent's operation gets when a reminder applies and it did not
// say --yes. Evaluated inside the operation's own lock, against the record
// the operation would change, before anything is written.
import { git } from './git.ts'
import { RequestError, type Workspace } from './workspace.ts'
import type { RunCatalog } from '../shared/catalog.ts'
import type { Workflow } from '../shared/model.ts'
import { evaluate, reminderText, type Boundary, type Reminder } from '../shared/reminders.ts'
import { runFolder, type RunGraph, type RunRecord } from '../shared/run.ts'

// How an operation takes part (CLI and HTTP give it for an agent's or a
// person's operation; absent for WFE's own records: an attempt's end, an
// intake, a discussion's completion on a run's behalf). `yes` continues past
// the reminders of this one operation; `extra` adds checks made elsewhere
// for it; `what` names the operation in the refusal.
export interface Advice { yes?: boolean; extra?: Reminder[]; what?: string }

const SIGNAL_PATHS = 5

// Paths of the run's own copy changed since it began, outside its record
// folder: a sign that work was done, not where or as which activity.
export async function workSignals(ws: Workspace, record: RunRecord): Promise<string[]> {
  const out: string[] = []
  const own = `${runFolder(record)}/`
  const base = record.storage?.repositories.find(r => r.path === '.')?.base
  if (ws.copyOf && base) {
    const changed = new Set<string>()
    const d = await git(ws.root, ['diff', '--name-only', base, '--'])
    if (d.code === 0) for (const l of d.stdout.split('\n')) if (l.trim()) changed.add(l.trim())
    const u = await git(ws.root, ['status', '--porcelain', '--untracked-files=all'])
    if (u.code === 0) for (const l of u.stdout.split('\n')) if (l.length > 3) changed.add(l.slice(3).trim().replace(/^"|"$/g, ''))
    const paths = [...changed].filter(p => !p.startsWith(own) && !p.startsWith('.local/')).sort()
    if (paths.length) out.push(`the run's copy has ${paths.length} changed path${paths.length === 1 ? '' : 's'} outside its records (${paths.slice(0, SIGNAL_PATHS).join(', ')}${paths.length > SIGNAL_PATHS ? ', …' : ''})`)
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
// node) give one response.
export async function adviseOrRefuse(ws: Workspace, advice: Advice | undefined, b: Boundary | Boundary[], f: { record: RunRecord; after: RunRecord; graph: RunGraph; authored: Pick<Workflow, 'nodes'> | undefined; catalog: RunCatalog }): Promise<void> {
  if (!advice || advice.yes) return
  const bs = [b].flat()
  const signals = bs.every(x => x.kind === 'present') ? [] : await workSignals(ws, f.after)
  const reminders: Reminder[] = []
  for (const x of bs) for (const r of evaluate(x, { ...f, signals, extra: advice.extra })) if (!reminders.some(y => y.code === r.code)) reminders.push(r)
  if (!reminders.length) return
  const what = advice.what ?? bs.map(describe).join(' and ')
  throw new RequestError(409, reminderText(reminders, what), { code: 'reminder', boundaries: bs.map(x => x.kind), reminders })
}

const describe = (b: Boundary) => b.kind === 'complete' ? `completing ${b.node}` : b.kind === 'ask' ? `asking ${b.to}` : b.kind === 'present' ? `registering a presentation from ${b.node}` : `posting this ${b.messageKind}`
