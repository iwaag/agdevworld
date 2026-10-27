// Evidence at the boundaries where a result is reported and received (tidy
// p2, docs/delegation.md "Assessing a result", docs/runs.md "Reporting a
// result"). Pure: the file layer reads what a run changed, removed and
// published; this module chooses which questions to put beside those facts.
// A path or a template chooses a *question*, never a finding: whether the
// entry is right, the tests ran or a delivery is portable is the agent's to
// inspect, and WFE says so.
//
// Why: in tidy p1's trial (ponderer/conduct/run-048) ponderer judged three
// results 12–23 s after taking them up, from the child's outcome line, and
// accepted a report that was never written and a README carrying one host's
// addresses. protoprey freework/run-007 reported "7 tests pass" with an
// eighth test that never ran; run-006 read data/deliveries.json without its
// status check and missed an adoption pointing at agsfx's run copy. After two
// corrections ponderer reported one (#453), and conversation-unanswered could
// not see it because #452 had already replied.
import { latestResult, type Delegation, type DelegationEvent } from './delegation.ts'
import type { Workflow } from './model.ts'
import type { RunRecord } from './run.ts'

export type WorkKind = 'documentation' | 'delivery' | 'moves' | 'tests'
export interface WorkContext {
  tidy: boolean // a node of the run was made from the catalog's tidy template
  kinds: WorkKind[]
  basis: string[] // what chose them, for the reader: a few paths, "tidy node", "output o1"
}

const DOC = /(^|\/)(README|GUIDE|CONTRIBUTING|CHANGELOG)(\.[a-z]+)?$|^(docs?|agent|knowledge)\/.*\.(md|markdown|txt|rst)$|^[^/]+\.(md|markdown|rst)$/i
const TEST = /(^|\/)(tests?|spec|__tests__)\/|(^|\/)test_[^/]+$|[._-](test|spec)\.[a-z0-9]+$/i
const DELIVERY = /(^|\/)(delivery|deliveries|adoptions?)[^/]*\.json$|(^|\/)cooperation\.md$/i
const IGNORE = /(^|\/)\.gitignore$/

// The questions that fit what a run did: from its template provenance, the
// paths of its copy it changed or removed (outside its own run folder) and
// its published outputs. Nothing chosen: the general questions alone.
export function workContext(o: { templates: string[]; changed: string[]; removed: string[]; outputs: string[] }): WorkContext {
  const kinds = new Set<WorkKind>()
  const basis: string[] = []
  const tidy = o.templates.includes('tidy')
  if (tidy) basis.push('a tidy node')
  const by = (k: WorkKind, paths: string[]) => { if (paths.length) { kinds.add(k); basis.push(...paths.slice(0, 2)) } }
  const present = o.changed.filter(p => !o.removed.includes(p))
  by('documentation', present.filter(p => DOC.test(p)))
  by('tests', present.filter(p => TEST.test(p)))
  by('delivery', present.filter(p => DELIVERY.test(p)))
  if (o.outputs.length) { kinds.add('delivery'); basis.push(`output ${o.outputs.join(', ')}`) }
  by('moves', [...o.removed.map(p => `${p} (removed)`), ...present.filter(p => IGNORE.test(p))])
  if (tidy) kinds.add('documentation')
  const order: WorkKind[] = ['documentation', 'delivery', 'moves', 'tests']
  return { tidy, kinds: order.filter(k => kinds.has(k)), basis: [...new Set(basis)] }
}

// One question per kind of work, for each side. The meaning behind them is
// devpolicy's (styles.md *Keeping a project tidy*, *Project cooperation*).
const ASK: Record<WorkKind, { producer: string; receiver: string }> = {
  documentation: {
    producer: 'Documentation: does the entry agree with the implementation and the adopted deliveries, do its references resolve, are run history and current state apart, and are one machine\'s facts (hosts, home paths, LAN addresses) out of portable text, with the portable requirement kept?',
    receiver: 'Documentation: does the entry agree with the implementation and the adopted deliveries? Do its references resolve? Are run history and current state apart? Are one machine\'s facts (hosts, home paths, LAN addresses) out of portable text, and the portable requirement kept?',
  },
  delivery: {
    producer: 'Delivery: is the output published (wfe run publish) and identified by hash, and can a fresh copy obtain it without a producer\'s working copy? Run the acquisition or status check; reading the record is not that check.',
    receiver: 'Delivery: is the output published and identified by hash? Can a fresh consumer obtain it without the producer\'s working copy? Which install or runtime checks ran?',
  },
  moves: {
    producer: 'Removals and moves: can what you removed be regenerated, are original assets and evidence kept, and are references and consumers updated?',
    receiver: 'Removals and moves: can the removed files be regenerated? Are original assets and evidence kept? Were references and consumers checked?',
  },
  tests: {
    producer: 'Tests: did the new and changed tests actually run (listed by the runner, not only present in the source), and do the counts you report include them?',
    // tidy p2 trial C: ponderer judged run-006's correction "consistent with
    // reported 4 tests … Tests not re-run" from the report's own output; the
    // test it claimed to have moved was still outside the class.
    receiver: 'Tests: the output in the report is the child\'s claim. Run the named command on its files where you can (or read the tests: is each one collected?), and say in your note whether the counts are your own or unverified.',
  },
}

const basisLine = (c: WorkContext, who: string) => c.kinds.length || c.tidy
  ? `(chosen from ${who}: ${c.basis.slice(0, 5).join(', ')}${c.basis.length > 5 ? ', …' : ''}; a path chooses a question, it shows no defect)`
  : null

