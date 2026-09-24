// A room's playback model: agent posts as ordered turns, and a cursor.
//
// Every agent post of the source conversation is one *reply* to page
// through — Front's, and in an argue every specialist's. What its turns are
// depends on the view (`argue` p2):
//
// - **original** — one turn: the post as it was written, under its speaker.
// - **dialogue** — the turns of a saved interpretation of that post, each
//   spoken by a character of the settings revision the interpretation names
//   and citing the posts it re-voices. A post with no usable interpretation
//   (not rendered yet, failed, a speaker without a character) falls back to
//   the original turn and says why, so the reader never waits for a
//   rendering to read what an agent said.
//
// The scene plays one reply at a time, turn by turn, page by page; replies
// that arrive while the user is reading are queued behind the one on show.
// Nothing here reads the relay or draws: it is arithmetic over what the relay
// already said.

import type { Citation, PostMeaning, Presentation, Rendering, RoomPost } from './roomState'
import { linksIn, type FoundLink } from './textLayout'

export type ViewMode = 'dialogue' | 'original'

// Why a reply is shown the way it is.
export type ReplyState = 'rendered' | 'stale' | 'original' | 'pending' | 'overdue' | 'failed' | 'unrendered'

export interface PlayTurn {
  // A character id of the reply's revision, or null when the line is the
  // post as written (drawn with the speaker's own face, when it has one).
  character: string | null
  text: string
  sources: Citation[]
  speaker: string
  agent: string | null
}

export interface PlayReply {
  message_id: number
  at: number
  // The settings revision the turns were written for; null for the post as
  // written, which is drawn with whatever settings are current.
  revision: string | null
  turns: PlayTurn[]
  content: string
  links: FoundLink[]
  state: ReplyState
  note: string | null
  speaker: string
  agent: string | null
  // What the source post says it is for. A rendering inherits it from the
  // post it re-voices and never decides it from its own words.
  meaning: PostMeaning | null
}

// Which interpretation of a post is shown: the one asked for; else the
// active revision's; else the newest there is. A stale one is still shown —
// marked — because an edited post's old rendering is better than none.
export function renderingOf(renderings: Rendering[] | undefined, wanted: string | null, active: string | null): Rendering | null {
  if (!renderings || renderings.length === 0) return null
  const newestOf = (revision: string | null) => [...renderings].reverse().find((one) => one.settings_revision === revision) ?? null
  if (wanted) return newestOf(wanted)
  return newestOf(active) ?? renderings[renderings.length - 1]
}

function original(post: RoomPost): PlayTurn {
  return { character: null, text: post.content, sources: [], speaker: post.speaker, agent: post.agent }
}

export function replyOf(post: RoomPost, presentation: Presentation | null, mode: ViewMode, wanted: string | null): PlayReply {
  const base = {
    message_id: post.message_id, at: post.at, content: post.content, links: linksIn(post.content),
    speaker: post.speaker, agent: post.agent, meaning: post.meaning ?? null,
  }
  if (mode === 'original' || !presentation) {
    return { ...base, revision: null, turns: [original(post)], state: 'original', note: null }
  }
  const found = renderingOf(presentation.renderings[String(post.message_id)], wanted, presentation.active_revision)
  const voiced = found?.turns.filter((turn) => !turn.plain && turn.character && turn.text) ?? []
  if (found && voiced.length > 0) {
    return {
      ...base, revision: found.settings_revision,
      turns: voiced.map((turn) => ({
        character: turn.character, text: turn.text ?? '', sources: turn.sources ?? [],
        speaker: turn.speaker ?? post.speaker, agent: post.agent,
      })),
      state: found.stale ? 'stale' : 'rendered',
      note: found.stale ? 'the post changed after this was rendered' : null,
    }
  }
  if (found) {
    // Rendered, and the speaker has no character in that revision.
    return { ...base, revision: null, turns: [original(post)], state: 'unrendered', note: `${post.speaker} has no character in settings ${found.settings_revision.slice(0, 12)}` }
  }
  const failed = presentation.failed.find((one) => one.messages.includes(post.message_id)
    && (!wanted || one.settings_revision === wanted))
  if (failed) return { ...base, revision: null, turns: [original(post)], state: 'failed', note: `rendering failed: ${failed.error}` }
  const pending = presentation.pending.find((one) => one.message_id === post.message_id)
  if (pending && !wanted) {
    return {
      ...base, revision: null, turns: [original(post)], state: pending.overdue ? 'overdue' : 'pending',
      note: pending.overdue ? 'not rendered — the renderer is slow, off or down' : 'being rendered…',
    }
  }
  return { ...base, revision: null, turns: [original(post)], state: 'unrendered', note: wanted ? `no rendering at settings ${wanted.slice(0, 12)}` : 'no rendering' }
}

