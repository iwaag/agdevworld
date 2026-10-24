// `wfe review …` (workflow_editor p17, docs/reviews.md): a person's review of
// completed work on a review node. The run's agent prepares it and its work
// is done; the person (or an identified check actor) starts it, approves it
// or requests changes; WFE stops what it started. Thin over
// server/reviews.ts; no command needs the service.
import { roundLine, startedInstances, subjectLabel, type ReviewRound } from '../shared/humanReview.ts'
import { runKey, type BecauseRef, type RunRecord, type RunRef } from '../shared/run.ts'
import { readRun, resolveRef } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError } from '../server/workspace.ts'
import type { RoundView } from '../server/reviews.ts'
import type { RunCli } from './run.ts'

const COMMON = `Common options: --by <name> (outside an attempt: who records), --attempt <id>
  (default WFE_ATTEMPT), --receipt <id> (a retransmission is recorded once),
  --json, --workspace <id> (default: the workspace containing the current
  directory). <run> is <workflow>/<run-id>; <rv> is a round (rv1, rv2, …).`

export const REVIEW_HELP: Record<string, string> = {
  prepare: `wfe review prepare <run> <node> --summary <text> --subject <ref>… [--reviewer <person>]

Hands completed work to a person's review on a review node (type: review)
that is ready (its predecessors are completed) or running. Your own work
is done after this: end the attempt. Nothing waits in a process; the person
starts the review with one button, later.
  --subject  each presentation the person looks at, frozen now by its
             manifest revision (a later presentation never replaces it):
               p1                      this run's presentation
               d1 | d1:p2              the child of delegation d1: its latest
                                       presentation, or the one named
               <ws>:<workflow>/<run>:p1  another run's
             Each bundle is checked on disk against its manifest; a missing
             or changed one is refused. A child that presented nothing has
             nothing to review here: it presents first.
  --summary  what was done and what to check, in the person's language;
             shown first on the review page.
You may have reviewed it yourself and stopped the child's page first: that
is fine; this review starts it again from the frozen bundle. Add the node
with wfe nodes instantiate human-review --run <run> --after <node> and
wfe run adjust (or ponder --next review:<node>) before preparing it.`,
  list: `wfe review list <run>

Every round of the run: its state, who decided, its subjects.`,
  show: `wfe review show <run> <rv>

One round: the summary, each subject (owning run, presentation, revision,
what serves it now, newer presentations of its run shown beside it), the
starts, the decision, cleanup and the continuation after requested changes.`,
  start: `wfe review start <run> <rv>

The person's Start review: records the request, starts every subject through
its owning run (an instance already serving is reused) and waits until each
answered or failed. Repeating it while it starts records nothing more. A
start is not a view and not an approval.`,
  approve: `wfe review approve <run> <rv> [--feedback <text>] [--synthetic]

Records the person's approval of exactly the round's frozen revisions, then
stops what the review started (verified; a failed stop is retried and never
asks again). Refused unless every subject is available (start-failed names
which are not). Approval is an assessment of the result: it is not
permission to run, revise, deploy or integrate anything.
  --synthetic  the actor (--by) is a named check actor standing in for
               nobody's real review; shown as such everywhere.
An agent's own assessment is never recorded as the person's: from an
attempt it is refused unless --because names the person's own words
(answer:<q> or instruction:<i>).`,
  'request-changes': `wfe review request-changes <run> <rv> --feedback <text> [--synthetic]

Records the person's feedback and closes the round. The run stays open: its
responsible agent is continued, takes the changes up, appends work and a new
review node. What the review started is handed to that agent.`,
  cleanup: `wfe review cleanup <run> <rv>

Stops what the round started (through each owning run), unless another
active round uses it, the person asked to keep it, or it serves its own
run's unfinished review. WFE does this after an approval or a cancellation
by itself; after requested changes the responsible agent may run it, or
leave the page up to compare (the next approval stops it).`,
  'take-up': `wfe review take-up <run> <rv> [--note <text>] [--no-change --note <why>]

The responsible agent read the changes requested in <rv>. Appending work as
nodes (or reopening a node, or asking the same child again) addresses them;
--no-change records why nothing changes and lets the run complete as it is.`,
}

export const REVIEW_INDEX = `wfe review <subcommand> — a person's review of completed work (docs/reviews.md)

  prepare <run> <node> --summary … --subject …   hand finished work to the person's review
  list <run> | show <run> <rv>                   rounds and where they stand
  start <run> <rv>                               the person's Start review (all subjects)
  approve <run> <rv>                             the person's approval; WFE then cleans up
  request-changes <run> <rv> --feedback …        the person's feedback; the agent continues
  cleanup <run> <rv>                             stop what the round started
  take-up <run> <rv> [--no-change --note …]      the agent read requested changes

wfe review help <subcommand> for details.`

