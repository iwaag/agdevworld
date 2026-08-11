import {
  loadExistingNodes,
  loadWorkspaceRows,
  type ActualDeviceModel,
  type ClusterStatus,
  type DriftTarget,
  type WorkspaceRow,
} from './clusterState'
import {
  jobDetailLine,
  loadAutolabJobs,
  loadAutolabNodes,
  loadAutolabProjects,
  loadAutolabStatus,
  statusHeadline,
  type AutolabJobDetail,
  type AutolabJobRow,
  type AutolabNode,
  type AutolabProject,
  type AutolabStatus,
} from './autolabState'
import type { PanelChip, PanelGridApi, PanelGridConfig, PanelRowStatus } from './scenes/PanelGridScene'

// A selection carries the full source record so detail views can render
// everything the snapshot knows about the clicked panel. `device` is the
// matching nctl.actual.v2 device (with facts_raw) when a detail snapshot is
// available; main.ts attaches it before showing details.
export type PanelSelection =
  | { view: 'nodes'; target: DriftTarget; device?: ActualDeviceModel }
  | { view: 'workspaces'; row: WorkspaceRow }
  // `detail` and `summary` are attached by the popup once the drill-down has
  // loaded, so "ask the agent" carries what the user is actually looking at.
  | {
      view: 'autolab'
      node: string
      job: AutolabJobRow
      detail?: AutolabJobDetail
      summary?: { iter: string; text: string }
    }

const CLUSTER_STATUS_STYLE: Record<ClusterStatus, PanelRowStatus> = {
  converged: { emoji: '✅', color: 0x67e8a5, label: 'CONVERGED' },
  converging: { emoji: '🔄', color: 0x70c7ff, label: 'CONVERGING' },
  drifting: { emoji: '⚠️', color: 0xffc56d, label: 'DRIFTING' },
  unknown: { emoji: '❓', color: 0xb7b5d8, label: 'UNKNOWN' },
}

export function nodesViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  return {
    key: 'nodes',
    title: 'cluster / now',
    loadingText: 'listening for a cluster snapshot…',
    unavailableText: 'cluster snapshot unavailable',
    subtitle: (count) => `${count} nodes are present`,
    footer: 'desired nodes with confirmed actual state',
    switchTo: { key: 'workspaces', label: 'workspaces' },
    loadRows: async () =>
      (await loadExistingNodes()).map((node) => ({
        id: node.id,
        name: node.name,
        status: CLUSTER_STATUS_STYLE[node.status],
        payload: node.entry,
      })),
    onSelect: (row) => onSelect({ view: 'nodes', target: row.payload as DriftTarget }),
  }
}

export function workspacesViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  return {
    key: 'workspaces',
    title: 'workspaces / now',
    loadingText: 'listening for a workspace snapshot…',
    unavailableText: 'workspace snapshot unavailable',
    subtitle: (count) => `${count} workspaces are present`,
    footer: 'desired workspaces and their activity',
    switchTo: { key: 'autolab', label: 'autolab' },
    loadRows: async () =>
      (await loadWorkspaceRows()).map((row) => ({
        id: row.slug,
        name: row.name,
        status: WORKSPACE_ACTIVITY_STYLE[row.activity_class ?? ''] ?? WORKSPACE_ACTIVITY_UNKNOWN,
        detail: row.node,
        payload: row,
      })),
    onSelect: (row) => onSelect({ view: 'workspaces', row: row.payload as WorkspaceRow }),
  }
}

// autolab: the job status vocabulary of agautolab's state.json, mapped onto
// the same panel-status shape the cluster views use.
const JOB_STATUS_STYLE: Record<string, PanelRowStatus> = {
  converged: { emoji: '✅', color: 0x67e8a5, label: 'CONVERGED' },
  running: { emoji: '🔄', color: 0x70c7ff, label: 'RUNNING' },
  pending: { emoji: '⏳', color: 0xb7b5d8, label: 'PENDING' },
  awaiting_approval: { emoji: '🙋', color: 0xffc56d, label: 'AWAITING APPROVAL' },
  stuck: { emoji: '🧱', color: 0xffc56d, label: 'STUCK' },
  error: { emoji: '💥', color: 0xff8aa8, label: 'ERROR' },
}
const JOB_STATUS_UNKNOWN: PanelRowStatus = { emoji: '❓', color: 0xb7b5d8, label: 'UNKNOWN' }
const JOB_NOT_STARTED: PanelRowStatus = { emoji: '🌱', color: 0xb7b5d8, label: 'NOT STARTED' }
const PROJECT_STATUS: PanelRowStatus = { emoji: '🧭', color: 0x9b8cff, label: 'PROJECT' }
const PROJECT_ERROR: PanelRowStatus = { emoji: '💥', color: 0xff8aa8, label: 'PROJECT ERROR' }

