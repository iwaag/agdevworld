// `wfe delegate …` (p10, docs/delegation.md): a run's agent entrusts a
// delegate node's work to another managed workflow, reads what its child
// asks and delivers, answers it and judges the result. Thin over
// server/delegate.ts and the run operations; no command needs the service.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { delegationState, pendingEvents, type Delegation, type DelegationEvent } from '../shared/delegation.ts'
import { holderOf, runKey, type BecauseRef, type RunRecord, type RunRef } from '../shared/run.ts'
import { readRun, resolveRef, runDir, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError } from '../server/workspace.ts'
import type { RunCli } from './run.ts'

const COMMON = `Common options: --by <name> (outside an attempt: who records; an executing
  attempt (WFE_ATTEMPT) records as the run's agent), --attempt <id> (default
  WFE_ATTEMPT), --receipt <id> (a retransmission is recorded once), --json,
  --workspace <id> (default: the workspace containing the current directory).
<run> is <workflow>/<run-id> of the delegating (parent) run; <d> is its
delegation id (d1, d2, …).`

export const DELEGATE_HELP: Record<string, string> = {
  request: `wfe delegate request <run> <node> --request <file|-> [--original <file>] [--replaces <d>]

Entrusts the running delegate node's work to the workflow it names
(project/workflow in the run's definition). Before anything is written the
target is resolved to its one workspace on this host (an ambiguous or
missing one is refused, never guessed), checked to validate and to accept
requests, and checked for cycles (its definitions delegating back here, or
this run descending from that workflow). Then:
  Writes  delegations/<d>/request.md (your request, exactly as the child
          receives it) and delegations/<d>/original-input.md (the person's
          own words this run started from, or --original), and records the
          dispatch: the node waits on the delegation.
  Then    the request is posted in the target workflow's Zulip channel as a
          new request topic; its intake creates the child run, which works in
          its worker's execution slot (one per worker). Nothing polls: end your attempt when
          only the child's work remains; its questions and its result resume
          this run.
Write the request for someone who knows nothing of this run: what is wanted,
the constraints, what you need back and in what form.
One delegation per delegate node at a time. To replace a failed or rejected
child, judge it first (dispose), then --replaces <d>. A retransmission of
the same request is recorded once.`,
  list: `wfe delegate list <run>

The run's delegations: node, target, state (dispatching, working,
attention, result, stopped, satisfied, rejected, abandoned, orphaned), the
child, and the facts not yet taken up. Reads only.`,
  show: `wfe delegate show <run> <d>

One delegation in full: the request and original by hash, the child (its
run, request topic and run view), every relayed fact (questions with the
documents or deliverables they present, the result manifest, failures,
holds), your answers and instructions, and the disposition. Reads only.`,
  'take-up': `wfe delegate take-up <run> <d> <n>...

Records that you read relayed facts n… of delegation <d> (wfe delegate show).
The delegate node resumes running. Taking up tells the record you read
the facts; answering and disposing do not wait for it. An attempt that ends
with a fact it was started for not taken up is held as interrupted, like
work left ready, so recovery or the person looks at it.`,
  answer: `wfe delegate answer <run> <d> <question> --answer <text> [--because answer:<q>[:<n>]]

Answers the child's question (its id, as the child asked it). The answer is
posted in the child's request topic and recorded there as the child's
answer, from you (or from the person whose words you relay with --because).
The delegate node waits again.
  A question that agrees the child's plan, or anything else within this
  run's request, is yours to answer.
  A question that confirms the child's result (it presents deliverables) is
  an acceptance: when the delegate node says accepts: person, answer it only
  with your person's taken-up answer (--because answer:<q>); ask your person
  first with wfe run ask. With accepts: parent you may accept it yourself.
  Read what a question presents first: wfe delegate file <run> <d> <path>.
A question the child already closed is refused; nothing is sent.`,
  instruct: `wfe delegate instruct <run> <d> --instruction <text> [--because answer:<q>[:<n>]|instruction:<i>]

Sends the child a further instruction (it is recorded as the child's
additional instruction, read at its next step; nothing running is
interrupted). --because when you relay your person's words.`,
  dispose: `wfe delegate dispose <run> <d> --disposition satisfied|rejected|abandoned --note <text> [--event <n>]

Judges the delegation, and closes it:
  satisfied  the child's latest result (its completed event, taken up)
             serves the request; the delegate node may complete now.
  rejected   that result does not serve it; replace the child (request
             --replaces <d>), fail the node, or ask your person.
  abandoned  no usable result will come (a failure, a cancellation, a
             delivery that never became a child); no result is needed.
This is your receipt of the result, not the child's acceptance (that is its
own decision, from its confirmation) and not your run's result decision.`,
  cancel: `wfe delegate cancel <run> <d> --reason <text> [--because answer:<q>[:<n>]|instruction:<i>]

Cancels the delegation's child run, as its requester: its queued work is
dropped and a running attempt of it is stopped; its records, copy and
branch stay. This is the explicit act: holding or cancelling your own run
never cancels the child. The cancellation comes back as a relayed fact;
then judge the delegation (dispose --disposition abandoned).`,
  file: `wfe delegate file <run> <d> <path> [--out <file>]

Prints a file of the child's working copy (a path of the child's project,
as its questions and result name it), or copies it to --out. Says whether
its bytes are the ones the delegation's facts recorded (by hash).`,
  sync: `wfe delegate sync

Relays what every bound child recorded to its parent now (the intake's pass
and the executor's reconcile do this by themselves) and queues the parents'
continuations. Safe to repeat.`,
}

