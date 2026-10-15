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

export interface DocLink { path: string; name: string; url?: string; raw?: string; commit?: string } // url (view) and raw (download) only when published
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
  // p6: which conversation the message is for. The request topic is where
  // the person talks with the agent; the run topic carries progress.
  conversation?: 'request' | 'run'
  requestTopic?: string // a link to the run's request topic, when it has one
  runTopic?: string // a link to the run's progress topic
  decision?: { decision: 'accepted' | 'rejected'; by: string; question?: string; from?: string } // the latest result decision now
  // p7: where a presentation is served now (resolved from this host's
  // state; `local`: the address opens only on the execution host), and
  // which presentations are still open (cleanup pending).
  presentation?: (id: string) => { url: string; local: boolean; live: boolean } | null
  openPresentations?: string[]
}

const cut = (text: string, n: number) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t }
const firstLine = (text: string) => text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
const TEXT_LIKE = /\.(md|txt|json|ya?ml|csv|html?|py|js|ts|svg)$/i
const docText = (d: DocLink) => (d.url ? (d.raw && !TEXT_LIKE.test(d.name) ? `[${d.name}](${d.raw}) ([view](${d.url}))` : `[${d.name}](${d.url})`) : d.commit ? `${d.name} (published at ${d.commit.slice(0, 7)}; no web link for its repository)` : `${d.name} (not yet published: only on the execution host)`)
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16) + ' UTC'

