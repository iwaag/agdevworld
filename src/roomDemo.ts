// A room with no relay behind it (`?view=frontdesk&demo=1`, `?view=argue&demo=1`).
//
// It plays the whole flow from a script so the screen can be looked at and
// driven by a test with nothing running: a human post, the ack, the agents'
// plain replies, the rendering arriving a moment later (so the *pending*
// fallback is visible first), one reply whose rendering fails, a second
// interpretation on request, and — for the desk — the completion panel with
// a target that fails once. Nothing here reaches the realm.
//
// Since `clearer_chat_ui` step 3 every scripted post says what it is for — a
// progress note, a report, a question or a confirmation for the Developer —
// and the demo keeps the requests' states the way the relay's read model
// does (`agag.outstanding`: an answer naming a request settles it; an
// unnamed answer settles the one pending request, never one of two).

import type {
  CompletionAction as CloseAction,
  CompletionKind as CloseKind,
  CompletionPlan as ClosePlan,
  CompletionResult as CloseResult,
  CompletionState as CloseState,
} from './completionState'
import type { PostMeaning, Presentation, Rendering, RequestRow, RoomAdapter, RoomDetail, RoomId, RoomPost, RoomRequests, RoomStatus } from './roomState'

interface Line { agent: string; speaker: string; by: string; sender_id: number; text: string; voiced: string[] | null; meaning?: PostMeaning }

const DEVELOPER = 8
const progress: PostMeaning = { intent: 'progress' }
const report: PostMeaning = { intent: 'report' }
const question: PostMeaning = { intent: 'response_request', to: DEVELOPER, ask: 'question' }
const confirmation: PostMeaning = { intent: 'response_request', to: DEVELOPER, ask: 'confirmation' }

// What the agents "say" to each human post, plainly, and how Front re-voices
// it. `voiced: null` is a speaker without a character (shown as written).
const SCRIPT: Line[][] = [
  [{ agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15, meaning: progress,
     text: 'Reading the board and the introductions first.',
     voiced: ['いま掲示板と自己紹介を読んでるとこ〜📖'] },
   { agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15, meaning: question,
     text: 'Welcome. This is a plain reply: the discussion itself carries no character. What would you like to do?',
     voiced: ['やっほー✨ ようこそ〜！💁‍♀️ ここの会話そのものはキャラなしで進むんだって。', '今日はなにする？🙆‍♀️💕'] }],
  [{ agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15,
     meaning: report,
     text: 'I asked autolab. Its plan is in #pj-ghtrends › workplan-trend9; see https://example.invalid/main/repos/example-awesome-tool.md',
     voiced: ['親方に聞いてきたよ〜！計画は #pj-ghtrends › workplan-trend9 にあるって📝 https://example.invalid/main/repos/example-awesome-tool.md'] },
   { agent: 'autolab', speaker: 'autolab-agstudio1', by: 'autolab-agstudio1', sender_id: 11,
     meaning: report,
     text: 'Planned 2 tasks. Commit a99625f has the fetcher. I could not verify the GitHub token; if it is expired task 1 fails with HTTP 401.',
     voiced: ['2つ計画した。フェッチャーはコミット a99625f。', 'GitHub トークンは確認できてない。切れてたら task 1 は HTTP 401 で落ちる。'] },
   { agent: 'archsage', speaker: 'sage:arxiv', by: 'archsage', sender_id: 24,
     text: 'Three papers bear on this; none of them measures what you asked, which is itself worth a study.',
     voiced: null }],
  [{ agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15, meaning: report,
     text: 'This reply is long on purpose, so that paging can be looked at. '.repeat(14).trim(),
     voiced: ['これはページ送りのテスト用にわざと長くしてあるやつだよ〜📖 '.repeat(10).trim()] },
   { agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15, meaning: confirmation,
     text: 'Shall I ask autolab to start task 1 now?',
     voiced: ['親方に task 1 始めてもらっていい？🙏'] },
   { agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15, meaning: question,
     text: 'And which palette should the title screen use, A or B?',
     voiced: ['あとタイトル画面のパレット、A と B どっちにする？🎨'] }],
  [{ agent: 'front', speaker: 'Front', by: 'Front', sender_id: 15,
     meaning: report,
     text: 'The rendering of this reply fails in the demo, so the original stays on show with the reason.',
     voiced: [] }],
]