export function repliesOf(posts: RoomPost[], presentation: Presentation | null, mode: ViewMode, wanted: string | null): PlayReply[] {
  return posts.filter((post) => post.kind === 'agent' || post.kind === 'other').map((post) => replyOf(post, presentation, mode, wanted))
}

export interface Cursor {
  reply: number
  turn: number
  page: number
}

export const START: Cursor = { reply: -1, turn: 0, page: 0 }

// Where the cursor lands when the replies change: a first load jumps to the
// newest reply; afterwards the reply on show stays on show and anything
// newer queues behind it. A reply that vanished (a resolved conversation
// re-read, an unknown relay) keeps the nearest one. A reply whose turns
// changed under the reader (its rendering arrived) keeps its place, clamped.
export function settle(cursor: Cursor, replies: PlayReply[], shownId: number | null): Cursor {
  if (replies.length === 0) return START
  if (shownId === null) return { reply: replies.length - 1, turn: 0, page: 0 }
  const found = replies.findIndex((reply) => reply.message_id === shownId)
  if (found >= 0) {
    const turn = Math.min(cursor.turn, replies[found].turns.length - 1)
    return { reply: found, turn, page: turn === cursor.turn ? cursor.page : 0 }
  }
  const nearest = replies.findIndex((reply) => reply.message_id > shownId)
  return { reply: nearest >= 0 ? Math.max(0, nearest - 1) : replies.length - 1, turn: 0, page: 0 }
}

export function queuedAfter(cursor: Cursor, replies: PlayReply[]): number {
  return cursor.reply < 0 ? 0 : Math.max(0, replies.length - 1 - cursor.reply)
}

// One step forward or back through pages, then turns, then replies.
// `pagesOf(reply, turn)` is how many pages that turn wraps to on screen.
export function step(
  cursor: Cursor, replies: PlayReply[], delta: 1 | -1, pagesOf: (reply: number, turn: number) => number,
): Cursor {
  if (cursor.reply < 0 || replies.length === 0) return cursor
  const turns = replies[cursor.reply].turns.length
  if (delta > 0) {
    if (cursor.page < pagesOf(cursor.reply, cursor.turn) - 1) return { ...cursor, page: cursor.page + 1 }
    if (cursor.turn < turns - 1) return { ...cursor, turn: cursor.turn + 1, page: 0 }
    if (cursor.reply < replies.length - 1) return { reply: cursor.reply + 1, turn: 0, page: 0 }
    return cursor
  }
  if (cursor.page > 0) return { ...cursor, page: cursor.page - 1 }
  if (cursor.turn > 0) return { ...cursor, turn: cursor.turn - 1, page: pagesOf(cursor.reply, cursor.turn - 1) - 1 }
  if (cursor.reply > 0) {
    const previous = replies[cursor.reply - 1]
    const lastTurn = previous.turns.length - 1
    return { reply: cursor.reply - 1, turn: lastTurn, page: pagesOf(cursor.reply - 1, lastTurn) - 1 }
  }
  return cursor
}

export function atEnd(cursor: Cursor, replies: PlayReply[], pagesOf: (reply: number, turn: number) => number): boolean {
  if (cursor.reply < 0) return true
  const reply = replies[cursor.reply]
  return cursor.turn >= reply.turns.length - 1 && cursor.page >= pagesOf(cursor.reply, cursor.turn) - 1
}

export function citation(source: Citation): string {
  return `#${source.channel} › ${source.topic}${source.message_id !== null && source.message_id !== undefined ? ` #${source.message_id}` : ''}`
}
