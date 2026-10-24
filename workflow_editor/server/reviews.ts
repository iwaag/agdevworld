// Human review rounds on this host (workflow_editor p17, docs/reviews.md):
// the file and host layer of the review.* operations.
//
// - prepare: resolves the subjects the agent names into frozen references
//   (owning run by creation, presentation and manifest revision, the
//   delegated result and repository trees it represents), checking each
//   bundle on disk against its manifest;
// - start: records the person's request, then starts every subject through
//   its owning run's Presenter (an instance already serving is reused,
//   never duplicated) and records what it found;
// - decide: records the person's decision, then (approved) cleanup;
// - cleanup: stops what the review started, through each owning run,
//   unless another active round uses it or the person asked to keep it;
// - reconcile: a round left starting, or a cleanup owed or failed, is
//   continued — after a restart, or by another process.
//
// Start and cleanup are host operations, not agent turns. Lifecycle effects
// on a presentation are recorded on its owning run (presentation.observe);
// the round records which instances it started or reused.
import { createHash } from 'node:crypto'
import { canonicalJson } from '../shared/canonical.ts'
import { latestResult } from '../shared/delegation.ts'
import { hostOwes, reviewStateText, startedInstances, subjectLabel, type CleanupResult, type ReviewRound, type ReviewSubject, type RoundView, type SubjectServing, type SubjectView } from '../shared/humanReview.ts'
export type { RoundView, SubjectView }
import { isOpen, runKey, type BecauseRef, type RunRecord, type RunRef } from '../shared/run.ts'
import { loadBoundary, assertWorkspaceAllowed } from './boundary.ts'
import { loadRegistry } from './registry.ts'
import { checkSubject, readRun, resolveRef, runOp, type OpContext } from './runs.ts'
import { runSpace } from './runspace.ts'
import { Presenter, type PresentContext } from './present.ts'
import { RequestError, Workspace } from './workspace.ts'