// One event: its lines, the free text kept apart so the budget can shorten it.
function lines(e: NotableEvent, c: RenderContext): { head: string; free: string; tail: string[] } {
  const node = e.node ? c.label(e.node) : ''
  const doc = e.document ? docText(c.link(e.document)) : ''
  const subject = e.subject?.length ? e.subject.map(p => docText(c.link(p))).join(', ') : ''
  const inRequest = c.conversation === 'request'
  switch (e.type) {
    case 'accepted': return { head: `**Request received** — ${c.executor} performs it as run ${c.ref}.`, free: '', tail: [...(c.runTopic ? [`Progress: ${c.runTopic}`] : []), ...(c.next ? [`Next: ${c.next}`] : []), 'Reply here: answers to questions, further instructions.'] }
    case 'started': return { head: `**Started** — ${c.executor} took up the request${c.request ? ':' : '.'}`, free: c.request ? `“${c.request}”` : '', tail: [...(c.requestTopic ? [`Request and conversation: ${c.requestTopic}`] : []), ...(c.next ? [`Next: ${c.next}`] : [])] }
    case 'presented': {
      const at = e.presentation ? c.presentation?.(e.presentation) : null
      const where = at ? (at.live ? `[Open the review](${at.url})${at.local ? ' — opens on the execution host (this address is local to it)' : ''}` : `no longer served (${at.url} was its address)`) : 'its address is not known on this host'
      return { head: `**Ready for review — ${e.title ?? e.presentation}** (${e.presentation}): the result and what to check, on one screen.`, free: '', tail: [where, `Your answer goes ${inRequest ? 'here' : 'to the question that follows'}; the review screen says where.`] }
    }
    case 'adjusted': return { head: `**Plan adjusted** (${e.revision}) by ${e.by}${e.adjusted?.added.length ? ` — added ${e.adjusted.added.map(c.label).join(', ')}` : ''}${e.adjusted?.removed.length ? `${e.adjusted?.added.length ? ';' : ' —'} removed ${e.adjusted.removed.map(c.label).join(', ')}` : ''}:`, free: e.text, tail: c.next ? [`Next: ${c.next}`] : [] }
    case 'cleanup-failed': return { head: `**Cleanup failed — presentation ${e.presentation}** could not be verified as stopped:`, free: e.text, tail: [`Next: retry with \`wfe present stop ${c.ref} --all\` on the execution host; the result decision stands.`] }
    case 'question': {
      const stale = e.question && !c.openQuestion(e.question)
      return {
        head: `**Question for ${e.holder}**${e.step === '_plan' ? ' — agree to the plan' : e.confirms ? ' — confirm the result' : node ? ` — ${node}` : ''} (${e.question})${stale ? ' — already answered or closed; no action needed' : ''}`,
        free: firstLine(e.text) === e.text.trim() ? e.text.trim() : e.text.trim().replace(/\n+/g, ' / '),
        tail: [...(doc ? [`${e.step === '_plan' ? 'Plan' : 'Document'}: ${doc}`] : []), ...(subject ? [`Deliverables: ${subject}`] : []),
          ...(e.presentation ? [(p => `Review: ${p ? (p.live ? `[presentation ${e.presentation}](${p.url})${p.local ? ' (opens on the execution host)' : ''}` : `presentation ${e.presentation} is no longer served`) : `presentation ${e.presentation}`}`)(c.presentation?.(e.presentation) ?? null)] : []),
          ...(stale ? [] : [`Answer: ${c.answerRoute(e.question ?? '')}`])],
      }
    }
    case 'answered': return inRequest
      ? { head: `**Recorded** as your answer to ${e.question}. ${c.executor} reads it when it resumes (recorded, not yet read).`, free: '', tail: [] }
      : { head: `**Answered** — ${e.question} by ${e.by}; ${c.executor} resumes with it.`, free: '', tail: [] }
    case 'instructed': return { head: `**Instruction recorded** (${e.instructions?.join(', ')}) — ${c.executor} reads it at its next step; nothing running is interrupted.`, free: inRequest ? '' : e.text, tail: [] }
    case 'acknowledged': return { head: `**Instruction taken up** (${e.instructions?.join(', ')}: ${e.response === 'incorporate' ? 'it will be followed' : e.response === 'clarify' ? 'a question follows' : 'it needs a new request'}) —`, free: e.text, tail: [] }
    case 'notice': return { head: e.text, free: '', tail: [] }
    case 'reported': return { head: `**Report — ${node}:**`, free: e.text, tail: [...(doc ? [`Details: ${doc}`] : []), ...(c.next ? [`Next: ${c.next}`] : [])] }
    case 'node-completed': return { head: `**Done — ${node}:**`, free: e.text, tail: c.next ? [`Next: ${c.next}`] : [] }
    case 'failed': return { head: `**Failed — ${node || e.step}:**`, free: e.text, tail: [`Next: ${c.person ?? 'the person'} looks at the run, then resumes or cancels it.`] }
    case 'held': {
      const what = e.hold === 'stopped' ? 'Stopped' : e.hold === 'interrupted' ? 'Interrupted' : 'Execution lost (unknown)'
      // Who stopped it and on whose words (p9); a hold keeps the run's work and reserves nothing.
      const who = e.heldBy ? ` by ${e.heldBy}${e.because ? `, on ${e.because.from}'s ${e.because.kind === 'answer' ? `answer to ${e.because.question}` : `instruction ${e.because.instruction}`}` : ''}` : ''
      return { head: `**${what}**${who} — its plan and work are kept; nothing of it runs until it is resumed. Other requests in the project can run meanwhile.`, free: e.text, tail: [`Next: ${c.person ?? 'the person'} looks at the run and resumes it in agdevworld${e.hold === 'stopped' ? ' when ready' : ''}.`] }
    }
    case 'resumed': return { head: `**Resumed** by ${e.by}:`, free: e.text, tail: [] }
    case 'completed': return {
      head: '**Execution completed**' + (e.step ? ' — final report written.' : '.'),
      free: e.text,
      tail: [...(doc ? [`Report: ${doc}`] : []),
        c.decision ? `Result ${c.decision.decision}${c.decision.question ? ` by ${c.decision.from ?? c.person ?? 'the person'}'s answer to ${c.decision.question}` : ` by ${c.decision.by}`} (a separate record from this completion).`
          : `Not accepted yet: ${c.person ?? 'the person'} reviews the result and decides.`,
        ...(inRequest ? ['This request is complete; a new request needs a new request topic.'] : [])],
    }
    case 'decided': return e.confirmation
      ? { head: `**Result ${e.decision}** — ${e.confirmation.from}'s answer to ${e.confirmation.question}, recorded by ${e.by}.`, free: '', tail: [...(subject ? [`Confirmed: ${subject}`] : []), ...(e.presentation ? [`Confirmed: presentation ${e.presentation}, the revision it showed.`] : []), ...(c.openPresentations?.length ? [`Cleanup pending: presentation ${c.openPresentations.join(', ')} still served; the run completes after it is stopped.`] : [])] }
      : { head: `**Result ${e.decision}** by ${e.by}.`, free: e.text ? `Evidence: ${e.text}` : '', tail: [] }
    case 'cancelled': return { head: `**Run cancelled** by ${e.by}:`, free: e.text, tail: [] }
    case 'integrated': return { head: '**Integrated** — the accepted result is on the project\'s shared branches:', free: e.text, tail: [] }
    // p10: this run entrusted a node's work to another workflow, and what came back.
    case 'delegated': return { head: `**Delegated** — ${node} to ${e.holder} (${e.delegation}); the request is posted in that workflow's channel.`, free: '', tail: c.next ? [`Next: ${c.next}`] : [] }
    case 'delegation': return { head: `**${e.holder} — ${e.delegationEvent === 'completed' ? 'result delivered' : e.delegationEvent === 'failed' ? 'failure' : 'cancelled'}** for ${node} (${e.delegation}):`, free: e.text, tail: [`Next: ${c.executor} reviews it.`] }
  }
}

