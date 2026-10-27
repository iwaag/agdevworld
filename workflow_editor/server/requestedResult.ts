// A result the receiver requested itself (tidy p3). In p2's fixture trials
// ponderer commissioned work with `wfe request` and awaited it with
// `conversation ask --run`; the delegation assessment and `delegate revise`
// never reached those results, and the await told only "unanswered: ended
// without a message here". The requested run records who asked
// (input.entrustedBy, a run), so the same claim, records and questions are
// rendered here from the same helper (shared/assessment.ts claimBeside), and
// its requester — only its requester — returns the result to it.
//
// Identity: the producing run, its completing history entry (the result),
// the requesting relation as recorded, and when this was observed. Live
// state is said apart ("now"). Observing a run grants nothing: a run that
// did not request it is told who did and how to reach them.
import { claimBeside } from '../shared/assessment.ts'
import { openCorrections, situation, type RunRecord, type RunRef } from '../shared/run.ts'
import type { DelegateStore } from './delegate.ts'
import { recordAt, resultPosition } from './delegate.ts'
import { changedPaths, pathsByNode } from './reminders.ts'
import { readRun, runOp } from './runs.ts'
import { runSpace } from './runspace.ts'
import { RequestError } from './workspace.ts'

export interface RequestedAssessment {
  run: string // <workspace>/<workflow>/<run>
  requestedBy: string | null // the requesting run as recorded, <project>/<workflow>/<run>
  delegatedBy: string | null // a delegated child's parent delegation (its own route)
  relation: 'requester' | 'observer'
  receiver: string | null
  state: string // the run's situation now
  resultSeq: number | null // the completing entry of the latest result
  completedAt: string | null
  position: number | null // the history position its facts are frozen at
  manifest: string | null
  observedAt: string
  claim: string[]
  evidence: string[]
  inspect: string[]
  correction: string | null // the correction this result answers
  corrections: string[] // every correction the run received, and its state now
  route: string[]
  unavailable: string[]
}

const lastCompletion = (r: RunRecord) => [...r.history].reverse().find(h => h.change?.execution?.[1] === 'completed') ?? null
export const requesterOf = (r: RunRecord): string | null => r.input.entrustedBy?.kind === 'run' ? `${r.input.entrustedBy.project ?? r.project}/${r.input.entrustedBy.workflow}/${r.input.entrustedBy.run}` : null

// `receiver`: the run reading it, <project>/<workflow>/<run> (null: a person
// or a tool outside a run; it is told the route, not given one).
export async function assessRequested(store: DelegateStore, target: { workspace: string; ref: RunRef }, receiver: string | null): Promise<RequestedAssessment> {
  const name = `${target.workspace}/${target.ref.workflow}/${target.ref.run}`
  const ws = await store.workspace(target.workspace)
  const space = await runSpace(ws, target.ref)
  const reading = await readRun(space, target.ref)
  const rec = reading.record
  if (!rec) throw new RequestError(404, `no run ${name}`)
  const unavailable: string[] = []
  const requestedBy = requesterOf(rec)
  const ent = rec.input.entrustedBy
  const delegatedBy = ent?.kind === 'delegation' ? ent.delegation : null
  const relation = receiver && requestedBy === receiver ? 'requester' : 'observer'
  const done = lastCompletion(rec)
  const out: RequestedAssessment = { run: name, requestedBy, delegatedBy, relation, receiver, state: situation(rec), resultSeq: done?.seq ?? null, completedAt: done?.at ?? null, position: null, manifest: null, observedAt: new Date().toISOString(), claim: [], evidence: [], inspect: [], correction: null, corrections: [], route: [], unavailable }
  for (const k of Object.values(rec.corrections ?? {})) out.corrections.push(`${k.id} (returned the result of seq ${k.result.seq}, by ${k.by}${k.from !== k.by ? ` relaying ${k.from}` : ''}${k.request ? '' : k.delegation ? `, delegation request ${k.delegation.revision}` : ''}): ${k.addressed ? `addressed (${k.addressed.how}, seq ${k.addressed.seq})` : 'not addressed yet'} — "${k.text.replace(/\s+/g, ' ').slice(0, 120)}"`)
  if (done) {
    const frozen = recordAt(rec, resultPosition(rec, done.seq))
    if (!frozen) unavailable.push('the run\'s record as of the result does not replay')
    out.position = frozen?.seq ?? null
    const manifest = await store.manifest(space, frozen ?? rec).catch(e => { unavailable.push(`its result manifest: ${(e as Error).message}`); return null })
    out.manifest = manifest?.digest ?? null
    const paths = await changedPaths(space, rec).catch(() => null)
    let changed: { path: string; nodes: string[] }[] | null = null
    let removed: string[] = []
    if (paths === null) unavailable.push('its working copy (its changed files) is not readable here')
    else {
      const by = pathsByNode(paths, frozen ?? rec, (frozen ?? rec).updated)
      changed = paths.map(p => ({ path: p.path, nodes: Object.entries(by).filter(([, ps]) => ps.includes(p.path)).map(([n]) => n) }))
      removed = paths.filter(p => p.mtime === null).map(p => p.path)
    }
    const active = frozen?.definition.active
    const authored = (active ? reading.bundle.revisions?.find(r => r.revision === active)?.workflow : undefined) ?? reading.bundle.entries[rec.definition.root]?.workflow
    const ret = relation === 'requester' ? `wfe run return ${name} --requester ${receiver} --result-seq ${done.seq} --instruction "…" --reason "…" --evidence "…"` : 'its requester returns it'
    const c = claimBeside(manifest, { frozen, authored, now: rec, changed, removed, who: 'the requested run' }, `wfe run result ${name} --file <path>`, ret)
    Object.assign(out, { claim: c.claim, evidence: c.evidence, inspect: c.inspect })
    const answered = Object.values(rec.corrections ?? {}).filter(k => k.result.seq < done.seq).at(-1)
    if (answered) out.correction = `This result follows correction ${answered.id} (which returned the result of seq ${answered.result.seq}): "${answered.text.replace(/\s+/g, ' ').slice(0, 160)}". A judgement or check of the earlier result does not cover it: check the correction itself.`
  }
  if (!done) out.route.push(`${name} has no completed result yet (${out.state}); nothing to judge or return.`)
  else if (openCorrections(rec).length) out.route.push(`${name} is open for correction ${openCorrections(rec).map(k => k.id).join(', ')}; its next completion is a new result.`)
  else if (relation === 'requester') out.route.push(`You requested this run (input.entrustedBy). What falls short of what you asked goes back to it: wfe run return ${name} --requester ${receiver} --result-seq ${done.seq} --instruction "what to add or change" --reason "why" --evidence "what you checked". It reopens, its agent adds the work, and its next completion is a new result: await it again (wfe conversation ask --node <n> --run ${name} …). No go-ahead is needed for what the request asked; materially new work is the person's to decide.`)
  else if (delegatedBy) out.route.push(`${name} is a delegated child (${delegatedBy}); its parent assesses it with wfe delegate show and returns it with wfe delegate revise; no other run returns it.`)
  else out.route.push(`You did not request ${name} (${requestedBy ? `requested by ${requestedBy}` : 'no requesting run is recorded'}); observing it gives no authority to return it. Tell ${requestedBy ?? 'the person'} what you found.`)
  return out
}