export const DELEGATE_INDEX = `wfe delegate <subcommand> … (p10: entrusting a delegate node's work to another workflow)

  request <run> <node> --request <file>   dispatch the delegate node's request
  list <run>                              the run's delegations and their state
  show <run> <d>                          one delegation: child, facts, answers
  take-up <run> <d> <n>...                record that you read relayed facts
  answer <run> <d> <q> --answer <text>    answer the child's question
  instruct <run> <d> --instruction <text> send the child a further instruction
  dispose <run> <d> --disposition …       judge the result (satisfied / rejected / abandoned)
  cancel <run> <d> --reason <text>        cancel the child run (an explicit act of its own)
  file <run> <d> <path>                   read a file the child presents
  sync                                    relay children's facts now

Contract: workflow_editor/docs/delegation.md. Details: wfe delegate help <subcommand>.`

function eventLines(e: DelegationEvent): string[] {
  const out = [`  ${String(e.n).padStart(2)}. ${e.type}${e.question ? ` ${e.question}` : ''}${e.confirms ? ' (confirms the result)' : e.plan ? ' (agrees the plan)' : ''}${e.to ? ` to ${e.to}` : ''} — ${e.takenUp ? `taken up by ${e.takenUp.by}` : e.wakes ? 'NOT TAKEN UP' : 'recorded'} (child seq ${e.child.seq}, ${e.at})`]
  for (const l of e.text.split('\n')) if (l.trim()) out.push(`      ${l}`)
  if (e.document) out.push(`      document: ${e.document.path} (${e.document.sha256.slice(0, 12)}, ${e.document.bytes} bytes)`)
  for (const f of e.subject ?? []) out.push(`      presents: ${f.path} (${f.sha256.slice(0, 12)}, ${f.bytes} bytes)`)
  if (e.presentation) out.push(`      presentation ${e.presentation.id} (revision ${e.presentation.revision.slice(7, 19)})`)
  if (e.manifest) {
    const m = e.manifest
    out.push(`      result manifest ${m.digest.slice(7, 19)}: execution ${m.execution}${m.decision ? `, decision ${m.decision.decision} by ${m.decision.by}` : ', no decision'}${m.branch ? `, branch ${m.branch}` : ''}`)
    if (m.outcome) out.push(`      outcome: ${m.outcome}`)
    for (const f of [...(m.report ? [m.report] : []), ...m.artifacts]) out.push(`      ${f === m.report ? 'report' : 'artifact'}: ${f.path} (${f.sha256.slice(0, 12)}, ${f.bytes} bytes${f.commit ? `, in ${f.commit.slice(0, 10)}` : ', not committed yet'})`)
  }
  return out
}

