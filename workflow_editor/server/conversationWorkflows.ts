// Workflows in a discussion (argue p4 ex3, docs/discussions.md *Workflows
// in a discussion*): which workflow a turn referenced, created, edited or
// executed, at which exact version, as evidence beside the speech. WFE keeps
// these records in the conversation store; clients present them.
//
// - an association (`workflow_refs`) names the discussion and the actor's
//   turn (run, attempt, invitation, conductor activity), the relation, the
//   role (the subject of the discussion, or the conductor's own
//   progression), the target (a definition file, or one run of a workflow),
//   the version after (and, for an edit, before) by byte sha256 and semantic
//   digest, the nodes it singles out, the explicit source messages and the
//   operation that produced it. It is recorded once (token) and never
//   rewritten; a later message association is an event
//   (`workflow_ref_events`);
// - every version a record names is captured (`workflow_snapshots`, by
//   sha256): a saved definition is a draft in a working tree that the next
//   save replaces, so its bytes are the only proof of what was seen;
// - an operation whose effect is not in a durable record of its own (a
//   save, a new definition, a request) is journaled `pending` before it runs
//   and recorded after it succeeded; `repair` resolves an interrupted one
//   from the operation's evidence, or marks it `unconfirmed`. Run revisions
//   and delegated children are derived from the runs' own records under the
//   same tokens, so a hook and a repair never record one twice;
// - reading resolves a version from its snapshot (else the run's frozen
//   files), checks its sha256, parses it (never executes it), compares
//   versions by node id and edge endpoints, and replays a run's history for
//   the node states at the recorded point. The current target is a separate
//   read, labelled current, never a substitute.
//
// Nothing here posts speech, invites, starts or continues a run, reopens a
// discussion or moves its `updated`.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compile } from '../shared/compile.ts'
import { canonicalJson, semanticDigest } from '../shared/canonical.ts'
import { positions, METRICS } from '../shared/layout.ts'
import type { Workflow } from '../shared/model.ts'
import { replay, type RunRecord } from '../shared/run.ts'
import { parseRunName, runName, runUrl } from './conversations.ts'
import type { ConversationService } from './conversationService.ts'
import { git } from './git.ts'
import { readRun } from './runs.ts'
import { loadRegistry } from './registry.ts'
import { transaction } from './sqlite.ts'
import { RequestError, type Workspace } from './workspace.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'

export const WORKFLOW_RELATIONS = ['referenced', 'created', 'edited', 'executed'] as const
export type WorkflowRelation = typeof WORKFLOW_RELATIONS[number]
export const WORKFLOW_ROLES = ['subject', 'progression'] as const
export type WorkflowRole = typeof WORKFLOW_ROLES[number]
export type Evidence = 'operation' | 'claim' | 'backfill'
// How a run's discussion context is followed through what entrusted it.
const MAX_DEPTH = 4
const MAX_NOTE = 2000
const MAX_TEXT = 1_000_000
// A pending journal row older than this is resolved by repair.
const PENDING_GRACE_MS = 60_000

export type Target = { kind: 'definition'; file: string } | { kind: 'run'; run: string }
// One version of a workflow. `draft`: working-tree bytes not equal to the
// committed file; `committed`: equal to the file at `commit`; `revision`: a
// run's frozen revision (r1 the original), `seq` its history position.
// `at`: when this version came to be — a revision's adjustment (r1: the
// run's creation), or when WFE read a definition's bytes. A record's own
// `at` is when it was recorded, which for a derived record is later.
export interface Version {
  kind: 'draft' | 'committed' | 'revision'
  at?: string
  sha256: string
  definitionDigest: string | null
  path?: string
  commit?: string
  run?: string
  revision?: string
  seq?: number
}
export interface WorkflowRefRow {
  id: number; conv: string; relation: string; role: string; project: string; workflow: string; target: string; after: string | null; before: string | null
  nodes: string; note: string; evidence: string; operation: string; messages: string; activity: number | null; invitation: number | null
  run: string | null; attempt: string | null; actor: string; origin: string | null; state: string; at: string; token: string
}
export interface WorkflowRefEventRow { id: number; conv: string; ref: number; message: number; by: string; run: string | null; at: string; note: string }
export interface WorkflowRef {
  id: number; relation: WorkflowRelation; role: WorkflowRole; project: string; workflow: string; target: Target
  after: Version | null; before: Version | null; nodes: string[]; note: string; evidence: Evidence; operation: string
  messages: number[]; activity: number | null; invitation: number | null; run: string | null; attempt: string | null; actor: string
  origin: string | null; state: 'pending' | 'recorded' | 'unconfirmed'; at: string
}
// The turn an operation belongs to: the discussion, the actor run and
// attempt, the invitation that started its turn, and — for a run working
// for a discussion run (a delegated or requested child) — the run whose turn
// it is (`origin`).
export interface Turn { conv: string; run: string; attempt: string | null; actor: string; invitation: number | null; origin: string | null }

const graphOf = (w: Workflow) => { const c = compile(w); return c.ok ? c.graph : null }
const now = () => new Date().toISOString()
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const json = <T>(s: string | null): T | null => (s === null ? null : JSON.parse(s) as T)

// ---- comparison ---------------------------------------------------------------------