// ---- delegation posts (p10, docs/delegation.md) ---------------------------------------------

// Bot posts carry text agents and tools wrote: a mention in it must not
// notify anyone or serve a listener. A zero-width space breaks the syntax
// (`@**name**`, `@_**name**`, `@*group*`) and leaves it readable.
export const quietMentions = (text: string) => text.replace(/@(_?\*)/g, '@\u200b$1')
export const DELEGATION_POST_MAX = 8000
export interface DelegationPost {
  kind: 'request' | 'answer' | 'instruction'
  from: string // whose words
  by: string // who sent them (the parent's agent)
  text: string
  question?: string
  parent: string // <project>/<workflow>/<run>, node
  node: string
  onBehalfOf?: string | null
  parentLink?: string
  marker: string
}
export function renderDelegationPost(p: DelegationPost): string {
  const body = quietMentions(p.text.length > DELEGATION_POST_MAX ? `${p.text.slice(0, DELEGATION_POST_MAX)}\n\n_…cut here; the whole text is the run's ${p.kind === 'request' ? 'request.md' : 'record'}._` : p.text.trim())
  const relayed = p.from !== p.by ? ` (${p.from}'s words, relayed by ${p.by})` : ''
  const head = p.kind === 'request'
    ? `**Request from ${p.by}**${p.onBehalfOf ? ` for ${p.onBehalfOf}` : ''} — delegated by ${p.parent} (node ${p.node}).`
    : p.kind === 'answer' ? `**${p.question}: answer from ${p.from}**${relayed}` : `**Instruction from ${p.from}**${relayed}`
  return [head, '', body, '', ...(p.parentLink ? [`Delegating run: ${p.parentLink}`] : []), 'Questions here reach the requesting run; its agent answers here.', p.marker].join('\n')
}

// The last line of a message: which run and entries it carries. Searching a
// topic for it tells whether a send whose answer was lost did post.
export const messageMarker = (ref: string, events: Pick<NotableEvent, 'seq' | 'type'>[]) => `ref ${ref}${events.map(e => ` #${e.seq}:${e.type}`).join('')}`

