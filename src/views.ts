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
import {
  changePlaneIssueState,
  dispatchPlaneIssue,
  loadDispatchNodes,
  loadPlaneIssues,
  loadPlaneStates,
  planeIssueState,
  type DispatchNode,
  type PlaneIssue,
} from './planeState'
import {
  agentWork,
  introHeadline,
  loadRoomAgents,
  loadRoomWork,
  type RoomAgent,
  type RoomWork,
  type RoomWorkRow,
} from './agentRoomState'
import type { PanelChip, PanelGridApi, PanelGridConfig, PanelRowStatus } from './scenes/PanelGridScene'

// A selection carries the full source record so detail views can render
// everything the snapshot knows about the clicked panel. `device` is the
// matching nctl.actual.v2 device (with facts_raw) when a detail snapshot is
// available; main.ts attaches it before showing details.
export type PanelSelection =
  | { view: 'nodes'; target: DriftTarget; device?: ActualDeviceModel }
  | { view: 'workspaces'; row: WorkspaceRow }
  | { view: 'autolab-project'; node: string; project: AutolabProject; profiles: string[] }
  // `detail` and `summary` are attached by the popup once the drill-down has
  // loaded, so "ask the agent" carries what the user is actually looking at.
  | {
      view: 'autolab'
      node: string
      job: AutolabJobRow
      detail?: AutolabJobDetail
      summary?: { iter: string; text: string }
    }
  // The agent room carries the agent's whole introduction and the open topics
  // of its own channel, so the popup renders without a second fetch.
  | { view: 'agent-room'; agent: RoomAgent; work: RoomWorkRow[] }
  | { view: 'agent-room-board'; group: string; kind: 'project' | 'agent'; rows: RoomWorkRow[] }

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
  let mode: 'projects' | 'jobs' = 'projects'
  let nodes: AutolabNode[] = []
  let selected = ''
  let status: AutolabStatus | undefined
  let statusError: string | undefined
  let api: PanelGridApi | undefined
  let availableProfiles: string[] = []

  const projectRow = (project: AutolabProject) => ({
    id: `${selected}/project/${project.name}`,
    name: `project / ${project.name}`,
    status: project.error ? PROJECT_ERROR : PROJECT_STATUS,
    detail: project.error
      ? project.error
      : `coding ${project.roles?.coding?.profile ?? '?'} · director ${project.roles?.director?.profile ?? '?'}`,
    payload: { kind: 'project' as const, project },
    interactive: true,
  })

  return {
    key: 'autolab',
    title: 'autolab / now',
    loadingText: 'asking the autolab nodes…',
    unavailableText: 'autolab unavailable',
    subtitle: (count) => (selected ? `${count} ${mode} on ${selected}` : 'no autolab node selected'),
    footer: 'projects and jobs are separate views; changes go through conversation',
    switchTo: { key: 'tasks', label: 'tasks' },
    bind: (bound) => {
      api = bound
    },
    headline: () => (selected ? statusHeadline(selected, status, statusError) : undefined),
    chips: () => {
      const chips: PanelChip[] = (['projects', 'jobs'] as const).map((value) => ({
        id: `mode-${value}`,
        label: value,
        active: mode === value,
        onClick: () => {
          if (mode === value) return
          mode = value
          api?.reload()
        },
      }))
      chips.push(...nodes.map((node) => ({
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
      })))
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
      // The mediator headline must not decide whether either grid renders:
      // /status can fail on a node whose project or job route answers.
      const statusPromise = loadAutolabStatus(selected).catch((error: unknown) => {
        statusError = error instanceof Error ? error.message : 'status unavailable'
        return undefined
      })
      if (mode === 'projects') {
        const [projects, statusResult] = await Promise.all([
          loadAutolabProjects(selected),
          statusPromise,
        ])
        status = statusResult
        availableProfiles = projects.profiles
        return projects.projects.map(projectRow)
      }
      const [jobs, statusResult] = await Promise.all([loadAutolabJobs(selected), statusPromise])
      status = statusResult
      return jobs.map((job) => ({
          id: `${selected}/${job.name}`,
          name: job.name,
          status: jobStatusStyle(job),
          detail: jobDetailLine(job),
          payload: { kind: 'job' as const, job },
          interactive: true,
      }))
    },
    onSelect: (row) => {
      const payload = row.payload as
        | { kind: 'project'; project: AutolabProject }
        | { kind: 'job'; job: AutolabJobRow }
      if (payload.kind === 'project') {
        onSelect({
          view: 'autolab-project',
          node: selected,
          project: payload.project,
          profiles: availableProfiles,
        })
        return
      }
      onSelect({ view: 'autolab', node: selected, job: payload.job })
    },
  }
}

