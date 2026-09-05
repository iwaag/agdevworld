// The agent room's reads: agents and their open work, straight from Zulip
// through the `agentroom` relay (`agentroom/README.md`).
//
// Nothing here is cached in the browser and nothing is fetched at build time —
// the whole point of this view is that it shows the realm as it is now. The
// relay holds a 30-second in-memory cache so a reload does not re-sweep.

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
}

export interface RoomWork {
  channels: string[]
  topics: RoomWorkRow[]
  errors: Array<{ channel: string; error: string }>
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

export async function loadRoomAgents(): Promise<RoomAgent[]> {
  return (await read<{ agents: RoomAgent[] }>('/agents')).agents
}

export async function loadRoomWork(): Promise<RoomWork> {
  return await read<RoomWork>('/work')
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
