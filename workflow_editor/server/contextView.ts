// Read views of scoped context (workflow_editor p13, docs/context.md) for the
// browser and the CLI: the scope matrix of a project or workflow with the
// bundles the same resolver produces, and a run's used-versus-next view.
// Nothing here writes; edits go through ContextStore (set, check, refreshFailed, remove).
import { contextChanges, renderContext, type AttemptContext, type BlockState, type ContextBundle, type ContextChange } from '../shared/context.ts'
import { configChanges, currentSession, runKey, type AttemptSettings, type RunRecord, type RunRef } from '../shared/run.ts'
import { sessionPolicyOf, type Workflow } from '../shared/model.ts'
import type { AccessContext } from './access.ts'
import { resolveContext } from './context.ts'
import { ContextStore } from './contextStore.ts'
import { activeWorkflow, type ExecStore } from './exec.ts'
import { readRun } from './runs.ts'
import { runSpace } from './runspace.ts'
import { RequestError, type Workspace } from './workspace.ts'

export interface ContextMatrix {
  project: string
  workflow: string | null
  workflows: { id: string; name: string }[]
  // Every local block of the three scopes (removed ones too, for their history).
  blocks: { system: BlockState[]; project: BlockState[]; workflow: BlockState[] | null }
  // What an authoring session of this project/workflow is given, and what
  // a new run of the workflow would be prepared with now (the common
  // contract is the execution host's, decided at claim).
  authoring: ContextBundle
  execution: ContextBundle | null
  rendered: { authoring: string; execution: string | null }
}

export async function workflowById(ws: Workspace, id: string): Promise<Workflow | null> {
  const { list } = await ws.workflowSummaries()
  const hit = list.find(s => s.id === id)
  if (!hit) return null
  return (await ws.readWorkflowFile(hit.file)).workflow ?? null
}

export async function contextMatrix(ctx: AccessContext, ws: Workspace, workflowId?: string | null): Promise<ContextMatrix> {
  const store = new ContextStore(ctx.area)
  const workflow = workflowId ? await workflowById(ws, workflowId) : null
  if (workflowId && !workflow) throw new RequestError(404, `no readable workflow "${workflowId}" in workspace ${ws.reg.id}`)
  const authoring = await resolveContext(ctx, { purpose: 'authoring', ws, workflow })
  const execution = workflow ? await resolveContext(ctx, { purpose: 'execution', ws, workflow, contract: null }) : null
  const { list } = await ws.workflowSummaries()
  return {
    project: authoring.project, workflow: workflow?.id ?? null,
    workflows: list.filter(w => w.id).map(w => ({ id: w.id!, name: w.name ?? w.id! })),
    blocks: {
      system: await store.blocks({ scope: 'system' }),
      project: await store.blocks({ scope: 'project', project: authoring.project }),
      workflow: workflow ? await store.blocks({ scope: 'workflow', project: authoring.project, workflow: workflow.id }) : null,
    },
    authoring, execution,
    rendered: { authoring: renderContext(authoring), execution: execution ? renderContext(execution) : null },
  }
}

export interface AttemptContextView {
  attempt: string
  began: string
  reason: string
  recorded: AttemptContext | null // null: prepared before p13
  legacy?: { path: string; sha256: string }[] // what an attempt before p13 recorded (guides by hash)
  delivery: { event: 'delivered' | 'undelivered'; at: string; detail?: string } | null
  snapshot: (ContextBundle & { rendered: string }) | null
  unavailable?: string
  session?: AttemptSettings['session']
}
export interface RunContextView {
  run: string
  attempts: AttemptContextView[]
  next: ContextBundle
  nextRendered: string
  // Last attempt → next attempt, source by source (all sources), and what
  // the session comparison makes of it.
  changes: ContextChange[]
  session: { policy: 'fresh' | 'run'; current: string | null; next: string }
}

export async function runContextView(exec: ExecStore, ws: Workspace, ref: RunRef): Promise<RunContextView> {
  const store = new ContextStore(exec.ctx.area)
  const space = await runSpace(ws, ref)
  const reading = await readRun(space, ref)
  const rec: RunRecord | undefined = reading.record
  if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read: ${reading.problem?.message ?? 'no record'}`)
  const attempts: AttemptContextView[] = []
  for (const e of rec.history) {
    if (e.op !== 'attempt.begin') continue
    const b = e as unknown as { attempt: string; at: string; reason: string; settings?: AttemptSettings }
    const c = b.settings?.context ?? null
    const d = [...rec.history].reverse().find(h => h.op === 'attempt.context' && (h as unknown as { attempt: string }).attempt === b.attempt) as unknown as { event: 'delivered' | 'undelivered'; at: string; detail?: string } | undefined
    const v: AttemptContextView = { attempt: b.attempt, began: b.at, reason: b.reason, recorded: c, delivery: d ? { event: d.event, at: d.at, ...(d.detail ? { detail: d.detail } : {}) } : null, snapshot: null, ...(b.settings?.session ? { session: b.settings.session } : {}) }
    if (!c) { v.unavailable = 'this attempt was prepared before scoped context (workflow_editor p13): only its guides were recorded, by hash'; if (b.settings?.guides) v.legacy = b.settings.guides }
    else {
      const snap = await store.readSnapshot(c.snapshot)
      if ('unavailable' in snap) v.unavailable = snap.unavailable
      else v.snapshot = snap
    }
    attempts.push(v)
  }
  const last = [...attempts].reverse().find(a => a.recorded)
  const contract = [...rec.history].reverse().map(h => (h as unknown as { settings?: AttemptSettings }).settings?.contract).find(Boolean) ?? null
  const next = await resolveContext(exec.accessContext(), { purpose: 'execution', ws: space, workflow: activeWorkflow(rec, reading.bundle) ?? null, run: rec, contract, host: exec.executor })
  const was = last?.snapshot?.sources ?? last?.recorded?.sources ?? []
  const changes = contextChanges(was.map(s => ({ ...s, title: 'title' in s ? (s as { title: string }).title : undefined })), next.sources.map(s => ({ key: s.key, delivery: s.delivery, sha256: s.sha256, title: s.title })))
  const policy = sessionPolicyOf(reading.bundle.entries[rec.definition.root]?.workflow?.execution)
  const cur = currentSession(rec)
  let nextSession: string
  if (policy === 'fresh') nextSession = 'a new session (the workflow\'s policy is fresh): the next attempt gets the whole bootstrap with this context'
  else if (!cur) nextSession = 'a new session: the run has no current one'
  else {
    const now = { agent: cur.config.agent, profile: cur.config.profile, backend: cur.config.backend, contract: cur.config.contract, context: { snapshot: `ctx-${'0'.repeat(24)}`, fingerprint: next.fingerprint, sources: next.sources.map(s => ({ key: s.key, scope: s.scope, category: s.category, delivery: s.delivery, ...(s.sha256 ? { sha256: s.sha256 } : {}) })) } }
    const diff = configChanges(cur.config, now)
    nextSession = diff.length ? `a new session replaces ${cur.id ?? 'the current one'} (configuration changed: ${diff.join('; ')}); the next attempt gets the whole bootstrap with this context` : `resumes session ${cur.id ?? '(id not known)'}: the effective context is unchanged, so the next attempt gets a continuation`
  }
  return { run: runKey(ref), attempts, next, nextRendered: renderContext(next), changes, session: { policy, current: cur?.id ?? null, next: nextSession } }
}
