// Delegation on this host (p10, docs/delegation.md): the file layer and the
// relay around the parent's `delegations` record (shared/run.ts).
//
// - dispatch: resolves the delegate node's portable target to a workspace
//   (explicitly, never by guess), refuses cycles, writes the request (and
//   the human original beside it) into the parent's run folder and records
//   the dispatch. Delivery is the notifier's (server/notify.ts, a
//   `delegation` conversation); the child is created by the intake from the
//   delivered post (server/intake.ts), which binds it here (`bind`).
// - relay: reads every bound child's record and records its relayed facts
//   on the parent, each under its own receipt, and queues the parent's
//   continuation for the facts that wake it. It runs in the intake's pass
//   and in the executor's reconcile; both are safe to repeat.
// - the parent agent's other operations (take-up, answer, instruct,
//   dispose) and reading the child's files go through the same checks.
//
// <area>/.local/delegate/delegate.sqlite is an index of delegations to
// relay, rebuilt from the parent records by `rebuild()`; the records stay
// the authority.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson, semanticDigest } from '../shared/canonical.ts'
import {
  childFacts, delegationFolder, isOpenDelegation, pendingEvents, questionEvent, WAKING,
  type ChildRef, type Delegation, type ManifestFile, type ResultManifest, type TransportRef,
} from '../shared/delegation.ts'
import { normalizeRepoPath } from '../shared/model.ts'
import { graphOfState, hostOf, questionState, replay, runKey, standingHold, type BecauseRef, type DocumentEvidence, type RunRecord, type RunRef } from '../shared/run.ts'
import { assessResult, assessmentReminders, type Assessment, type ChildEvidence } from '../shared/assessment.ts'
import { latestResult, openRevision as openRevisionOf } from '../shared/delegation.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { ExecStore, JobRow } from './exec.ts'
import { atomicWrite, inside } from './files.ts'
import { git } from './git.ts'
import { creationOf } from './observe.ts'
import { loadRegistry, observe, type Registration } from './registry.ts'
import { RUN_FILE, catalogOf, listRuns, readRun, runDir, runOp, runOpLocked, type OpContext } from './runs.ts'
import { withLock } from './lock.ts'
import { reminderText } from '../shared/reminders.ts'
import { changedPaths, pathsByNode } from './reminders.ts'
import { runSpace } from './runspace.ts'
import { named, openStore } from './sqlite.ts'
import { RequestError, Workspace } from './workspace.ts'

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const now = () => new Date().toISOString()
export const uidOf = (r: RunRecord) => `${r.project}/${r.workflow}/${r.run}#${creationOf(r)}`
const MAX_FILE = 4 * 1024 * 1024

export interface DelegateContext { registryFile: string; area: string; exec?: ExecStore }
interface IndexRow { uid: string; parent_ws: string; parent_workflow: string; parent_run: string; delegation: string; node: string; target_project: string; target_workflow: string; target_ws: string; child_workflow: string | null; child_run: string | null; child_uid: string | null; relayed: number; state: 'open' | 'closed'; problem: string | null; updated: string }

