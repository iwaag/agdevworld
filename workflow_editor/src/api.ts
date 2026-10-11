// Thin client for the local service. Errors carry the service's message.
import type {
  AddSubmoduleResponse, AgdevResult, CreateProjectResult, DashboardResponse, ProjectResponse, RegisterResponse, RunOpResponse, RunResponse, RunSummary, SaveResponse,
  WorkflowResponse, WorkspacesResponse,
} from '../shared/api.ts'
import type { ApprovalState } from '../shared/canonical.ts'
import type { ApprovalKind, Project, Workflow } from '../shared/model.ts'

// One run's execution on this host (server/exec.ts runView).
export interface RunExecView {
  attempts: { id: string; state: string; began: string; ended: string | null; exit_code: number | null; signal: string | null; outcome: string | null; backend: string | null; pid: number | null; alive: boolean | null; stop_requested: string | null; log: string | null }[]
  jobs: { id: number; kind: string; state: string; reason: string; created: string; note: string | null }[]
  checkpoints: { id: number; kind: string; state: string; created: string; updated: string; error: string | null; steps: { repo: string; include: string[]; excluded: string[]; conflicts: string[]; commit?: string; pushed?: boolean; branch?: string; error?: string }[] }[]
  executor: { state: string; detail?: string; at?: string }
}

export class ApiError extends Error {
  status: number
  detail?: unknown
  constructor(status: number, message: string, detail?: unknown) { super(message); this.status = status; this.detail = detail }
}

async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  createWorkflow: (id: string, wid: string, name: string) => call<{ file: string }>('POST', `${ws(id)}/workflows`, { id: wid, name }),
  workflow: (id: string, file: string, refresh = false) => call<WorkflowResponse>('GET', `${wf(id, file)}${refresh ? '?refresh=1' : ''}`),
  saveWorkflow: (id: string, file: string, workflow: Workflow) => call<SaveResponse>('PUT', wf(id, file), { workflow }),
  approve: (id: string, file: string, kind: ApprovalKind, approver: string) =>
    call<SaveResponse & { state: ApprovalState }>('POST', `${wf(id, file)}/approve`, { kind, approver }),
  runs: (id: string) => call<RunSummary[]>('GET', `${ws(id)}/runs`),
  run: (id: string, workflow: string, run: string, rev?: string) =>
    call<RunResponse>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`),
  runFile: (id: string, workflow: string, run: string, path: string, rev?: string) =>
    call<{ path: string; text: string }>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/file?path=${encodeURIComponent(path)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`),
  // One run operation (docs/runs.md); `by` is the declared actor, `expectSeq` the sequence the view showed.
  runOp: (id: string, workflow: string, run: string, op: Record<string, unknown> & { op: string; by: string; expectSeq?: number }) =>
    call<RunOpResponse>('POST', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/ops`, op),
  runExec: (id: string, workflow: string, run: string) => call<RunExecView>('GET', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/exec`),
  retryCheckpoint: (id: string, workflow: string, run: string, checkpoint: number) => call<unknown>('POST', `${ws(id)}/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/checkpoints/${checkpoint}/publish`),
  requestRun: (id: string, input: { workflow: string; text: string; author: string; receipt: string }) =>
    call<{ ok: true; duplicate: boolean; ref: { workflow: string; run: string }; job: { id: number; state: string } }>('POST', `${ws(id)}/runs`, input),
  eventsUrl: (id?: string) => (id ? `${ws(id)}/events` : 'api/events'),
}