export function describeDelegation(d: Delegation, rec: RunRecord): string[] {
  return [
    `Delegation ${d.id} (${d.uid}) from node ${d.node} to ${d.target.project}/${d.target.workflow} (workspace ${d.target.workspace}): ${delegationState(d)}`,
    `  request: ${d.request.path} (${d.request.sha256.slice(0, 12)})${d.original ? `; original: ${d.original.path}` : ''}; requester ${d.requester}${d.onBehalfOf ? ` for ${d.onBehalfOf}` : ''}; result acceptance: ${d.accepts === 'parent' ? 'this run\'s agent may accept' : 'the person\'s (relay their answer)'}`,
    `  dispatched ${d.dispatched.at} by ${d.dispatched.by}${d.predecessor ? `, replacing ${d.predecessor}` : ''}`,
    d.child ? `  child: ${d.child.project} ${d.child.workflow}/${d.child.run} (${d.child.uid}) in workspace ${d.child.workspace}${d.transport ? `; request post ${d.transport.message} in #${d.transport.stream} › ${d.transport.topic}` : ''}` : '  child: none yet (the request is being delivered; wfe notify status shows the delivery)',
    ...(d.events.length ? ['  facts relayed:', ...d.events.flatMap(eventLines)] : ['  facts relayed: none yet']),
    ...d.answers.map(a => `  answer ${a.n} to ${a.question} from ${a.from}${a.from !== a.by ? ` (relayed by ${a.by})` : ''} at ${a.at}: ${a.text.replace(/\s+/g, ' ').slice(0, 200)}`),
    ...d.instructions.map(a => `  instruction ${a.n} from ${a.from} at ${a.at}: ${a.text.replace(/\s+/g, ' ').slice(0, 200)}`),
    d.disposition ? `  judged ${d.disposition.kind} by ${d.disposition.by} at ${d.disposition.at}${d.disposition.manifest ? ` (manifest ${d.disposition.manifest.slice(7, 19)})` : ''}: ${d.disposition.note}` : d.closed ? `  closed: ${d.closed.reason}` : '',
    ...(rec.nodes[d.node] ? [`  node ${d.node}: ${rec.nodes[d.node].state}${rec.nodes[d.node].wait ? `; next move: ${holderOf(rec, d.node)}` : ''}`] : []),
  ].filter(Boolean)
}