// --- the demo's completion plan ------------------------------------------------

const DEMO_FLAKY = 'topic:agforge-agstudio1/assetrun-title'
const demoClosed = new Set<string>()
let demoFailedOnce = false
// The demo argue: ✔ after a close from the room, open again after a post.
let demoResolved = false

// An argue's plan is the discussion only: the argue topic, and what it led
// to listed as untouched (`closing._argue_boundary`).
function demoArguePlan(_id: string, closed: Set<string>): ClosePlan {
  const root = { channel: 'argue', topic: 'argue-demo' }
  const key = 'topic:argue/argue-demo'
  const done = closed.has(key)
  const actions: CloseAction[] = [{
    kind: 'conversation', key, label: '#argue › argue-demo',
    state: done ? 'done' : 'ready', reason: done ? 'already ✔' : 'will be marked ✔ once everything above is done', detail: {},
  }]
  return {
    schema: 'ag.completion.v1', generated_at: Date.now() / 1000,
    topic: root.topic, channel: root.channel, root,
    scope: {
      root, kind: 'argue', closable: true, reason: '',
      description: '#argue › argue-demo, an argue: the discussion only. A project, study or plan it opened stays open, and so does the conversation it was opened from',
      parents: [], context: [], routine: null,
    },
    history: [],
    fingerprint: actions.map((one) => `${one.key}=${one.state}`).join('|'),
    status: { zulip_read: true, zulip_write: true, reason: '' },
    actions, counts: { ready: done ? 0 : 1, blocked: 0, done: done ? 1 : 0, kept: 0 }, blocked: [],
    excluded: [{ channel: 'pj-demo', topic: 'workplan-setup-demo', reason: 'what the argue ended in stays open: closing an argue ends the discussion and nothing it opened' }],
    gaps: { truncated: false, unread: [], bounded: [], errors: [] },
    results: [], note: 'this ends the discussion; a post here resumes it',
  }
}

function resultRow(action: CloseAction): Omit<CloseResult, 'outcome' | 'note'> {
  return { key: action.key, kind: action.kind, label: action.label }
}

function demoPlan(id: string, closed: Set<string>, _failed: boolean): ClosePlan {
  const make = (kind: CloseKind, key: string, label: string, state: CloseState, reason: string): CloseAction =>
    ({ kind, key, label, state: closed.has(key) ? 'done' : state, reason: closed.has(key) ? 'closed in this session' : reason, detail: {} })
  const actions: CloseAction[] = [
    make('work', 'work:demo-mission', 'G-13 Cover a new GitHub-trending repository', 'ready', 'every one of its 1 sub-works is completed'),
    make('work', 'work:demo-task', 'G-14 Pick and summarize a new trending repo', 'done', 'already Done; closing it again changes nothing'),
    make('work', 'work:demo-open', 'F2-31 Title картина, still rendering', 'blocked', '1 of 2 sub-works are not completed'),
    make('topic', 'topic:pj-ghtrends/workplan-trend6', '#pj-ghtrends › workplan-trend6', 'ready', 'will be marked ✔'),
    make('topic', DEMO_FLAKY, '#agforge-agstudio1 › assetrun-title', 'ready', 'will be marked ✔'),
    make('channel', 'channel:work-g-13', '#work-g-13', 'ready', 'will be archived — every one of its 1 topics belongs to this conversation'),
    make('channel', 'channel:work-g-9', '#work-g-9', 'kept', 'kept — the channel holds topics this conversation did not reach: workrun-task2-g-9'),
    make('conversation', `topic:front/front-desk-${id}`, `#front › front-desk-${id}`, 'ready', 'will be marked ✔ once everything above is done'),
  ]
  const counts = {
    ready: actions.filter((one) => one.state === 'ready').length,
    blocked: actions.filter((one) => one.state === 'blocked').length,
    done: actions.filter((one) => one.state === 'done').length,
    kept: actions.filter((one) => one.state === 'kept').length,
  }
  const root = { channel: 'front', topic: `front-desk-${id}` }
  return {
    schema: 'ag.completion.v1', generated_at: Date.now() / 1000,
    topic: root.topic, channel: root.channel, root,
    scope: {
      root, kind: 'desk', closable: true, reason: '',
      description: `Front Desk conversation ${id} and the work it opened`,
      parents: [], context: [], routine: null,
    },
    history: [],
    fingerprint: actions.map((one) => `${one.key}=${one.state}`).join('|'),
    status: { zulip_read: true, zulip_write: true, reason: '' },
    actions, counts, blocked: actions.filter((one) => one.state === 'blocked'),
    excluded: [{ channel: 'pj-ghtrends', topic: 'workplan-trend5', reason: 'anchored to another request (front/front-desk-20260907-0900)' }],
    gaps: { truncated: false, unread: [], bounded: [], errors: [] },
    results: [], note: 'this closes work; it does not stop a running agent',
  }
}