const NODE_PROPS = ['type', 'name', 'description', 'repositories', 'workflow', 'project', 'accepts', 'confirms', 'activity'] as const
const STYLE_PROPS = ['appearance'] as const
export interface NodeChange { id: string; name: string; props: { prop: string; before: unknown; after: unknown }[]; style: string[]; moved: boolean }
export interface Changes {
  behavioural: boolean // the semantic definition digests differ
  added: { id: string; name: string; type: string }[]
  removed: { id: string; name: string; type: string }[]
  changed: NodeChange[] // behavioural property changes, with before and after
  restyled: NodeChange[] // appearance or position only
  edgesAdded: [string, string][]
  edgesRemoved: [string, string][]
  fields: { field: string; before: unknown; after: unknown }[] // workflow-level fields
  generated: { added: string[]; removed: string[] } // the compiled graph's generated steps (`_…`)
}
const edgeKey = (e: { from: string; to: string }) => `${e.from}\u0000${e.to}`
export function compareWorkflows(a: Workflow, b: Workflow, digests: { before: string | null; after: string | null }): Changes {
  const nodeOf = (w: Workflow, id: string) => ({ id, name: w.nodes[id].name || id, type: w.nodes[id].type })
  const added = Object.keys(b.nodes).filter(id => !(id in a.nodes)).sort().map(id => nodeOf(b, id))
  const removed = Object.keys(a.nodes).filter(id => !(id in b.nodes)).sort().map(id => nodeOf(a, id))
  const changed: NodeChange[] = [], restyled: NodeChange[] = []
  const pa = positions(a), pb = positions(b)
  for (const id of Object.keys(b.nodes).filter(x => x in a.nodes).sort()) {
    const x = a.nodes[id] as unknown as Record<string, unknown>, y = b.nodes[id] as unknown as Record<string, unknown>
    const props = NODE_PROPS.filter(p => canonicalJson(x[p] ?? null) !== canonicalJson(y[p] ?? null)).map(p => ({ prop: p, before: x[p] ?? null, after: y[p] ?? null }))
    const style = STYLE_PROPS.filter(p => canonicalJson(x[p] ?? null) !== canonicalJson(y[p] ?? null))
    const p1 = pa.get(id), p2 = pb.get(id)
    const moved = !!(a.layout.nodes[id] || b.layout.nodes[id]) && (p1?.x !== p2?.x || p1?.y !== p2?.y)
    const c = { id, name: b.nodes[id].name || id, props, style: [...style], moved }
    if (props.length) changed.push(c)
    else if (style.length || moved) restyled.push(c)
  }
  const ea = new Set(a.edges.map(edgeKey)), eb = new Set(b.edges.map(edgeKey))
  const pair = (k: string) => k.split('\u0000') as [string, string]
  const fields: Changes['fields'] = []
  for (const f of ['intent', 'documentation', 'execution', 'intake', 'repositories', 'name'] as const) {
    if (canonicalJson(a[f] ?? null) !== canonicalJson(b[f] ?? null)) fields.push({ field: f, before: a[f] ?? null, after: b[f] ?? null })
  }
  const gen = (w: Workflow) => { const c = compile(w); return c.ok ? Object.keys(c.graph.nodes).filter(id => id.startsWith('_')) : [] }
  const ga = new Set(gen(a)), gb = new Set(gen(b))
  return {
    behavioural: digests.before !== null && digests.after !== null ? digests.before !== digests.after : true,
    added, removed, changed, restyled,
    edgesAdded: [...eb].filter(k => !ea.has(k)).sort().map(pair),
    edgesRemoved: [...ea].filter(k => !eb.has(k)).sort().map(pair),
    fields,
    generated: { added: [...gb].filter(x => !ga.has(x)).sort(), removed: [...ga].filter(x => !gb.has(x)).sort() },
  }
}

// A small picture of a graph for a card: boxes where the editor would put
// them and the edges between them. Display only.
export interface Preview { width: number; height: number; nodes: { id: string; x: number; y: number; type: string; mark?: string }[]; edges: [string, string][]; removed: string[] }
export function previewOf(w: Workflow, marks: Record<string, string> = {}, removed: string[] = []): Preview {
  const pos = positions(w)
  const m = METRICS.compact
  const nodes = Object.keys(w.nodes).map(id => ({ id, x: pos.get(id)!.x, y: pos.get(id)!.y, type: w.nodes[id].type, ...(marks[id] ? { mark: marks[id] } : {}) }))
  const width = Math.max(m.width, ...nodes.map(n => n.x + m.width)) + 40
  const height = Math.max(m.height, ...nodes.map(n => n.y + m.height)) + 40
  return { width, height, nodes, edges: w.edges.filter(e => e.from in w.nodes && e.to in w.nodes).map(e => [e.from, e.to] as [string, string]), removed }
}

// ---- the store ----------------------------------------------------------------------

