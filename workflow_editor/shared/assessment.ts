// Assessing a delegated result where the parent receives and reports it
// (workflow_editor fix6, docs/delegation.md "Assessing a result"). Pure: the
// file layer (server/delegate.ts) reads the child — its record as of the
// result, its record now, its frozen catalog and the files its copy changed —
// and this module separates what those records show from what the child's
// catalog expects. It judges nothing it cannot observe: an expectation is
// the person's prose, shown beside the evidence, never compiled into a rule.
//
// Why: in conversation 20261024-160217-forusr misc/freework/run-001…004
// completed without a presentation (run-002 wrote its work nodes by hand, two
// read only the tail of fix5's warning), and ponderer judged each result
// satisfied within seconds — run-035 d1 with an 8.4 MB video, no
// presentation, no confirmation, `accepts: person`. The parent did act on
// clear discussion-activity reminders; the hypothesis is that the evidence
// and a concrete correction at its receiving point improve delivery.
import type { RunCatalog } from './catalog.ts'
import { latestResult, type Delegation, type DelegationEvent } from './delegation.ts'
import type { Workflow } from './model.ts'
import { isNotes, isViewable, roleOf, substantiveNodes, type Reminder } from './reminders.ts'
import { isOpen, questionState, runFolder, runKey, type RunGraph, type RunRecord } from './run.ts'

export type CheckCode = 'presentation-missing' | 'review-unrecorded' | 'presentation-serving'
// ok: the records show it; missing / serving: the records show the omission;
// unknown: the evidence to tell is not in the records (never a proven violation).
export type CheckStatus = 'ok' | 'missing' | 'serving' | 'unknown'
export interface AssessmentCheck {
  code: CheckCode
  status: CheckStatus
  facts: string[] // what the records show (frozen with the result, unless said "now")
  expectations: string[] // the child's catalog expectations this check is about, as frozen
  summary: string // one line: the omission, for the end of a refusal
  repair: string[] // what the parent can do (never acting as the child)
}

// What the file layer read of the child for one result.
export interface ChildEvidence {
  // The child as of the result: its history through the entry after which
  // the result was told (the attempt that completed it ended).
  frozen: RunRecord | null
  graph: RunGraph | null // the graph in force then
  authored: Pick<Workflow, 'nodes'> | undefined // the definition in force then
  now: RunRecord | null // the child as it is now
  catalog: RunCatalog // the snapshot the child was given
  changed: { path: string; nodes: string[] }[] | null // files the child's copy changed outside its records (observed now), with the nodes running when each was written; null: not readable
  unavailable: string[] // what could not be read, said explicitly
}

export interface Assessment {
  delegation: string
  uid: string
  event: number // the completed event assessed
  manifest: string | null // its manifest digest
  child: string | null // the child's uid
  childRun: string | null // <workflow>/<run>
  childSeq: number // the child's completing entry
  position: number | null // the child's history position the frozen facts come from
  definition: string | null // the child's revision in force then
  catalog: string | null // the child's catalog snapshot (sha256), or why none
  accepts: 'person' | 'parent'
  person: string | null // on whose behalf the parent asked
  state: string // the delegation's disposition, or open
  latest: boolean // the delegation's latest result
  checks: AssessmentCheck[]
  current: string[] // what changed in the child since the result (now)
  integrations: string[] // the child's integrations: historical facts bound to their own revisions
  unavailable: string[]
}

const list = (xs: string[]) => xs.join(', ')
const few = (xs: string[], n = 4) => `${xs.slice(0, n).join(', ')}${xs.length > n ? `, … (${xs.length} in all)` : ''}`

function completedAt(record: RunRecord): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of record.history) for (const [n, [, to]] of Object.entries(e.change?.nodes ?? {})) if (to === 'completed') out[n] = e.seq
  return out
}
const registeredAt = (record: RunRecord, id: string) => record.history.find(e => e.op === 'presentation.register' && (e as { presentation?: string }).presentation === id)?.seq ?? 0

// The expectations of the child's frozen catalog a check is about.
function expectationsOf(c: RunCatalog, ids: string[]): string[] {
  if (c.state !== 'supplied') return []
  return c.snapshot.templates.filter(t => ids.includes(t.id)).map(t => `${t.id} r${t.revision}: ${t.expectation.trim().split('\n').join(' ')}`)
}

