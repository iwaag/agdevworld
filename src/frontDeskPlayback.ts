// The Front Desk's playback model: replies as ordered turns, and a cursor.
//
// A Front post is either a plain reply — one turn, spoken by Front — or a
// reply with a dialogue: the turns agfront validated, each spoken by a
// character of the settings revision the dialogue names. The scene plays one
// reply at a time, turn by turn, page by page; replies that arrive while
// the user is reading are queued behind the one on show, and the cursor
// says whether there is anything ahead. Nothing here reads the relay or
// draws: it is arithmetic over the posts the relay already classified.

import type { DeskCitation, DeskPost } from './frontDeskState'
import { linksIn, type FoundLink } from './textLayout'

export interface PlayTurn {
  // A character id of the reply's revision, or null when the line is
  // Front's plain reply (drawn as Front whatever the revision calls it).
  character: string | null
  text: string
  sources: DeskCitation[]
}

export interface PlayReply {
  message_id: number
  at: number
  // The settings revision the dialogue was written for; null for a plain
  // reply, which is drawn with whatever settings are current.
  revision: string | null
  turns: PlayTurn[]
  // The readable reply, kept for the links it carries and for the history
  // of a reply whose scene was unusable.
  content: string
  links: FoundLink[]
  error: string | null
  scene: boolean
}

export function replyOf(post: DeskPost): PlayReply {
  const dialogue = post.dialogue ?? null
  const scene = Boolean(dialogue && dialogue.turns.length > 0)
  const turns: PlayTurn[] = scene
    ? dialogue!.turns.map((turn) => ({ character: turn.character, text: turn.text, sources: turn.sources ?? [] }))
    : [{ character: null, text: post.content, sources: [] }]
  return {
    message_id: post.message_id, at: post.at,
    revision: scene ? dialogue!.settings_revision || null : null,
    turns, content: post.content, links: linksIn(post.content),
    error: post.dialogue_error ?? null, scene,
  }
}

export function repliesOf(posts: DeskPost[]): PlayReply[] {
  return posts.filter((post) => post.kind === 'agent').map(replyOf)
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
// re-read, an unknown relay) keeps the nearest one.
export function settle(cursor: Cursor, replies: PlayReply[], shownId: number | null): Cursor {
  if (replies.length === 0) return START
  if (shownId === null) return { reply: replies.length - 1, turn: 0, page: 0 }
  const found = replies.findIndex((reply) => reply.message_id === shownId)
  if (found >= 0) return { ...cursor, reply: found }
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

export function citation(source: DeskCitation): string {
  return `#${source.channel} › ${source.topic}${source.message_id !== null && source.message_id !== undefined ? ` #${source.message_id}` : ''}`
}
