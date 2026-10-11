// The HTTP boundary between the local service and any client. Plain JSON;
// nothing here depends on the UI.
import type { ApprovalState } from './canonical.ts'
import type { ApprovalKind, Issue, Project, Workflow } from './model.ts'
import type { RepositoryInfo } from './validate.ts'
import type { ExecutionState, RunRecord } from './run.ts'

export interface FileProblem {
  kind: 'malformed' | 'unsupported' | 'shape' | 'missing' | 'unreadable'
  message: string
  line?: number
  col?: number
}

export interface WorkspaceSummary {
  id: string
  label: string
  host: string
  // Registration is a local record; observation is what this service sees now.
  observed: {
    available: boolean
    reason?: string
    projectId?: string
    projectName?: string
    branch?: string | null
    head?: string
  }
}

// The registry and the authoring area as the service sees them.
export interface WorkspacesResponse {
  approver: string
  workspaces: WorkspaceSummary[]
  registry: { path: string; exists: boolean }
  area: { path: string; sources: string } // where browser-created projects and new sources go
}

// Something a project root lacks, with the action that fixes it.
export interface Diagnostic { severity: 'error' | 'warning'; code: string; message: string; fix?: string }

export interface CreateStep { name: string; status: 'done' | 'kept' | 'failed'; detail: string }
export interface CreateProjectResult {
  ok: boolean
  message: string
  root: string
  workspace?: string
  steps: CreateStep[]
  commits: { repository: string; commit: string; message: string }[]
  resumable?: boolean // an unfinished creation can be continued with resume
  diagnostics?: Diagnostic[]
}

export interface RegisterResponse {
  ok: boolean
  status: 'registered' | 'already-registered' | 'refused'
  message: string
  registration?: { id: string; label: string; host: string; path: string }
  diagnostics: Diagnostic[]
}

export type RepoCategory = 'root' | 'devdocs' | 'study' | 'wedo' | 'other'

export interface RepositoryStatus extends RepositoryInfo {
  name: string
  category: RepoCategory
  url?: string // as written in .gitmodules
  recorded?: string // gitlink in HEAD
  staged?: string // gitlink in the index, when it differs from HEAD
  head?: string // checked-out commit
  branch?: string | null // null = detached HEAD
  dirty: number // changed entries in `git status --porcelain`
  matchesRecorded?: boolean
  // Publication: the branch's upstream as last fetched (no network read).
  // ahead = local commits not published; null upstream = nothing to compare.
  publication?: { upstream: string | null; ahead: number; behind: number }
  error?: string
}

export interface WorkflowSummary {
  file: string
  id?: string
  name?: string
  problem?: FileProblem
  errors: number
  warnings: number
  approvals?: Record<ApprovalKind, ApprovalState['status']>
  delegates: string[]
}

export interface ProjectResponse {
  workspace: string
  rev: string | null // content hash of project.yaml, for display and echo detection only
  project?: Project
  problem?: FileProblem
  issues: Issue[]
  repositories: RepositoryStatus[]
  workflows: WorkflowSummary[]
  workflowsDir: { exists: boolean; reason?: string }
  structure: Diagnostic[]
}

export interface WorkflowResponse {
  workspace: string
  file: string
  rev: string | null
  text: string | null
  workflow?: Workflow
  problem?: FileProblem
  issues: Issue[]
  approvals?: Record<ApprovalKind, ApprovalState>
  repositories: RepositoryStatus[]
  workflows: WorkflowSummary[]
}

export interface SaveResponse { ok: true; rev: string; text: string }

export interface AddSubmoduleResponse {
  ok: boolean
  message: string
  stderr?: string
  // After a failure: what Git left behind, so it can be inspected; nothing is reset.
  partial?: { gitmodulesEntry: boolean; pathExists: boolean; staged: boolean; gitDirExists: boolean }
}

export interface ApiError { error: string; detail?: unknown }

export interface ChangeEvent {
  byEditor?: boolean // the content matches the editor's own last save of that file
  type: 'changed'
  workspace: string
  // workflows: a file appeared or disappeared; git: HEAD, index, dirty or
  // submodule checkout state changed; registry: the workspace list changed.
  // run: a run's record or its folder's files changed; runs: a run appeared or disappeared.
  kind: 'project' | 'workflow' | 'workflows' | 'repositories' | 'git' | 'registry' | 'run' | 'runs'
  file?: string
  run?: string // `<workflow>/<run>` for kind run
  rev: string | null
}