export function assessResult(parent: RunRecord, d: Delegation, ev: DelegationEvent, c: ChildEvidence): Assessment {
  const run = runKey(parent)
  const child = d.child
  const childRun = child ? `${child.workflow}/${child.run}` : null
  const fr = c.frozen
  const unavailable = [...c.unavailable]
  if (!ev.manifest) unavailable.push(`result event ${ev.n} carries no result manifest`)
  if (c.catalog.state === 'unavailable') unavailable.push(`the child's node catalog was not readable when it was created (${c.catalog.problem})`)
  const checks: AssessmentCheck[] = []
  const revise = (what: string) => `return it to the same child: wfe delegate revise ${run} ${d.id} --instruction "${what}" --reason "…" (the child adds and performs the missing work; its next completion comes back as a new result)`
  const inspect = `inspect it first: wfe delegate show ${run} ${d.id}; wfe delegate file ${run} ${d.id} <path>`

  // ---- presentation missing (as of the result) ----
  // `deliverable`: the result has something a person reviews (work, viewable
  // files or a presentation); a consultation's or a study's answer does not
  // acquire a review obligation from `accepts` alone.
  let deliverable = false
  if (!fr || !c.graph) {
    checks.push({ code: 'presentation-missing', status: 'unknown', facts: ['the child\'s record as of this result could not be read'], expectations: expectationsOf(c.catalog, ['present', 'work']), summary: `${d.id}: whether the child presented its result is unknown (its record is not readable)`, repair: [inspect] })
  } else {
    const changedBy: Record<string, string[]> = {}
    for (const p of c.changed ?? []) for (const n of p.nodes) (changedBy[n] ??= []).push(p.path)
    const substantive = substantiveNodes(fr, c.graph, c.authored, changedBy)
    const done = completedAt(fr)
    const work = Object.keys(fr.nodes).filter(id => roleOf(id, fr, c.graph!, c.authored, substantive) === 'work' && fr.nodes[id].state === 'completed')
    const own = `${runFolder(fr)}/`
    const files = [...new Set([...(ev.manifest?.artifacts.map(a => a.path) ?? []), ...(c.changed?.map(p => p.path) ?? []), ...Object.values(fr.nodes).flatMap(n => n.outcome?.artifacts ?? [])])].filter(p => !p.startsWith(own))
    const viewable = files.filter(isViewable)
    const pres = Object.values(fr.presentations ?? {})
    const lastWork = Math.max(0, ...work.map(id => done[id] ?? 0))
    const linked = new Set(pres.flatMap(p => p.links?.map(l => l.node) ?? []))
    const covering = pres.filter(p => registeredAt(fr, p.id) > lastWork)
    const uncovered = work.filter(id => !linked.has(id) && (done[id] ?? 0) > Math.max(0, ...pres.map(p => registeredAt(fr, p.id))))
    const facts: string[] = []
    facts.push(work.length ? `completed work: ${list(work.map(id => substantive.has(id) ? `${id} (added by the child, with files)` : id))}` : 'no completed work node (template work, or a node the child added with files beyond notes)')
    if (viewable.length) facts.push(`viewable candidates (by extension, a signal not proof): ${few(viewable)}`)
    else if (files.filter(p => !isNotes(p)).length) facts.push(`files beyond notes: ${few(files.filter(p => !isNotes(p)))}`)
    if (c.changed === null) facts.push('the child\'s copy could not be read: only recorded artifacts are known')
    facts.push(pres.length ? `presentations: ${list(pres.map(p => `${p.id} "${p.title}" registered at seq ${registeredAt(fr, p.id)} from ${p.node}${p.links?.length ? ` (linked to ${list(p.links.map(l => l.node))})` : ''}`))}` : 'presentations: none')
    const needs = (work.length > 0 && uncovered.length > 0) || (!work.length && viewable.length > 0 && !pres.length)
    deliverable = work.length > 0 || viewable.length > 0 || pres.length > 0
    if (needs) {
      const shown = viewable.length ? viewable : files.filter(p => !isNotes(p))
      if (pres.length && work.length) facts.push(`${list(uncovered)} completed after the latest presentation: an earlier page does not cover later work`)
      checks.push({
        code: 'presentation-missing', status: 'missing', facts, expectations: expectationsOf(c.catalog, ['present', 'work']),
        summary: `${d.id} (${childRun}) completed ${work.length ? list(uncovered.length ? uncovered : work) : 'its result'}${shown.length ? ` with ${few(shown, 2)}` : ''} and presented nothing → wfe delegate revise ${run} ${d.id} --instruction "present … through a present node, then plan its cleanup"`,
        repair: [inspect, revise('present the result through a present node of its own (register, start, ask the person through me), and plan its cleanup')],
      })
    } else checks.push({ code: 'presentation-missing', status: 'ok', facts: [...facts, ...(covering.length ? [`${list(covering.map(p => p.id))} registered after the last work`] : [])], expectations: expectationsOf(c.catalog, ['present', 'work']), summary: '', repair: [] })
  }

  // ---- the person's review (accepts: person, for a deliverable) ----
  if (d.accepts === 'person' && deliverable) {
    const person = d.onBehalfOf
    const facts: string[] = []
    const found: string[] = []
    const agentsOf = new Set([parent.executor.name, fr?.executor.name ?? '', d.requester].filter(Boolean))
    const personal = (from: string) => person ? from === person : !agentsOf.has(from)
    if (fr) {
      for (const q of Object.values(fr.questions)) for (const [i, a] of q.answers.entries()) if (personal(a.from)) found.push(`the child's ${q.id} answer ${i} is ${a.from}'s`)
      for (const dc of fr.decisions) {
        const from = dc.confirmation?.from ?? dc.by
        facts.push(`decision ${dc.decision} by ${dc.by}${dc.confirmation ? ` from ${dc.confirmation.question} answered by ${from}` : ''}`)
      }
      const confirms = Object.values(fr.questions).filter(q => c.graph?.nodes[q.node ?? '']?.confirms === 'result')
      if (confirms.length) facts.push(`confirmation asked: ${list(confirms.map(q => `${q.id} to ${q.to} (${questionState(q)}${q.answers.length ? `, answered by ${list(q.answers.map(a => a.from))}` : ''})`))}`)
    }
    for (const a of d.answers) if (a.because && personal(a.from)) found.push(`answer ${a.n} to the child's ${a.question} relays ${a.from}'s words (${a.because.kind === 'answer' ? `answer to ${a.because.question}` : `instruction ${a.because.instruction}`})`)
    for (const r of d.revisions ?? []) if (r.because && personal(r.from)) found.push(`correction ${r.n} relays ${r.from}'s words`)
    if (found.length) checks.push({ code: 'review-unrecorded', status: 'ok', facts: [...facts, ...found], expectations: [], summary: '', repair: [] })
    else {
      facts.push(`no answer from ${person ?? 'the person'} about this result is traceable: a confirmation node, a decision or an agent's answer alone does not show that they reviewed it`)
      checks.push({
        code: 'review-unrecorded', status: 'unknown', facts, expectations: [],
        summary: `${d.id} accepts: person, and no answer from ${person ?? 'the person'} about this result is traceable → relay their actual answer, or ask them (wfe run ask … --to ${person ?? '<person>'})`,
        repair: [`if ${person ?? 'the person'} answered elsewhere (the conversation), relay their words: wfe run answer ${run} <q> --from ${person ?? '<person>'} --source-message <id>, then name them (--because answer:<q>)`,
          `ask them about the child's result (its presentation link, or what it produced): wfe run ask ${run} <node> --to ${person ?? '<person>'} --question "…"`],
      })
    }
  }

  // ---- a presentation still serving (now; frozen when now is unreadable) ----
  const nowRec = c.now ?? fr
  if (nowRec) {
    const open = Object.values(nowRec.presentations ?? {}).filter(isOpen)
    const facts: string[] = []
    const forgotten: string[] = []
    for (const p of open) {
      const qs = Object.values(nowRec.questions).filter(q => q.presentation?.id === p.id)
      const review = qs.length ? list(qs.map(q => `${q.id} ${questionState(q)}`)) : 'never asked about'
      const cleanup = Object.keys(nowRec.nodes).some(id => roleOf(id, nowRec, c.graph ?? { nodes: {}, edges: [] }, c.authored) === 'cleanup' && ['pending', 'running', 'waiting'].includes(nowRec.nodes[id].state))
      if (p.retained) facts.push(`${p.id} serving now: kept on request (${p.retained.note}; stopped later by ${p.retained.owner})`)
      else if (qs.some(q => questionState(q) === 'open')) facts.push(`${p.id} serving now: its review is not answered yet (${review}); the person can still look at it`)
      else if (cleanup) facts.push(`${p.id} serving now: a cleanup node is planned`)
      else { facts.push(`${p.id} "${p.title}" serving now (${review}), no cleanup planned, no request to keep it recorded`); forgotten.push(p.id) }
    }
    const stopped = Object.values(nowRec.presentations ?? {}).filter(p => !isOpen(p))
    if (stopped.length) facts.push(`stopped: ${list(stopped.map(p => `${p.id} (${p.state})`))}`)
    if (forgotten.length) checks.push({
      code: 'presentation-serving', status: 'serving', facts, expectations: expectationsOf(c.catalog, ['cleanup']),
      summary: `${d.id}: the child's ${list(forgotten)} still serving after its review with no cleanup → ask the child to stop it (wfe delegate revise …), or relay the person's request to keep it`,
      repair: [`if the review is finished, ask the child for its cleanup: ${revise(`stop ${list(forgotten)} in a cleanup node and verify it stopped`)}`,
        'if the person asked for the page to stay available, relay their words to the child (wfe delegate revise/instruct with --because) so it records who stops it later (wfe present keep)',
        'nothing here stops a page by itself; never stop the child\'s page from this run'],
    })
    else checks.push({ code: 'presentation-serving', status: 'ok', facts, expectations: expectationsOf(c.catalog, ['cleanup']), summary: '', repair: [] })
  }

  // ---- what changed since, and integrations (historical facts) ----
  const current: string[] = []
  if (c.now && c.frozen && c.now.seq > c.frozen.seq) {
    const ops = [...new Set(c.now.history.filter(h => h.seq > c.frozen!.seq).map(h => h.op))]
    current.push(`the child recorded since this result: ${few(ops, 6)} (seq ${c.frozen.seq} → ${c.now.seq}; execution ${c.now.execution.state})`)
    for (const k of Object.values(c.now.corrections ?? {})) current.push(`correction ${k.id} (revision ${k.delegation.revision}) ${k.addressed ? `addressed (${k.addressed.how})` : 'not addressed yet'}`)
  }
  const integrations = (c.now ?? fr)?.integrations?.map(i => `integrated at ${i.at} from decision ${i.decision}: ${list(i.repositories.map(r => `${r.path} ${r.method}${r.result ? ` → ${r.result.slice(0, 10)}` : ''}`))}`) ?? []
  const latest = latestResult(d)
  return {
    delegation: d.id, uid: d.uid, event: ev.n, manifest: ev.manifest?.digest ?? null, child: child?.uid ?? null, childRun, childSeq: ev.child.seq,
    position: fr?.seq ?? null, definition: fr?.definition.active ?? null, catalog: c.catalog.state === 'supplied' ? c.catalog.sha256 : c.catalog.state,
    accepts: d.accepts, person: d.onBehalfOf, state: d.disposition?.kind ?? (d.closed ? 'closed' : 'open'), latest: latest?.n === ev.n,
    checks, current, integrations, unavailable,
  }
}