export function requestedLines(a: RequestedAssessment, indent = '  '): string[] {
  return [
    `${indent}result of ${a.run}: ${a.resultSeq ? `completed at seq ${a.resultSeq} (${a.completedAt})${a.position ? `, facts as of seq ${a.position}` : ''}${a.manifest ? `, manifest ${a.manifest.slice(7, 19)}` : ''}` : `none yet (${a.state})`}; ${a.requestedBy ? `requested by ${a.requestedBy}` : a.delegatedBy ? `delegated by ${a.delegatedBy}` : 'no requesting run recorded'}${a.relation === 'requester' ? ' (you)' : ''}; observed ${a.observedAt}`,
    ...(a.correction ? [`${indent}  ${a.correction}`] : []),
    ...a.claim.map(x => `${indent}  claim — ${x}`),
    ...a.evidence.map(x => `${indent}  records — ${x}`),
    ...a.corrections.map(x => `${indent}  correction ${x}`),
    ...a.inspect.map((x, i) => `${indent}  ${i === 0 ? 'to judge: ' : '  · '}${x}`),
    ...a.route.map(x => `${indent}  ${x}`),
    ...a.unavailable.map(x => `${indent}  unavailable: ${x}`),
  ]
}

// The requester returns the requested run's latest result to it (tidy p3).
// Authority is the recorded relation; inside an attempt, the attempt must be
// the requesting run's own. The result returned is named by its completing
// entry, so a newer result is never returned by a stale assessment.
export async function returnRequested(store: DelegateStore, target: { workspace: string; ref: RunRef }, o: { requester: string; instruction: string; reason: string; evidence?: string; resultSeq?: number; attempt?: string; by?: string; receipt?: string; via: string }): Promise<{ record: RunRecord; correction: string; duplicate: boolean; job: string | null }> {
  const name = `${target.workspace}/${target.ref.workflow}/${target.ref.run}`
  const m = /^([a-z0-9][a-z0-9_.-]*)\/([a-z0-9][a-z0-9_.-]*)\/(run-[a-z0-9][a-z0-9_.-]*)$/.exec(o.requester)
  if (!m) throw new RequestError(400, `--requester is <project>/<workflow>/<run>, not "${o.requester}"`)
  const rws = await store.workspace(m[1])
  const rref = { workflow: m[2], run: m[3] }
  const req = (await readRun(await runSpace(rws, rref), rref)).record
  if (!req) throw new RequestError(404, `no run ${o.requester}`)
  let by = o.by?.trim()
  if (o.attempt) {
    if (req.control.attempt?.id !== o.attempt) throw new RequestError(403, `attempt ${o.attempt} is not ${o.requester}'s open attempt; a run returns only what it requested`, { code: 'not-requester' })
    by = req.executor.name
  }
  if (!by) throw new RequestError(400, 'who returns it? Pass --by (outside the requesting run\'s attempt)')
  const ws = await store.workspace(target.workspace)
  const space = await runSpace(ws, target.ref)
  const rec = (await readRun(space, target.ref)).record
  if (!rec) throw new RequestError(404, `no run ${name}`)
  const owner = requesterOf(rec)
  if (owner !== `${req.project}/${req.workflow}/${req.run}`) throw new RequestError(403, `${o.requester} did not request ${name} (${owner ? `requested by ${owner}` : rec.input.entrustedBy?.kind === 'delegation' ? 'a delegated child: its parent uses wfe delegate revise' : 'no requesting run is recorded'}); only its requester returns its result`, { code: 'not-requester' })
  const done = lastCompletion(rec)
  // A retransmission (same receipt) finds what it recorded.
  const sent = o.receipt ? rec.history.find(h => h.receipt === o.receipt) : undefined
  if (sent) return { record: rec, correction: sent.change.correction?.[1] ?? '', duplicate: true, job: null }
  if (!done || situation(rec) !== 'completed') throw new RequestError(409, `${name} is ${situation(rec)}; a correction returns a completed result`, { code: 'correction-state' })
  if (o.resultSeq !== undefined && o.resultSeq !== done.seq) throw new RequestError(409, `${name}'s latest result completed at seq ${done.seq}, not ${o.resultSeq}; assess the latest result (wfe run result ${name})`, { code: 'result-superseded' })
  const receipt = o.receipt ?? `return:${o.requester}:${name}:${done.seq}`
  const before = rec.history.some(h => h.receipt === receipt)
  const r = await runOp(space, target.ref, { op: 'correction.receive', request: { run: owner }, result: { seq: done.seq }, text: o.instruction, reason: o.reason, from: by, ...(o.evidence ? { evidence: o.evidence } : {}), receipt } as never, { by, via: o.via })
  const id = r.record.history.find(h => h.receipt === receipt)?.change.correction?.[1] ?? Object.keys(r.record.corrections ?? {}).at(-1)!
  const job = before ? null : await store.ctx.exec?.afterCorrection(ws, target.ref, id).catch(() => null) ?? null
  return { record: r.record, correction: id, duplicate: before, job: job ? String(job.id) : null }
}

