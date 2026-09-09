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
import { COMPLETED_EVENT } from './completionState'
import {
  healthLine,
  confirmDone,
  loadOpsBoard,
  shownState,
  type OpsBoard,
  type OpsInstance,
  type OpsRow,
  type OpsState,
} from './opsState'
import {
  loadInflight,
  loadRoutine,
  loadRoutines,
  routineDetail,
  routineHeadline,
  type InflightBoard,
  type RoutineBoard,
  type RoutineDetail,
  type RoutineRow,
} from './routineState'
import type {
  PanelChip,
  PanelGridApi,
  PanelGridConfig,
  PanelRow,
  PanelRowStatus,
} from './scenes/PanelGridScene'

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
  // The operation room carries the whole board beside the clicked row, because
  // a row's meaning depends on whether the relay could vouch for it at all.
  | { view: 'ops-row'; row: OpsRow; board: OpsBoard }
  | { view: 'ops-instance'; instance: OpsInstance; board: OpsBoard }
  | { view: 'ops-health'; board: OpsBoard }
  // The routine carries the row the board already has; the tree and the
  // host-side in-flight read arrive a moment later and re-open the popup.
  | {
      view: 'routine'
      routine: RoutineRow
      board: RoutineBoard
      detail?: RoutineDetail
      flight?: InflightBoard
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
  // Resolved topics too (`front_desk` p4): off by default, because the room
  // is about what is open; on when a finished request is to be completed.
  let withResolved = false
  let agents: RoomAgent[] = []
  let retired: string[] = []
  let work: RoomWork | undefined
  let api: PanelGridApi | undefined
  window.addEventListener(COMPLETED_EVENT, () => api?.reload())

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
        ? `${count} agents have introduced themselves` +
          (retired.length > 0 ? ` · ${retired.length} retired` : '')
        : withResolved ? `${count} boards with open or resolved work` : `${count} boards have work still open`,
    footer: 'live from Zulip: introductions from #agents, open work from every project and agent channel',
    switchTo: { key: 'ops', label: 'operation room' },
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
      chips.push({
        id: 'resolved', label: withResolved ? '✔ resolved: shown' : '✔ resolved: hidden',
        active: withResolved,
        onClick: () => { withResolved = !withResolved; api?.reload() },
      })
      chips.push({ id: 'refresh', label: '⟳ refresh', onClick: () => api?.reload() })
      return chips
    },
    loadRows: async () => {
      // Both reads on every load: the agent cards carry an open-work count, so
      // neither answer is complete without the other.
      const [foundAgents, foundWork] = await Promise.all([loadRoomAgents(), loadRoomWork(withResolved)])
      agents = foundAgents.agents
      retired = foundAgents.retired
      work = foundWork
      if (mode === 'agents') {
        return agents.map((agent) => {
          const open = agentWork(foundWork, agent.instance).filter((row) => !row.resolved)
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
            label: withResolved
              ? `${board.rows.filter((row) => !row.resolved).length} OPEN · ${board.rows.filter((row) => row.resolved).length} ✔`
              : `${board.rows.length} OPEN`,
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

// The operation room: the conversation layer, and only it. Every row is a
// `(instance, channel, topic)` that somebody owes a reply in, coloured by what
// the `agentroom` relay's state engine concluded and captioned by why.
//
// Three rules from the plan, all of them p1 findings rather than taste:
//
//  1. `unknown` is drawn as its own state, never as quiet. p9's 26 silent
//     minutes were indistinguishable from an idle board, and this screen
//     exists to make that distinction visible.
//  2. Every row carries its provenance. Green and red alike are inferences
//     from traces left for other purposes; showing the evidence is the only
//     defence against a confident wrong answer.
//  3. Stalled comes first. The relay sorts; this view does not re-sort.

const OPS_STATUS: Record<OpsState, PanelRowStatus> = {
  stalled: { emoji: '🛑', color: 0xff8aa8, label: 'STALLED' },
  awaiting: { emoji: '📥', color: 0x70c7ff, label: 'AWAITING' },
  acked: { emoji: '🔄', color: 0x9b8cff, label: 'ACKED' },
  done: { emoji: '✅', color: 0x67e8a5, label: 'DONE' },
  // Amber, and never the grey this app uses for idle in every other view.
  unknown: { emoji: '❓', color: 0xffc56d, label: 'UNKNOWN' },
}

function opsInstanceStatus(instance: OpsInstance): PanelRowStatus {
  if (instance.state !== 'ok' || instance.roster === 'missing') return OPS_STATUS.unknown
  const counts = instance.counts
  if (counts.stalled > 0) return { ...OPS_STATUS.stalled, label: `${counts.stalled} STALLED` }
  if (counts.awaiting > 0) return { ...OPS_STATUS.awaiting, label: `${counts.awaiting} AWAITING` }
  if (counts.acked > 0) return { ...OPS_STATUS.acked, label: `${counts.acked} RUNNING` }
  // "Nothing owed" is a real answer here and only here: this instance has a
  // roster, the queue is live, and no conversation is waiting on it.
  return { emoji: '🟢', color: 0x67e8a5, label: 'NOTHING OWED' }
}

export function opsViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  let mode: 'board' | 'agents' = 'board'
  let board: OpsBoard | undefined
  let api: PanelGridApi | undefined
  // What the last confirm answered. A refusal has to be *read*, not swallowed
  // into a reload that looks like nothing happened.
  let note = ''
  let working = false

  const doneRows = () => (board?.rows ?? []).filter((row) => shownState(row) === 'done')
  window.addEventListener(COMPLETED_EVENT, () => api?.reload())

  const confirm = async (target?: { channel: string; topic: string }) => {
    if (working) return
    working = true
    note = target ? 'confirming…' : 'confirming all done…'
    api?.reload()
    const found = await confirmDone(target)
    working = false
    note = found.ok ? '' : `⚠ ${found.message}`
    api?.reload()
  }

  return {
    key: 'ops',
    title: 'operation room / who owes a reply',
    nameFontSize: 13,
    // The card's second line is the evidence, which is the point of the view.
    // `provenance.short` is sized for three of these lines; 148 holds them.
    panelHeight: 148,
    loadingText: 'reading the operation room relay…',
    unavailableText: 'the operation room is unreadable',
    subtitle: (count) => {
      if (!board) return 'reading…'
      if (board.health.state !== 'live') {
        // The relay is unreachable when it knows of no agents at all, and the
        // single card on screen is then a placeholder, not a row: counting it
        // would be the board's first small lie.
        if (board.instances.length === 0) return 'the operation room cannot be read'
        return mode === 'agents'
          ? `${count} ${plural(count, 'agent')} — state unknown`
          : `${count} ${plural(count, 'row')}, state unknown`
      }
      // Retired agents are not on the board at all (a ✔ on the `intro-`
      // topic). Counted here anyway: an agent that simply stops being drawn
      // is indistinguishable from one the relay failed to read.
      const retired = board.retired.length
      const gone = retired > 0 ? ` · ${retired} retired` : ''
      if (mode === 'agents') return `${count} ${plural(count, 'agent')} on the board${gone}`
      // `done` is a receipt, not an open row. Counting it under the word
      // "open" was the p2 review's small lie: the number grew all day while
      // nothing was owed. It is still shown, just not as debt.
      const done = doneRows().length
      const open = count - done
      const tail = done > 0 ? ` · ${done} done to confirm` : ''
      if (open === 0) return `nothing is owed a reply right now${tail}`
      const stalled = board.rows.filter((row) => row.state === 'stalled').length
      if (stalled > 0) return `${stalled} stalled of ${open} open ${plural(open, 'row')}${tail}`
      return `${open} ${plural(open, 'row')} open${tail}`
    },
    footer:
      'conversation layer only — Zulip, live: awaiting · stalled · acked · done · unknown',
    switchTo: { key: 'routines', label: 'routines' },
    bind: (bound) => {
      api = bound
    },
    headline: () => {
      if (note) return note
      if (!board) return undefined
      const hidden = board.confirmed?.rows ?? 0
      return hidden > 0
        ? `${healthLine(board)} · ${hidden} confirmed ${plural(hidden, 'row')} hidden`
        : healthLine(board)
    },
    chips: () => {
      const chips: PanelChip[] = (['board', 'agents'] as const).map((value) => ({
        id: `ops-mode-${value}`,
        label: value === 'board' ? 'owed replies' : 'agents',
        active: mode === value,
        onClick: () => {
          if (mode === value) return
          mode = value
          api?.reload()
        },
      }))
      // Only when there is something to confirm, and only on the board — the
      // agents view has no rows to act on. The relay refuses anything but
      // `done` anyway; this is the affordance, not the rule.
      const done = doneRows().length
      if (mode === 'board' && done > 0) {
        chips.push({
          id: 'ops-confirm',
          label: working ? '✓ confirming…' : `✓ confirm ${done} done`,
          onClick: () => void confirm(),
        })
      }
      chips.push({ id: 'ops-refresh', label: '⟳ refresh', onClick: () => api?.reload() })
      return chips
    },
    loadRows: async () => {
      const found = await loadOpsBoard()
      board = found
      if (mode === 'agents') {
        // A relay that cannot be read knows of no agents, and an empty agent
        // list would read as "there are none". Say which it is.
        if (found.instances.length === 0) return [opsUnreadableCard(found)]
        return found.instances.map((instance) => ({
          id: `ops-agent/${instance.instance}`,
          name: clipped(instance.instance, 27),
          status: opsInstanceStatus(instance),
          detail: opsInstanceDetail(instance),
          payload: { kind: 'instance' as const, instance, board: found },
        }))
      }
      if (found.rows.length === 0) {
        // Two very different empties, and the difference is the whole point.
        if (found.health.state !== 'live') return [opsUnreadableCard(found)]
        return []
      }
      // The relay sorted these stalled-first; re-sorting here would put a
      // second opinion between the evidence and the screen.
      // The card is named after the **instance**, not the conversation. Four
      // rows of `ops-testbed/agechoplan-…` came out as four identical clipped
      // titles in a screenshot — two topics for two instances, and the card
      // said which of neither. The instance is the short, always-distinct
      // half; the conversation is the first line of the body.
      return found.rows.map((row, index) => ({
        id: `ops-row/${index}/${row.instance}/${row.channel ?? ''}/${row.topic ?? ''}`,
        name: clipped(row.instance, 26),
        status: {
          ...OPS_STATUS[row.state],
          label:
            row.state === 'unknown' && row.stale_state
              ? `UNKNOWN (was ${row.stale_state.toUpperCase()})`
              : OPS_STATUS[row.state].label,
        },
        // Hard-clipped per line, not word-wrapped: a channel/topic name is
        // one unbroken token, and Phaser's wrap only breaks on spaces — at 52
        // characters it ran straight through the card's right edge and into
        // the neighbouring card; 27 and 24 each still reached the border.
        // 22 is what the status line actually holds at 10px, measured.
        detail:
          (row.topic ? `${clipped(row.channel ?? '', 22)}\n${clipped(row.topic, 22)}\n` : '') +
          clipped(row.provenance.short, 76),
        // One card, one conversation, so the row-level confirm belongs here
        // rather than only in the chip. The card stays selectable: the
        // evidence popup is the reason it is a card at all.
        actions:
          shownState(row) === 'done' && row.channel && row.topic
            ? [{
                label: '✓ confirm',
                color: 0x67e8a5,
                disabled: working,
                onClick: () => void confirm({ channel: row.channel!, topic: row.topic! }),
              }]
            : undefined,
        payload: { kind: 'row' as const, row, board: found },
      }))
    },
    onSelect: (row) => {
      const payload = row.payload as
        | { kind: 'row'; row: OpsRow; board: OpsBoard }
        | { kind: 'instance'; instance: OpsInstance; board: OpsBoard }
        | { kind: 'health'; board: OpsBoard }
      if (payload.kind === 'row') onSelect({ view: 'ops-row', row: payload.row, board: payload.board })
      else if (payload.kind === 'instance') {
        onSelect({ view: 'ops-instance', instance: payload.instance, board: payload.board })
      } else onSelect({ view: 'ops-health', board: payload.board })
    },
  }
}

const ROUTINE_STATUS: Record<string, PanelRowStatus> = {
  stalled: { emoji: '🔴', color: 0xff8aa8, label: 'STALLED' },
  awaiting: { emoji: '🕓', color: 0x70c7ff, label: 'AWAITING' },
  acked: { emoji: '🌀', color: 0x9b8cff, label: 'ACKED' },
  done: { emoji: '✅', color: 0x67e8a5, label: 'ANSWERED' },
  unknown: { emoji: '❓', color: 0xffc56d, label: 'UNKNOWN' },
}

export function routinesViewConfig(
  onSelect: (selection: PanelSelection) => void,
): PanelGridConfig {
  let board: RoutineBoard | undefined
  let api: PanelGridApi | undefined
  // The routine whose tree and chat are on screen. The chat panel owns the
  // conversation; this is only what the popup is showing.
  let opened: string | undefined

  // The tree and the host signal are a second and third fetch, so the popup
  // opens immediately with what the board already knows and fills in. Neither
  // costs a Zulip call: the relay answers both from memory and from this
  // host's own directories.
  const open = async (row: RoutineRow) => {
    opened = row.name
    onSelect({ view: 'routine', routine: row, board: board! })
    const [detail, flight] = await Promise.all([loadRoutine(row.name), loadInflight(row.name)])
    if (opened !== row.name) return
    onSelect({
      view: 'routine',
      routine: 'error' in detail ? row : detail.routine,
      board: board!,
      detail: 'error' in detail ? undefined : detail,
      flight: 'error' in flight ? undefined : flight,
    })
  }

  return {
    key: 'routines',
    title: 'routines / standing requests and their runs',
    nameFontSize: 15,
    panelHeight: 132,
    loadingText: 'reading the routine board…',
    unavailableText: 'the routine board is unreadable',
    subtitle: (count) => {
      if (!board) return 'reading…'
      if (board.health.state !== 'live') {
        if (board.routines.length === 0) return 'the routine board cannot be read'
        return `${count} ${plural(count, 'routine')} — state unknown`
      }
      const owed = board.routines.filter(
        (row) => row.state === 'stalled' || row.state === 'awaiting' || row.state === 'acked',
      ).length
      const never = board.routines.filter((row) => row.answer.state === 'no fire').length
      const tail = never > 0 ? ` · ${never} never fired by the dispatcher` : ''
      if (owed === 0) return `every routine's last fire was answered${tail}`
      return `${owed} ${plural(owed, 'fire')} still unanswered${tail}`
    },
    footer:
      'a routine is a standing request, a fire topic and a schedule — click one to talk to Front about it',
    switchTo: { key: 'nodes', label: 'nodes' },
    bind: (bound) => {
      api = bound
    },
    headline: () => (board ? routineHeadline(board) : undefined),
    chips: () => [{ id: 'routines-refresh', label: '⟳ refresh', onClick: () => api?.reload() }],
    loadRows: async () => {
      const found = await loadRoutines()
      board = found
      if (found.routines.length === 0) {
        return [{
          id: 'routines-unreadable',
          name: 'routine board',
          status: ROUTINE_STATUS.unknown,
          detail: found.health.reason,
          payload: undefined,
          interactive: false,
        }]
      }
      return found.routines.map((row) => ({
        id: `routine/${row.name}`,
        name: clipped(row.retired ? `✔ ${row.name}` : row.name, 24),
        status: {
          ...ROUTINE_STATUS[row.state],
          label:
            row.state === 'unknown' && row.stale_state
              ? `UNKNOWN (was ${row.stale_state.toUpperCase()})`
              : ROUTINE_STATUS[row.state].label,
        },
        detail: clipped(routineDetail(row), 76),
        actions: [{
          label: '💬 chat',
          color: 0x70c7ff,
          onClick: () => void open(row),
        }],
        payload: row,
      }))
    },
    onSelect: (row) => {
      const found = row.payload as RoutineRow | undefined
      if (found) void open(found)
    },
  }
}

// The card that stands in for a board nobody could read. It is a card and not
// an empty grid because an empty grid is indistinguishable from a quiet realm.
function opsUnreadableCard(board: OpsBoard): PanelRow {
  return {
    id: 'ops-unreadable',
    name: 'operation room',
    status: OPS_STATUS.unknown,
    detail: board.health.reason,
    payload: { kind: 'health' as const, board },
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

function opsInstanceDetail(instance: OpsInstance): string {
  if (instance.roster === 'missing') {
    return 'its #agents introduction carries no roster block'
  }
  const channel =
    instance.channel_exists === false
      ? `no channel of its own (declares ${instance.channel})`
      : `channel ${instance.channel}`
  const prefixes = instance.prefixes.length > 0 ? instance.prefixes.join(' ') : 'no prefixes'
  return clipped(`${channel} · ${prefixes}`, 88)
}
