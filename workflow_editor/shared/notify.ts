// Zulip coordination (p5): names and message text. Pure — the outbox,
// bindings and links are server/notify.ts; the transport is autolab's.
//
//   channel folder  ←  project      wf-<project>
//   channel         ←  workflow     wf-<project>.<workflow>
//   topic           ←  run          <run id>
//
// Names are labels: identity is the recorded Zulip id. The `wf-` prefix is
// distinct from the legacy autolab surfaces (`pj-<slug>` project channels,
// `work-m<id>` mission channels, agent instance channels), and run topics
// (`run-…`) match no listener's sweep prefix, so nothing here is served by
// a legacy listener. Messages never mention anyone.
import type { NotableEvent } from './run.ts'

export const NAME_MAX = 60 // Zulip's channel, folder and topic name limit
export const MESSAGE_BUDGET = 900 // characters; coordination stays short
export const DELAYED_AFTER_MS = 15 * 60 * 1000

// FNV-1a, 32 bit: a short stable suffix when a name has to be cut.
function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

// A name within the limit; a cut name keeps a hash of the whole, so two
// long identities never meet in one label.
export function fitName(full: string, max = NAME_MAX): string {
  return full.length <= max ? full : `${full.slice(0, max - 7)}~${shortHash(full)}`
}
export const folderName = (project: string) => fitName(`wf-${project}`)
export const channelName = (project: string, workflow: string) => fitName(`wf-${project}.${workflow}`)
export const topicName = (run: string) => fitName(run)

// Descriptions carry the identity in words. They are how a channel this
// integration created but did not record (a crash between the two) is
// recognized again — never its name alone.
export const folderDescription = (project: string, label: string) =>
  `[wfe] project ${project}${label && label !== project ? ` (${label})` : ''}: one channel per workflow, one topic per run.`
export const channelDescription = (project: string, workflow: string) =>
  `[wfe] project ${project} · workflow ${workflow}: one topic per run; details in devdocs/runs/${workflow}/.`
export function ownsDescription(kind: 'folder' | 'channel', description: string, project: string, workflow?: string): boolean {
  return kind === 'folder'
    ? description.startsWith(`[wfe] project ${project}:`) || description.startsWith(`[wfe] project ${project} (`)
    : description.startsWith(`[wfe] project ${project} · workflow ${workflow}:`)
}

// ---- messages ----------------------------------------------------------------------------

export interface DocLink { path: string; name: string; url?: string; commit?: string } // url only when published
export interface RenderContext {
  ref: string // <workflow>/<run>
  executor: string
  request?: string // the first line of the person's words
  answerRoute: (question: string) => string // where a question is answered (a link, or words when no remote URL is configured)
  runLink?: string // the run view, when a reachable URL is configured
  link(path: string): DocLink
  label(node: string): string // an authored node's display name
  openQuestion(id: string): boolean // still open or answered-not-taken-up now
  now: Date
  next?: string // the next action as the record states it now (ready / waiting)
  person?: string // who decides the result
}

const cut = (text: string, n: number) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t }
const firstLine = (text: string) => text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
const docText = (d: DocLink) => (d.url ? `[${d.name}](${d.url})` : d.commit ? `${d.name} (published at ${d.commit.slice(0, 7)}; no web link for its repository)` : `${d.name} (not yet published: only on the execution host)`)
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16) + ' UTC'

