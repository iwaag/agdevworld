// Reminders at operation boundaries (workflow_editor fix5, docs/runs.md
// "Reminders"): one evaluator over a run's records and the operation an agent
// is about to record — a completion, a question, a presentation's
// registration, an outward report. Shared by the service, the CLI and the
// browser; it touches no files. What the file layer observes (changed files
// in the run's copy) comes in as `signals`.
//
// A reminder is not proof of an omission: WFE cannot observe every shell
// action, nor judge whether a result needs a presentation. Each one says what
// the records show, what is unknown, how to repair it, and that the same
// command with --yes continues. gimmickimg/freework/run-010 recorded its
// experiment as nodes and completed with no presentation; run-011 presented
// it only because a separate request asked (fix4's report). run-001…008 did
// their work inside the talk.
import type { RunCatalog } from './catalog.ts'
import type { Workflow, WorkflowNode } from './model.ts'
import { isOpen, questionState, runKey, type Presentation, type RunGraph, type RunRecord } from './run.ts'

// What a node is for, as far as its structured records say. Never its name.
// - present / cleanup: made from the catalog's seed templates (present,
//   cleanup), drawn with their icon, or (present) a node a presentation was
//   registered from. A presentation linked to work recorded afterwards
//   shows that work; it does not make the work a presentation node;
// - work: made from the catalog's `work` template, or an untemplated `do`
//   node the run added itself (not in its original definition): the work the
//   agent decided on. A designed workflow's own nodes are the designer's;
// - step: a generated documentation step; activity: a discussion activity;
//   confirm: the result-confirmation talk; talk: any other talk.
export type NodeRole = 'present' | 'cleanup' | 'work' | 'confirm' | 'talk' | 'activity' | 'step' | 'other'
const PRESENT = 'present', CLEANUP = 'cleanup', WORK = 'work'

export function roleOf(id: string, record: Pick<RunRecord, 'definition' | 'presentations'>, graph: RunGraph, authored: Pick<Workflow, 'nodes'> | undefined): NodeRole {
  const g = graph.nodes[id]
  if (!g || g.step) return 'step'
  if (g.activity) return 'activity'
  const a: Partial<WorkflowNode> = authored?.nodes[id] ?? {}
  const pres = Object.values(record.presentations ?? {})
  if (a.template?.id === PRESENT || a.appearance?.icon === PRESENT || pres.some(p => p.node === id)) return 'present'
  if (a.template?.id === CLEANUP || a.appearance?.icon === CLEANUP) return 'cleanup'
  if (g.confirms === 'result') return 'confirm'
  if (g.type === 'talk') return 'talk'
  if (a.template?.id === WORK) return 'work'
  if (g.type === 'do' && !a.template && !record.definition.effective?.nodes[id]) return 'work'
  return 'other'
}

// The operation about to be recorded.
export type Boundary =
  | { kind: 'complete'; node: string } // node.complete, adjust --completing, a conversation post that completes its node
  | { kind: 'ask'; node: string | null; to: string; presents: boolean } // presents: --presentation, --output or --subject
  | { kind: 'present'; node: string } // presentation.register
  | { kind: 'report'; messageKind: string } // an outward conversation post (result, synthesis)

export interface Facts {
  record: RunRecord // as it is now
  // As the operation would leave it (the reducer applied to a copy), and the
  // graph and authored definition in force then; equal to the current ones
  // for operations that do not change the definition.
  after: RunRecord
  graph: RunGraph
  authored: Pick<Workflow, 'nodes'> | undefined
  catalog: RunCatalog
  // File-layer observations that work may have been done (changed paths in
  // the run's copy outside its records, …), each as a short phrase.
  signals: string[]
  // Checks made elsewhere for the same operation (a conductor's open
  // discussion), merged into one response.
  extra?: Reminder[]
}

export interface Reminder {
  code: string
  text: string // the observed facts and what stays unknown
  repair: string[] // concrete commands or acts
  refs: string[] // nodes, presentations, questions it is about
}

// How long a talk may run before work inside it is plausible (a signal for
// the self-check, never a finding by itself).
export const LONG_TALK_MS = 10 * 60_000

const list = (xs: string[]) => xs.join(', ')
const planned = (state: string | undefined) => state === 'pending' || state === 'running' || state === 'waiting'

// Milliseconds each node spent running, from the history's transitions.
export function runningTime(record: RunRecord, until = record.updated): Record<string, number> {
  const since: Record<string, number> = {}
  const total: Record<string, number> = {}
  for (const e of record.history) {
    for (const [n, [, to]] of Object.entries(e.change?.nodes ?? {})) {
      const t = Date.parse(e.at)
      if (since[n] !== undefined) { total[n] = (total[n] ?? 0) + (t - since[n]); delete since[n] }
      if (to === 'running') since[n] = t
    }
  }
  for (const [n, t] of Object.entries(since)) total[n] = (total[n] ?? 0) + Math.max(0, Date.parse(until) - t)
  return total
}

