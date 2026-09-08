// Front Desk's read and write, through the agentroom relay.
//
// A Front Desk conversation is one `#front` topic, `front-desk-<id>`, which
// Front's existing `front-` sweep serves. Zulip is the history; the relay
// holds it in the memory its event queue keeps current and answers from
// there, so the view may ask every few seconds without a Zulip call. Nothing
// is interpreted here: which post is an ack, whether a reply is owed, whether
// the topic is resolved — every word comes from the relay, as in
// `routineState.ts`.
//
// The demo source at the bottom exists so the scene can be looked at with no
// relay running (`?view=frontdesk&demo=1`): it answers in the Front Desk
// voice from a script and never touches the realm.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export type PostKind = 'developer' | 'agent' | 'ack' | 'other'

// One line of a scene: spoken by a character of the settings revision the
// dialogue names, with the posts it was drawn from when Front cited them.
export interface DeskCitation {
  channel: string
  topic: string
  message_id: number | null
}

export interface DeskTurn {
  character: string
  text: string
  sources: DeskCitation[]
}

// A short exchange between characters that agfront wrote beside Front's
// reply (`ag.frontdesk-dialogue.v1`), already validated there. The relay
// splits it off the post: `content` is the reply alone, this is the scene.
export interface DeskDialogue {
  schema: string
  settings_revision: string
  turns: DeskTurn[]
}

export interface DeskPost {
  message_id: number
  at: number
  by: string
  sender_id: number
  content: string
  kind: PostKind
  dialogue?: DeskDialogue | null
  // What agfront (or the relay) found wrong with a block that could not be
  // used: the reply is shown on its own and the issue is recorded here.
  dialogue_error?: string | null
}

// The relay's verdict on where the conversation stands. `waiting` is the
// Developer having spoken last; `received` is Front's ack being the newest
// post; `answered` is a real reply after the newest Developer post; `done`
// is Zulip's ✔; `quiet` is a conversation nobody is waiting on; `unknown` is
// a relay that cannot read the realm right now.
export type DeskState = 'waiting' | 'received' | 'answered' | 'done' | 'quiet' | 'unknown'

export interface DeskStatus {
  state: DeskState
  since: number | null
  evidence: string
}

export interface DeskConversationRow {
  id: string
  topic: string
  live_topic: string
  resolved: boolean
  posts: number
  last_post: { at: number; by: string } | null
  status: DeskStatus
}

export interface DeskConversation extends Omit<DeskConversationRow, 'posts'> {
  // `held` — the relay's event-queue memory; `read` — a direct read of Zulip
  // for a conversation the memory does not hold (an old resolved one);
  // `unknown` — neither could be done, and `posts` is the last thing known.
  known: 'held' | 'read' | 'unknown'
  history: { posts: number; bounded: boolean; note: string }
  posts: DeskPost[]
  // The row's `posts` count lives in `history.posts` here.
  latest_reply: DeskPost | null
  zulip_url: string | null
}

export interface DeskChatStatus {
  configured: boolean
  reason: string | null
  max_chars?: number
}

export interface DeskHealth {
  state: 'live' | 'unknown'
  reason: string
}

export interface DeskBoard {
  schema: string
  generated_at: number
  health: DeskHealth
  chat: DeskChatStatus
  channel: string
  prefix: string
  conversations: DeskConversationRow[]
}

export interface DeskDetail {
  schema: string
  generated_at: number
  health: DeskHealth
  chat: DeskChatStatus
  conversation: DeskConversation
}

export interface SendResult {
  sent: boolean
  message_id?: number
  duplicate?: boolean
  uncertain?: boolean
  error?: string
  note?: string
}

export interface DeskSource {
  board: () => Promise<DeskBoard | { error: string }>
  detail: (id: string) => Promise<DeskDetail | { error: string }>
  send: (id: string, text: string, token: string) => Promise<SendResult>
}

// A conversation id is what follows `front-desk-` in the topic. Kept to a
// shape the relay validates too, so a bad one is refused there as well.
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