// Renders one message for one event or several adjacent routine events of
// one run. The marker line names the run and the entries, so a message
// whose sending was uncertain can be found again before retrying.
export function renderMessage(events: NotableEvent[], c: RenderContext, extra: { delayedFrom?: string; marker?: string } = {}): string {
  const parts = events.map(e => lines(e, c))
  const marker = extra.marker ?? messageMarker(c.ref, events)
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
// referred to them, now readable at a commit. The marker names the
// follow-up's own event (p5/ex1), so no two follow-ups share one.
export function renderPublished(ref: string, docs: DocLink[], commit: string, token: string): string {
  return [`**Details published** at ${commit.slice(0, 7)}: ${docs.map(docText).join(', ')}`, `ref ${ref} ${token} ${commit.slice(0, 7)}`].join('\n')
}

export function renderPublication(ref: string, state: 'failed' | 'attention' | 'recovered', detail: string, checkpoint: number): string {
  if (state === 'recovered') return [`**Publication recovered** — the run's records and artifacts are published (checkpoint ${checkpoint}).`, `ref ${ref} cp${checkpoint}:recovered`].join('\n')
  return [
    `**Publication ${state === 'failed' ? 'failed' : 'needs a person'}** (checkpoint ${checkpoint}): ${cut(detail, 300)}`,
    'The work is recorded on the execution host; links stay unpublished until this is resolved. Retry in agdevworld (run view → Retry publication) or `wfe exec publish ' + checkpoint + '`.',
    `ref ${ref} cp${checkpoint}:${state}`,
  ].join('\n')
}

// A reply about one of the person's posts that changed nothing, or needs
// them (p6, docs/intake.md): which post, what happened to it, what to do.
export type NoticeKind = 'clarify' | 'late' | 'closed' | 'refused' | 'problem'
export function renderNotice(o: { kind: NoticeKind; post: string; classification: { kind: string; reason?: string; question?: string; questions?: string[]; state?: string } | null; detail: string | null; ref: string; executor: string; marker: string }): string {
  const c = o.classification
  let body: string
  if (o.kind === 'clarify') {
    body = c?.reason === 'ambiguous' ? `**Which question?** Your [post](${o.post}) could answer ${c.questions?.join(' or ')}; nothing was recorded. Reply again quoting the question, or start with \`${c.questions?.[0]}:\`.`
      : c?.reason === 'not-yet-asked' ? `**Not recorded as an answer** — ${c.questions?.[0]} had not been asked here yet when you wrote this [post](${o.post}). Reply to the question once it appears.`
        : `**No such question** — this run has no ${c?.questions?.[0]}; your [post](${o.post}) was not recorded as an answer.`
  } else if (o.kind === 'late') {
    body = `**Too late for ${c?.question}** — it was already ${c?.state === 'withdrawn' ? 'withdrawn' : 'taken up'}, so your [post](${o.post}) is kept but not applied. If it changes anything, say so in a new message (it is recorded as an instruction).`
  } else if (o.kind === 'closed') {
    body = `**This request is ${c?.reason === 'cancelled' ? 'cancelled' : 'complete'}** (run ${o.ref}). Your [post](${o.post}) is kept but not applied; it does not reopen the run. A new request needs a new \`request-…\` topic.`
  } else if (o.kind === 'refused') {
    body = `**This request could not start**: ${cut(o.detail ?? '', 300)} Your [post](${o.post}) is kept. Open a new \`request-…\` topic when it can.`
  } else body = `**Routing problem** with your [post](${o.post}): ${cut(o.detail ?? '', 400)}`
  return [body, o.marker].join('\n')
}

// Hash-encoded Zulip narrow for a topic.
export function topicUrl(base: string, streamId: number, channel: string, topic: string): string {
  const enc = (t: string) => encodeURIComponent(t).replace(/\./g, '%2E').replace(/%/g, '.')
  return `${base.replace(/\/$/, '')}/#narrow/channel/${streamId}-${enc(channel)}/topic/${enc(topic)}`
}
export const messageUrl = (base: string, streamId: number, channel: string, topic: string, id: number) => `${topicUrl(base, streamId, channel, topic)}/near/${id}`