// ---- runs (docs/runs.md) ------------------------------------------------------

// A run as listed: its record when it reads cleanly, or why it does not.
export interface RunSummary {
  ref: string // `<workflow>/<run>`
  workflow: string
  run: string
  dir: string // project-relative
  problem?: FileProblem & { code?: string }
  created?: string
  updated?: string
  seq?: number
  execution?: ExecutionState
  counts?: Record<string, number>
  waiting?: { node: string; holder: string }[]
  ready?: string[]
  failed?: string[]
  input?: 'braindump' | 'request'
  executor?: string
  decision?: 'accepted' | 'rejected'
}

export interface RunFile { name: string; size: number; modified: string }

// What a bundled workflow is compared with: the current source in devdocs/workflows.
export interface SourceComparison {
  workflow: string
  status: 'same' | 'changed' | 'deleted' | 'unreadable'
  source?: string // where the bundle was copied from
  file?: string // where the workflow id is now
  renamed?: boolean // the id now lives in another file of devdocs/workflows
  detail?: string
}

export interface RelatedRun {
  ref: string
  execution?: ExecutionState
  seq?: number
  problem?: string // missing, unreadable, inconsistent …
}

// A commit of the repository that owns devdocs (server/devdocs.ts):
// `root` in directory mode, `devdocs` in submodule mode. `root` names the
// project root commit whose gitlink was followed, when one was.
export interface HistoryRev { owner: 'root' | 'devdocs'; commit: string; subject: string; date: string; root?: string }

export interface RunResponse {
  workspace: string
  ref: string
  dir: string
  rev?: string // the owning repository's commit, when the run was read from history
  revInfo?: HistoryRev
  record?: RunRecord
  problem?: FileProblem & { code?: string }
  bundle: Record<string, { file: string; workflow?: Workflow; problem?: string }>
  sources: SourceComparison[]
  files: RunFile[]
  predecessor?: RelatedRun
  artifacts: { path: string; exists: boolean }[]
}

export interface RunOpResponse { ok: true; seq: number; record: RunRecord }

// ---- the agdev dashboard (p4) -----------------------------------------------------

// Where a listed fact was read and when. A fact that could not be read
// carries `error` instead of a value: unavailable is never shown as empty.
export interface Observation { source: string; at: string; error?: string }

export interface DashboardWorkspace {
  id: string
  label: string
  host: string
  available: boolean
  reason?: string
  runs?: { ongoing: number; waitingOnPerson: number; problems: number; list: { ref: string; execution?: string; waiting: { node: string; holder: string }[] }[] }
  runsError?: string
}

export interface DashboardProject {
  id: string
  root: { key: string; fullName?: string; htmlUrl?: string; error?: string }
  name?: string
  intent?: string
  devdocs?: string
  definition: Observation // where name, intent and devdocs mode were read
  workspaces: DashboardWorkspace[]
}

export interface RepositoryUse { project: string; path: string; source: string; at: string }

export interface DashboardRepository {
  key: string
  category: 'root' | 'devdocs' | 'study' | 'wedo' | 'other'
  description: string
  registered: { owner: string; name: string }
  gitea: { state: 'ok' | 'renamed' | 'missing' | 'unknown'; fullName?: string; htmlUrl?: string; description?: string; empty?: boolean; error?: string; at: string }
  usedBy: RepositoryUse[]
  usageUnknown: { project: string; error: string }[] // projects whose usage could not be read
}

export interface DashboardResponse {
  at: string
  registry: { path: string; exists: boolean }
  gitea: { state: 'ok' | 'unconfigured' | 'unreachable'; url?: string; owner?: string; error?: string }
  executor: { state: 'available' | 'unavailable' | 'unknown' | 'not-configured'; detail?: string; at?: string }
  projects: DashboardProject[]
  repositories: DashboardRepository[]
  // Workspaces registered without a project entry (local-only projects).
  unlinkedWorkspaces: DashboardWorkspace[]
}

export interface AgdevStep { name: string; status: 'done' | 'kept' | 'failed'; detail: string }
export interface AgdevResult { ok: boolean; message: string; steps?: AgdevStep[]; [k: string]: unknown }
