// Thin client for the local service. Errors carry the service's message.
import type {
  AddSubmoduleResponse, AgdevResult, CreateProjectResult, DashboardResponse, ProjectResponse, RegisterResponse, RunOpResponse, RunResponse, RunSummary, SaveResponse,
  WorkflowResponse, WorkspacesResponse,
} from '../shared/api.ts'
import type { ApprovalState } from '../shared/canonical.ts'
import type { ApprovalKind, Documentation, Project, Workflow } from '../shared/model.ts'
import type { Catalog, NodeTemplate, TemplateContent } from '../shared/catalog.ts'

// One run's execution on this host (server/exec.ts runView).
export interface RunExecView {
  attempts: { id: string; state: string; began: string; ended: string | null; exit_code: number | null; signal: string | null; outcome: string | null; backend: string | null; pid: number | null; alive: boolean | null; stop_requested: string | null; log: string | null
    activity?: { unit: 'turn' | null; count: number | null; last: string | null; bytes: number; problem?: string } | null }[] // p8/ex2: observed on the host that has the log
  jobs: { id: number; kind: string; state: string; reason: string; created: string; note: string | null }[]
  checkpoints: { id: number; kind: string; state: string; created: string; updated: string; error: string | null; steps: { repo: string; include: string[]; excluded: string[]; conflicts: string[]; commit?: string; pushed?: boolean; branch?: string; error?: string }[] }[]
  executor: { state: string; detail?: string; at?: string }
}

// What each presentation's record says and what this host observes (p7,
// server/present.ts view).
export interface PresentationView {
  id: string; title: string; node: string; revision: string; state: string; instance: string | null
  url: string | null; local: boolean; live: boolean; files: number
  observed: { alive: boolean; identity: boolean; detail: string; instance: string; port: number; pid: number | null; state: string } | null
}

// The result of inspecting or applying an adjustment (p7, server/runs.ts adjustRun).
export interface AdjustView {
  ok: boolean; dryRun: boolean; parent: string; revision?: string
  authored: { added: string[]; removed: string[]; changed: { id: string; fields: string[] }[]; restyled: string[] }
  graph: { added: string[]; removed: string[]; changed: string[]; edgesAdded: [string, string][]; edgesRemoved: [string, string][] }
  problems: { code: string; message: string }[]
  notes?: string[] // p8/ex2: an added node nothing leads to, an unknown node field
}

// The person's node catalog (p7/ex1, server/catalog.ts readCatalog).
export type CatalogView = ({ state: 'ok'; file: string; catalog: Catalog; initializedNow?: boolean } | { state: 'unavailable'; file: string; problem: string }) & { examples: (TemplateContent & { id: string })[] }
type TemplateBody = TemplateContent & { by: string }

export class ApiError extends Error {
  status: number
  detail?: unknown
  constructor(status: number, message: string, detail?: unknown) { super(message); this.status = status; this.detail = detail }
}