export async function delegateCommand(c: RunCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') {
    const topic = args[0]
    console.log(topic && DELEGATE_HELP[topic] ? `${DELEGATE_HELP[topic]}\n\n${COMMON}` : DELEGATE_INDEX)
    return topic && !DELEGATE_HELP[topic] ? 2 : 0
  }
  if (!DELEGATE_HELP[sub]) throw c.usage(`no delegate subcommand "${sub}" (see: wfe delegate help)`)
  if (c.flag('help')) { console.log(`${DELEGATE_HELP[sub]}\n\n${COMMON}`); return 0 }
  const store = c.exec().delegate
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f() } catch (e) {
      if (e instanceof RequestError) throw c.refused(e.message, e.detail)
      throw e
    }
  }
  if (sub === 'sync') {
    const notes = await wrap(async () => [...await store.rebuild(), ...await store.relay()])
    c.out(notes.join('\n') || 'Nothing new to relay.', { ok: true, notes })
    return 0
  }
  const ws = await c.workspace()
  const ref = async (): Promise<RunRef> => {
    if (!args[0]) throw c.usage('<run> is required')
    return wrap(() => resolveRef(ws, args[0]))
  }
  const attempt = c.opt('attempt') ?? process.env.WFE_ATTEMPT ?? undefined
  const by = c.opt('by')
  const receipt = c.opt('receipt')
  const record = async (r: RunRef) => {
    const rec = (await wrap(async () => readRun(await runSpace(ws, r), r))).record
    if (!rec) throw c.refused(`run ${runKey(r)} cannot be read`)
    return rec
  }
  // Who records: the same rules as wfe run (an attempt records as the
  // run's agent; outside one, a host-performed run needs --by).
  const recorder = (rec: RunRecord) => {
    if (attempt) {
      if (by?.trim() && by.trim() !== rec.executor.name) throw c.refused(`this process is attempt ${attempt} of ${rec.executor.name}; it records as ${rec.executor.name}, not as ${by.trim()} (name your person's words with --because)`)
      return rec.executor.name
    }
    if (!by?.trim() && rec.executor.host) throw c.refused(`who records this? Pass --by <your name>: run ${rec.workflow}/${rec.run} is performed by ${rec.executor.name} on the execution host, and only its executing attempt records under that name.`)
    return by?.trim() || undefined
  }
  const because = (): BecauseRef | undefined => {
    const v = c.opt('because')
    if (!v) return undefined
    const m = /^(answer|instruction):([a-z0-9]+)(?::(\d+))?$/.exec(v)
    if (!m) throw c.usage('--because is answer:<question>[:<answer index>] or instruction:<instruction id>')
    return m[1] === 'answer' ? { kind: 'answer', question: m[2], ...(m[3] ? { answer: Number(m[3]) } : {}) } : { kind: 'instruction', instruction: m[2] }
  }
  const meta = () => ({ ...(attempt ? { attempt } : {}), ...(receipt ? { receipt } : {}) })
  const need = (k: string, what: string) => { const v = c.opt(k); if (!v?.trim()) throw c.usage(`--${k} is required: ${what}`); return v }
  const delegation = (rec: RunRecord, id: string | undefined) => {
    if (!id) throw c.usage('<d> is required (d1, d2, …; wfe delegate list <run>)')
    const d = rec.delegations?.[id]
    if (!d) throw c.refused(`run ${rec.workflow}/${rec.run} has no delegation ${id}${rec.delegations ? ` (it has ${Object.keys(rec.delegations).join(', ')})` : ''}`)
    return d
  }
  const after = (rec: RunRecord, d: Delegation, what: string) => {
    const n = rec.nodes[d.node]
    c.out([what, `Delegation ${d.id}: ${delegationState(d)}; node ${d.node} is ${n?.state}${n?.wait ? ` (next move: ${holderOf(rec, d.node)})` : ''}.`].join('\n'), { ok: true, ref: runKey(rec), seq: rec.seq, delegation: d })
    return 0
  }
  switch (sub) {
    case 'request': {
      const r = await ref()
      const node = args[1]
      if (!node) throw c.usage('<node> is required: the running delegate node')
      const file = need('request', 'the request text (a file, or - for stdin)')
      const text = readFileSync(file === '-' ? 0 : resolve(file), 'utf8')
      const original = c.opt('original') ? readFileSync(resolve(c.opt('original')!), 'utf8') : undefined
      const rec = await record(r)
      const res = await wrap(() => store.dispatch(ws, r, node, { request: text, original, predecessor: c.opt('replaces'), by: recorder(rec), via: 'cli', ...meta() }))
      return after(res.record, res.delegation, `${res.duplicate ? 'Already dispatched (same request); nothing changed.' : `Dispatched ${res.delegation.id}: ${node} → ${res.delegation.target.project}/${res.delegation.target.workflow} (workspace ${res.delegation.target.workspace}).`} The request is posted in that workflow's channel; its intake creates the child.${res.notes.length ? `\n${res.notes.join('\n')}` : ''}\nWhen only the child's work remains, end your attempt: its questions and its result resume this run.`)
    }
    case 'list': {
      const rec = await record(await ref())
      const all = Object.values(rec.delegations ?? {})
      c.out(all.length ? all.map(d => `${d.id}  ${d.node.padEnd(16)} → ${`${d.target.project}/${d.target.workflow}`.padEnd(24)} ${delegationState(d).padEnd(11)} ${d.child ? `${d.child.workflow}/${d.child.run}` : '(no child yet)'}${pendingEvents(d).length ? `  — ${pendingEvents(d).map(e => `${e.type} #${e.n}`).join(', ')} not taken up` : ''}`).join('\n') : 'No delegations.', { ref: runKey(rec), delegations: all.map(d => ({ ...d, state: delegationState(d) })) })
      return 0
    }
    case 'show': {
      const rec = await record(await ref())
      const d = delegation(rec, args[1])
      c.out(describeDelegation(d, rec).join('\n'), { ref: runKey(rec), delegation: { ...d, state: delegationState(d) } })
      return 0
    }
    case 'take-up': {
      const r = await ref()
      const rec = await record(r)
      const d = delegation(rec, args[1])
      const ns = args.slice(2).map(Number)
      if (!ns.length || ns.some(n => !Number.isInteger(n) || n < 1)) throw c.usage('<n>... is required: the fact numbers (wfe delegate show)')
      const res = await wrap(async () => runOp(await runSpace(ws, r), r, { op: 'delegation.take-up', delegation: d.id, events: ns, ...meta() } as never, { by: recorder(rec), via: 'cli' }))
      return after(res.record, res.record.delegations![d.id], res.duplicate ? 'Already recorded (same receipt); nothing changed.' : `Taken up: ${ns.map(n => `#${n}`).join(', ')} of ${d.id}.`)
    }
    case 'answer': {
      const r = await ref()
      const rec = await record(r)
      const d = delegation(rec, args[1])
      const q = args[2]
      if (!q) throw c.usage('<question> is required: the child\'s question id (q1, q2, …)')
      const res = await wrap(() => store.answer(ws, r, d.id, q, need('answer', 'the answer text'), { by: recorder(rec), via: 'cli', because: because(), ...meta() }))
      return after(res.record, res.record.delegations![d.id], res.duplicate ? 'Already recorded (same receipt); nothing changed.' : `Answered ${q} of ${d.id}; it is posted in the child's request topic and recorded there.`)
    }
    case 'instruct': {
      const r = await ref()
      const rec = await record(r)
      const d = delegation(rec, args[1])
      const why = because()
      const res = await wrap(async () => runOp(await runSpace(ws, r), r, { op: 'delegation.instruct', delegation: d.id, text: need('instruction', 'the instruction'), ...(why ? { because: why } : {}), ...meta() } as never, { by: recorder(rec), via: 'cli' }))
      return after(res.record, res.record.delegations![d.id], res.duplicate ? 'Already recorded (same receipt); nothing changed.' : `Instruction for ${d.id} recorded; it is posted in the child's request topic.`)
    }
    case 'dispose': {
      const r = await ref()
      const rec = await record(r)
      const d = delegation(rec, args[1])
      const kind = need('disposition', 'satisfied, rejected or abandoned')
      const ev = c.opt('event') !== undefined ? Number(c.opt('event')) : undefined
      const res = await wrap(async () => runOp(await runSpace(ws, r), r, { op: 'delegation.dispose', delegation: d.id, disposition: kind, note: need('note', 'what you found'), ...(ev !== undefined ? { event: ev } : {}), ...meta() } as never, { by: recorder(rec), via: 'cli' }))
      return after(res.record, res.record.delegations![d.id], res.duplicate ? 'Already recorded (same receipt); nothing changed.' : `Delegation ${d.id} judged ${kind}.${kind === 'satisfied' ? ` Node ${d.node} may complete now (wfe run complete).` : ''}`)
    }
    case 'cancel': {
      const r = await ref()
      const rec = await record(r)
      const d = delegation(rec, args[1])
      if (!d.child) throw c.refused(`delegation ${d.id} has no child yet; nothing to cancel (abandon it instead: dispose --disposition abandoned)`)
      const who = recorder(rec) ?? rec.executor.name
      const why = because()
      const reason = need('reason', 'why the child is cancelled')
      const cws = await wrap(() => store.workspace(d.child!.workspace))
      const cref = { workflow: d.child.workflow, run: d.child.run }
      const child = await wrap(async () => (await readRun(await runSpace(cws, cref), cref)).record)
      if (child?.cancelled) throw c.refused(`the child ${cref.workflow}/${cref.run} is already cancelled (${child.cancelled.reason})`)
      const res = await wrap(() => c.exec().cancel(cws, cref, who, `cancelled by its requester ${who} (delegation ${d.uid}): ${reason}${why ? ` (on ${why.kind === 'answer' ? `answer ${why.question}` : `instruction ${why.instruction}`} of ${rec.workflow}/${rec.run})` : ''}`, 'delegation'))
      const notes = await wrap(() => store.relay())
      c.out([`Cancelled the child ${d.child.project} ${cref.workflow}/${cref.run}.`, ...notes, 'Judge the delegation next: wfe delegate dispose … --disposition abandoned.'].join('\n'), { ok: true, child: { ...cref, cancelled: res.record.cancelled }, notes })
      return 0
    }
    case 'file': {
      const rec = await record(await ref())
      const d = delegation(rec, args[1])
      const path = args[2]
      if (!path) throw c.usage('<path> is required: a path of the child\'s project')
      const check = (sha: string, expected: string | null) => expected ? (expected === sha ? 'matches the recorded hash' : `DIFFERS from the recorded hash ${expected.slice(0, 12)} (changed since the child presented it)`) : 'not named by any recorded fact'
      if (c.opt('out')) {
        const r = await wrap(() => store.copyChildFile(d, path, resolve(c.opt('out')!)))
        c.out(`Copied ${r.path} (${r.bytes} bytes, ${r.sha256.slice(0, 12)}) to ${c.opt('out')}; ${check(r.sha256, r.expected)}.`, r)
        return 0
      }
      const r = await wrap(() => store.childFile(d, path))
      if (c.flag('json')) { c.out('', { path: r.path, sha256: r.sha256, expected: r.expected, bytes: r.bytes.length, text: r.bytes.toString('utf8') }); return 0 }
      process.stdout.write(r.bytes)
      console.error(`\n[${r.path}: ${r.bytes.length} bytes, ${r.sha256.slice(0, 12)}; ${check(r.sha256, r.expected)}]`)
      return 0
    }
  }
  return 2
}

// Where a parent's delegation files are (for messages and the browser).
export const delegationDir = (r: RunRef, d: string) => `${runDir(r)}/delegations/${d}`