// The runs a conductor awaited in its conversations (conversation ask --run)
// and where each stands, for its account to the room (tidy p3): the latest
// result or correction fact of each, with its time. Facts only; whether a
// post accounts for them well is the agent's judgement.
export async function awaitedStanding(ds: { invitations(conv: string): { awaited_by: string | null; awaits: string | null; run: string | null }[]; exec?: { workspace(id: string): Promise<import('./workspace.ts').Workspace> } | null }, convs: string[], conductor: string): Promise<{ run: string; at: string; text: string }[]> {
  const runs = [...new Set(convs.flatMap(id => ds.invitations(id).filter(i => i.awaited_by === conductor && i.awaits && i.run).map(i => i.run!)))]
  const out: { run: string; at: string; text: string }[] = []
  for (const name of runs) {
    const m = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(name)
    if (!m || !ds.exec) continue
    const ref = { workflow: m[2], run: m[3] }
    const rec = await ds.exec.workspace(m[1]).then(async ws => (await readRun(await runSpace(ws, ref), ref)).record).catch(() => null)
    if (!rec) continue
    const done = lastCompletion(rec)
    const ks = Object.values(rec.corrections ?? {})
    const open = openCorrections(rec)
    const times = [...(done ? [done.at] : []), ...ks.map(k => k.at)].sort()
    if (!times.length) continue
    const after = ks.length ? ` after ${ks.length} correction${ks.length === 1 ? '' : 's'} (${ks.map(k => k.id).join(', ')}; an earlier result fell short ${ks.length === 1 ? 'once' : `${ks.length} times`})` : ''
    const text = open.length ? `${name} (requested): returned for correction ${open.map(k => k.id).join(', ')}, not back yet`
      : done ? `${name} (requested): result at seq ${done.seq}${after}${requesterOf(rec) === null ? '' : `; requested by ${requesterOf(rec)}`}`
        : `${name} (requested): no result yet`
    out.push({ run: name, at: times.at(-1)!, text })
  }
  return out
}

// One file of the requested run's working copy (its project's path), with its
// hash, as `wfe delegate file` reads a child's.
export async function requestedFile(store: DelegateStore, target: { workspace: string; ref: RunRef }, path: string): Promise<{ path: string; sha256: string; bytes: Buffer }> {
  const { inside } = await import('./files.ts')
  const { readFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const space = await runSpace(await store.workspace(target.workspace), target.ref)
  const bytes = await readFile(await inside(space.root, path)).catch(e => { throw new RequestError(404, `${path} is not readable in ${target.workspace}/${target.ref.workflow}/${target.ref.run}'s copy (${(e as Error).message})`) })
  if (bytes.length > 4 * 1024 * 1024) throw new RequestError(413, `${path} is ${bytes.length} bytes; read at most 4 MiB here`)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes }
}