// One event: its lines, the free text kept apart so the budget can shorten it.
function lines(e: NotableEvent, c: RenderContext): { head: string; free: string; tail: string[] } {
  const node = e.node ? c.label(e.node) : ''
  const doc = e.document ? docText(c.link(e.document)) : ''
  switch (e.type) {
    case 'started': return { head: `**Started** — ${c.executor} took up the request${c.request ? ':' : '.'}`, free: c.request ? `“${c.request}”` : '', tail: c.next ? [`Next: ${c.next}`] : [] }
    case 'question': {
      const stale = e.question && !c.openQuestion(e.question)
      return {
        head: `**Question for ${e.holder}**${e.step === '_plan' ? ' — agree to the plan' : node ? ` — ${node}` : ''} (${e.question})${stale ? ' — already answered or closed; no action needed' : ''}`,
        free: firstLine(e.text) === e.text.trim() ? e.text.trim() : e.text.trim().replace(/\n+/g, ' / '),
        tail: [...(doc ? [`${e.step === '_plan' ? 'Plan' : 'Document'}: ${doc}`] : []), ...(stale ? [] : [`Answer: ${c.answerRoute(e.question ?? '')}`])],
      }
    }
    case 'answered': return { head: `**Answered** — ${e.question} by ${e.by}; ${c.executor} resumes with it.`, free: '', tail: [] }
    case 'reported': return { head: `**Report — ${node}:**`, free: e.text, tail: [...(doc ? [`Details: ${doc}`] : []), ...(c.next ? [`Next: ${c.next}`] : [])] }
    case 'node-completed': return { head: `**Done — ${node}:**`, free: e.text, tail: c.next ? [`Next: ${c.next}`] : [] }
    case 'failed': return { head: `**Failed — ${node || e.step}:**`, free: e.text, tail: [`Next: ${c.person ?? 'the person'} looks at the run, then resumes or cancels it.`] }
    case 'held': {
      const what = e.hold === 'stopped' ? 'Stopped' : e.hold === 'interrupted' ? 'Interrupted' : 'Execution lost (unknown)'
      return { head: `**${what}** — nothing runs until it is resumed.`, free: e.text, tail: [`Next: ${c.person ?? 'the person'} looks at the working tree and resumes in agdevworld${e.hold === 'stopped' ? ' when ready' : ''}.`] }
    }
    case 'resumed': return { head: `**Resumed** by ${e.by}:`, free: e.text, tail: [] }
    case 'completed': return {
      head: '**Execution completed**' + (e.step ? ' — final report written.' : '.'),
      free: e.text,
      tail: [...(doc ? [`Report: ${doc}`] : []), `Not accepted yet: ${c.person ?? 'the person'} reviews the result and decides.`],
    }
    case 'decided': return { head: `**Result ${e.decision}** by ${e.by}.`, free: e.text ? `Evidence: ${e.text}` : '', tail: [] }
    case 'cancelled': return { head: `**Run cancelled** by ${e.by}:`, free: e.text, tail: [] }
  }
}

// The last line of a message: which run and entries it carries. Searching a
// topic for it tells whether a send whose answer was lost did post.
export const messageMarker = (ref: string, events: Pick<NotableEvent, 'seq' | 'type'>[]) => `ref ${ref}${events.map(e => ` #${e.seq}:${e.type}`).join('')}`

// Renders one message for one event or several adjacent routine events of
// one run. The marker line names the run and the entries, so a message
// whose sending was uncertain can be found again before retrying.
export function renderMessage(events: NotableEvent[], c: RenderContext, extra: { delayedFrom?: string } = {}): string {
  const parts = events.map(e => lines(e, c))
  const marker = messageMarker(c.ref, events)
  const fixed = [
    ...(extra.delayedFrom ? ['_Delayed: recorded YYYY-MM-DD HH:MM UTC; the run may have moved on._'] : []),
    ...parts.flatMap(p => [p.head, ...p.tail]),
    ...(c.runLink ? [`Run: ${c.runLink}`] : []),
    marker,
  ].join('\n')
  // The free texts share what the budget leaves; actionable lines stay whole.
  const room = Math.max(60, MESSAGE_BUDGET - fixed.length)
  const each = Math.floor(room / Math.max(1, parts.filter(p => p.free).length))
  const body: string[] = []
  if (extra.delayedFrom) body.push(`_Delayed: recorded ${when(extra.delayedFrom)}; the run may have moved on._`)
  for (const p of parts) body.push(p.free ? `${p.head} ${cut(p.free, each)}` : p.head, ...p.tail)
  if (c.runLink) body.push(`Run: ${c.runLink}`)
  body.push(marker)
  return body.join('\n')
}

// Publication updates: details that were not yet published when a message
// referred to them, now readable at a commit.
export function renderPublished(ref: string, docs: DocLink[], commit: string): string {
  return [`**Details published** at ${commit.slice(0, 7)}: ${docs.map(docText).join(', ')}`, `ref ${ref} published ${commit.slice(0, 7)}`].join('\n')
}

export function renderPublication(ref: string, state: 'failed' | 'attention' | 'recovered', detail: string, checkpoint: number): string {
  if (state === 'recovered') return [`**Publication recovered** — the run's records and artifacts are published (checkpoint ${checkpoint}).`, `ref ${ref} cp${checkpoint}:recovered`].join('\n')
  return [
    `**Publication ${state === 'failed' ? 'failed' : 'needs a person'}** (checkpoint ${checkpoint}): ${cut(detail, 300)}`,
    'The work is recorded on the execution host; links stay unpublished until this is resolved. Retry in agdevworld (run view → Retry publication) or `wfe exec publish ' + checkpoint + '`.',
    `ref ${ref} cp${checkpoint}:${state}`,
  ].join('\n')
}

// Hash-encoded Zulip narrow for a topic.
export function topicUrl(base: string, streamId: number, channel: string, topic: string): string {
  const enc = (t: string) => encodeURIComponent(t).replace(/\./g, '%2E').replace(/%/g, '.')
  return `${base.replace(/\/$/, '')}/#narrow/channel/${streamId}-${enc(channel)}/topic/${enc(topic)}`
}