export class ConversationWorkflows {
  readonly ds: ConversationService
  constructor(ds: ConversationService) { this.ds = ds }
  private get db() { return this.ds.db }
  private tx<T>(f: () => T): T { return transaction(this.db, f, 'conversation store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }
  private async ws(id: string): Promise<Workspace> {
    if (!this.ds.exec) throw new RequestError(503, 'the execution store is not open here')
    return this.ds.exec.workspace(id)
  }

  rows(conv: string, since = 0): WorkflowRefRow[] { return this.all<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE conv = ? AND id > ? AND state != \'pending\' ORDER BY id', conv, since) }
  events(conv: string, since = 0): WorkflowRefEventRow[] { return this.all<WorkflowRefEventRow>('SELECT * FROM workflow_ref_events WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  horizon(conv: string): { workflow: number; workflowEvent: number } {
    const max = (sql: string) => this.one<{ n: number | null }>(sql, conv)!.n ?? 0
    return { workflow: max('SELECT max(id) AS n FROM workflow_refs WHERE conv = ? AND state != \'pending\''), workflowEvent: max('SELECT max(id) AS n FROM workflow_ref_events WHERE conv = ?') }
  }
  snapshot(sha: string): { sha256: string; text: string; captured: string; origin: string } | undefined { return this.one('SELECT * FROM workflow_snapshots WHERE sha256 = ?', sha) }
  view(r: WorkflowRefRow): WorkflowRef {
    return {
      id: r.id, relation: r.relation as WorkflowRelation, role: r.role as WorkflowRole, project: r.project, workflow: r.workflow, target: JSON.parse(r.target) as Target,
      after: json<Version>(r.after), before: json<Version>(r.before), nodes: JSON.parse(r.nodes) as string[], note: r.note, evidence: r.evidence as Evidence, operation: r.operation,
      messages: [...new Set([...(JSON.parse(r.messages) as number[]), ...this.all<{ message: number }>('SELECT message FROM workflow_ref_events WHERE ref = ? ORDER BY id', r.id).map(e => e.message)])],
      activity: r.activity, invitation: r.invitation, run: r.run, attempt: r.attempt, actor: r.actor, origin: r.origin, state: r.state as WorkflowRef['state'], at: r.at,
    }
  }
  ref(conv: string, id: number): WorkflowRefRow {
    const r = this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE id = ? AND conv = ?', id, conv)
    if (!r || r.state === 'pending') throw new RequestError(404, `discussion ${conv} has no workflow record ${id}`)
    return r
  }

  // When recording began (store v10): what is derived for an operation
  // before it is history, recorded as backfill.
  private since(): string { return this.one<{ value: string }>('SELECT value FROM workflow_meta WHERE key = \'since\'')?.value ?? '' }
  private evidenceAt(at: string | undefined, given: Evidence | undefined): Evidence { return given ?? (at && at < this.since() ? 'backfill' : 'operation') }

  private capture(text: string, origin: string): string {
    const sha = sha256(text)
    this.db.prepare('INSERT OR IGNORE INTO workflow_snapshots (sha256, text, captured, origin) VALUES (?, ?, ?, ?)').run(sha, text, now(), origin)
    return sha
  }

  // ---- the turn of an operation -----------------------------------------------------

  // The discussion turn an executing attempt works in: its run's own
  // invitation (input.source), the discussion it conducts, or — for a run
  // entrusted by another run (a delegation or a request) — that run's turn,
  // followed up to MAX_DEPTH. Null outside any discussion.
  async turnOf(attempt: string | undefined): Promise<Turn | null> {
    if (!attempt || !this.ds.exec) return null
    const row = this.ds.exec.attemptRow(attempt)
    if (!row || row.state === 'ended') return null
    const run = runName(row.workspace, { workflow: row.workflow, run: row.run })
    const rec = await this.record(run)
    if (!rec) return null
    const found = await this.contextOfRun(run, rec, 0)
    return found ? { conv: found.conv, run, attempt, actor: rec.executor.name, invitation: found.invitation, origin: found.origin } : null
  }
  private async record(run: string): Promise<RunRecord | null> {
    try {
      const { workspace, ref } = parseRunName(run)
      return (await readRun(await this.ws(workspace), ref)).record ?? null
    } catch { return null }
  }
  async contextOfRun(run: string, rec: RunRecord, depth: number): Promise<{ conv: string; invitation: number | null; origin: string | null } | null> {
    const src = rec.input.source?.kind === 'conversation' ? rec.input.source : null
    if (src && this.ds.conversation(src.conversation)) return { conv: src.conversation, invitation: src.invitation ?? null, origin: depth ? run : null }
    const conducted = this.ds.conductedBy(run)[0]
    if (conducted) return { conv: conducted, invitation: null, origin: depth ? run : null }
    if (depth >= MAX_DEPTH) return null
    const by = rec.input.entrustedBy
    const parent = by?.kind === 'run' ? runName(by.project ?? parseRunName(run).workspace, { workflow: by.workflow, run: by.run })
      : by?.kind === 'delegation' ? await this.workspaceRun(by.parent.project, by.parent.workflow, by.parent.run) : null
    if (!parent) return null
    const prec = await this.record(parent)
    if (!prec) return null
    const up = await this.contextOfRun(parent, prec, depth + 1)
    return up ? { conv: up.conv, invitation: up.invitation, origin: up.origin ?? parent } : null
  }
  // A delegation names its parent by project; the run name is by workspace.
  private async workspaceRun(project: string, workflow: string, run: string): Promise<string> {
    const reg = this.ds.exec ? (await loadRegistry(this.ds.exec.ctx.registryFile)).workspaces.find(w => (w.project ?? w.id) === project) : undefined
    return runName(reg?.id ?? project, { workflow, run })
  }
  // Progression: a run of the facilitator's own workflow (its conductor
  // graph), or the facilitator's project's work requested by the
  // facilitator's run; everything else is the discussion's subject.
  roleOf(project: string, workflow: string, target: Target, actor: string | null): WorkflowRole {
    const cfg = this.ds.config()
    if ('disabled' in cfg) return 'subject'
    if (project !== cfg.facilitator.workspace) return 'subject'
    if (target.kind === 'run' && workflow === cfg.facilitator.workflow) return 'progression'
    return actor && parseRunName(actor).workspace === cfg.facilitator.workspace ? 'progression' : 'subject'
  }
  private activityOf(conv: string, run: string, revision: string | undefined): number | null {
    if (!revision) return null
    for (const a of this.all<{ id: number; decision: string | null }>('SELECT id, decision FROM activities WHERE conv = ? AND run = ? AND kind = \'ponder\' ORDER BY id', conv, run)) {
      const d = json<{ revision?: string | null }>(a.decision)
      if (d?.revision === revision) return a.id
    }
    return null
  }

  // ---- versions -----------------------------------------------------------------------

  // A definition file as it is now in a workspace: its bytes captured, and
  // `committed` when they equal the file at the owning repository's HEAD.
  async definitionVersion(ws: Workspace, file: string, text?: string): Promise<{ version: Version; text: string; workflow: Workflow | null } | null> {
    const t = text ?? (await ws.readWorkflowFile(file)).text
    if (t === null) return null
    const parsed = parseWorkflow(t)
    const workflow = parsed.ok ? parsed.model : null
    const path = `devdocs/workflows/${file}`
    let commit: string | undefined
    try {
      const info = await ws.devdocs()
      const rel = `${info.prefix}workflows/${file}`
      const head = await git(info.ownerDir, ['rev-parse', 'HEAD'])
      const blob = await git(info.ownerDir, ['rev-parse', `HEAD:${rel}`])
      if (head.code === 0 && blob.code === 0) {
        const mine = createHash('sha1').update(`blob ${Buffer.byteLength(t, 'utf8')}\0`).update(t, 'utf8').digest('hex')
        if (mine === blob.stdout.trim()) commit = head.stdout.trim()
      }
    } catch { /* not a repository: a draft */ }
    const version: Version = { kind: commit ? 'committed' : 'draft', at: now(), sha256: this.capture(t, `${ws.reg.id}:${path}`), definitionDigest: workflow ? await semanticDigest('definition', workflow) : null, path, ...(commit ? { commit } : {}) }
    return { version, text: t, workflow }
  }
  // A run's revision (default: the one in force), its bytes captured.
  async revisionVersion(run: string, revision?: string): Promise<{ version: Version; record: RunRecord } | null> {
    const { workspace, ref } = parseRunName(run)
    const read = await readRun(await this.ws(workspace), ref)
    const rec = read.record
    if (!rec) return null
    const want = revision ?? rec.definition.active ?? 'r1'
    const seqOf = (rev: string) => rev === 'r1' ? 1 : rec.history.find(e => e.op === 'run.adjust' && e.change?.revision?.[1] === rev)?.seq
    let text: string | undefined, sha: string | undefined, digest: string | undefined, path: string | undefined, at: string | undefined
    if (want === 'r1') {
      const e = rec.definition.workflows[rec.definition.root]
      text = read.bundle?.entries[rec.definition.root]?.text; sha = e?.sha256; digest = e?.definitionDigest; path = e?.file; at = rec.history[0]?.at
    } else {
      const r = rec.definition.revisions?.find(x => x.revision === want)
      text = read.bundle?.revisions?.find(x => x.revision === want)?.text; sha = r?.sha256; digest = r?.definitionDigest; path = r?.file; at = r?.at
    }
    if (!sha) return null
    if (text !== undefined && sha256(text) === sha) this.capture(text, `${run}:${path}`)
    return { version: { kind: 'revision', ...(at ? { at } : {}), sha256: sha, definitionDigest: digest ?? null, run, revision: want, seq: seqOf(want) ?? rec.seq, ...(path ? { path } : {}) }, record: rec }
  }

  // ---- recording ----------------------------------------------------------------------

  private insert(conv: string, o: { relation: WorkflowRelation; role: WorkflowRole; project: string; workflow: string; target: Target; after: Version | null; before?: Version | null; nodes?: string[]; note?: string; evidence: Evidence; operation: string; messages?: number[]; activity?: number | null; invitation?: number | null; run?: string | null; attempt?: string | null; actor: string; origin?: string | null; state: 'pending' | 'recorded' | 'unconfirmed'; token: string }): { row: WorkflowRefRow; duplicate: boolean } {
    if ((o.note ?? '').length > MAX_NOTE) throw new RequestError(413, `a note is at most ${MAX_NOTE} characters`)
    return this.tx(() => {
      const seen = this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE conv = ? AND token = ?', conv, o.token)
      if (seen) return { row: seen, duplicate: true }
      const id = Number(this.db.prepare(`INSERT INTO workflow_refs (conv, relation, role, project, workflow, target, after, before, nodes, note, evidence, operation, messages, activity, invitation, run, attempt, actor, origin, state, at, token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conv, o.relation, o.role, o.project, o.workflow, JSON.stringify(o.target), o.after ? JSON.stringify(o.after) : null, o.before ? JSON.stringify(o.before) : null,
        JSON.stringify([...new Set(o.nodes ?? [])]), o.note?.trim() ?? '', o.evidence, o.operation, JSON.stringify([...new Set(o.messages ?? [])].sort((a, b) => a - b)), o.activity ?? null, o.invitation ?? null, o.run ?? null, o.attempt ?? null, o.actor, o.origin ?? null, o.state, now(), o.token).lastInsertRowid)
      return { row: this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE id = ?', id)!, duplicate: false }
    })
  }
  private validMessages(conv: string, ms: number[]): number[] {
    for (const n of ms) { const m = this.ds.cs.message(n); if (!m || m.conv !== conv) throw new RequestError(400, `message #${n} is not in discussion ${conv}`) }
    return ms
  }

  // A definition save or creation from a discussion turn, journaled: begin
  // before the write (capturing what it replaces), finish after it.
  // `model`: the definition a save will write; its bytes are rendered over
  // the file on disk as the save renders them (Workspace.saveWorkflow).
  async beginDefinitionWrite(turn: Turn, ws: Workspace, file: string, o: { operation: 'workflow.save' | 'workflow.new'; model?: Workflow; note?: string }): Promise<number | null> {
    const before = o.operation === 'workflow.save' ? await this.definitionVersion(ws, file) : null
    const workflow = (before?.workflow?.id) ?? file.replace(/\.ya?ml$/, '')
    const doc = before ? parseWorkflow(before.text) : null
    const text = o.model && doc?.ok ? renderWorkflow(doc.doc, o.model) : undefined
    const intended = text !== undefined ? sha256(text) : 'new'
    if (before && before.version.sha256 === intended) return null // unchanged: nothing to record
    const target: Target = { kind: 'definition', file }
    const r = this.insert(turn.conv, {
      relation: o.operation === 'workflow.new' ? 'created' : 'edited', role: this.roleOf(ws.reg.id, workflow, target, turn.run), project: ws.reg.id, workflow, target,
      after: text !== undefined ? { kind: 'draft', sha256: intended, definitionDigest: null, path: `devdocs/workflows/${file}` } : null, before: before?.version ?? null,
      note: o.note, evidence: 'operation', operation: o.operation, invitation: turn.invitation, run: turn.run, attempt: turn.attempt, actor: turn.actor, origin: turn.origin, state: 'pending',
      token: `op:${turn.attempt}:${o.operation}:${ws.reg.id}/${file}:${intended}`,
    })
    return r.duplicate && r.row.state !== 'pending' ? null : r.row.id
  }
  async finishDefinitionWrite(id: number | null, ws: Workspace, file: string): Promise<WorkflowRef | null> {
    if (id === null) return null
    const row = this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE id = ?', id)
    if (!row) return null
    const cur = await this.definitionVersion(ws, file)
    if (!cur) { this.abort(id); return null }
    const before = json<Version>(row.before)
    const nodes = before && cur.workflow ? this.changedNodes(before.sha256, cur.workflow) : []
    this.db.prepare('UPDATE workflow_refs SET after = ?, nodes = ?, workflow = ?, state = \'recorded\', at = ? WHERE id = ? AND state = \'pending\'').run(JSON.stringify(cur.version), JSON.stringify(nodes), cur.workflow?.id ?? row.workflow, now(), id)
    return this.view(this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE id = ?', id)!)
  }
  abort(id: number | null) { if (id !== null) this.db.prepare('DELETE FROM workflow_refs WHERE id = ? AND state = \'pending\'').run(id) }
  private changedNodes(beforeSha: string, after: Workflow): string[] {
    const t = this.snapshot(beforeSha)?.text
    const p = t ? parseWorkflow(t) : null
    if (!p?.ok) return []
    const c = compareWorkflows(p.model, after, { before: null, after: null })
    return [...c.added.map(n => n.id), ...c.changed.map(n => n.id)]
  }

  // A run requested from a discussion turn (`wfe request`): executed, at the
  // child's original revision. Journaled by receipt.
  beginRequest(turn: Turn, o: { workspace: string; workflow: string; receipt: string }): number {
    const r = this.insert(turn.conv, {
      relation: 'executed', role: this.roleOf(o.workspace, o.workflow, { kind: 'run', run: '' }, turn.run), project: o.workspace, workflow: o.workflow, target: { kind: 'run', run: '' }, after: null,
      evidence: 'operation', operation: `run.request:${o.receipt}`, invitation: turn.invitation, run: turn.run, attempt: turn.attempt, actor: turn.actor, origin: turn.origin, state: 'pending', token: `request:${o.receipt}`,
    })
    return r.row.id
  }
  async finishRequest(id: number, child: string): Promise<WorkflowRef | null> {
    const row = this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE id = ?', id)
    if (!row || row.state !== 'pending') return row ? this.view(row) : null
    const v = await this.revisionVersion(child, 'r1').catch(() => null)
    const target: Target = { kind: 'run', run: child }
    this.db.prepare('UPDATE workflow_refs SET target = ?, after = ?, role = ?, state = \'recorded\', at = ? WHERE id = ?').run(JSON.stringify(target), v ? JSON.stringify(v.version) : null, this.roleOf(row.project, row.workflow, target, row.run), now(), id)
    return this.view(this.one<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE id = ?', id)!)
  }

  // Every revision of a run of this discussion that is not recorded yet,
  // from the run's own history (the adjust's attempt and seq); and every
  // child its delegations created. The tokens are the run's own ids, so the
  // hook after an adjust and a later pass record each once. `evidence`
  // `backfill` names records made for history (with the note).
  async deriveRun(conv: string, run: string, o: { evidence?: Evidence; note?: string; turn?: Partial<Turn>; depth?: number } = {}): Promise<WorkflowRef[]> {
    const rec = await this.record(run)
    if (!rec) return []
    const made: WorkflowRef[] = []
    const { workspace } = parseRunName(run)
    const target: Target = { kind: 'run', run }
    const ctx = o.turn ?? (await this.contextOfRun(run, rec, 0)) ?? {}
    for (const rev of rec.definition.revisions ?? []) {
      const token = `adjust:${run}:${rev.revision}`
      if (this.one('SELECT 1 FROM workflow_refs WHERE conv = ? AND token = ?', conv, token)) continue
      const entry = rec.history.find(e => e.op === 'run.adjust' && e.change?.revision?.[1] === rev.revision)
      const after = await this.revisionVersion(run, rev.revision)
      const before = await this.revisionVersion(run, rev.parent)
      const evidence = this.evidenceAt(entry?.at ?? rev.at, o.evidence)
      const r = this.insert(conv, {
        relation: 'edited', role: this.roleOf(workspace, rec.definition.root, target, run), project: workspace, workflow: rec.definition.root, target,
        after: after?.version ?? null, before: before?.version ?? null, nodes: [...rev.diff.added, ...rev.diff.changed], note: evidence === 'backfill' ? `backfill (argue p4 ex3) from ${run}'s history${entry ? ` seq ${entry.seq}` : ''}: ${rev.reason}`.slice(0, MAX_NOTE) : o.note ?? rev.reason.slice(0, MAX_NOTE),
        evidence, operation: `run.adjust:${rev.revision}${entry ? `@${entry.seq}` : ''}`, activity: this.activityOf(conv, run, rev.revision),
        invitation: 'invitation' in ctx ? ctx.invitation ?? null : null, run, attempt: entry?.attempt ?? null, actor: rec.executor.name, origin: 'origin' in ctx ? ctx.origin ?? null : null, state: 'recorded', token,
      })
      if (!r.duplicate) made.push(this.view(r.row))
    }
    for (const d of Object.values(rec.delegations ?? {})) {
      if (!d.child) continue
      const child = runName(d.child.workspace, { workflow: d.child.workflow, run: d.child.run })
      const token = `delegation:${d.uid}`
      if (!this.one('SELECT 1 FROM workflow_refs WHERE conv = ? AND token = ?', conv, token)) {
        const v = await this.revisionVersion(child, 'r1').catch(() => null)
        const ct: Target = { kind: 'run', run: child }
        const evidence = this.evidenceAt(d.dispatched.at, o.evidence)
        const r = this.insert(conv, {
          relation: 'executed', role: this.roleOf(d.child.workspace, d.child.workflow, ct, run), project: d.child.workspace, workflow: d.child.workflow, target: ct, after: v?.version ?? null,
          nodes: [d.node], note: evidence === 'backfill' ? `backfill (argue p4 ex3) from ${run}'s delegation ${d.id}: delegated from node ${d.node}` : o.note ?? `delegated from node ${d.node} (${d.id})`, evidence, operation: `delegate.request:${d.id}@${d.dispatched.seq}`,
          invitation: 'invitation' in ctx ? ctx.invitation ?? null : null, run, attempt: d.dispatched.attempt, actor: rec.executor.name, origin: 'origin' in ctx ? ctx.origin ?? null : null, state: 'recorded', token,
        })
        if (!r.duplicate) made.push(this.view(r.row))
      }
      // The delegated project's own revisions belong to the same turn.
      if ((o.depth ?? 0) < MAX_DEPTH - 1) made.push(...await this.deriveRun(conv, child, { ...o, depth: (o.depth ?? 0) + 1, turn: { invitation: 'invitation' in ctx ? ctx.invitation ?? null : null, origin: run } }))
    }
    return made
  }

  // An explicit reference: the agent (or the person) declares that this
  // workflow at this version is material of the discussion. WFE reads and
  // captures the version it names, which proves what was retrieved at that
  // turn; it does not prove that it was understood.
  async attach(conv: string, o: { project: string; workflow?: string; file?: string; run?: string; revision?: string; commit?: string; relation?: WorkflowRelation; role?: WorkflowRole; nodes?: string[]; note?: string; messages?: number[]; from?: string; turn: Turn | null; author: string }): Promise<{ ref: WorkflowRef; duplicate: boolean }> {
    this.ds.conversation(conv) ?? (() => { throw new RequestError(404, `no discussion ${conv}`) })()
    const messages = this.validMessages(conv, o.messages ?? [])
    const relation = o.relation ?? 'referenced'
    if (!(WORKFLOW_RELATIONS as readonly string[]).includes(relation)) throw new RequestError(400, `a relation is one of ${WORKFLOW_RELATIONS.join(', ')}`)
    if (o.role && !(WORKFLOW_ROLES as readonly string[]).includes(o.role)) throw new RequestError(400, `a role is ${WORKFLOW_ROLES.join(' or ')}`)
    let target: Target, version: Version, workflow: string, wf: Workflow | null = null
    if (o.run) {
      const run = o.run.includes('/') && o.run.split('/').length === 3 ? o.run : `${o.project}/${o.run}`
      const v = await this.revisionVersion(run, o.revision)
      if (!v) throw new RequestError(404, `run ${run} has no revision ${o.revision ?? '(active)'} to attach`)
      target = { kind: 'run', run }; version = v.version; workflow = v.record.definition.root
    } else {
      const ws = await this.ws(o.project)
      const file = o.file ?? await this.fileOf(ws, o.workflow!)
      if (o.commit) {
        const info = await ws.devdocs()
        const shown = await git(info.ownerDir, ['show', `${o.commit}:${info.prefix}workflows/${file}`])
        if (shown.code !== 0) throw new RequestError(404, `${o.project} has no devdocs/workflows/${file} at ${o.commit}: ${shown.stderr.trim()}`)
        const full = (await git(info.ownerDir, ['rev-parse', `${o.commit}^{commit}`])).stdout.trim()
        const p = parseWorkflow(shown.stdout); wf = p.ok ? p.model : null
        version = { kind: 'committed', at: now(), sha256: this.capture(shown.stdout, `${o.project}:${full}:devdocs/workflows/${file}`), definitionDigest: wf ? await semanticDigest('definition', wf) : null, path: `devdocs/workflows/${file}`, commit: full }
      } else {
        const v = await this.definitionVersion(ws, file)
        if (!v) throw new RequestError(404, `${o.project} has no devdocs/workflows/${file}`)
        version = v.version; wf = v.workflow
      }
      target = { kind: 'definition', file }; workflow = wf?.id ?? file.replace(/\.ya?ml$/, '')
    }
    if (o.nodes?.length && wf) for (const n of o.nodes) if (!(n in wf.nodes)) throw new RequestError(400, `node ${n} is not in ${workflow} at that version`)
    const note = [o.note?.trim(), o.from ? `copied from ${o.from}` : ''].filter(Boolean).join(' — ')
    const by = o.turn?.run ?? o.author
    const r = this.insert(conv, {
      relation, role: o.role ?? this.roleOf(o.project, workflow, target, o.turn?.run ?? null), project: o.project, workflow, target, after: version, nodes: o.nodes, note, evidence: 'claim', operation: 'attach', messages,
      invitation: o.turn?.invitation ?? null, run: o.turn?.run ?? null, attempt: o.turn?.attempt ?? null, actor: o.turn?.actor ?? o.author, origin: o.turn?.origin ?? null, state: 'recorded',
      token: `attach:${by}:${relation}:${canonicalJson(target)}:${version.sha256}:${messages.join(',')}`,
    })
    return { ref: this.view(r.row), duplicate: r.duplicate }
  }
  private async fileOf(ws: Workspace, name: string): Promise<string> {
    const { list } = await ws.workflowSummaries()
    const hit = list.find(s => s.file === name) ?? list.find(s => s.file === `${name}.yaml` || s.file === `${name}.yml`) ?? list.find(s => s.id === name)
    if (!hit) throw new RequestError(404, `no workflow "${name}" in ${ws.reg.id}`)
    return hit.file
  }

  // A later association of a record with the message it belongs to.
  link(conv: string, id: number, o: { message: number; by: string; run?: string | null; note?: string }): { ref: WorkflowRef; duplicate: boolean } {
    const row = this.ref(conv, id)
    this.validMessages(conv, [o.message])
    if (o.run && row.run && o.run !== row.run && o.run !== row.origin) throw new RequestError(403, `record ${id} is ${row.run}'s; a run links only its own records (the person may link any, with a note)`, { code: 'not-yours' })
    const dup = this.tx(() => {
      if (this.one('SELECT 1 FROM workflow_ref_events WHERE ref = ? AND message = ?', id, o.message) || (JSON.parse(row.messages) as number[]).includes(o.message)) return true
      this.db.prepare('INSERT INTO workflow_ref_events (conv, ref, message, by, run, at, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conv, id, o.message, o.by, o.run ?? null, now(), o.note?.trim() ?? '')
      return false
    })
    return { ref: this.view(row), duplicate: dup }
  }

  // Pending rows whose operation ended without its bookkeeping, resolved
  // from the operation's own evidence; and the runs of open discussions
  // derived (revisions, delegated children).
  async repair(o: { conv?: string; all?: boolean } = {}): Promise<string[]> {
    const notes: string[] = []
    const cutoff = new Date(Date.now() - PENDING_GRACE_MS).toISOString()
    for (const row of this.all<WorkflowRefRow>('SELECT * FROM workflow_refs WHERE state = \'pending\' AND at < ? ORDER BY id', cutoff)) {
      try {
        if (row.operation.startsWith('run.request:')) {
          const receipt = row.operation.slice('run.request:'.length)
          const job = this.ds.exec?.db.prepare('SELECT workspace, workflow, run FROM jobs WHERE receipt = ?').get(`request:${receipt}`) as { workspace: string; workflow: string; run: string } | undefined
          if (job) { await this.finishRequest(row.id, runName(job.workspace, { workflow: job.workflow, run: job.run })); this.recovered(row.id, `the request's job (receipt ${receipt})`); notes.push(`workflow record ${row.id}: recovered from the request's job`) }
          else { this.unconfirmed(row.id, 'no job carries the request\'s receipt'); notes.push(`workflow record ${row.id}: unconfirmed`) }
          continue
        }
        const target = JSON.parse(row.target) as Target
        const intended = json<Version>(row.after)
        if (target.kind === 'definition' && intended && intended.sha256 !== 'new') {
          const ws = await this.ws(row.project)
          const text = (await ws.readWorkflowFile(target.file)).text
          if (text !== null && sha256(text) === intended.sha256) { await this.finishDefinitionWrite(row.id, ws, target.file); this.recovered(row.id, 'the file holds the bytes the save wrote'); notes.push(`workflow record ${row.id}: recovered from the file`) }
          else { this.unconfirmed(row.id, 'the file does not hold the bytes the save would have written'); notes.push(`workflow record ${row.id}: unconfirmed`) }
          continue
        }
        this.unconfirmed(row.id, 'the operation left no evidence to verify it')
        notes.push(`workflow record ${row.id}: unconfirmed`)
      } catch (e) { notes.push(`workflow record ${row.id}: ${(e as Error).message}`) }
    }
    const convs = o.conv ? [o.conv] : this.ds.list().filter(c => o.all || c.state === 'open').map(c => c.id)
    // A hand-off link names the message and the run an outcome was handed
    // to: that run was executed from that message.
    if (o.all) for (const conv of convs) for (const l of this.ds.cs.links(conv).filter(l => l.relation === 'handoff')) {
      try {
        const v = await this.revisionVersion(l.run, 'r1').catch(() => null)
        const { workspace, ref } = parseRunName(l.run)
        const target: Target = { kind: 'run', run: l.run }
        const r = this.insert(conv, { relation: 'executed', role: this.roleOf(workspace, ref.workflow, target, null), project: workspace, workflow: ref.workflow, target, after: v?.version ?? null, note: `backfill (argue p4 ex3) from hand-off link ${l.id} by ${l.by}: ${l.note}`.slice(0, MAX_NOTE), evidence: 'backfill', operation: `link.handoff:${l.id}`, messages: [l.message], run: null, attempt: l.attempt, actor: l.by, state: 'recorded', token: `handoff:${l.id}` })
        if (!r.duplicate) notes.push(`${conv}: recorded workflow ${r.row.id} (executed ${l.run}, from hand-off link ${l.id})`)
      } catch (e) { notes.push(`${conv}: hand-off link ${l.id}: ${(e as Error).message}`) }
    }
    for (const conv of convs) for (const run of this.runsOf(conv)) {
      try { for (const r of await this.deriveRun(conv, run)) notes.push(`${conv}: recorded workflow ${r.id} (${r.relation} ${r.target.kind === 'run' ? r.target.run : r.workflow})`) } catch (e) { notes.push(`${conv}: ${run}: ${(e as Error).message}`) }
    }
    return notes
  }
  private recovered(id: number, how: string) { this.db.prepare('UPDATE workflow_refs SET note = trim(note || \' \' || ?) WHERE id = ?').run(`(recovered from ${how})`, id) }
  private unconfirmed(id: number, why: string) { this.db.prepare('UPDATE workflow_refs SET state = \'unconfirmed\', note = trim(note || \' \' || ?) WHERE id = ? AND state = \'pending\'').run(`(unconfirmed: ${why})`, id) }
  // The runs that speak for the discussion: its invitations' runs and its
  // conductors (each conductor activity's run).
  runsOf(conv: string): string[] {
    const runs = new Set<string>()
    for (const i of this.ds.invitations(conv)) if (i.run && !i.awaits) runs.add(i.run)
    for (const a of this.all<{ run: string }>('SELECT DISTINCT run FROM activities WHERE conv = ?', conv)) runs.add(a.run)
    const c = this.ds.conversation(conv)?.conductor
    if (c) runs.add(c)
    return [...runs]
  }

  // ---- reading ------------------------------------------------------------------------

  // A version's text: its snapshot, else the run's frozen file; the byte
  // digest is checked either way. Null with the reason when unavailable.
  async textOf(v: Version | null): Promise<{ text: string; workflow: Workflow } | { unavailable: string }> {
    if (!v) return { unavailable: 'no version was recorded' }
    let text = this.snapshot(v.sha256)?.text
    if (text === undefined && v.kind === 'revision' && v.run && v.path) {
      try {
        const { workspace, ref } = parseRunName(v.run)
        const dir = (await readRun(await this.ws(workspace), ref)).dir
        text = await readFile(join(dir, v.path), 'utf8')
      } catch { /* the run's records are not readable here */ }
    }
    if (text === undefined) return { unavailable: v.kind === 'draft' ? 'this draft was not captured' : 'this version is not readable here (no snapshot, and the source is gone)' }
    if (text.length > MAX_TEXT) return { unavailable: 'this version is too large to show' }
    if (sha256(text) !== v.sha256) return { unavailable: 'digest mismatch: the bytes found are not the recorded version' }
    const p = parseWorkflow(text)
    if (!p.ok) return { unavailable: `the recorded version does not parse: ${p.problem.message}` }
    return { text, workflow: p.model }
  }
  // Node states of a run at a history position, by replaying its history up
  // to there.
  async statesAt(run: string, seq: number | undefined): Promise<{ basis: string; seq: number; at: string; nodes: Record<string, string> } | { unavailable: string }> {
    const rec = await this.record(run)
    if (!rec) return { unavailable: 'the run\'s records are not readable here' }
    const eff = rec.definition.effective
    if (!eff) return { unavailable: 'the run was created before frozen graphs' }
    let upto = Math.min(seq ?? rec.seq, rec.history.length)
    // An adjustment made at a node's completion is one step with that
    // completion (shared/run.ts replay): the point includes it.
    while (upto < rec.history.length && typeof (rec.history[upto - 1] as { completing?: unknown }).completing === 'string' && rec.history[upto - 1].op === 'run.adjust') upto++
    try {
      const { state } = replay(rec.history.slice(0, upto), { nodes: eff.nodes, edges: eff.edges })
      return { basis: 'recorded', seq: upto, at: rec.history[upto - 1]?.at ?? '', nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, n]) => [id, n.state])) }
    } catch (e) { return { unavailable: `the history does not replay: ${(e as Error).message}` } }
  }

  // The list a client draws cards from: each record with what a card says.
  async list(conv: string, viewBase?: string | null) {
    const out = []
    for (const row of this.rows(conv)) {
      const r = this.view(row)
      const after = await this.textOf(r.after)
      const before = r.before ? await this.textOf(r.before) : null
      const changes = 'workflow' in after && before && 'workflow' in before ? compareWorkflows(before.workflow, after.workflow, { before: r.before!.definitionDigest, after: r.after!.definitionDigest }) : null
      const marks: Record<string, string> = {}
      if (changes) { for (const n of changes.added) marks[n.id] = 'added'; for (const n of changes.changed) marks[n.id] = 'changed' }
      for (const n of r.nodes) marks[n] ??= r.relation === 'edited' ? 'changed' : 'selected'
      out.push({
        ...r, name: 'workflow' in after ? after.workflow.name || r.workflow : r.workflow, available: 'workflow' in after, unavailable: 'unavailable' in after ? after.unavailable : null,
        beforeAvailable: before ? 'workflow' in before : null, changes, preview: 'workflow' in after ? previewOf(after.workflow, marks, changes?.removed.map(n => n.id) ?? []) : null,
        runUrl: r.run ? runUrl(viewBase, r.run) : null, editorUrl: this.editorUrl(viewBase, r),
      })
    }
    return out
  }
  editorUrl(viewBase: string | null | undefined, r: Pick<WorkflowRef, 'target' | 'project'>): string | null {
    if (!viewBase) return null
    if (r.target.kind === 'run') return r.target.run ? runUrl(viewBase, r.target.run) : null
    return `${viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(r.project)}/wf/${encodeURIComponent(r.target.file)}`
  }

  // One record's pinned graph: the version after (and before), parsed and
  // compiled, the comparison, and the node states at the recorded point for
  // a run (a definition has none).
  async graph(conv: string, id: number, viewBase?: string | null) {
    const r = this.view(this.ref(conv, id))
    const side = async (v: Version | null) => {
      const t = await this.textOf(v)
      if ('unavailable' in t) return { version: v, available: false, unavailable: t.unavailable }
      const c = compile(t.workflow)
      return { version: v, available: true, workflow: t.workflow, effective: c.ok ? c.graph : null }
    }
    const after = await side(r.after)
    const before = r.before ? await side(r.before) : null
    const changes = after.workflow && before?.workflow ? compareWorkflows(before.workflow, after.workflow, { before: r.before!.definitionDigest, after: r.after!.definitionDigest }) : null
    const state = r.target.kind === 'run' && r.target.run ? await this.statesAt(r.target.run, r.after?.seq) : { unavailable: 'a definition has no execution state: it is not a run' }
    return { ref: r, after, before, changes, state, time: r.at, runUrl: r.run ? runUrl(viewBase, r.run) : null, editorUrl: this.editorUrl(viewBase, r) }
  }

  // The target as it is now, labelled current: a definition's working-tree
  // file, or a run's revision in force with its current node states.
  async current(conv: string, id: number, viewBase?: string | null) {
    const r = this.view(this.ref(conv, id))
    try {
      if (r.target.kind === 'run') {
        if (!r.target.run) return { ref: r, current: { available: false, unavailable: 'the run was not recorded' } }
        const v = await this.revisionVersion(r.target.run)
        if (!v) return { ref: r, current: { available: false, unavailable: 'the run is not readable here' } }
        const t = await this.textOf(v.version)
        const states = await this.statesAt(r.target.run, undefined)
        return { ref: r, current: 'workflow' in t ? { available: true, version: v.version, workflow: t.workflow, effective: graphOf(t.workflow), state: states, same: v.version.sha256 === r.after?.sha256, at: now() } : { available: false, unavailable: t.unavailable }, editorUrl: this.editorUrl(viewBase, r) }
      }
      const ws = await this.ws(r.project)
      const v = await this.definitionVersion(ws, r.target.file)
      if (!v?.workflow) return { ref: r, current: { available: false, unavailable: v ? 'the current file does not parse' : `${r.project} has no devdocs/workflows/${r.target.file} now` } }
      return { ref: r, current: { available: true, version: v.version, workflow: v.workflow, effective: graphOf(v.workflow), state: { unavailable: 'a definition has no execution state: it is not a run' }, same: v.version.sha256 === r.after?.sha256, at: now() }, editorUrl: this.editorUrl(viewBase, r) }
    } catch (e) { return { ref: r, current: { available: false, unavailable: (e as Error).message } } }
  }
}
