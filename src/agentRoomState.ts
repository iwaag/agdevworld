// The agent room's reads: agents and their open work, straight from Zulip
// through the `agentroom` relay (`agentroom/README.md`).
//
// Nothing here is cached in the browser and nothing is fetched at build time —
// the whole point of this view is that it shows the realm as it is now. Since
// `better_zulip_call` p1 the relay answers from its mirror — a persisted,
// event-updated copy of the realm — so a reload costs no Zulip call, and the
// payload's `health` says whether that copy is live or the last good one.

// The relay listens on loopback beside the browser: the same address whether
// the page came from vite (:5173) or the nginx image (:8090). Override with
// VITE_AGENTROOM_URL when it runs somewhere else.
const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export interface RoomPost {
  id: number
  sender: string
  timestamp: number
  content: string
}

export interface RoomAgent {
  instance: string
  topic: string
  // The instance's own channel, when one exists. A link, not a claim: the
  // introduction itself is what says where to write.
  entrance: string | null
  intro: RoomPost | null
  history: RoomPost[]
}

export interface RoomWorkRow {
  channel: string
  topic: string
  kind: 'project' | 'agent'
  group: string
  stream_id: number
  // Zulip's ✔. Only present in a listing that asked for resolved topics too.
  resolved?: boolean
}

// The mirror's freshness, beside every payload: a stale copy is still
// shown, and this is what lets the headline say so instead of pretending.
export interface RoomHealth {
  state: 'live' | 'stale' | 'unknown'
  reason: string
  stale_since: number | null
  revision: number
  last_event_at: number | null
  resyncs: number
}

export interface RoomWork {
  channels: string[]
  topics: RoomWorkRow[]
  include_resolved?: boolean
  health: RoomHealth
}

export function roomHealthLine(health: RoomHealth | undefined): string | undefined {
  if (!health || health.state === 'live') return undefined
  const since = health.stale_since ? new Date(health.stale_since * 1000).toLocaleTimeString() : 'an unknown time'
  return `⚠ the mirror is ${health.state} since ${since} — ${health.reason}; showing the last good copy`
}

async function read<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`)
  } catch {
    // The relay is a separate process a developer starts by hand; saying so
    // beats "failed to fetch".
    throw new Error(`the agentroom relay is not answering on ${BASE}`)
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    throw new Error(detail ?? `agentroom answered ${response.status}`)
  }
  return payload as T
}

export interface RoomRoster {
  agents: RoomAgent[]
  health?: RoomHealth
  // Instances whose `intro-` topic carries Zulip's ✔ — retired, and so not in
  // `agents`. Kept so the room can say an agent left rather than letting the
  // card quietly stop being drawn.
  retired: string[]
}

export async function loadRoomAgents(): Promise<RoomRoster> {
  const found = await read<RoomRoster>('/agents')
  return { agents: found.agents, retired: found.retired ?? [], health: found.health }
}

// `includeResolved` lists the ✔ topics too (`front_desk` p4): a finished
// request is completed from here, and finished means resolved.
export async function loadRoomWork(includeResolved = false): Promise<RoomWork> {
  return await read<RoomWork>(includeResolved ? '/work?resolved=1' : '/work')
}

// The open topics filed under one agent's own channel. Project work is not
// attributed to an agent: a `pj-` channel is the project's board, and which
// agent is carrying which task there is not something a topic name can be
// asked (topic vocabulary differs per agent; only `✔ ` is common).
export function agentWork(work: RoomWork, instance: string): RoomWorkRow[] {
  return work.topics.filter((row) => row.kind === 'agent' && row.group === instance)
}

// One line of an introduction for a panel that has room for one line: the
// first prose line, with the markdown heading and any decoration dropped.
export function introHeadline(agent: RoomAgent): string {
  const body = agent.intro?.content ?? ''
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('---')) continue
    return line.replace(/[*`]/g, '')
  }
  return 'no introduction posted'
}

export function postedAt(post: RoomPost | null): string {
  if (!post) return ''
  return new Date(post.timestamp * 1000).toLocaleString()
}