export class DelegateStore {
  readonly db: DatabaseSync
  readonly ctx: DelegateContext
  constructor(ctx: DelegateContext) {
    this.ctx = ctx
    const dir = join(ctx.area, '.local', 'delegate')
    mkdirSync(dir, { recursive: true })
    this.db = openStore('delegate store', join(dir, 'delegate.sqlite'), [{
      version: 1,
      up: db => db.exec(`
        CREATE TABLE delegations (uid TEXT PRIMARY KEY, parent_ws TEXT NOT NULL, parent_workflow TEXT NOT NULL, parent_run TEXT NOT NULL, delegation TEXT NOT NULL, node TEXT NOT NULL,
          target_project TEXT NOT NULL, target_workflow TEXT NOT NULL, target_ws TEXT NOT NULL, child_workflow TEXT, child_run TEXT, child_uid TEXT,
          relayed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, problem TEXT, updated TEXT NOT NULL);
        CREATE INDEX delegations_state ON delegations (state);
      `),
    }])
  }
  close() { this.db.close() }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('delegate store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private run(sql: string, ...a: (string | number | null)[]) { return named('delegate store', 'a write', () => this.db.prepare(sql).run(...a)) }

  rows(): IndexRow[] { return this.all<IndexRow>('SELECT * FROM delegations ORDER BY uid') }
  private index(ws: string, rec: RunRecord, d: Delegation) {
    const closed = !!d.closed || (!!d.disposition && !!d.child && this.childSettled(d))
    this.run(`INSERT INTO delegations (uid, parent_ws, parent_workflow, parent_run, delegation, node, target_project, target_workflow, target_ws, child_workflow, child_run, child_uid, relayed, state, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (uid) DO UPDATE SET child_workflow = excluded.child_workflow, child_run = excluded.child_run, child_uid = excluded.child_uid,
      state = excluded.state, updated = excluded.updated`,
    d.uid, ws, rec.workflow, rec.run, d.id, d.node, d.target.project, d.target.workflow, d.target.workspace, d.child?.workflow ?? null, d.child?.run ?? null, d.child?.uid ?? null, d.closed ? 'closed' : closed ? 'closed' : 'open', now())
  }
  // A judged delegation is still relayed until its child is over (its
  // decision and integration are recorded for the record).
  private childSettled(d: Delegation) { return d.events.some(e => e.type === 'cancelled' || e.type === 'integrated') }

  // ---- resolution ------------------------------------------------------------------------

  private async registered(): Promise<Registration[]> { return (await loadRegistry(this.ctx.registryFile)).workspaces }

  async workspace(id: string): Promise<Workspace> {
    const reg = (await this.registered()).find(w => w.id === id)
    if (!reg) throw new RequestError(404, `workspace "${id}" is not registered`)
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Delegation')
    return new Workspace(reg)
  }

  // The target project's workspace on this host: its one registered
  // workspace, or the one zulip.json intake.projects selects. Ambiguity is
  // refused with the candidates, never guessed (docs/delegation.md).
  async targetWorkspace(project: string): Promise<Workspace> {
    const regs = (await this.registered()).filter(w => w.project === project)
    const { loadNotifyConfig } = await import('./notify.ts')
    const cfg = loadNotifyConfig(this.ctx.area)
    const selected = cfg && !('problem' in cfg) ? ((cfg.intake as { projects?: Record<string, { workspace?: string }> } | undefined)?.projects?.[project]?.workspace) : undefined
    const reg = selected ? regs.find(w => w.id === selected) : regs.length === 1 ? regs[0] : undefined
    if (!reg) throw new RequestError(409, selected ? `project ${project}: zulip.json selects workspace ${selected}, which is not registered for it` : regs.length ? `project ${project} has ${regs.length} workspaces here (${regs.map(w => w.id).join(', ')}); name one in zulip.json intake.projects.${project}.workspace — a delegation never guesses` : `project ${project} has no workspace registered on this host`, { code: 'delegate-target' })
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Delegation')
    if (!(await observe(reg)).available) throw new RequestError(409, `workspace ${reg.id} of project ${project} is not available`, { code: 'delegate-target' })
    return new Workspace(reg)
  }

  // Every registered workflow's delegate targets, as `<project>/<workflow>` keys.
  private async definitionGraph(): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>()
    for (const reg of await this.registered()) {
      if (!reg.project || !(await observe(reg)).available) continue
      const ws = new Workspace(reg)
      for (const s of (await ws.workflowSummaries().catch(() => ({ list: [] }))).list) {
        if (!s.id) continue
        graph.set(`${reg.project}/${s.id}`, s.delegates.map(t => (t.includes('/') ? t : `${reg.project}/${t}`)))
      }
    }
    return graph
  }

  // The ancestors of a run through delegation: each parent's record, read
  // from its own workspace, as `<project>/<workflow>` with its uid.
  async ancestors(rec: RunRecord): Promise<{ key: string; uid: string }[]> {
    const out: { key: string; uid: string }[] = []
    let cur: RunRecord | undefined = rec
    for (let depth = 0; cur && depth < 32; depth++) {
      const e: RunRecord['input']['entrustedBy'] = cur.input.entrustedBy
      if (e?.kind !== 'delegation') break
      const parent: { project: string; workflow: string; run: string; creation: string; node: string } = e.parent
      out.push({ key: `${parent.project}/${parent.workflow}`, uid: `${parent.project}/${parent.workflow}/${parent.run}#${parent.creation}` })
      const regs: Registration[] = (await this.registered()).filter(w => w.project === parent.project)
      cur = undefined
      for (const r of regs) {
        const found: RunRecord | undefined = (await readRun(new Workspace(r), { workflow: parent.workflow, run: parent.run }).catch(() => null))?.record
        if (found && creationOf(found) === parent.creation) { cur = found; break }
      }
    }
    return out
  }

  // ---- dispatch ---------------------------------------------------------------------------