export function demoAdapter(room: RoomId, revision = 'demo'): RoomAdapter {
  const posts: RoomPost[] = []
  const renderings: Record<string, Rendering[]> = {}
  const failed: Presentation['failed'] = []
  const requests: Presentation['requests'] = []
  const born = new Map<number, number>()
  let next = 1
  let round = 0
  const channel = room === 'argue' ? 'argue' : 'front'
  const topic = room === 'argue' ? 'argue-demo' : 'front-desk-demo'
  const now = () => Date.now() / 1000

  const render = (post: RoomPost, line: Line, at: string, prefix = '') => {
    if (line.voiced === null) {
      (renderings[post.message_id] ??= []).push({
        settings_revision: at, renderer: 'demo/1', job: `j${post.message_id}-${at}`, stale: false, missing_sources: [],
        turns: [{ character: null, speaker: line.speaker, plain: true, sources: [{ channel, topic, message_id: post.message_id }] }],
        memo_message_ids: [], at: now(),
      })
      return
    }
    if (line.voiced.length === 0) {
      failed.push({ job: `j${post.message_id}-${at}`, messages: [post.message_id], settings_revision: at, error: 'the model is unavailable (demo)', attempts: 3, at: now() })
      return
    }
    (renderings[post.message_id] ??= []).push({
      settings_revision: at, renderer: 'demo/1', job: `j${post.message_id}-${at}`, stale: false, missing_sources: [],
      turns: line.voiced.map((text) => ({
        character: line.agent === 'front' ? 'front' : line.agent, speaker: line.speaker, text: `${prefix}${text}`,
        sources: [{ channel, topic, message_id: post.message_id }],
      })),
      memo_message_ids: [], at: now(),
    })
  }
  const lines = new Map<number, Line>()
  const say = (line: Line) => {
    const post: RoomPost = { message_id: next++, at: now(), by: line.by, sender_id: line.sender_id, content: line.text, kind: 'agent', agent: line.agent, speaker: line.speaker, meaning: line.meaning ?? null }
    posts.push(post)
    lines.set(post.message_id, line)
    born.set(post.message_id, now())
    // The rendering lands a few seconds after the speech, as it really does.
    window.setTimeout(() => render(post, line, revision), 4000)
  }
  // The relay's read model, in miniature: a reference settles what it
  // names; an unnamed post by the recipient settles the one pending request.
  const requestsOf = (): RoomRequests => {
    const rows: RequestRow[] = []
    const unmatched: Record<string, number[]> = {}
    for (const post of posts) {
      const meaning = post.meaning
      if (post.kind === 'human' && meaning?.answer !== 'none') {
        const mine = rows.filter((row) => row.to === post.sender_id && row.state === 'pending')
        const named = mine.filter((row) => meaning?.re?.includes(row.id))
        if (named.length) for (const row of named) Object.assign(row, { state: 'answered', settled_by: post.message_id, how: 'reference' })
        else if (mine.length === 1) Object.assign(mine[0], { state: 'answered', settled_by: post.message_id, how: 'next_post' })
        else if (mine.length > 1) unmatched[String(post.message_id)] = mine.map((row) => row.id)
      }
      if (meaning?.intent === 'response_request' && meaning.to !== undefined) {
        rows.push({ id: post.message_id, sender_id: post.sender_id, sender_name: post.by, to: meaning.to, to_name: 'Developer',
          ask: meaning.ask ?? null, text: post.content, timestamp: post.at, state: 'pending', settled_by: null, how: null,
          certain: true, overtaken_by: [] })
      }
    }
    if (demoResolved) for (const row of rows) if (row.state === 'pending') row.state = 'closed'
    return { requests: rows, pending: rows.filter((row) => row.state === 'pending').map((row) => row.id), unmatched, uncertain: [], closed: demoResolved }
  }
  const status = (): RoomStatus => {
    const last = posts[posts.length - 1]
    if (!last) return { state: 'quiet', since: null, evidence: 'no posts yet' }
    if (last.kind === 'human') return { state: 'waiting', since: last.at, evidence: 'the human spoke last' }
    if (last.kind === 'ack') return { state: 'received', since: last.at, evidence: 'Front acked and has not answered' }
    const pending = requestsOf().pending
    if (pending.length) return { state: 'asking', since: last.at, evidence: `${pending.length} request(s) pending` }
    return { state: 'answered', since: last.at, evidence: `${last.speaker} answered` }
  }
  const presentation = (): Presentation => {
    const agentPosts = posts.filter((post) => post.kind === 'agent')
    const failedIds = new Set(failed.filter((one) => one.settings_revision === revision).flatMap((one) => one.messages))
    // Waiting: at the active revision, and at every revision a re-voicing
    // asked for and has not got yet — so the paid button reads busy.
    const wanted = new Set([revision, ...requests.map((one) => one.settings_revision)])
    const pending = agentPosts
      .filter((post) => [...wanted].some((at) => !(renderings[post.message_id] ?? []).some((one) => one.settings_revision === at)
        && !(at === revision && failedIds.has(post.message_id))))
      .map((post) => ({ message_id: post.message_id, age_seconds: now() - (born.get(post.message_id) ?? now()), overdue: false }))
    const seen = new Map<string, number>()
    for (const list of Object.values(renderings)) for (const one of list) seen.set(one.settings_revision, (seen.get(one.settings_revision) ?? 0) + 1)
    return {
      anchor: 1, memo: { channel: 'memo', topic: `${topic}-s1` }, active_revision: revision,
      interpretations: [...seen.entries()].map(([settings_revision, results]) => ({ settings_revision, renderer: 'demo/1', results, posts: results, stale: 0, newest_at: now() })),
      renderings, pending, failed, refused: [], requests,
      renderer: pending.length ? { state: 'rendering', reason: `${pending.length} post(s) are waiting to be rendered` } : { state: 'idle', reason: 'everything is rendered or failed' },
    }
  }
  const detail = (key: string): RoomDetail => ({
    health: { state: 'live', reason: 'demo source, nothing here reaches the realm' },
    chat: { configured: true, reason: null, max_chars: 4000 },
    conversation: {
      key, channel, topic, live_topic: demoResolved ? `✔ ${topic}` : topic, resolved: demoResolved, known: 'held', bounded: false,
      posts: [...posts], status: demoResolved ? { state: 'done', since: null, evidence: 'the topic carries ✔' } : status(),
      zulip_url: null, presentation: presentation(), requests: requestsOf(), viewer_id: DEVELOPER,
    },
  })
  const answer = () => {
    window.setTimeout(() => {
      posts.push({ message_id: next++, at: now(), by: 'Front', sender_id: 15, content: 'Message received. Please wait for the reply.', kind: 'ack', agent: 'front', speaker: 'Front' })
      window.setTimeout(() => {
        const script = SCRIPT[Math.min(round, SCRIPT.length - 1)]
        round += 1
        // The specialists only speak in an argue; the desk hears Front alone.
        for (const line of script) if (room === 'argue' || line.agent === 'front') say(line)
      }, 2500)
    }, 800)
  }
  return {
    room, title: room === 'argue' ? 'ARGUING ROOM' : 'FRONT DESK', param: room === 'argue' ? 'argue' : 'conv',
    other: room === 'argue' ? { label: 'Front Desk ↗', href: '/?view=frontdesk&demo=1' } : { label: 'Arguing Room ↗', href: '/?view=argue&demo=1' },
    newKey: () => (room === 'argue' ? null : 'demo'),
    async list() {
      return posts.length || room === 'front' ? [{ key: 'demo', label: 'demo', resolved: demoResolved, asking: requestsOf().pending.length, last_post: posts.length ? { at: posts[posts.length - 1].at, by: posts[posts.length - 1].by } : null }] : []
    },
    async detail(key) { return detail(key) },
    async send(_key, text, _token, correlation) {
      posts.push({ message_id: next++, at: now(), by: 'Developer', sender_id: DEVELOPER, content: text, kind: 'human', agent: null, speaker: 'Developer',
        meaning: correlation?.kind === 'answer' ? { re: [correlation.id] } : correlation?.kind === 'none' ? { answer: 'none' } : null })
      const resumed = demoResolved
      demoResolved = false
      demoClosed.delete('topic:argue/argue-demo')
      answer()
      return { sent: true, message_id: next - 1, resumed }
    },
    create: room === 'argue' ? async (text) => {
      posts.push({ message_id: next++, at: now(), by: 'Developer', sender_id: 8, content: text, kind: 'human', agent: null, speaker: 'Developer' })
      answer()
      return { sent: true, message_id: next - 1, key: 'demo' }
    } : undefined,
    // Another interpretation: the same posts, a revision of its own, and
    // the earlier one kept.
    async render(_key, asked) {
      const at = asked && asked !== revision ? asked : `${revision}-again`
      requests.push({ message_id: next++, settings_revision: at, at: now() })
      window.setTimeout(() => {
        for (const post of posts) {
          const line = lines.get(post.message_id)
          if (line && !(renderings[post.message_id] ?? []).some((one) => one.settings_revision === at)) render(post, line, at, '【再解釈】')
        }
      }, 3000)
      return { sent: true, note: 'asked; earlier interpretations stay' }
    },
    completion: room === 'argue' ? {
      async closePlan(id) { return demoArguePlan(id, demoClosed) },
      async close(id, fingerprint) {
        const plan = demoArguePlan(id, demoClosed)
        if (fingerprint !== plan.fingerprint) {
          return { ...plan, refused: true, error: 'the targets have changed since this preview was made; nothing was closed' }
        }
        const results: CloseResult[] = plan.actions.map((action) => action.state === 'done'
          ? { ...resultRow(action), outcome: 'already', note: action.reason }
          : { ...resultRow(action), outcome: 'applied', note: 'is ✔' })
        demoClosed.add(plan.actions[0].key)
        demoResolved = true
        return { ...demoArguePlan(id, demoClosed), results, applied: true, partial: false }
      },
    } : room === 'front' ? {
      async closePlan(id) {
      return demoPlan(id, demoClosed, demoFailedOnce)
    },
      async close(id, fingerprint) {
      const plan = demoPlan(id, demoClosed, demoFailedOnce)
      if (fingerprint !== plan.fingerprint) {
        return { ...plan, refused: true, error: 'the targets have changed since this preview was made; nothing was closed' }
      }
      const results: CloseResult[] = []
      let trouble = false
      for (const action of plan.actions) {
        if (action.state === 'done') { results.push({ ...resultRow(action), outcome: 'already', note: action.reason }); continue }
        if (action.state !== 'ready') {
          trouble = trouble || action.state === 'blocked'
          results.push({ ...resultRow(action), outcome: 'skipped', note: action.reason })
          continue
        }
        if (action.key === DEMO_FLAKY && !demoFailedOnce) {
          demoFailedOnce = true
          trouble = true
          results.push({ ...resultRow(action), outcome: 'failed', note: 'ConnectionError: the realm refused the rename' })
          continue
        }
        if (action.kind === 'conversation' && trouble) {
          results.push({ ...resultRow(action), outcome: 'skipped', note: 'kept open: related work is still blocked or failed, and a ✔ here would say the whole thing is finished' })
          continue
        }
        demoClosed.add(action.key)
        results.push({
          ...resultRow(action), outcome: 'applied',
          note: action.kind === 'work' ? 'is Done'
            : action.kind === 'channel' ? 'is archived' : 'is ✔',
        })
      }
      const after = demoPlan(id, demoClosed, demoFailedOnce)
      return { ...after, results, applied: true, partial: results.some((one) => one.outcome === 'failed') || after.counts.blocked > 0 }
    },
    } : undefined,
    words: room === 'argue'
      ? { newButton: 'new argue', empty: 'A new argue (demo). State what you want in the bar below.', prompt: 'Say something in this argue…', resumed: '↩ resumed', done: '✔ resolved' }
      : { newButton: 'new conversation', empty: 'A new conversation (demo). Say something in the bar below.', prompt: 'Say something to Front…', resumed: '↩ reopened', done: '✔ resolved' },
  }
}