export function newConversationId(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

export function submitToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function read<T>(path: string): Promise<T | { error: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { error: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    return { error: detail ?? `agentroom answered ${response.status}` }
  }
  if (!payload || typeof payload !== 'object') return { error: 'agentroom returned an unreadable response' }
  return payload as T
}

export const relaySource: DeskSource = {
  board: () => read<DeskBoard>('/frontdesk'),
  detail: (id) => read<DeskDetail>(`/frontdesk/${encodeURIComponent(id)}`),
  async send(id, text, token) {
    let response: Response
    try {
      response = await fetch(`${BASE}/frontdesk/${encodeURIComponent(id)}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, token }),
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      // No answer at all. A timeout is the uncertain case: the post may have
      // left the relay and landed, and a second one would start a second run.
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
      return {
        sent: false, uncertain: timedOut,
        error: timedOut ? 'the relay did not answer in time; the post may have landed' : `the agentroom relay is not answering on ${BASE}`,
      }
    }
    const payload = (await response.json().catch(() => undefined)) as SendResult | undefined
    if (!response.ok || !payload?.sent) {
      return {
        sent: false, uncertain: Boolean(payload?.uncertain), duplicate: Boolean(payload?.duplicate),
        error: payload?.error ?? `agentroom answered ${response.status}`, note: payload?.note,
      }
    }
    return payload
  },
}

export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown age'
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} d`
}

export function clock(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

// --- the demo source ---------------------------------------------------------

const DEMO_REPLIES = [
  'やっほー✨ Front Desk へようこそ〜！💁‍♀️ 今日はなにする？雑談でもお仕事でもオッケーだよ🙆‍♀️💕',
  'それな〜！！😆✨ わかりみが深い🥹💯 で、そのあとどうなったの？👀',
  'おっけ〜〜👌💖 じゃあまとめるね📝\n\n1. 今日の予定を確認する🗓️\n2. autolab ちゃんに ghtrends をお願いする🤖\n3. 終わったらここで報告する📣\n\nこれで進めてよき？🙋‍♀️',
  'ぜんぶ終わったよ〜〜🎉🎉🎉 リポジトリは `example/awesome-tool` で、スター ⭐12,345 / フォーク 🍴678 だったって！📊 サマリーはこちら👉 https://example.invalid/main/repos/example-awesome-tool.md まじ最高✨ ' +
    'ちなみに長い返事のテストもかねてもうちょい書くね📝 ' +
    'ページ送りがちゃんと動くかどうか、絵文字が真っ二つにならないかどうか👀🔍 日本語の折り返しが自然かどうか🇯🇵📖 そういうのを見てほしいの〜🙏💕 ' +
    'あとリンクのチップもね🔗 [リポジトリ](https://github.com/example/awesome-tool) と [作業トピック](https://example.invalid/#narrow/channel/pj-ghtrends) を置いとくね😉✨ ' +
    'まだ続くよ〜〜！！😂 こういう長文でも最後まで読めるように、ページの右下の矢印で進んでね▶️ 戻るのは◀️だよ〜 わかった？🥰 ' +
    'では今日もおつかれさま〜〜🌙💤 またなんでも言ってね💌',
  'forge ちゃんからタイトル画像が届いたよ🎨✨ 設定に forge のキャラがいれば左上に顔が出るはず👀',
]

// The scenes the demo replies play: the third reply is an exchange with
// Autolab (the collaborator in the upper left), the fourth is Front-only
// with an unusable block, so both paths of the screen can be looked at.
const DEMO_SCENES: (DeskDialogue | { error: string } | null)[] = [
  null,
  null,
  {
    schema: 'ag.frontdesk-dialogue.v1', settings_revision: 'demo',
    turns: [
      { character: 'front', text: '親方〜！ghtrends の件、どうなった？✨', sources: [] },
      { character: 'autolab', text: '終わった。example/awesome-tool。コミット a99625f。', sources: [{ channel: 'work-g-13', topic: 'workrun-task1-g-13', message_id: 5203 }] },
      { character: 'front', text: 'さすが親方〜！😆💕 じゃあ開発者さんに報告しとくね📣', sources: [] },
      { character: 'autolab', text: '…机、片付けろって言うなよ。', sources: [] },
    ],
  },
  { error: "turn 2: character 'forge' is not in settings revision demo (known: autolab, front)" },
  {
    schema: 'ag.frontdesk-dialogue.v1', settings_revision: 'demo',
    turns: [
      { character: 'forge', text: 'タイトル画像、できたぞ。', sources: [{ channel: 'agforge-agstudio1', topic: 'assetplan-title', message_id: 6001 }] },
      { character: 'front', text: 'わ〜！ありがと〜✨ 開発者さんに見せてくるね💕', sources: [] },
    ],
  },
]

export function demoSource(revision = 'demo'): DeskSource {
  const posts: DeskPost[] = []
  let next = 1
  let reply = 0
  let pending: number | undefined
  const push = (by: string, sender_id: number, content: string, kind: PostKind, scene: (typeof DEMO_SCENES)[number] = null) => {
    posts.push({
      message_id: next++, at: Date.now() / 1000, by, sender_id, content, kind,
      dialogue: scene && 'turns' in scene ? { ...scene, settings_revision: revision } : null,
      dialogue_error: scene && 'error' in scene ? scene.error : null,
    })
  }
  const status = (): DeskStatus => {
    const last = posts[posts.length - 1]
    if (!last) return { state: 'quiet', since: null, evidence: 'no posts yet' }
    if (last.kind === 'developer') return { state: 'waiting', since: last.at, evidence: 'the Developer spoke last' }
    if (last.kind === 'ack') return { state: 'received', since: last.at, evidence: 'Front acked and has not answered' }
    return { state: 'answered', since: last.at, evidence: 'Front answered' }
  }
  const health: DeskHealth = { state: 'live', reason: 'demo source, nothing here reaches the realm' }
  const chat: DeskChatStatus = { configured: true, reason: null, max_chars: 4000 }
  const row = (id: string): DeskConversationRow => ({
    id, topic: `front-desk-${id}`, live_topic: `front-desk-${id}`, resolved: false,
    posts: posts.length, last_post: posts.length ? { at: posts[posts.length - 1].at, by: posts[posts.length - 1].by } : null,
    status: status(),
  })
  return {
    async board() {
      return { schema: 'ag.frontdesk.v1', generated_at: Date.now() / 1000, health, chat, channel: 'front', prefix: 'front-desk-', conversations: [row('demo')] }
    },
    async detail(id) {
      const latest = [...posts].reverse().find((p) => p.kind === 'agent') ?? null
      return {
        schema: 'ag.frontdesk.v1', generated_at: Date.now() / 1000, health, chat,
        conversation: {
          ...row(id), known: 'held', history: { posts: posts.length, bounded: false, note: 'demo' },
          posts: [...posts], latest_reply: latest, zulip_url: null,
        },
      }
    },
    async send(_id, text) {
      push('Developer', 8, text, 'developer')
      window.clearTimeout(pending)
      pending = window.setTimeout(() => {
        push('Front', 15, 'Message received. Please wait for the reply.', 'ack')
        pending = window.setTimeout(() => {
          const index = Math.min(reply, DEMO_REPLIES.length - 1)
          push('Front', 15, DEMO_REPLIES[index], 'agent', DEMO_SCENES[index] ?? null)
          reply += 1
        }, 2500)
      }, 800)
      return { sent: true, message_id: next - 1 }
    },
  }
}