  async dispatch(ws: Workspace, ref: RunRef, node: string, o: { request: string; original?: string; predecessor?: string; attempt?: string; by?: string; via: string; receipt?: string }): Promise<{ record: RunRecord; delegation: Delegation; duplicate: boolean; notes: string[] }> {
    const space = await runSpace(ws, ref)
    const reading = await readRun(space, ref)
    const rec = reading.record
    if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read: ${reading.problem?.message ?? ''}`)
    const gn = (rec.definition.revisions?.at(-1)?.effective ?? rec.definition.effective)?.nodes[node]
    if (!gn) throw new RequestError(422, `node "${node}" is not in run ${runKey(ref)}'s graph`, { code: 'node-unknown' })
    if (gn.type !== 'delegate' || !gn.workflow) throw new RequestError(422, `node "${node}" is ${gn.type}; only a delegate node with a target dispatches`, { code: 'state' })
    if (!o.request.trim()) throw new RequestError(400, 'the request is empty: write what the child is asked for')
    const receipt = o.receipt ?? `dispatch:${node}:${sha256(o.request).slice(0, 16)}:${o.predecessor ?? ''}`
    const dup = rec.history.find(h => h.receipt === receipt)
    if (dup) {
      const d = Object.values(rec.delegations ?? {}).find(x => x.dispatched.seq === dup.seq)!
      return { record: rec, delegation: d, duplicate: true, notes: [] }
    }
    const project = gn.project ?? rec.project
    const target = await this.targetWorkspace(project)
    const notes: string[] = []
    // The target as it is now: it exists, validates and accepts requests.
    const summary = (await target.workflowSummaries()).list.find(s => s.id === gn.workflow)
    if (!summary) {
      const unreadable = (await target.workflowSummaries()).list.find(s => !s.id && s.problem && /^(.*)\.ya?ml$/.exec(s.file)?.[1] === gn.workflow)
      throw new RequestError(409, unreadable ? `${project}/${unreadable.file} cannot be read: ${unreadable.problem!.message}` : `project ${project} (workspace ${target.reg.id}) has no workflow "${gn.workflow}"`, { code: 'delegate-target' })
    }
    const tw = await target.workflowResponse(summary.file)
    if (!tw.workflow || tw.issues.some(i => i.severity === 'error')) throw new RequestError(409, `${project}/${gn.workflow} has validation errors; a child needs a valid definition (wfe validate ${gn.workflow} --workspace ${target.reg.id})`, { code: 'delegate-target' })
    if (tw.workflow.intake.zulip !== 'requests') throw new RequestError(409, `${project}/${gn.workflow} opts out of requests (intake: {zulip: ""}); a delegation is delivered through its intake`, { code: 'delegate-target' })
    // Cycles: the target's definitions reaching back, and the active ancestors.
    const self = `${rec.project}/${rec.workflow}`
    const tkey = `${project}/${gn.workflow}`
    const graph = await this.definitionGraph()
    const seen = new Set<string>(), path: string[] = []
    const reaches = (k: string): boolean => {
      if (k === self) { path.push(k); return true }
      if (seen.has(k)) return false
      seen.add(k)
      for (const t of graph.get(k) ?? []) if (reaches(t)) { path.unshift(k); return true }
      return false
    }
    if (tkey === self || reaches(tkey)) throw new RequestError(422, `delegating ${self} → ${tkey} is a cycle: ${[self, ...(tkey === self ? [] : path)].join(' → ')}`, { code: 'delegate-cycle' })
    const ancestors = await this.ancestors(rec)
    const loop = ancestors.find(a => a.key === tkey)
    if (loop) throw new RequestError(422, `delegating to ${tkey} would run it inside itself: this run descends from ${loop.uid} (${ancestors.map(a => a.key).join(' ← ')})`, { code: 'delegate-cycle' })
    // The request and the human original, written into the run folder.
    const id = `d${Object.keys(rec.delegations ?? {}).length + 1}`
    const folder = delegationFolder(runDir(ref), id)
    const dir = await inside(space.root, folder)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, 'request.md'), o.request)
    const original = o.original ?? await this.humanOriginal(space, ref, rec)
    if (original !== null) await atomicWrite(join(dir, 'original-input.md'), original)
    const ev = (name: string, text: string): DocumentEvidence => ({ path: `${folder}/${name}`, sha256: sha256(text), bytes: Buffer.byteLength(text) })
    const onBehalfOf = rec.input.author ?? rec.input.onBehalfOf ?? null
    const r = await runOp(space, ref, {
      op: 'delegation.dispatch', delegation: id, uid: `${uidOf(rec)}/${id}`, node, target: { project, workflow: gn.workflow, workspace: target.reg.id },
      request: ev('request.md', o.request), ...(original !== null ? { original: ev('original-input.md', original) } : {}),
      ...(onBehalfOf ? { onBehalfOf } : {}), ...(o.predecessor ? { predecessor: o.predecessor } : {}), targetDigest: await semanticDigest('definition', tw.workflow),
      receipt, ...(o.attempt ? { attempt: o.attempt } : {}),
    } as never, { by: o.by, via: o.via })
    const d = r.record.delegations![id]
    this.index(ws.shared.reg.id, r.record, d)
    if (summary.warnings) notes.push(...tw.issues.filter(i => i.severity === 'warning' && i.code !== 'delegate-not-executable').map(i => `${tkey}: ${i.code}: ${i.message}`))
    return { record: r.record, delegation: d, duplicate: !!r.duplicate, notes }
  }

  // The person's words a run's request ultimately comes from: the parent's
  // braindump, or the original its own request kept (docs/delegation.md).
  private async humanOriginal(space: Workspace, ref: RunRef, rec: RunRecord): Promise<string | null> {
    const file = rec.input.kind === 'braindump' ? rec.input.file : rec.input.original
    if (!file) return null
    return readFile(join(await inside(space.root, runDir(ref)), file), 'utf8').catch(() => null)
  }

  // ---- the intake's side ------------------------------------------------------------------

  // A delegation's parent and the request it dispatched, as the intake needs
  // them to create the child: checked against the recorded hash.
  async requestOf(parent: { workspace: string; workflow: string; run: string }, id: string): Promise<{ record: RunRecord; delegation: Delegation; request: string; original: string | null; space: Workspace }> {
    const ws = await this.workspace(parent.workspace)
    const ref = { workflow: parent.workflow, run: parent.run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    if (!rec) throw new RequestError(409, `the parent run ${runKey(ref)} in ${parent.workspace} cannot be read`)
    const d = rec.delegations?.[id]
    if (!d) throw new RequestError(409, `the parent run ${runKey(ref)} has no delegation ${id}`)
    const read = async (e: DocumentEvidence | undefined) => {
      if (!e) return null
      const text = await readFile(await inside(space.root, e.path), 'utf8')
      if (sha256(text) !== e.sha256) throw new RequestError(409, `${e.path} changed since delegation ${id} was dispatched (its hash differs); the request is not delivered as something else`)
      return text
    }
    return { record: rec, delegation: d, request: (await read(d.request))!, original: await read(d.original), space }
  }

  async bind(parent: { workspace: string; workflow: string; run: string }, id: string, child: RunRecord, childWorkspace: string, transport: TransportRef): Promise<void> {
    const { record, delegation, space } = await this.requestOf(parent, id)
    const ref: ChildRef = { uid: uidOf(child), workspace: childWorkspace, project: child.project, workflow: child.workflow, run: child.run, created: child.created }
    const r = await runOp(space, { workflow: record.workflow, run: record.run }, { op: 'delegation.bind', delegation: id, child: ref, transport, receipt: `delegation-bind:${delegation.uid}` } as never, { by: 'wfe', via: 'delegation' })
    this.index(parent.workspace, r.record, r.record.delegations![id])
  }

  // A post for this delegation was not applied to the child (late, the
  // child closed, refused): the parent is told, and woken.
  async refused(parent: { workspace: string; workflow: string; run: string }, id: string, o: { kind: 'answer' | 'instruction' | 'revision'; index: number; reason: string; question?: string }): Promise<void> {
    const ws = await this.workspace(parent.workspace)
    const ref = { workflow: parent.workflow, run: parent.run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    const d = rec?.delegations?.[id]
    if (!rec || !d || rec.cancelled || d.closed) return
    await runOp(space, ref, { op: 'delegation.event', delegation: id, event: { type: 'answer-refused', child: { seq: 0, at: now(), by: 'intake' }, text: `${o.kind === 'revision' ? 'correction request' : o.kind} ${o.index} was not applied to the child: ${o.reason}`, ...(o.question ? { question: o.question } : {}), ...(o.kind === 'revision' ? { revision: o.index } : { answer: o.index }) }, receipt: `delegation:${d.uid}:${o.kind}:${o.index}:refused` } as never, { by: 'wfe', via: 'delegation' })
    await this.continuation(space, ref)
  }

  // ---- the relay --------------------------------------------------------------------------

  // Re-reads every parent record of every available workspace and indexes
  // its delegations: what a lost index row, or a dispatch recorded where the
  // index was not written, needs. Cheap enough for every reconcile.
  async rebuild(): Promise<string[]> {
    const notes: string[] = []
    const known = new Set(this.rows().map(r => r.uid))
    for (const reg of await this.registered()) {
      if (!(await observe(reg)).available) continue
      const ws = new Workspace(reg)
      for (const s of await listRuns(ws).catch(() => [])) {
        if (s.problem) continue
        const rec = (await readRun(ws, { workflow: s.workflow, run: s.run }).catch(() => null))?.record
        for (const d of Object.values(rec?.delegations ?? {})) {
          this.index(reg.id, rec!, d)
          if (!known.has(d.uid)) notes.push(`delegation ${d.uid}: indexed from its record`)
        }
      }
    }
    return notes
  }

  // Relays what each bound child recorded since the last pass: one parent
  // entry per fact (by receipt), and a continuation for the facts that wake
  // the parent. A cancelled parent records nothing more; its index row
  // closes and the child stays readable.
  async relay(): Promise<string[]> {
    const notes: string[] = []
    for (const row of this.rows().filter(r => r.state === 'open')) {
      try {
        notes.push(...await this.relayOne(row))
      } catch (e) {
        const msg = (e as Error).message
        if (row.problem !== msg) notes.push(`delegation ${row.uid}: ${msg}`)
        this.run('UPDATE delegations SET problem = ?, updated = ? WHERE uid = ?', msg.slice(0, 500), now(), row.uid)
      }
    }
    return notes
  }

  private async relayOne(row: IndexRow): Promise<string[]> {
    const ws = await this.workspace(row.parent_ws)
    const ref = { workflow: row.parent_workflow, run: row.parent_run }
    const space = await runSpace(ws, ref)
    let rec = (await readRun(space, ref)).record
    if (!rec) throw new Error(`the parent ${runKey(ref)} cannot be read`)
    let d = rec.delegations?.[row.delegation]
    if (!d) throw new Error(`the parent ${runKey(ref)} has no delegation ${row.delegation}`)
    if (rec.cancelled || d.closed) { this.run('UPDATE delegations SET state = \'closed\', problem = NULL, updated = ? WHERE uid = ?', now(), row.uid); return [`delegation ${row.uid}: closed with its parent`] }
    this.index(row.parent_ws, rec, d)
    if (!d.child) return []
    const cws = await this.workspace(d.child.workspace)
    const cref = { workflow: d.child.workflow, run: d.child.run }
    const cspace = await runSpace(cws, cref)
    const child = (await readRun(cspace, cref)).record
    if (!child) throw new Error(`the child ${d.child.project}/${runKey(cref)} cannot be read`)
    if (uidOf(child) !== d.child.uid) throw new Error(`the child ${runKey(cref)} in ${d.child.workspace} is ${uidOf(child)}, not the bound ${d.child.uid}; nothing is relayed from another run`)
    const notes: string[] = []
    let woke = false
    for (const f of childFacts(d.uid, child, row.relayed)) {
      if (rec!.history.some(h => h.receipt === f.receipt)) continue
      const event = f.event.type === 'completed' ? { ...f.event, manifest: await this.manifest(cspace, child) } : f.event
      const r = await runOp(space, ref, { op: 'delegation.event', delegation: d.id, event, receipt: f.receipt } as never, { by: 'wfe', via: 'delegation' })
      rec = r.record
      if (!r.duplicate) { notes.push(`delegation ${d.uid}: ${f.event.type} (child seq ${f.event.child.seq})`); if (WAKING.has(f.event.type)) woke = true }
    }
    d = rec!.delegations![d.id]
    this.run('UPDATE delegations SET relayed = max(relayed, ?), problem = NULL, updated = ? WHERE uid = ?', child.seq, now(), row.uid)
    this.index(row.parent_ws, rec!, d)
    if (woke || pendingEvents(d).length) {
      const job = await this.continuation(space, ref)
      if (job && woke) notes.push(`${runKey(ref)}: continuation queued (job ${job.id}, ${job.state})`)
    }
    return notes
  }

  // The parent's continuation for a relayed fact (docs/delegation.md): one
  // job per fact, by its receipt; nothing while the parent is held,
  // cancelled or executing (an attempt's end queues it then).
  async continuation(ws: Workspace, ref: RunRef): Promise<JobRow | null> {
    const exec = this.ctx.exec
    if (!exec) return null
    const space = await runSpace(ws, ref)
    const r = (await readRun(space, ref)).record
    if (!r || hostOf(r.executor) !== exec.executor || r.cancelled || r.control.hold || r.control.stop || r.control.attempt) return null
    // p18: a standing conductor's closed room continues nothing; a fact it
    // held at a transition waits for the person's resume.
    if (standingHold(r)) return null
    for (const d of Object.values(r.delegations ?? {})) {
      if (!isOpenDelegation(d)) continue
      const e = pendingEvents(d).find(x => !r.standing?.held.includes(`${d.id}#${x.n}`))
      if (e) return exec.enqueue(ws.shared.reg.id, ref, 'resume', `delegation:${ws.shared.reg.id}/${runKey(ref)}/${d.id}/${e.n}`, `resume: delegation ${d.id} relayed ${e.type} #${e.n} from ${d.target.project}/${d.target.workflow}`)
    }
    return null
  }

  // What a completed child hands back (docs/delegation.md): its outcome,
  // the final report and artifacts by hash (and the commit of the run
  // branch holding each, when that commit has it unchanged), its decision.
  async manifest(space: Workspace, child: RunRecord): Promise<ResultManifest> {
    const done = [...child.history].reverse().find(h => h.change.execution?.[1] === 'completed') as unknown as { outcome?: string } | undefined
    const graph = child.definition.revisions?.at(-1)?.effective ?? child.definition.effective
    const finalStep = Object.entries(graph?.nodes ?? {}).find(([, n]) => n.step?.kind === 'final-report')?.[0]
    const head = (await git(space.root, ['rev-parse', 'HEAD'])).stdout.trim() || null
    const fileOf = async (path: string): Promise<ManifestFile | null> => {
      try {
        const abs = await inside(space.root, path)
        const st = await lstat(abs)
        if (!st.isFile() || st.size > 512 * 1024 * 1024) return null
        const bytes = await readFile(abs)
        const h = sha256(bytes)
        // The commit holds it unchanged when HEAD's blob of it is the same bytes.
        const blob = head ? (await git(space.root, ['rev-parse', `HEAD:${path}`])).stdout.trim() : ''
        const same = blob ? (await git(space.root, ['hash-object', abs])).stdout.trim() === blob : false
        return { path, sha256: h, bytes: bytes.length, commit: same ? head : null }
      } catch { return null }
    }
    const report = finalStep && child.nodes[finalStep]?.document ? await fileOf(child.nodes[finalStep].document!.path) : null
    const artifacts: ManifestFile[] = []
    for (const p of [...new Set(child.artifacts.map(a => a.path))]) {
      if (report && p === report.path) continue
      const f = await fileOf(p)
      if (f) artifacts.push(f)
    }
    const last = child.decisions.at(-1)
    const body = { child: uidOf(child), execution: child.execution.state, outcome: done?.outcome ?? '', report, artifacts, decision: last ? { decision: last.decision, by: last.by, at: last.at } : null, branch: child.storage?.branch ?? null }
    return { digest: `sha256:${sha256(canonicalJson(body))}`, ...body }
  }

  // ---- the parent agent's operations --------------------------------------------------------

  // Answers a child's question. The child's own record decides whether the
  // question is still open: a closed one is refused here rather than sent.
  async answer(ws: Workspace, ref: RunRef, id: string, question: string, text: string, ctx: OpContext & { attempt?: string; because?: BecauseRef; receipt?: string }) {
    const { d } = await this.parentDelegation(ws, ref, id)
    if (d.child) {
      const child = await this.child(d)
      const q = child?.record.questions[question]
      if (q && ['taken-up', 'withdrawn'].includes(questionState(q))) throw new RequestError(409, `the child's ${question} is ${questionState(q)}; an answer is not sent to a closed question${questionEvent(d, question) ? '' : ''}`, { code: 'question-closed' })
    }
    return runOp(await runSpace(ws, ref), ref, { op: 'delegation.answer', delegation: id, question, text, ...(ctx.because ? { because: ctx.because } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
  }

  // Judges the delegation (fix6): under the parent's lock, the result judged
  // is the latest one (or the one named, which must be it), its manifest the
  // one the caller assessed; `satisfied` is assessed first and refused with
  // the reminders unless `yes`. Correctness errors (a stale result, a result
  // returned for correction) are never passed with yes.
  async dispose(ws: Workspace, ref: RunRef, id: string, o: { disposition: string; note: string; event?: number; manifest?: string; yes?: boolean; advise?: boolean }, ctx: OpContext & { attempt?: string; receipt?: string }) {
    const space = await runSpace(ws, ref)
    const file = join(await inside(space.root, runDir(ref)), RUN_FILE)
    return withLock(file, async () => {
      const { record, d } = await this.parentDelegation(space, ref, id)
      const op = { op: 'delegation.dispose', delegation: id, disposition: o.disposition, note: o.note, ...(o.event !== undefined ? { event: o.event } : {}), ...(o.manifest ? { manifest: o.manifest } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) }
      const retransmitted = !!ctx.receipt && record.history.some(h => h.receipt === ctx.receipt)
      if (o.disposition === 'satisfied' && o.advise !== false && !o.yes && !retransmitted && !d.disposition) {
        const ev = o.event !== undefined ? d.events.find(e => e.n === o.event) : latestResult(d)
        const latest = latestResult(d)
        // Only a judgment the reducer would record is assessed; its own
        // refusal (stale, returned, closed) comes first.
        if (ev && ev.type === 'completed' && latest?.n === ev.n && (!o.manifest || o.manifest === ev.manifest?.digest) && !openRevisionOf(d)) {
          const a = await assessDelegation(this, record, d, ev)
          const rs = a ? assessmentReminders([a]) : []
          if (rs.length) throw new RequestError(409, reminderText(rs, `judging ${id} satisfied`), { code: 'reminder', boundaries: ['dispose'], reminders: rs, assessment: a })
        }
      }
      return runOpLocked(space, ref, op as never, ctx)
    }, { what: `run ${runKey(ref)}` })
  }

  // Returns the child's current completed result to the same child for
  // correction (fix6, `wfe delegate revise`). The reducer checks the result's
  // identity and the delegation's state under the parent's lock; the
  // notifier delivers it into the child's request topic, and the child's
  // intake records it there and continues the child.
  async revise(ws: Workspace, ref: RunRef, id: string, o: { instruction: string; reason: string; event?: number; manifest?: string; because?: BecauseRef; followUp?: string }, ctx: OpContext & { attempt?: string; receipt?: string }) {
    const { d } = await this.parentDelegation(ws, ref, id)
    if (d.child) {
      const c = await this.child(d).catch(() => null)
      if (c?.record.cancelled) throw new RequestError(409, `the child ${d.child.workflow}/${d.child.run} is cancelled (${c.record.cancelled.reason}); a correction does not undo that`, { code: 'child-stopped' })
      if (c && c.record.control.attempt) throw new RequestError(409, `the child ${d.child.workflow}/${d.child.run} has attempt ${c.record.control.attempt.id} open; its result is not settled — wait for it to end`, { code: 'child-active' })
      if (c && c.record.execution.state !== 'completed' && !(c.record.corrections && Object.values(c.record.corrections).some(k => k.delegation.uid === d.uid && !k.addressed))) throw new RequestError(409, `the child ${d.child.workflow}/${d.child.run} is ${c.record.execution.state} now, not completed; a correction returns a completed result`, { code: 'child-active' })
    }
    const r = await runOp(await runSpace(ws, ref), ref, { op: 'delegation.revise', delegation: id, instruction: o.instruction, reason: o.reason, ...(o.event !== undefined ? { event: o.event } : {}), ...(o.manifest ? { manifest: o.manifest } : {}), ...(o.because ? { because: o.because } : {}), ...(o.followUp ? { followUp: o.followUp } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
    // A follow-up reopened a judged delegation (p17): its child's next
    // result is relayed again.
    const nd = r.record.delegations?.[id]
    if (o.followUp && nd) this.index(ws.reg.id, r.record, nd)
    return r
  }

  async parentDelegation(ws: Workspace, ref: RunRef, id: string): Promise<{ record: RunRecord; d: Delegation }> {
    const record = (await readRun(await runSpace(ws, ref), ref)).record
    if (!record) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
    const d = record.delegations?.[id]
    if (!d) throw new RequestError(404, `run ${runKey(ref)} has no delegation ${id}${record.delegations ? ` (it has ${Object.keys(record.delegations).join(', ')})` : ''}`, { code: 'delegation-unknown' })
    return { record, d }
  }

  async child(d: Delegation): Promise<{ record: RunRecord; space: Workspace } | null> {
    if (!d.child) return null
    const cws = await this.workspace(d.child.workspace)
    const cref = { workflow: d.child.workflow, run: d.child.run }
    const space = await runSpace(cws, cref)
    const record = (await readRun(space, cref)).record
    if (!record) return null
    if (uidOf(record) !== d.child.uid) throw new RequestError(409, `the child ${runKey(cref)} in ${d.child.workspace} is another run now (${uidOf(record)}, bound ${d.child.uid})`)
    return { record, space }
  }

  // A file of the child's working copy, read for the parent's agent: inside
  // the child's copy, a regular file, and (when the delegation's events name
  // it) the bytes those events recorded.
  async childFile(d: Delegation, path: string): Promise<{ path: string; bytes: Buffer; sha256: string; expected: string | null }> {
    const c = await this.child(d)
    if (!c) throw new RequestError(409, `delegation ${d.id} has no child yet`)
    const rel = normalizeRepoPath(path)
    if (!rel || rel === '.') throw new RequestError(400, `"${path}" is not a path inside the child's project`)
    const abs = await inside(c.space.root, rel)
    const st = await lstat(abs).catch(() => null)
    if (!st || !st.isFile() || st.isSymbolicLink() || !(await realpath(abs)).startsWith(await realpath(c.space.root))) throw new RequestError(404, `${rel} is not a regular file of the child's working copy (${d.child!.workflow}/${d.child!.run})`)
    if (st.size > MAX_FILE) throw new RequestError(413, `${rel} is larger than ${MAX_FILE} bytes; use --out <file> to copy it`)
    const bytes = await readFile(abs)
    const known = d.events.flatMap(e => [...(e.document ? [e.document] : []), ...(e.subject ?? []), ...(e.manifest ? [...(e.manifest.report ? [e.manifest.report] : []), ...e.manifest.artifacts] : [])]).filter(x => x.path === rel).at(-1)
    return { path: rel, bytes, sha256: sha256(bytes), expected: known?.sha256 ?? null }
  }

  // Copies a large file of the child to `out`, checked the same way.
  async copyChildFile(d: Delegation, path: string, out: string): Promise<{ path: string; sha256: string; bytes: number; expected: string | null }> {
    const c = await this.child(d)
    if (!c) throw new RequestError(409, `delegation ${d.id} has no child yet`)
    const rel = normalizeRepoPath(path)
    if (!rel || rel === '.') throw new RequestError(400, `"${path}" is not a path inside the child's project`)
    const abs = await inside(c.space.root, rel)
    const st = await lstat(abs).catch(() => null)
    if (!st || !st.isFile() || st.isSymbolicLink()) throw new RequestError(404, `${rel} is not a regular file of the child's working copy`)
    const bytes = await readFile(abs)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(out, bytes, { flag: 'wx' })
    const known = d.events.flatMap(e => [...(e.subject ?? []), ...(e.manifest ? [...(e.manifest.report ? [e.manifest.report] : []), ...e.manifest.artifacts] : [])]).filter(x => x.path === rel).at(-1)
    return { path: rel, sha256: sha256(bytes), bytes: bytes.length, expected: known?.sha256 ?? null }
  }
}

// ---- assessing a result (fix6, shared/assessment.ts) ------------------------------

// Where the facts of a result are frozen: the first entry at or after the
// completing one after which no attempt of the child is open (the relay
// tells a completion once the attempt that completed it ended).
export function resultPosition(child: RunRecord, completingSeq: number): number {
  let open = false
  for (const h of child.history) {
    if (h.op === 'attempt.begin') open = true
    if (h.op === 'attempt.end') open = false
    if (h.seq >= completingSeq && !open) return h.seq
  }
  return child.seq
}

// The child's record as of a history position, replayed from its own history.
export function recordAt(child: RunRecord, seq: number): RunRecord | null {
  const g = child.definition.effective
  if (!g) return null
  if (seq >= child.seq) return child
  try {
    const history = child.history.slice(0, seq)
    return { ...replay(history, { nodes: g.nodes, edges: g.edges }).state, history }
  } catch { return null }
}

export async function assessDelegation(store: DelegateStore, parent: RunRecord, d: Delegation, ev = latestResult(d)): Promise<Assessment | null> {
  if (!ev) return null
  const unavailable: string[] = []
  let c: { record: RunRecord; space: Workspace } | null = null
  try { c = await store.child(d) } catch (e) { unavailable.push(`the child: ${(e as Error).message}`) }
  if (!c && !unavailable.length) unavailable.push(d.child ? `the child ${d.child.workflow}/${d.child.run} cannot be read on this host` : 'no child is bound')
  let frozen: RunRecord | null = null
  let authored: ChildEvidence['authored']
  let catalog: ChildEvidence['catalog'] = { state: 'none' }
  let changed: ChildEvidence['changed'] = null
  if (c) {
    const reading = await readRun(c.space, { workflow: c.record.workflow, run: c.record.run })
    frozen = recordAt(c.record, resultPosition(c.record, ev.child.seq))
    if (!frozen) unavailable.push('the child\'s record as of the result does not replay')
    const active = frozen?.definition.active
    authored = (active ? reading.bundle.revisions?.find(r => r.revision === active)?.workflow : undefined) ?? reading.bundle.entries[c.record.definition.root]?.workflow
    catalog = catalogOf(c.record, reading.bundle)
    const paths = await changedPaths(c.space, c.record).catch(() => null)
    if (paths === null) unavailable.push('the child\'s working copy (its changed files) is not readable here')
    else {
      const by = pathsByNode(paths, frozen ?? c.record, (frozen ?? c.record).updated)
      changed = paths.map(p => ({ path: p.path, nodes: Object.entries(by).filter(([, ps]) => ps.includes(p.path)).map(([n]) => n) }))
    }
  }
  return assessResult(parent, d, ev, { frozen, graph: frozen ? graphOfState(frozen) ?? null : null, authored, now: c?.record ?? null, catalog, changed, unavailable })
}

// The reminders of every delegated result a run reports (fix6): each
// delegation's latest result, open or judged satisfied; a repaired omission
// (a corrected result) is assessed anew and its old warning is gone.
export async function delegatedReminders(store: DelegateStore, parent: RunRecord): Promise<ReturnType<typeof assessmentReminders>> {
  const out: Assessment[] = []
  for (const d of Object.values(parent.delegations ?? {})) {
    if (d.disposition && d.disposition.kind !== 'satisfied') continue
    if (d.closed && !d.disposition) continue
    const a = await assessDelegation(store, parent, d).catch(() => null)
    if (a) out.push(a)
  }
  return assessmentReminders(out)
}

// A run's delegations for the views (p10): each with its state and its
// child's situation now; for a child, the delegation it came from.
export async function delegationsView(store: DelegateStore, ws: Workspace, ref: RunRef) {
  const { delegationState } = await import('../shared/delegation.ts')
  const { holderOf, situation } = await import('../shared/run.ts')
  const { runStatus } = await import('../shared/status.ts')
  const { NotifyStore } = await import('./notify.ts')
  const rec = (await readRun(await runSpace(ws, ref), ref)).record
  if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
  const n = new NotifyStore({ area: store.ctx.area, registryFile: store.ctx.registryFile, exec: store.ctx.exec })
  try {
    const delegations = []
    for (const d of Object.values(rec.delegations ?? {})) {
      const c = await store.child(d).catch(() => null)
      const links = c ? await n.runStatusOf(d.child!.project, c.space.shared, { workflow: d.child!.workflow, run: d.child!.run }).then(st => ({ conversation: st.request?.url ?? null, progress: st.topic?.url ?? null, io: st.io?.url ?? null }), () => null) : null
      // fix6: the latest result's assessment, beside the delegation.
      const assessment = latestResult(d) ? await assessDelegation(store, rec, d).catch(() => null) : null
      delegations.push({
        ...d, state: delegationState(d), pending: pendingEvents(d).map(e => e.n), assessment,
        childNow: c ? { situation: situation(c.record), execution: c.record.execution.state, seq: c.record.seq, waiting: c.record.execution.waiting.map(w => ({ node: w.node, holder: holderOf(c.record, w.node) })), decisions: c.record.decisions.length, links, hold: c.record.control.hold?.kind ?? null, status: runStatus(c.record) } : null,
      })
    }
    // The parent's own reading with its children as they are now (p8 ex1).
    const status = runStatus(rec, { children: Object.fromEntries(delegations.filter(d => d.childNow).map(d => [d.id, { situation: d.childNow!.situation, hold: d.childNow!.hold, execution: d.childNow!.execution, run: d.child?.run ?? null }])) })
    const ent = rec.input.entrustedBy
    // A child names its parent; the parent's workspace here, for a link.
    const parentWs = ent?.kind === 'delegation' ? (await loadRegistry(store.ctx.registryFile)).workspaces.find(w => w.project === ent.parent.project)?.id ?? null : null
    return { ref: runKey(ref), delegations, status, parent: ent?.kind === 'delegation' ? { ...ent, workspace: parentWs } : null }
  } finally { n.close() }
}