// What the run that did the work is asked as its result goes back: advice
// printed with an ordinary operation, never a refusal. Ordinary work is asked
// whether what readers rely on still matches; a run that tidied is asked for
// evidence, not another pass.
export function producerLines(o: { context: WorkContext; requester: string | null; report: string | null }): string[] {
  const c = o.context
  const who = o.requester ? `${o.requester} compares what you report with your files and records` : 'whoever reads it compares what you report with your files and records'
  const lines = [
    `Before the result goes back (advice; nothing is refused): ${who}.`,
    `  · Say which files and records changed and at which commit, which checks actually ran and with what results, and what is unverified, deliberately unchanged or left open.`,
    `  · The report${o.report ? ` (${o.report})` : ''} and every path it names are read where you say they are.`,
    c.tidy ? '  · This run tidied: report its evidence rather than tidy again.'
      : '  · Do the project\'s entry (README), guide and setup or acquisition instructions still match this change? If not, correct them in a node of this run (the catalog\'s tidy fits), not only in the report.',
    ...c.kinds.map(k => `  · ${ASK[k].producer}`),
  ]
  const b = basisLine(c, 'this run\'s changes')
  return b ? [...lines, `  ${b}`] : lines
}

// What the receiving run is asked beside a result's records: what WFE cannot
// judge, as questions, with how to read the files.
// `who`: the producer as the receiver knows it (a delegated child, or a run
// it requested — tidy p3).
export function receiverQuestions(c: WorkContext, read: string, revise: string, who = 'the child'): string[] {
  const b = basisLine(c, `${who}'s changes`)
  return [
    `WFE checked records, not content. Compare the claim with the files before judging (${read}).`,
    ...c.kinds.map(k => who === 'the child' ? ASK[k].receiver : ASK[k].receiver.replace(/the child's/g, `${who}'s`)),
    ...(b ? [b] : []),
    `What is missing goes back to ${who === 'the child' ? 'the same child' : who} (${revise}) as part of assessing it — no go-ahead is needed for what the request asked — and its next result is checked again; otherwise your judgement's note says what you checked.`,
  ]
}

// Which correction a result answers (fix6 revise; p17/p18 reopenings): an
// earlier judgement or check does not cover it.
export function correctionLine(d: Delegation, ev: DelegationEvent): string | null {
  const rv = (d.revisions ?? []).filter(r => r.event < ev.n).at(-1)
  if (!rv) return null
  if ((d.revisions ?? []).some(r => r.event === ev.n)) return null // this result was itself returned
  const judged = (d.reopened ?? []).map(x => x.disposition).filter(x => x.event !== null && x.event < ev.n).at(-1)
  return `This result follows correction request ${rv.n} (it returned event ${rv.event}): "${rv.instruction.replace(/\s+/g, ' ').slice(0, 160)}". ${judged ? `The judgement of event ${judged.event} (${judged.kind}) and any` : 'Any'} check of event ${rv.event} does not cover it: check the correction itself.`
}

// Where a delegation stands, in one phrase (a multi-child account).
export function delegationStanding(d: Delegation): string {
  const ev = latestResult(d)
  const child = d.child ? `${d.target.project} ${d.child.workflow}/${d.child.run}` : `${d.target.project}/${d.target.workflow}`
  const rv = (d.revisions ?? []).at(-1)
  // tidy p3: a result that needed corrections, or whose acceptance was set
  // aside, says so: p2's last summary presented a twice-returned result as
  // done and dropped the failed correction.
  const n = (d.revisions ?? []).length
  const history = `${n ? ` after ${n} correction request${n === 1 ? '' : 's'}` : ''}${d.reopened?.length ? ` (an earlier satisfied judgement set aside ${d.reopened.length === 1 ? 'once' : `${d.reopened.length} times`})` : ''}`
  const state = d.disposition ? `judged ${d.disposition.kind}${d.disposition.event !== null ? ` (event ${d.disposition.event})` : ''}${history}`
    : d.closed ? `closed: ${d.closed.reason}`
      : rv && (!ev || ev.n <= rv.event) ? `returned for correction (request ${rv.n}), not back yet`
        : ev ? `result event ${ev.n}${(d.revisions ?? []).some(r => r.event < ev.n) ? ` (a corrected result${history})` : ''}, not judged yet`
          : 'no result yet'
  return `${d.id} → ${child}: ${state}`
}

// The latest fact of a delegation that an account to the room would report:
// a result, its judgement or a correction request (ISO time), or null.
export function lastResultFact(d: Delegation): string | null {
  const times = [...d.events.filter(e => e.type === 'completed').map(e => e.at), ...(d.disposition ? [d.disposition.at] : []), ...(d.revisions ?? []).map(r => r.at)]
  return times.length ? times.sort().at(-1)! : null
}

// The delegations with a result fact after `since` (null: every one with a
// fact), each in one phrase.
export function changedSince(record: Pick<RunRecord, 'delegations'>, since: string | null): string[] {
  return Object.values(record.delegations ?? {}).filter(d => { const t = lastResultFact(d); return !!t && (since === null || t > since) }).map(delegationStanding)
}

// The template ids of a run's nodes, from the definition in force.
export const templatesOf = (record: Pick<RunRecord, 'nodes'>, authored: Pick<Workflow, 'nodes'> | undefined) =>
  [...new Set(Object.keys(record.nodes).map(id => authored?.nodes[id]?.template?.id).filter((x): x is string => !!x))]