// The seq at which each node was last completed (or recorded as done).
function completedAt(record: RunRecord): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of record.history) for (const [n, [, to]] of Object.entries(e.change?.nodes ?? {})) if (to === 'completed') out[n] = e.seq
  return out
}

function registeredAt(record: RunRecord, p: Presentation): number {
  return record.history.find(e => e.op === 'presentation.register' && (e as { presentation?: string }).presentation === p.id)?.seq ?? 0
}

export function evaluate(b: Boundary, f: Facts): Reminder[] {
  const { record, after, graph, authored } = f
  const run = runKey(record)
  const role = (id: string) => roleOf(id, after, graph, authored)
  const ids = Object.keys(after.nodes)
  const out: Reminder[] = [...(f.extra ?? [])]
  const add = (r: Reminder) => { if (!out.some(x => x.code === r.code)) out.push(r) }
  const completesRun = b.kind === 'complete' && record.execution.state !== 'completed' && after.execution.state === 'completed'
  const completing = b.kind === 'complete' ? b.node : null
  const templates = f.catalog.state === 'supplied' ? f.catalog.snapshot.templates : []
  const has = (t: string) => templates.some(x => x.id === t)
  const instantiate = (t: string, where: string) => has(t)
    ? `wfe nodes instantiate ${t} --run ${run} --file <draft> ${where} (draft: wfe run revisions ${run} --show ${after.definition.active ?? 'r1'} > <draft>), then wfe run adjust ${run} --definition <draft> --reason "…"`
    : `add a ${t} node to a draft of the definition (wfe run revisions ${run} --show ${after.definition.active ?? 'r1'} > <draft>), then wfe run adjust ${run} --definition <draft> --reason "…"`

  // A discussion activity completed with a plain completion (fix3).
  if (completing && graph.nodes[completing]?.activity) {
    const a = graph.nodes[completing].activity!
    const how: Record<string, string> = {
      announce: `wfe discussion announce --node ${completing} --text … --re … (with --conclude [--close] for the conclusion)`,
      ask: `let WFE complete it when its invitations are resolved, or move on with wfe discussion settle --node ${completing} --reason …`,
      ponder: `wfe discussion ponder --node ${completing} --decision … --source … (--next adds what comes next)`,
    }
    if (how[a]) add({ code: 'discussion-activity', refs: [completing], text: `${completing} is the ${a} activity of a discussion. Completed this way, the discussion gets no record of it (no message, decision or outcomes).`, repair: [how[a]] })
  }

  // Open presentations and who stops them.
  const open = Object.values(after.presentations ?? {}).filter(isOpen)
  const cleanupPlanned = ids.filter(id => id !== completing && role(id) === 'cleanup' && planned(after.nodes[id]?.state))
  const reviewed = completing ? Object.values(record.questions).filter(q => q.node === completing && q.presentation && q.answers.length) : []
  const presentationsChecked = completesRun || b.kind === 'report' || (completing && role(completing) === 'cleanup') || reviewed.length > 0
  if (presentationsChecked && open.length && !cleanupPlanned.length) {
    const about = open.map(p => {
      const qs = Object.values(after.questions).filter(q => q.presentation?.id === p.id)
      return `${p.id} "${p.title}" (${p.state}, registered from ${p.node}${qs.length ? `; asked in ${qs.map(q => `${q.id}, ${questionState(q)}`).join('; ')}` : '; never asked about'})`
    })
    const why = completing && role(completing) === 'cleanup' ? `${completing} is a cleanup node, yet ${open.length === 1 ? 'this presentation is' : 'these presentations are'} still recorded as serving`
      : reviewed.length ? `${completing} took the person's answer to ${list(reviewed.map(q => q.id))} about ${list(reviewed.map(q => q.presentation!.id))}; if the review is finished, cleanup is due`
        : completesRun ? 'this completes the run' : 'this reports the result'
    add({
      code: 'presentation-serving', refs: open.map(p => p.id),
      text: `${why}: ${list(about)} ${open.length === 1 ? 'is' : 'are'} still serving, and no cleanup node is planned. An answer may ask for changes or for the page to stay available; only the answer tells which. A page nobody stops serves on.`,
      repair: [`if the review is finished: wfe present stop ${run} ${open.length === 1 ? open[0].id : '--all'}, then wfe present status ${run} (stopped: process gone, port no longer answering)`,
        `or plan it: ${instantiate(CLEANUP, completing ? `--after ${completing}` : '')}`],
    })
  }

  // Work completed and not presented.
  const done = completedAt(after)
  const work = ids.filter(id => role(id) === 'work')
  const workDone = work.filter(id => after.nodes[id]?.state === 'completed')
  const pres = Object.values(after.presentations ?? {})
  const covered = Math.max(0, ...pres.map(p => registeredAt(after, p)))
  const linked = new Set(pres.flatMap(p => p.links?.map(l => l.node) ?? []))
  const unpresented = workDone.filter(id => (done[id] ?? 0) > covered && !linked.has(id))
  const presentPlanned = ids.some(id => id !== completing && role(id) === 'present' && planned(after.nodes[id]?.state))
  const lastWork = !!completing && role(completing) === 'work' && !work.some(id => id !== completing && planned(after.nodes[id]?.state))
  const confirmWithout = b.kind === 'ask' && !b.presents && !!b.node && role(b.node) === 'confirm'
  if ((completesRun || lastWork || b.kind === 'report' || confirmWithout) && unpresented.length && !presentPlanned) {
    const since = pres.length ? `after the latest presentation (${pres.at(-1)!.id}) was registered` : 'and the run has no presentation'
    add({
      code: 'presentation-missing', refs: unpresented,
      text: `${list(unpresented)} ${unpresented.length === 1 ? 'is' : 'are'} work this run completed ${since}, and no presentation node is planned. Whether this result needs one is your judgement: the person's catalog expects a node that presents what they can look at or try, before they confirm it.`,
      repair: [`present it through its own node: ${instantiate(PRESENT, `--after ${unpresented.at(-1)}`)}; in it, wfe present register / start, then ask with wfe run ask … --presentation <p>`,
        'if the work only produced records that need no viewing, continue with --yes'],
    })
  }

  // A presentation registered from a node that is not its own, or with
  // nothing planned to stop it.
  if (b.kind === 'present') {
    const r = role(b.node)
    if (r === 'talk' || r === 'work' || r === 'confirm' || r === 'activity') {
      add({
        code: 'presentation-inside-work', refs: [b.node],
        text: `${b.node} is a ${r === 'work' ? 'work' : r === 'confirm' ? 'result-confirmation' : r === 'activity' ? 'discussion activity' : 'talk'} node; a presentation registered from it does not appear as a step of its own (gimmickimg/freework/run-001…008 presented from inside the talk).`,
        repair: [`add a present node and register from it: ${instantiate(PRESENT, `--after ${b.node}`)}; then complete ${b.node}, start the new node and wfe present register ${run} <it> …`],
      })
    }
    if (!ids.some(id => role(id) === 'cleanup' && planned(after.nodes[id]?.state))) {
      add({
        code: 'cleanup-unplanned', refs: [b.node],
        text: 'No cleanup node is planned: the page keeps serving after your session ends, until someone stops it (fix4: three review pages of run-005…008 served on).',
        repair: [`plan its stop: ${instantiate(CLEANUP, '--after <the node that takes the review answer>')}`],
      })
    }
  }

  // The self-check before speaking outward or completing the run: work done
  // outside nodes cannot be seen in the records, only suspected.
  const outward = b.kind === 'report' || b.kind === 'ask' || completesRun
  const visible = ids.some(id => { const x = role(id); return (x === 'work' || x === 'other') && (after.nodes[id]?.state === 'completed' || after.nodes[id]?.state === 'running') })
  if (outward && templates.length && !visible) {
    const time = runningTime(after)
    const talks = ids.filter(id => role(id) === 'talk' && (time[id] ?? 0) > LONG_TALK_MS)
    const signals = [...f.signals, ...talks.map(id => `${id} has been running for ${Math.round(time[id] / 60_000)} minutes`)]
    if (signals.length) {
      add({
        code: 'unrecorded-activity', refs: talks,
        text: `Before this ${b.kind === 'ask' ? 'question' : b.kind === 'report' ? 'report' : 'completion'}: the graph shows no work node, yet ${list(signals)}. WFE cannot tell whether work was done inside a talk or outside the run's nodes. The person's catalog names ${list(templates.map(t => t.id))} as steps they expect to see.`,
        repair: [`if such an activity was already performed without its own node, record it as done: wfe run record-done ${run} --template <id> --id <node> --after <node> --outcome "…" --reason "…" (wfe run help record-done)`,
          `if it has not happened yet, add it as pending work (wfe run adjust) and do it there`,
          'if nothing was done outside nodes, continue with --yes'],
      })
    }
  }
  return out
}

// The refusal text, one for every reminder of the operation.
export function reminderText(rs: Reminder[], what: string): string {
  return [`Not recorded — ${rs.length === 1 ? 'a reminder' : `${rs.length} reminders`} before ${what}:`,
    ...rs.flatMap(r => [`- ${r.code}: ${r.text}`, ...r.repair.map(x => `    · ${x}`)]),
    'Nothing was recorded, posted or queued. A reminder is not proof of an omission: after repairing, give the command again; if you judge continuing right as it is, give the same command with --yes. --yes passes these reminders only, for this one command.'].join('\n')
}

// What a person's answer about a presentation means for the agent taking it
// up: advisory, stated with the answer (take-up, continuation, state).
export function answerReminder(record: RunRecord, question: string): string | null {
  const q = record.questions[question]
  const p = q?.presentation ? record.presentations?.[q.presentation.id] : undefined
  if (!q || !p) return null
  const run = runKey(record)
  return `${q.id} asked about presentation ${p.id} (${p.state}). Decide from the answer: if it asks for changes, do them and present a new revision (the page may stay up meanwhile); if the review is finished, cleanup is due — wfe present stop ${run} ${p.id}, verified with wfe present status ${run}, in a cleanup node.`
}