async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [], signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (e) {
    throw new ApiError(0, `The editor service is not reachable (${(e as Error).message}).`)
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok && !okStatuses.includes(res.status)) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`, (data as { detail?: unknown }).detail)
  return data as T
}

// Paths are relative to the page, so the UI works at the service's root and
// under agdevworld's same-origin prefix (/wfe/) alike.
const ws = (id: string) => `api/workspaces/${encodeURIComponent(id)}`
const wf = (id: string, file: string) => `${ws(id)}/workflows/${encodeURIComponent(file)}`

export const api = {
  workspaces: () => call<WorkspacesResponse>('GET', 'api/workspaces'),
  dashboard: () => call<DashboardResponse>('GET', 'api/agdev'),
  createGiteaProject: (input: { id: string; name: string; intent: string; goals: string[]; devdocs: 'directory' | 'submodule'; resume?: boolean; reuse?: boolean }) =>
    call<CreateProjectResult>('POST', 'api/agdev/projects', input, [422]),
  registerGiteaProject: (owner: string, name: string) => call<AgdevResult>('POST', 'api/agdev/projects/register', { owner, name }),
  obtainWorkspace: (project: string) => call<AgdevResult>('POST', `api/agdev/projects/${encodeURIComponent(project)}/workspaces`),
  registerRepository: (owner: string, name: string, category: string) => call<AgdevResult>('POST', 'api/agdev/repositories', { owner, name, category }),
  createRepository: (name: string, category: string, description: string) => call<AgdevResult>('POST', 'api/agdev/repositories', { create: true, name, category, description }),
  addShared: (id: string, repository: string, path: string) => call<AddSubmoduleResponse & { url?: string }>('POST', `${ws(id)}/shared`, { repository, path }, [422]),
  createProject: (input: { id: string; name: string; intent: string; goals: string[]; dir?: string; devdocsSource?: string; resume?: boolean }) =>
    call<CreateProjectResult>('POST', 'api/projects', input, [422]),
  register: (path: string, id?: string) => call<RegisterResponse>('POST', 'api/workspaces', { path, id }, [422]),
  project: (id: string, refresh = false) => call<ProjectResponse>('GET', `${ws(id)}/project${refresh ? '?refresh=1' : ''}`),
  saveProject: (id: string, project: Project) => call<SaveResponse>('PUT', `${ws(id)}/project`, { project }),
  addSubmodule: (id: string, path: string, url: string) => call<AddSubmoduleResponse>('POST', `${ws(id)}/submodules`, { path, url }, [422]),
  addNewRepository: (id: string, path: string) => call<AddSubmoduleResponse>('POST', `${ws(id)}/submodules`, { path, create: true }, [422]),
  // documentation: a policy name or a whole declaration; absent, the template's (p8/ex2).
  createWorkflow: (id: string, wid: string, name: string, documentation?: string | Documentation, template = 'empty') =>
    call<{ file: string }>('POST', `${ws(id)}/workflows`, { id: wid, name, template, ...(typeof documentation === 'string' ? { policy: documentation } : documentation ? { documentation } : {}) }),
  workflowTemplates: (id: string) => call<{ id: string; name: string; description: string; documentation: Documentation }[]>('GET', `${ws(id)}/workflow-templates`),
  workflow: (id: string, file: string, refresh = false) => call<WorkflowResponse>('GET', `${wf(id, file)}${refresh ? '?refresh=1' : ''}`),
  saveWorkflow: (id: string, file: string, workflow: Workflow) => call<SaveResponse>('PUT', wf(id, file), { workflow }),
  approve: (id: string, file: string, kind: ApprovalKind, approver: string) =>
    call<SaveResponse & { state: ApprovalState }>('POST', `${wf(id, file)}/approve`, { kind, approver }),
  runs: (id: string) => call<RunSummary[]>('GET', `${ws(id)}/runs`),
  run: (id: string, workflow: string, run: string, rev?: string, signal?: AbortSignal) =>
    call<RunResponse>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`, undefined, [], signal),
  runFile: (id: string, workflow: string, run: string, path: string, rev?: string, signal?: AbortSignal) =>
    call<{ path: string; text: string }>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/file?path=${encodeURIComponent(path)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`, undefined, [], signal),
  // One run operation (docs/runs.md); `by` is the declared actor, `expectSeq` the sequence the view showed.
  runOp: (id: string, workflow: string, run: string, op: Record<string, unknown> & { op: string; by: string; expectSeq?: number }) =>
    call<RunOpResponse>('POST', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/ops`, op),
  runExec: (id: string, workflow: string, run: string, signal?: AbortSignal) => call<RunExecView>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/exec`, undefined, [], signal),
  runNotify: (id: string, workflow: string, run: string, signal?: AbortSignal) => call<RunNotifyView>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/notify`, undefined, [], signal),
  runPresentations: (id: string, workflow: string, run: string, signal?: AbortSignal) => call<{ presentations: PresentationView[] }>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/presentations`, undefined, [], signal),
  presentation: (id: string, workflow: string, run: string, p: string, action: 'start' | 'stop', by: string) => call<{ ok: boolean }>('POST', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/presentations/${encodeURIComponent(p)}/${action}`, { by }),
  adjustRun: (id: string, workflow: string, run: string, body: { text: string; reason: string; by: string; dryRun: boolean; expectRevision?: string; expectSeq?: number }) => call<AdjustView>('POST', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/adjust`, body, [422]),
  retryCheckpoint: (id: string, workflow: string, run: string, checkpoint: number) => call<unknown>('POST', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/checkpoints/${checkpoint}/publish`),
  requestRun: (id: string, input: { workflow: string; text: string; author: string; receipt: string }) =>
    call<{ ok: true; duplicate: boolean; ref: { workflow: string; run: string }; job: { id: number; state: string } }>('POST', `${ws(id)}/runs`, input),
  catalog: () => call<CatalogView>('GET', 'api/nodes'),
  createTemplate: (body: TemplateBody & { id: string }) => call<{ template: NodeTemplate }>('POST', 'api/nodes', body),
  updateTemplate: (id: string, body: TemplateBody & { expectRevision: number }) => call<{ template: NodeTemplate; changed: boolean }>('PUT', `api/nodes/${encodeURIComponent(id)}`, body),
  deleteTemplate: (id: string, revision: number, by: string) => call<{ ok: true }>('DELETE', `api/nodes/${encodeURIComponent(id)}?revision=${revision}&by=${encodeURIComponent(by)}`),
  addExample: (example: string, by: string) => call<{ template: NodeTemplate }>('POST', `api/nodes/examples/${encodeURIComponent(example)}`, { by }),
  eventsUrl: (id?: string) => (id ? `${ws(id)}/events` : 'api/events'),
}

// Zulip coordination of one run (server/notify.ts runStatus).
export interface RunNotifyView {
  configured: boolean; problem?: string; skipped?: string
  topic?: { url: string | null; channel: string; topic: string }
  request?: { url: string | null; channel: string; topic: string } // p6: the request topic the run was asked for in
  pending: number; failed: number; uncertain?: boolean; lastError?: string; lastSent?: string; provisioning?: string; viewBase: string | null
}