const TASK_BACKLOG: PanelRowStatus = { emoji: '🗂️', color: 0xb7b5d8, label: 'BACKLOG' }
const TASK_READY: PanelRowStatus = { emoji: '▶️', color: 0x70c7ff, label: 'READY' }

export function tasksViewConfig(): PanelGridConfig {
  let nodes: DispatchNode[] = []
  let selected = ''
  let api: PanelGridApi | undefined
  let message = ''
  const pending = new Set<string>()

  const selectedNode = () => nodes.find((node) => node.name === selected)
  const runAction = async (issue: PlaneIssue, action: 'execute' | 'cancel') => {
    const node = selectedNode()
    pending.add(issue.id)
    message = action === 'execute' ? `dispatching “${issue.name}”…` : `cancelling “${issue.name}”…`
    api?.reload()
    try {
      if (action === 'execute') {
        if (!node?.reachable) throw new Error('select a reachable autolab node')
        if (node.busy) throw new Error(`${node.name} already has a mission running`)
        await dispatchPlaneIssue(issue, node.name)
        message = `dispatched “${issue.name}” to ${node.name}`
      } else {
        await changePlaneIssueState(issue.id, 'Cancelled')
        message = `cancelled “${issue.name}” before dispatch`
      }
    } catch (error) {
      message = `${action} failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      pending.delete(issue.id)
      api?.reload()
    }
  }

  return {
    key: 'tasks',
    title: 'tasks / plane',
    loadingText: 'asking Plane for dispatchable work…',
    unavailableText: 'Plane task list unavailable',
    subtitle: (count) => `${count} backlog / ready tasks`,
    footer: 'manual dispatch: choose a node, then execute or cancel a Ready task',
    switchTo: { key: 'agentroom', label: 'agent room' },
    bind: (bound) => {
      api = bound
    },
    headline: () => {
      if (message) return message
      const node = selectedNode()
      if (!node) return 'no node selected'
      if (!node.reachable) return `${node.name}: unreachable`
      if (node.busy === undefined) return `${node.name}: reachable; mission state unknown`
      return `${node.name}: ${node.busy ? 'busy' : 'available for dispatch'}`
    },
    chips: () => [
      ...nodes.map((node) => ({
        id: node.name,
        label: `${node.busy ? '◉' : node.reachable ? '●' : '○'} ${node.name}`,
        active: node.name === selected,
        onClick: () => {
          if (selected === node.name) return
          selected = node.name
          message = ''
          api?.reload()
        },
      })),
      { id: 'refresh', label: '⟳ refresh', onClick: () => api?.reload() },
    ],
    loadRows: async () => {
      const [states, issues, foundNodes] = await Promise.all([
        loadPlaneStates(),
        loadPlaneIssues(),
        loadDispatchNodes(),
      ])
      nodes = foundNodes
      if (!nodes.some((node) => node.name === selected)) {
        selected = (nodes.find((node) => node.reachable && !node.busy) ?? nodes.find((node) => node.reachable) ?? nodes[0])?.name ?? ''
      }
      return issues.flatMap((issue) => {
        const state = planeIssueState(issue, states)
        if (!state || !['backlog', 'unstarted'].includes(state.group)) return []
        const ready = state.name === 'Ready' || state.group === 'unstarted'
        const working = pending.has(issue.id)
        const node = selectedNode()
        return [{
          id: issue.id,
          name: issue.name.length > 31 ? `${issue.name.slice(0, 30)}…` : issue.name,
          status: ready ? TASK_READY : TASK_BACKLOG,
          detail: state.name,
          payload: issue,
          interactive: false,
          actions: ready ? [
            {
              label: working ? 'working…' : '▶ execute',
              color: 0x67e8a5,
              disabled: working || !node?.reachable || node.busy === true,
              onClick: () => runAction(issue, 'execute'),
            },
            {
              label: '× cancel',
              color: 0xff8aa8,
              disabled: working,
              onClick: () => runAction(issue, 'cancel'),
            },
          ] : undefined,
        }]
      })
    },
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

// The agent room: who exists, and what of theirs is still open. Both come
// live from Zulip through the `agentroom` relay — there is no snapshot file
// behind this view, deliberately.
//
// Two modes rather than two views, because they are two readings of one
// board: the agents, and the flat list of everything unresolved. The plan
// asked for cards; this is the same card grid the other four views use.

const AGENT_IDLE: PanelRowStatus = { emoji: '🟢', color: 0x67e8a5, label: 'NOTHING OPEN' }
const AGENT_UNKNOWN: PanelRowStatus = { emoji: '❓', color: 0xb7b5d8, label: 'NO INTRO' }
const TOPIC_PROJECT: PanelRowStatus = { emoji: '🧭', color: 0x9b8cff, label: 'PROJECT' }
const TOPIC_AGENT: PanelRowStatus = { emoji: '💬', color: 0x70c7ff, label: 'AGENT' }

function agentStatus(agent: RoomAgent, open: number): PanelRowStatus {
  if (!agent.intro) return AGENT_UNKNOWN
  if (open === 0) return AGENT_IDLE
  return { emoji: '📥', color: 0x70c7ff, label: `${open} OPEN` }
}

function clipped(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function agentRoomViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  let mode: 'agents' | 'work' = 'agents'
  let agents: RoomAgent[] = []
  let work: RoomWork | undefined
  let api: PanelGridApi | undefined

  return {
    key: 'agentroom',
    title: 'agent room / zulip now',
    // `<agent>-<host>` instance names and raw topic names are both longer than
    // a node's; at 19px they were clipped mid-word by the panel's fixed width.
    nameFontSize: 15,
    // The card carries an introduction, not a status word: it needs the room.
    panelHeight: 124,
    loadingText: 'reading Zulip…',
    unavailableText: 'the agent room is unreadable',
    subtitle: (count) =>
      mode === 'agents'
        ? `${count} agents have introduced themselves`
        : `${count} boards have work still open`,
    footer: 'live from Zulip: introductions from #agents, open work from every project and agent channel',
    switchTo: { key: 'nodes', label: 'nodes' },
    bind: (bound) => {
      api = bound
    },
    // One unreadable channel must be said out loud: the alternative is a
    // shorter list that looks exactly like a quieter realm.
    headline: () => {
      const failed = work?.errors ?? []
      if (failed.length > 0) return `${failed.length} channel(s) could not be read: ${failed.map((e) => e.channel).join(', ')}`
      return work ? `${work.channels.length} channels swept` : undefined
    },
    chips: () => {
      const chips: PanelChip[] = (['agents', 'work'] as const).map((value) => ({
        id: `mode-${value}`,
        label: value === 'agents' ? 'agents' : 'open work',
        active: mode === value,
        onClick: () => {
          if (mode === value) return
          mode = value
          api?.reload()
        },
      }))
      chips.push({ id: 'refresh', label: '⟳ refresh', onClick: () => api?.reload() })
      return chips
    },
    loadRows: async () => {
      // Both reads on every load: the agent cards carry an open-work count, so
      // neither answer is complete without the other.
      const [foundAgents, foundWork] = await Promise.all([loadRoomAgents(), loadRoomWork()])
      agents = foundAgents
      work = foundWork
      if (mode === 'agents') {
        return agents.map((agent) => {
          const open = agentWork(foundWork, agent.instance)
          // The card is 84px tall and the status line wraps at ~28 characters,
          // so `detail` gets two lines and no more — measured, after a first
          // attempt spilled five lines of introduction over the row below.
          // The entrance is only worth a card line when it is not simply the
          // instance's name, which today it always is.
          const entrance = agent.entrance && agent.entrance !== agent.instance ? `${agent.entrance} · ` : ''
          return {
            id: `agent/${agent.instance}`,
            name: clipped(agent.instance, 24),
            status: agentStatus(agent, open.length),
            detail: `${entrance}${clipped(introHeadline(agent), 84)}`,
            payload: { kind: 'agent' as const, agent, work: open },
          }
        })
      }
      // One card per board, not per topic. 94 open topics in a grid that caps
      // at four columns and scales to fit came out unreadable — measured, in a
      // screenshot. The flat list the plan asks for lives one click away, in
      // the popup, which is where a list of 27 raw topic names is legible.
      const boards = new Map<string, { kind: 'project' | 'agent'; rows: RoomWorkRow[] }>()
      for (const row of foundWork.topics) {
        const board = boards.get(row.group) ?? { kind: row.kind, rows: [] }
        board.rows.push(row)
        boards.set(row.group, board)
      }
      return [...boards].map(([group, board]) => {
        const channels = new Set(board.rows.map((row) => row.channel))
        return {
          id: `board/${group}`,
          name: clipped(group, 24),
          status: {
            ...(board.kind === 'project' ? TOPIC_PROJECT : TOPIC_AGENT),
            label: `${board.rows.length} OPEN`,
          },
          detail:
            channels.size === 1
              ? `${board.kind} · one channel`
              : `${board.kind} · ${channels.size} channels`,
          payload: { kind: 'board' as const, group, board },
        }
      })
    },
    onSelect: (row) => {
      const payload = row.payload as
        | { kind: 'agent'; agent: RoomAgent; work: RoomWorkRow[] }
        | { kind: 'board'; group: string; board: { kind: 'project' | 'agent'; rows: RoomWorkRow[] } }
      if (payload.kind === 'agent') {
        onSelect({ view: 'agent-room', agent: payload.agent, work: payload.work })
        return
      }
      onSelect({
        view: 'agent-room-board',
        group: payload.group,
        kind: payload.board.kind,
        rows: payload.board.rows,
      })
    },
  }
}