// The reminders an assessment gives at the parent's boundaries: one per
// check that is not ok, naming the delegation and the result.
export function assessmentReminders(as: Assessment[]): Reminder[] {
  const out: Reminder[] = []
  for (const a of as) {
    for (const ch of a.checks) {
      if (ch.status === 'ok') continue
      const head = `${a.delegation} → ${a.childRun ?? 'child'}, result event ${a.event}${a.manifest ? ` (manifest ${a.manifest.slice(7, 19)})` : ''}${a.state !== 'open' ? `, judged ${a.state}` : ''}`
      out.push({
        code: `delegated-${ch.code}`, refs: [a.delegation, `event ${a.event}`],
        text: `${head}: ${ch.facts.join('; ')}.${ch.expectations.length ? ` The child's catalog expects: ${ch.expectations.join(' / ')}` : ''}${ch.status === 'unknown' ? ' Unknown is not a proven omission.' : ''}`,
        repair: ch.repair, summary: ch.summary,
      })
    }
  }
  return out
}

// The assessment as text (wfe delegate show, take-up, the brief).
export function assessmentLines(a: Assessment, indent = '  '): string[] {
  const mark: Record<CheckStatus, string> = { ok: 'ok', missing: 'MISSING', serving: 'SERVING', unknown: 'UNKNOWN' }
  return [
    `${indent}assessment of result event ${a.event}${a.manifest ? ` (manifest ${a.manifest.slice(7, 19)})` : ''}, child seq ${a.childSeq}${a.position ? ` (facts as of child seq ${a.position}, revision ${a.definition ?? 'r1'})` : ''}; catalog ${a.catalog ? a.catalog.slice(0, 12) : 'none'}; accepts: ${a.accepts}${a.person ? `, on behalf of ${a.person}` : ''}`,
    ...a.checks.flatMap(c => [`${indent}  ${mark[c.status]} ${c.code}: ${c.facts.join('; ') || '—'}`, ...c.expectations.map(e => `${indent}      expects ${e}`), ...(c.status === 'ok' ? [] : c.repair.map(r => `${indent}      · ${r}`))]),
    ...a.integrations.map(i => `${indent}  ${i} (a historical fact; a corrected result is accepted and integrated anew)`),
    ...a.current.map(x => `${indent}  now: ${x}`),
    ...a.unavailable.map(x => `${indent}  unavailable: ${x}`),
  ]
}