function roundText(v: RoundView | ReviewRound): string {
  const lines = [roundLine(v), `  summary: ${v.summary.split('\n').join('\n           ')}`, `  prepared by ${v.prepared.by} at ${v.prepared.at}${v.previous ? `; answers the changes requested in ${v.previous}` : ''}`]
  const now = 'subjectsNow' in v ? v.subjectsNow : null
  for (const x of v.subjects) {
    const s = now?.find(y => y.n === x.n)
    lines.push(`  subject ${x.n}: ${subjectLabel(x)} "${x.title}", revision ${x.revision.slice(7, 19)}${x.delegation ? ` (delegation ${x.delegation}${x.result ? `, result event ${x.result.event}` : ''})` : ''}`)
    if (s) lines.push(`    now: ${s.status}${s.live && s.url ? ` — ${s.url}${s.local ? ' (this host only)' : ''}` : ''}${s.mode ? ` (${s.mode} by this review)` : ''}${s.detail ? `; ${s.detail}` : ''}${s.newer.length ? `; newer in its run: ${s.newer.join(', ')}` : ''}${s.usedBy.length ? `; also used by ${s.usedBy.join(', ')}` : ''}`)
  }
  if (v.starts.length) lines.push(`  starts: ${v.starts.map(s => `${s.n} by ${s.by} (${s.via}) at ${s.at}`).join('; ')}`)
  if (v.decision) lines.push(`  decision: ${v.decision.outcome === 'approved' ? 'approved' : 'changes requested'} by ${v.decision.by}${v.decision.synthetic ? ' (synthetic check actor)' : ''}${v.decision.relayed ? ` (relayed by ${v.decision.relayed.by})` : ''} at ${v.decision.at}${v.decision.feedback ? `: ${v.decision.feedback}` : ''}`)
  if (v.cleanup) lines.push(`  cleanup: ${v.cleanup.state} (owner ${v.cleanup.owner})${v.cleanup.results.length ? `: ${v.cleanup.results.map(c => `${c.instance} ${c.status}`).join(', ')}` : ''}${startedInstances(v).length && v.cleanup.state !== 'done' ? `; still serving: ${startedInstances(v).map(x => x.instance).join(', ')}` : ''}`)
  if (v.continuation) lines.push(`  continuation: ${v.continuation.addressed ? `addressed (${v.continuation.addressed.how}, seq ${v.continuation.addressed.seq})` : v.continuation.takenUp ? `taken up by ${v.continuation.takenUp.by}; no work added yet` : 'not taken up yet'}`)
  if ('page' in v && v.page) lines.push(`  review page: ${v.page}`)
  return lines.join('\n')
}