export const REVIEWER = 'wfe-review' // who records the host's facts
const creationOf = (r: RunRecord) => createHash('sha256').update(canonicalJson(r.history[0] ?? null)).digest('hex').slice(0, 16)
const uidOf = (r: RunRecord) => `${r.project}/${r.workflow}/${r.run}#${creationOf(r)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const RETRY_MS = 60_000 // a failed cleanup is retried by reconcile after this

export class ReviewHost {
  readonly ctx: PresentContext
  private _pr?: Presenter
  constructor(ctx: PresentContext) { this.ctx = ctx }
  get presenter(): Presenter { return this._pr ??= new Presenter({ ...this.ctx, by: REVIEWER }) }
  close() { this._pr?.close() }

  async workspace(id: string): Promise<Workspace> {
    const reg = (await loadRegistry(this.ctx.registryFile)).workspaces.find(w => w.id === id)
    if (!reg) throw new RequestError(404, `workspace "${id}" is not registered`, { code: 'review-subjects' })
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Review')
    return new Workspace(reg)
  }
  private async record(ws: Workspace, ref: RunRef): Promise<RunRecord> {
    const r = await readRun(await runSpace(ws, ref), ref)
    if (!r.record) throw new RequestError(409, `run ${runKey(ref)} cannot be read: ${r.problem?.message ?? 'unknown problem'}`)
    return r.record
  }
  // The review page for a round (the editor's route; links are resolved there).
  pageOf(ws: string, ref: RunRef, id: string): string | null {
    const base = this.presenter.config().answerBase
    return base ? `${base.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(ws)}/review/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}/${encodeURIComponent(id)}` : null
  }

  // ---- prepare -------------------------------------------------------------------------------

  // A subject as the agent names it: `p1` (this run's), `d1` or `d1:p2` (the
  // child of a delegation: its latest presentation, or the one named), or
  // `<workspace>:<workflow>/<run>:<p>`.
  async resolveSubject(ws: Workspace, rec: RunRecord, text: string): Promise<Omit<ReviewSubject, 'n'>> {
    let owner: { ws: Workspace; ref: RunRef } | null = null
    let presentation: string | undefined
    let delegation: string | undefined
    let m: RegExpExecArray | null
    if ((m = /^(p[0-9]+)$/.exec(text))) { owner = { ws, ref: { workflow: rec.workflow, run: rec.run } }; presentation = m[1] }
    else if ((m = /^(d[0-9]+)(?::(p[0-9]+))?$/.exec(text))) {
      const d = rec.delegations?.[m[1]]
      if (!d) throw new RequestError(404, `run ${runKey(rec)} has no delegation ${m[1]}`, { code: 'review-subjects' })
      if (!d.child) throw new RequestError(409, `delegation ${d.id} has no child yet; there is nothing of it to review`, { code: 'review-subjects' })
      owner = { ws: await this.workspace(d.child.workspace), ref: { workflow: d.child.workflow, run: d.child.run } }
      presentation = m[2]
      delegation = d.id
    } else if ((m = /^([a-z0-9][a-z0-9_.-]*):([a-z0-9][a-z0-9_.-]*\/run-[a-z0-9][a-z0-9_.-]*):(p[0-9]+)$/.exec(text))) {
      const ows = await this.workspace(m[1])
      owner = { ws: ows, ref: await resolveRef(ows, m[2]) }
      presentation = m[3]
    } else throw new RequestError(400, `subject "${text}" is p<n> (this run's), d<n>[:p<n>] (a delegation's child) or <workspace>:<workflow>/<run>:p<n>`, { code: 'review-subjects' })
    const orec = await this.record(owner.ws, owner.ref)
    if (delegation && uidOf(orec) !== rec.delegations![delegation].child!.uid) throw new RequestError(409, `the child ${runKey(owner.ref)} is another run now than delegation ${delegation} bound`, { code: 'review-subjects' })
    if (orec.cancelled) throw new RequestError(409, `run ${orec.project}/${runKey(orec)} is cancelled; its presentations are not served again (${orec.cancelled.reason})`, { code: 'review-subjects' })
    const all = Object.values(orec.presentations ?? {})
    const p = presentation ? orec.presentations?.[presentation] : all.at(-1)
    if (!p) throw new RequestError(404, presentation ? `run ${orec.project}/${runKey(orec)} has no presentation ${presentation}` : `run ${orec.project}/${runKey(orec)} registered no presentation; there is nothing to show the person (its agent presents it first: wfe present register)`, { code: 'review-subjects' })
    // The bundle is there and intact now: a missing or altered file is
    // refused, never substituted.
    const space = await runSpace(owner.ws, owner.ref)
    for (const f of p.files) {
      const now = await checkSubject(space, f.path).catch(e => { throw new RequestError(409, `presentation ${p.id} of ${orec.project}/${runKey(orec)} is incomplete: ${f.path}: ${(e as Error).message}`, { code: 'review-subjects' }) })
      if (now.sha256 !== f.sha256) throw new RequestError(409, `presentation ${p.id} of ${orec.project}/${runKey(orec)} changed on disk: ${f.path} no longer matches its manifest; register the result again`, { code: 'review-subjects' })
    }
    let repositories: ReviewSubject['repositories']
    if (orec.storage && space.copyOf) {
      const { acceptedRevision } = await import('./integrate.ts')
      repositories = await acceptedRevision(space, orec.storage).catch(() => undefined)
    }
    const d = delegation ? rec.delegations![delegation] : undefined
    const ev = d ? latestResult(d) : undefined
    return {
      workspace: owner.ws.reg.id, project: orec.project, workflow: orec.workflow, run: orec.run, creation: creationOf(orec),
      presentation: p.id, revision: p.revision, title: p.title,
      ...(delegation ? { delegation } : {}), ...(ev ? { result: { event: ev.n, manifest: ev.manifest?.digest ?? null, childSeq: ev.child.seq } } : {}),
      ...(repositories ? { repositories } : {}),
    }
  }

  async prepare(ws: Workspace, ref: RunRef, node: string, o: { summary: string; subjects: string[]; reviewer?: string; previous?: string }, ctx: OpContext & { attempt?: string; receipt?: string }): Promise<{ record: RunRecord; round: ReviewRound; duplicate?: boolean }> {
    const rec = await this.record(ws, ref)
    if (ctx.receipt && rec.history.some(h => h.receipt === ctx.receipt)) {
      const id = (rec.history.find(h => h.receipt === ctx.receipt) as unknown as { review: string }).review
      return { record: rec, round: rec.reviews![id], duplicate: true }
    }
    if (!o.subjects.length) throw new RequestError(400, 'name at least one subject (--subject p1 | d1[:p2] | <workspace>:<workflow>/<run>:p<n>)', { code: 'review-subjects' })
    const subjects = []
    for (const t of o.subjects) subjects.push(await this.resolveSubject(ws, rec, t))
    const id = `rv${Object.keys(rec.reviews ?? {}).length + 1}`
    const r = await runOp(await runSpace(ws, ref), ref, { op: 'review.prepare', review: id, uid: `${uidOf(rec)}/${id}`, node, summary: o.summary, subjects, ...(o.reviewer ? { reviewer: o.reviewer } : {}), ...(o.previous ? { previous: o.previous } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
    return { record: r.record, round: r.record.reviews![id], duplicate: r.duplicate }
  }

  // ---- start ---------------------------------------------------------------------------------

  // The person's Start review: the request is recorded first (durable); then
  // every subject is started. `wait: false` returns once the request is
  // recorded and leaves the host work running (the service answers the
  // click at once and the page follows the round's state).
  async start(ws: Workspace, ref: RunRef, id: string, ctx: OpContext & { receipt?: string }, o: { wait?: boolean } = {}): Promise<{ record: RunRecord; round: ReviewRound; work: Promise<ReviewRound | null> }> {
    const rec = await this.record(ws, ref)
    const cur = rec.reviews?.[id]
    if (!cur) throw new RequestError(404, `run ${runKey(ref)} has no review round ${id}`, { code: 'review-unknown' })
    let record = rec
    // A double click or a retry while it starts records nothing more.
    if (cur.state !== 'starting') record = (await runOp(await runSpace(ws, ref), ref, { op: 'review.start', review: id, ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)).record
    const work = this.serve(ws, ref, id).catch(e => { console.error(`review ${runKey(ref)} ${id}: start: ${(e as Error).message}`); return null })
    if (o.wait !== false) await work
    const after = o.wait !== false ? await this.record(ws, ref) : record
    return { record: after, round: after.reviews![id], work }
  }

  // The host part of a start: one presentation start per subject through its
  // owning run, then one review.serve with what was found.
  async serve(ws: Workspace, ref: RunRef, id: string): Promise<ReviewRound | null> {
    const pr = this.presenter
    const rec0 = await this.record(ws, ref)
    const round0 = rec0.reviews?.[id]
    if (!round0 || round0.state !== 'starting') return round0 ?? null
    if (!pr.claimWork(round0.uid, 'start')) return null // another process of this host is on it
    try {
      const start = round0.starts.at(-1)!.n
      const found: Omit<SubjectServing, 'at' | 'start'>[] = []
      for (const x of round0.subjects) {
        try {
          const ows = await this.workspace(x.workspace)
          const oref = { workflow: x.workflow, run: x.run }
          const orec = await this.record(ows, oref)
          if (creationOf(orec) !== x.creation) throw new Error(`${x.project}/${runKey(oref)} is another run now (created anew); the reviewed one is gone`)
          const p = orec.presentations?.[x.presentation]
          if (!p) throw new Error(`presentation ${x.presentation} is no longer in ${x.project}/${runKey(oref)}`)
          if (p.revision !== x.revision) throw new Error(`presentation ${x.presentation} has revision ${p.revision.slice(7, 19)} now, not the reviewed ${x.revision.slice(7, 19)}`)
          let res = await pr.start(ows, oref, x.presentation, { by: REVIEWER, review: round0.uid })
          for (let i = 0; res.state === 'starting' && i < 60; i++) { await sleep(500); res = await pr.start(ows, oref, x.presentation, { by: REVIEWER, review: round0.uid }) }
          if (res.state !== 'serving') throw new Error(`another start of ${x.presentation} did not finish`)
          const mode = pr.use({ instance: res.instance.id, review: round0.uid, workspace: x.workspace, workflow: x.workflow, run: x.run, presentation: x.presentation, subject: x.n }, res.reused)
          found.push({ subject: x.n, status: 'available', instance: res.instance.id, mode, detail: `${res.reused ? 'already served' : 'started'} for this review; identity, review screen and entry answered` })
        } catch (e) {
          found.push({ subject: x.n, status: 'failed', instance: null, mode: null, detail: (e as Error).message.replace(/\s+/g, ' ').slice(0, 400) })
        }
      }
      const r = await runOp(await runSpace(ws, ref), ref, { op: 'review.serve', review: id, start, subjects: found } as never, { by: REVIEWER, via: 'review' }).catch(e => {
        // A newer start (or a decision) came meanwhile: its own host work records it.
        if (/review-state|review-stale|latest start|not starting/.test((e as Error).message)) return null
        throw e
      })
      return r?.record.reviews![id] ?? null
    } finally { pr.doneWork(round0.uid) }
  }

  // ---- decide --------------------------------------------------------------------------------

  async decide(ws: Workspace, ref: RunRef, id: string, o: { outcome: 'approved' | 'changes'; feedback?: string; revisions?: string[]; synthetic?: boolean; because?: BecauseRef }, ctx: OpContext & { attempt?: string; receipt?: string; operator?: { run: string; attempt: string } }, w: { wait?: boolean } = {}): Promise<{ record: RunRecord; round: ReviewRound; work: Promise<ReviewRound | null> }> {
    const rec = await this.record(ws, ref)
    const cur = rec.reviews?.[id]
    if (!cur) throw new RequestError(404, `run ${runKey(ref)} has no review round ${id}`, { code: 'review-unknown' })
    // Approval is of intact material: every bundle still matches its manifest.
    if (o.outcome === 'approved' && !(ctx.receipt && rec.history.some(h => h.receipt === ctx.receipt))) {
      for (const x of cur.subjects) {
        const problem = await this.integrity(x).catch(e => (e as Error).message)
        if (problem) throw new RequestError(409, `${id} cannot be approved: ${subjectLabel(x)}: ${problem}`, { code: 'review-unavailable' })
      }
    }
    const r = await runOp(await runSpace(ws, ref), ref, { op: 'review.decide', review: id, outcome: o.outcome, ...(o.feedback ? { feedback: o.feedback } : {}), ...(o.revisions ? { revisions: o.revisions } : {}), ...(o.synthetic ? { synthetic: true } : {}), ...(o.because ? { because: o.because } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}), ...(ctx.operator ? { operator: ctx.operator } : {}) } as never, ctx)
    const round = r.record.reviews![id]
    const work = round.state === 'approved' ? this.cleanup(ws, ref, id).catch(e => { console.error(`review ${runKey(ref)} ${id}: cleanup: ${(e as Error).message}`); return null }) : Promise.resolve(round)
    if (w.wait !== false) await work
    const after = w.wait !== false ? await this.record(ws, ref) : r.record
    return { record: after, round: after.reviews![id], work }
  }

  private async integrity(x: ReviewSubject): Promise<string | null> {
    const ows = await this.workspace(x.workspace)
    const oref = { workflow: x.workflow, run: x.run }
    const orec = await this.record(ows, oref)
    const p = orec.presentations?.[x.presentation]
    if (!p || p.revision !== x.revision) return 'the reviewed presentation is not in its run as reviewed'
    const space = await runSpace(ows, oref)
    for (const f of p.files) {
      const now = await checkSubject(space, f.path).catch(() => null)
      if (!now || now.sha256 !== f.sha256) return `${f.path} is missing or changed since it was presented`
    }
    return null
  }

  // ---- cleanup -------------------------------------------------------------------------------

  // Stops what a round started, through each owning run, and records what
  // it did. An instance another active round uses, or one the person asked
  // to keep, is kept; one that was already serving its own unfinished run's
  // review is left to it. `as`: who records (WFE's host, or the responsible
  // agent for instances handed to it).
  async cleanup(ws: Workspace, ref: RunRef, id: string, o: { by?: string; via?: string; attempt?: string } = {}): Promise<ReviewRound | null> {
    const pr = this.presenter
    const rec = await this.record(ws, ref)
    const round = rec.reviews?.[id]
    if (!round || !round.cleanup || round.cleanup.state === 'done') return round ?? null
    if (!pr.claimWork(round.uid, 'cleanup')) return null
    try {
      const results: Omit<CleanupResult, 'at'>[] = []
      const done = new Set(round.cleanup.results.filter(c => c.status === 'stopped' || c.status === 'kept' || c.status === 'left').map(c => c.instance))
      for (const x of round.serving.filter(s => s.status === 'available' && s.instance && !done.has(s.instance))) {
        const sub = round.subjects.find(y => y.n === x.subject)!
        try {
          const ows = await this.workspace(sub.workspace)
          const oref = { workflow: sub.workflow, run: sub.run }
          const orec = await this.record(ows, oref)
          const p = orec.presentations?.[sub.presentation]
          const others = pr.usersOf(x.instance!, round.uid).filter(u => u.review !== round.uid)
          const stillOpen: string[] = []
          for (const u of others) if (await this.roundOpen(u.review)) stillOpen.push(u.review); else pr.release(u.review, x.instance!)
          if (stillOpen.length) { results.push({ subject: x.subject, instance: x.instance, status: 'kept', detail: `still used by review ${stillOpen.join(', ')}` }); continue }
          if (p?.retained) { results.push({ subject: x.subject, instance: x.instance, status: 'kept', detail: `kept on request: ${p.retained.note} (${p.retained.owner} stops it later)` }); continue }
          if (x.mode === 'reused' && orec.execution.state !== 'completed' && !orec.cancelled && p && isOpen(p)) {
            results.push({ subject: x.subject, instance: x.instance, status: 'left', detail: `it was serving before this review, for ${orec.project}/${runKey(orec)}, which is still under way; that run stops it` })
            continue
          }
          const row = pr.row(x.instance!)
          const res = row ? await pr.stopInstance(row) : { ok: true, detail: 'not known on this host: nothing serves it' }
          if (res.ok) {
            pr.release(round.uid, x.instance!)
            // The owning run's own record says it stopped (its lifecycle fact).
            const fresh = (await readRun(await runSpace(ows, oref), oref)).record?.presentations?.[sub.presentation]
            if (fresh && fresh.state !== 'stopped' && fresh.instance === x.instance) await runOp(await runSpace(ows, oref), oref, { op: 'presentation.observe', presentation: sub.presentation, status: 'stopped', instance: x.instance!, detail: `stopped by the cleanup of human review ${round.uid}: ${res.detail}` } as never, { by: REVIEWER, via: 'present' }).catch(() => {})
          }
          results.push({ subject: x.subject, instance: x.instance, status: res.ok ? 'stopped' : 'stop-failed', detail: res.detail })
        } catch (e) {
          results.push({ subject: x.subject, instance: x.instance, status: 'stop-failed', detail: (e as Error).message.replace(/\s+/g, ' ').slice(0, 400) })
        }
      }
      const r = await runOp(await runSpace(ws, ref), ref, { op: 'review.cleanup', review: id, results, ...(o.attempt ? { attempt: o.attempt } : {}) } as never, { by: o.by ?? REVIEWER, via: o.via ?? 'review' })
      const after = r.record.reviews![id]
      if (after.cleanup?.state === 'done') pr.release(round.uid)
      // What earlier rounds handed to the agent and nobody stopped goes with
      // the approval of the round that answers them.
      if (after.state === 'complete') {
        for (let prev = after.previous ? r.record.reviews![after.previous] : undefined; prev; prev = prev.previous ? r.record.reviews![prev.previous] : undefined) {
          if (prev.cleanup?.state === 'handed' && startedInstances(prev).length) await this.cleanup(ws, ref, prev.id, {})
        }
      }
      return after
    } finally { pr.doneWork(round.uid) }
  }

  private async roundOpen(uid: string): Promise<boolean> {
    const m = /^([a-z0-9][a-z0-9_.-]*)\/([a-z0-9][a-z0-9_.-]*)\/(run-[a-z0-9][a-z0-9_.-]*)#[0-9a-f]+\/(rv[0-9]+)$/.exec(uid)
    if (!m) return false
    const reg = (await loadRegistry(this.ctx.registryFile)).workspaces.filter(w => w.project === m[1])
    for (const w of reg) {
      const rec = (await readRun(await runSpace(new Workspace(w), { workflow: m[2], run: m[3] }), { workflow: m[2], run: m[3] }).catch(() => null))?.record
      const r = rec?.reviews?.[m[4]]
      if (r && r.uid === uid) return r.state !== 'complete' && r.state !== 'cancelled' && !(r.state === 'changes-requested' && r.cleanup?.state !== 'handed')
    }
    return false
  }

  // ---- reconcile -----------------------------------------------------------------------------

  // A round whose host work is owed: started again (instances serving are
  // reused), or its cleanup retried after RETRY_MS.
  async reconcileRun(ws: Workspace, rec: RunRecord): Promise<string[]> {
    const notes: string[] = []
    const ref = { workflow: rec.workflow, run: rec.run }
    for (const r of Object.values(rec.reviews ?? {})) {
      if (!hostOwes(r)) continue
      if (r.state === 'starting') {
        const after = await this.serve(ws, ref, r.id).catch(e => { notes.push(`${ws.reg.id} ${runKey(ref)} ${r.id}: start: ${(e as Error).message}`); return null })
        if (after) notes.push(`${ws.reg.id} ${runKey(ref)} ${r.id}: start finished (${after.state})`)
        continue
      }
      const last = r.cleanup!.results.at(-1)?.at
      if (r.cleanup!.state === 'failed' && last && Date.now() - Date.parse(last) < RETRY_MS) continue
      const after = await this.cleanup(ws, ref, r.id).catch(e => { notes.push(`${ws.reg.id} ${runKey(ref)} ${r.id}: cleanup: ${(e as Error).message}`); return null })
      if (after) notes.push(`${ws.reg.id} ${runKey(ref)} ${r.id}: cleanup ${after.cleanup?.state}`)
    }
    return notes
  }

  // ---- views ---------------------------------------------------------------------------------

  async view(ws: Workspace, rec: RunRecord): Promise<RoundView[]> {
    const pr = this.presenter
    const out: RoundView[] = []
    const ref = { workflow: rec.workflow, run: rec.run }
    for (const r of Object.values(rec.reviews ?? {})) {
      const subjectsNow: SubjectView[] = []
      for (const x of r.subjects) {
        const s = r.serving.find(y => y.subject === x.n)
        let url: string | null = null, local = true, live = false, newer: string[] = []
        const usedBy = s?.instance ? pr.usersOf(s.instance, r.uid).map(u => u.review) : []
        if (s?.instance) { const a = await pr.address(s.instance).catch(() => null); if (a) { url = a.live ? a.url : null; local = a.local; live = a.live } }
        try {
          const orec = await this.record(await this.workspace(x.workspace), { workflow: x.workflow, run: x.run })
          newer = Object.values(orec.presentations ?? {}).filter(p => Number(p.id.slice(1)) > Number(x.presentation.slice(1))).map(p => `${p.id} "${p.title}"`)
        } catch { /* shown as it was recorded */ }
        const stopped = r.cleanup?.results.some(c => c.instance === s?.instance && c.status === 'stopped')
        subjectsNow.push({ ...x, status: !s ? 'not-started' : stopped ? 'stopped' : s.status, url, local, live, instance: s?.instance ?? null, mode: s?.mode ?? null, detail: s?.detail ?? '', newer, usedBy })
      }
      out.push({ ...r, text: reviewStateText(r), subjectsNow, workspace: ws.reg.id, workflow: rec.workflow, runId: rec.run, page: this.pageOf(ws.reg.id, ref, r.id) })
    }
    return out
  }
}
