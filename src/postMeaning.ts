// What a post is for, in words and an icon — one place for every surface.
//
// `clearer_chat_ui` step 3. A post says itself whether it is progress, a
// report, or a request for somebody's answer (`ag.post.v1`); the relay reads
// that from the post and says where each request stands now
// (`ag.outstanding.v1`). This file only turns those two facts into a label:
// it never looks at the words of a post, so a question asked in prose and a
// rewritten line of character dialogue are never reclassified here.
//
// Two things are kept apart on purpose. The **intent** is the post's own and
// never changes — an old question is still labelled a question. The
// **state** is the conversation's now — answered, withdrawn, still pending —
// so an old question in the history never looks like one waiting for you.
// Colour follows the tone, but every label also carries an icon and words:
// colour alone is not the signal.

import type { PostMeaning, RequestRow, RoomRequests } from './roomState'

export type LabelTone =
  | 'progress'      // work under way: restrained
  | 'report'        // information or a result
  | 'ask-you'       // a request pending for the person looking at the screen
  | 'ask-other'     // a request pending for somebody else
  | 'held'          // overtaken: their newer post is being read first
  | 'settled'       // a request that no longer waits (answered, withdrawn…)
  | 'answer'        // a post that names the request it answers

export interface PostLabel {
  icon: string
  text: string
  tone: LabelTone
}

export interface LabelStyle { color: string; background: string | null; bold: boolean }

export const LABEL_STYLE: Record<LabelTone, LabelStyle> = {
  progress: { color: '#7d8199', background: null, bold: false },
  report: { color: '#9fe6c1', background: null, bold: false },
  'ask-you': { color: '#0d0f14', background: '#ffc56d', bold: true },
  'ask-other': { color: '#ffc56d', background: null, bold: false },
  held: { color: '#b9bdd6', background: null, bold: false },
  settled: { color: '#7d8199', background: null, bold: false },
  answer: { color: '#70c7ff', background: null, bold: false },
}

function kindOf(ask: string | null | undefined): string {
  return ask === 'confirmation' ? 'confirmation' : 'question'
}

export function requestOf(requests: RoomRequests | null | undefined, id: number): RequestRow | null {
  return requests?.requests.find((row) => row.id === id) ?? null
}

// The label of one post, or null for an unclassified one.
export function labelOf(
  messageId: number,
  meaning: PostMeaning | null | undefined,
  requests: RoomRequests | null | undefined,
  viewer: number | null | undefined,
): PostLabel | null {
  if (!meaning || meaning.error) return null
  const answers = meaning.re?.length ? `answers ${meaning.re.map((id) => `#${id}`).join(', ')}`
    : meaning.answer === 'none' ? 'not an answer' : ''
  if (meaning.intent === 'progress') return { icon: '⏳', text: answers ? `progress · ${answers}` : 'progress', tone: 'progress' }
  if (meaning.intent === 'report') return { icon: '📄', text: answers ? `report · ${answers}` : 'report', tone: 'report' }
  if (meaning.intent === 'response_request') {
    const row = requestOf(requests, messageId)
    const kind = kindOf(meaning.ask)
    const forYou = viewer !== null && viewer !== undefined && meaning.to === viewer
    const who = forYou ? 'you' : row?.to_name || `user ${meaning.to}`
    switch (row?.state) {
      case 'answered':
        return { icon: '❓', text: `${kind} for ${who} · answered${row.settled_by ? ` in #${row.settled_by}` : ''}${row.certain ? '' : ' (probably)'}`, tone: 'settled' }
      case 'withdrawn':
        return { icon: '❓', text: `${kind} for ${who} · withdrawn`, tone: 'settled' }
      case 'superseded':
        return { icon: '❓', text: `${kind} for ${who} · replaced by #${row.settled_by}`, tone: 'settled' }
      case 'closed':
        return { icon: '❓', text: `${kind} for ${who} · unanswered when the conversation was closed`, tone: 'settled' }
      case 'overtaken':
        return { icon: '❓', text: `${kind} for ${who} · asked before your newer post was read`, tone: 'held' }
      default:
        // Pending, or the relay could not say (no request rows): the post
        // still says what it is, and "waiting" is claimed only when known.
        return forYou
          ? { icon: '❓', text: `${kind.toUpperCase()} FOR YOU${row ? ' · waiting for your reply' : ''}`, tone: 'ask-you' }
          : { icon: '❓', text: `${kind} for ${who}${row ? ' · waiting for their reply' : ''}`, tone: 'ask-other' }
    }
  }
  if (meaning.answer === 'none') return { icon: '↷', text: 'not an answer', tone: 'settled' }
  if (answers) return { icon: '↩', text: answers, tone: 'answer' }
  return null
}

// The requests waiting for the person looking at the screen, oldest first.
export function pendingFor(requests: RoomRequests | null | undefined, viewer: number | null | undefined): RequestRow[] {
  if (!requests || viewer === null || viewer === undefined) return []
  return requests.requests.filter((row) => row.state === 'pending' && row.to === viewer)
}

// Requests held back because the viewer spoke after the asker last read.
export function overtakenFor(requests: RoomRequests | null | undefined, viewer: number | null | undefined): RequestRow[] {
  if (!requests || viewer === null || viewer === undefined) return []
  return requests.requests.filter((row) => row.state === 'overtaken' && row.to === viewer)
}

export function shortText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}