export async function reviewCommand(c: RunCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') {
    const topic = args[0]
    console.log(topic && REVIEW_HELP[topic] ? `${REVIEW_HELP[topic]}\n\n${COMMON}` : REVIEW_INDEX)
    return topic && !REVIEW_HELP[topic] ? 2 : 0
  }
  if (!REVIEW_HELP[sub]) throw c.usage(`no review subcommand "${sub}" (see: wfe review help)`)
  if (c.flag('help')) { console.log(`${REVIEW_HELP[sub]}\n\n${COMMON}`); return 0 }
  const host = c.exec().reviews
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f() } catch (e) {
      if (e instanceof RequestError) throw c.refused(e.message, e.detail)
      throw e
    }
  }
  const ws = await c.workspace()
  const ref = async (): Promise<RunRef> => {
    if (!args[0]) throw c.usage('<run> is required')
    return wrap(() => resolveRef(ws, args[0]))
  }
  const attempt = c.opt('attempt') ?? process.env.WFE_ATTEMPT ?? undefined
  const by = c.opt('by')
  const receipt = c.opt('receipt')
  const record = async (r: RunRef): Promise<RunRecord> => {
    const rec = (await wrap(async () => readRun(await runSpace(ws, r), r))).record
    if (!rec) throw c.refused(`run ${runKey(r)} cannot be read`)
    return rec
  }
  // The agent's own operations record as the run's agent; a person's are
  // recorded under the name given with --by (never a default).
  const recorder = (rec: RunRecord, person: boolean) => {
    if (attempt) {
      if (by?.trim() && by.trim() !== rec.executor.name) throw c.refused(`this process is attempt ${attempt} of ${rec.executor.name}; it records as ${rec.executor.name}, not as ${by.trim()} (a person's words are named with --because)`)
      return rec.executor.name
    }
    if (person && !by?.trim()) throw c.refused('who decides? Pass --by <name>: a review decision is recorded under the name of who made it (a check actor adds --synthetic)')
    if (!by?.trim() && rec.executor.host) throw c.refused(`who records this? Pass --by <your name>: run ${runKey(rec)} is performed by ${rec.executor.name} on the execution host.`)
    return by?.trim() || undefined
  }
  const because = (): BecauseRef | undefined => {
    const v = c.opt('because')
    if (!v) return undefined
    const m = /^(answer|instruction):([a-z0-9]+)(?::(\d+))?$/.exec(v)
    if (!m) throw c.usage('--because is answer:<question>[:<answer index>] or instruction:<instruction id>')
    return m[1] === 'answer' ? { kind: 'answer', question: m[2], ...(m[3] ? { answer: Number(m[3]) } : {}) } : { kind: 'instruction', instruction: m[2] }
  }
  const need = (k: string, what: string) => { const v = c.opt(k); if (!v?.trim()) throw c.usage(`--${k} is required: ${what}`); return v }
  const rv = () => { if (!args[1]) throw c.usage('<rv> is required (rv1, rv2, …; wfe review list <run>)'); return args[1] }
  const show = async (r: RunRef, id: string) => {
    const rec = await record(r)
    const v = (await host.view(ws, rec)).find(x => x.id === id)
    if (!v) throw c.refused(`run ${runKey(r)} has no review round ${id}`)
    return v
  }

  switch (sub) {
    case 'prepare': {
      const r = await ref()
      if (!args[1]) throw c.usage('prepare <run> <node> --summary <text> --subject <ref>…')
      const rec = await record(r)
      const res = await wrap(() => host.prepare(ws, r, args[1], { summary: need('summary', 'what was done and what to check'), subjects: c.opts('subject'), ...(c.opt('reviewer') ? { reviewer: c.opt('reviewer')! } : {}), ...(c.opt('previous') ? { previous: c.opt('previous')! } : {}) }, { by: recorder(rec, false), via: 'cli', ...(attempt ? { attempt } : {}), ...(receipt ? { receipt } : {}) }))
      c.out(`${res.duplicate ? 'Already prepared (same receipt): ' : 'Prepared '}${roundLine(res.round)}\n${res.round.subjects.map(x => `  ${x.n}. ${subjectLabel(x)} "${x.title}" (revision ${x.revision.slice(7, 19)})`).join('\n')}\nThe node waits for ${res.round.reviewer ?? 'the person'}'s review; no process waits. End your attempt when your other work is done.${host.pageOf(ws.reg.id, r, res.round.id) ? `\nReview page: ${host.pageOf(ws.reg.id, r, res.round.id)}` : ''}`, { ok: true, round: res.round, duplicate: !!res.duplicate })
      return 0
    }
    case 'list': {
      const r = await ref()
      const rec = await record(r)
      const rounds = Object.values(rec.reviews ?? {})
      c.out(rounds.length ? rounds.map(roundLine).join('\n') : `Run ${runKey(r)} has no review rounds.`, { ok: true, rounds })
      return 0
    }
    case 'show': {
      const r = await ref()
      const v = await show(r, rv())
      c.out(roundText(v), { ok: true, round: v })
      return 0
    }
    case 'start': {
      const r = await ref()
      const id = rv()
      const rec = await record(r)
      const res = await wrap(() => host.start(ws, r, id, { by: recorder(rec, true), via: 'cli', ...(receipt ? { receipt } : {}) }))
      const v = await show(r, id)
      c.out(roundText(v), { ok: res.round.state === 'reviewing', round: v })
      return res.round.state === 'reviewing' ? 0 : 1
    }
    case 'approve':
    case 'request-changes': {
      const r = await ref()
      const id = rv()
      const rec = await record(r)
      const outcome = sub === 'approve' ? 'approved' as const : 'changes' as const
      const feedback = sub === 'approve' ? c.opt('feedback') : need('feedback', 'what to change')
      const res = await wrap(() => host.decide(ws, r, id, { outcome, ...(feedback ? { feedback } : {}), ...(c.flag('synthetic') ? { synthetic: true } : {}), ...(because() ? { because: because() } : {}) }, { by: recorder(rec, !attempt), via: 'cli', ...(attempt ? { attempt } : {}), ...(receipt ? { receipt } : {}) }))
      const v = await show(r, id)
      c.out(roundText(v), { ok: true, round: v })
      return outcome === 'approved' && res.round.state !== 'complete' ? 1 : 0
    }
    case 'cleanup': {
      const r = await ref()
      const id = rv()
      const rec = await record(r)
      const who = recorder(rec, false)
      const after = await wrap(() => host.cleanup(ws, r, id, { ...(who ? { by: who } : {}), via: 'cli', ...(attempt ? { attempt } : {}) }))
      const v = await show(r, id)
      c.out(after ? roundText(v) : `${id} has nothing to clean up, or another process is cleaning it up now.\n${roundText(v)}`, { ok: true, round: v })
      return v.cleanup && v.cleanup.state !== 'done' && v.cleanup.state !== 'handed' ? 1 : 0
    }
    case 'take-up': {
      const r = await ref()
      const id = rv()
      const rec = await record(r)
      const { runOp } = await import('../server/runs.ts')
      const noChange = c.flag('no-change')
      const res = await wrap(async () => runOp(await runSpace(ws, r), r, { op: 'review.take-up', review: id, note: noChange ? need('note', 'why nothing changes') : (c.opt('note') ?? ''), ...(noChange ? { noChange: true } : {}), ...(attempt ? { attempt } : {}), ...(receipt ? { receipt } : {}) } as never, { by: recorder(rec, false), via: 'cli' }))
      c.out(`${roundLine(res.record.reviews![id])}${noChange ? '\nRecorded: nothing changes; the run completes as it is.' : '\nTaken up. Append the work as nodes and a new review node after it; that addresses the changes.'}`, { ok: true, round: res.record.reviews![id] })
      return 0
    }
  }
  return 2
}