function jobStatusStyle(job: AutolabJobRow): PanelRowStatus {
  if (job.error) return { emoji: '💥', color: 0xff8aa8, label: 'UNREADABLE' }
  if (job.not_started) return JOB_NOT_STARTED
  return JOB_STATUS_STYLE[String(job.status)] ?? JOB_STATUS_UNKNOWN
}

// The picked node lives here rather than in the scene: the scene stays a
// config-driven grid, and this closure is what the chips mutate.
export function autolabViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  let nodes: AutolabNode[] = []
  let selected = ''
  let status: AutolabStatus | undefined
  let statusError: string | undefined
  let api: PanelGridApi | undefined
  let jobCount = 0
  let projectCount = 0

  const projectRow = (project: AutolabProject) => ({
    id: `${selected}/project/${project.name}`,
    name: `project / ${project.name}`,
    status: project.error ? PROJECT_ERROR : PROJECT_STATUS,
    detail: project.error
      ? project.error
      : `coding ${project.roles?.coding?.profile ?? '?'} · director ${project.roles?.director?.profile ?? '?'}`,
    payload: project,
    interactive: false,
  })

  return {
    key: 'autolab',
    title: 'autolab / now',
    loadingText: 'asking the autolab nodes…',
    unavailableText: 'autolab unavailable',
    subtitle: () => (selected ? `${projectCount} projects · ${jobCount} jobs on ${selected}` : 'no autolab node selected'),
    footer: 'project profiles are read-only here; ask the agent to change one',
    switchTo: { key: 'nodes', label: 'nodes' },
    bind: (bound) => {
      api = bound
    },
    headline: () => (selected ? statusHeadline(selected, status, statusError) : undefined),
    chips: () => {
      const chips: PanelChip[] = nodes.map((node) => ({
        id: node.name,
        // An unreachable node stays clickable and says so: picking it and
        // reading the real error beats a disabled control that explains
        // nothing.
        label: `${node.reachable ? '●' : '○'} ${node.name}`,
        active: node.name === selected,
        onClick: () => {
          if (node.name === selected) return
          selected = node.name
          api?.reload()
        },
      }))
      if (selected) chips.push({ id: 'refresh', label: '⟳ refresh', onClick: () => api?.reload() })
      return chips
    },
    loadRows: async () => {
      nodes = await loadAutolabNodes()
      if (nodes.length === 0) throw new Error('no autolab nodes are configured')
      // First entry point: pick the first reachable node, else the first one,
      // so the view lands on something rather than an empty picker.
      if (!nodes.some((node) => node.name === selected)) {
        selected = (nodes.find((node) => node.reachable) ?? nodes[0]).name
      }
      status = undefined
      statusError = undefined
      // The mediator headline must not decide whether the job grid renders:
      // /status can fail on a node whose /jobs answers perfectly well.
      const [jobs, projects, statusResult] = await Promise.all([
        loadAutolabJobs(selected),
        loadAutolabProjects(selected),
        loadAutolabStatus(selected).catch((error: unknown) => {
          statusError = error instanceof Error ? error.message : 'status unavailable'
          return undefined
        }),
      ])
      status = statusResult
      jobCount = jobs.length
      projectCount = projects.projects.length
      return [
        ...projects.projects.map(projectRow),
        ...jobs.map((job) => ({
          id: `${selected}/${job.name}`,
          name: job.name,
          status: jobStatusStyle(job),
          detail: jobDetailLine(job),
          payload: job,
          interactive: true,
        })),
      ]
    },
    onSelect: (row) => onSelect({ view: 'autolab', node: selected, job: row.payload as AutolabJobRow }),
  }
}

// Panel color/label come from activity_class — the field this envelope exists
// to surface — rather than gap codes.
const WORKSPACE_ACTIVITY_STYLE: Record<string, PanelRowStatus> = {
  active_development: { emoji: '🛠️', color: 0x67e8a5, label: 'ACTIVE DEV' },
  behind_origin: { emoji: '⏳', color: 0xffc56d, label: 'BEHIND ORIGIN' },
  idle: { emoji: '💤', color: 0xb7b5d8, label: 'IDLE' },
}

const WORKSPACE_ACTIVITY_UNKNOWN: PanelRowStatus = { emoji: '❓', color: 0xb7b5d8, label: 'UNKNOWN' }
