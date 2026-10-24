// The review page of a human review round (workflow_editor p17,
// docs/reviews.md): #/ws/<workspace>/review/<workflow>/<run>/<rv>.
// One Start review starts every presentation of the round; the page follows
// the round's durable state (starting, reviewing, start failed, approved
// with cleanup, changes requested) and resolves links from the host's state
// each time it reads, never from an old address. Presentations open on
// their own origins, in their own tabs: nothing served is framed here.
import { api, ApiError } from './api.ts'
import { h, when } from './dom.ts'
import type { ViewHandle } from './main.ts'
import type { RoundView, SubjectView } from '../shared/humanReview.ts'

const ACTOR_KEY = 'workflow-editor.actor'
const stored = () => { try { return localStorage.getItem(ACTOR_KEY) ?? '' } catch { return '' } }
const store = (v: string) => { try { localStorage.setItem(ACTOR_KEY, v) } catch { /* per-viewer convenience only */ } }

const STATUS_WORDS: Record<SubjectView['status'], string> = { available: 'Ready', failed: 'Did not start', 'not-started': 'Not started yet', stopped: 'Stopped after the review' }

export function renderReviewView(app: HTMLElement, wsId: string, workflow: string, run: string, rv: string): ViewHandle {
  const runHref = `#/ws/${encodeURIComponent(wsId)}/run/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}`
  const reviewHref = (id: string) => `#/ws/${encodeURIComponent(wsId)}/review/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/${encodeURIComponent(id)}`
  const body = h('div.review-page', h('p.muted', 'Loading…'))
  app.append(h('header.app-header', h('nav.crumbs', h('a', { href: '#/' }, 'Projects'), ' / ', h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, wsId), ' / ', h('a', { href: runHref }, `${workflow}/${run}`), ' / ', `Human review ${rv}`)),
    h('main.review-main', body))
  let gone = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let round: RoundView | null = null
  let others: RoundView[] = []
  let busy = false
  let note: { kind: 'ok' | 'error'; text: string } | null = null
  const nameInput = h('input', { type: 'text', value: stored(), placeholder: 'Your name', 'aria-label': 'Your name' }) as HTMLInputElement
  const feedback = h('textarea', { rows: 4, placeholder: 'What should change (required to request changes; optional with an approval)' }) as HTMLTextAreaElement

  async function load() {
    try {
      const [one, all] = await Promise.all([api.review(wsId, workflow, run, rv), api.runReviews(wsId, workflow, run)])
      if (gone) return
      round = one.review
      others = all.reviews.filter(x => x.id !== rv)
      render()
    } catch (e) {
      if (gone) return
      body.replaceChildren(h('p.error', e instanceof ApiError ? e.message : String(e)))
    }
    schedule()
  }
  // Follows host work: quickly while something is under way, slowly otherwise.
  function schedule() {
    if (gone) return
    clearTimeout(timer)
    const moving = round && (round.state === 'starting' || (round.cleanup && (round.cleanup.state === 'pending' || round.cleanup.state === 'failed')))
    timer = setTimeout(load, moving ? 1500 : 8000)
  }
  function who(): string | null {
    const n = nameInput.value.trim()
    if (!n) { note = { kind: 'error', text: 'Enter your name first: the review records who started and who decided.' }; render(); nameInput.focus(); return null }
    store(n)
    return n
  }
  async function act(action: 'start' | 'decide', extra: { outcome?: 'approved' | 'changes'; feedback?: string } = {}, done = '') {
    const by = who()
    if (!by || !round || busy) return
    if (extra.outcome === 'changes' && !extra.feedback?.trim()) { note = { kind: 'error', text: 'Say what should change: the feedback goes to the agent that continues the work.' }; render(); feedback.focus(); return }
    busy = true; note = null; render()
    try {
      const r = await api.reviewAct(wsId, workflow, run, rv, action, { by, ...extra, ...(extra.outcome === 'approved' ? { revisions: round.subjects.map(x => x.revision) } : {}), receipt: `review:${rv}:${action}:${extra.outcome ?? ''}:${Date.now()}` })
      round = { ...round, ...r.review }
      note = done ? { kind: 'ok', text: done } : null
      if (action === 'decide') feedback.value = ''
    } catch (e) {
      note = { kind: 'error', text: `${e instanceof ApiError ? e.message : String(e)} — nothing else was recorded.` }
    } finally { busy = false }
    await load()
  }

  function subjectRow(x: SubjectView, r: RoundView) {
    const ownerHref = `#/ws/${encodeURIComponent(x.workspace)}/run/${encodeURIComponent(x.workflow)}/${encodeURIComponent(x.run)}`
    const open = x.live && x.url
    return h('li.review-subject',
      h('div.review-subject-head', h('strong', x.title), ' ', h('span.muted.small', `${x.presentation} · revision ${x.revision.slice(7, 19)}`)),
      h('div.small', 'From ', h('a', { href: ownerHref }, `${x.project} / ${x.workflow}/${x.run}`), x.delegation ? ` (delegation ${x.delegation}${x.result ? `, result ${x.result.event}` : ''})` : ''),
      h('div.review-subject-state', h(`span.chip.${open ? 'ok' : x.status === 'failed' ? 'warn' : 'muted'}`, open ? 'Ready' : STATUS_WORDS[x.status]),
        open ? h('a.button.primary', { href: x.url!, target: '_blank', rel: 'noopener' }, 'Open ↗') : null,
        open && x.local ? h('span.muted.small', ' opens on the execution host only') : null,
        !open && x.status === 'available' && r.state === 'reviewing' ? h('span.muted.small', ' not serving now — Start review again') : null),
      x.status === 'failed' && x.detail ? h('p.small.error', x.detail) : null,
      x.newer.length ? h('p.small.muted', `Newer in its run (not part of this review): ${x.newer.join(', ')}`) : null,
      x.usedBy.length ? h('p.small.muted', `Also used by ${x.usedBy.join(', ')}`) : null)
  }

  function render() {
    const r = round
    if (!r) return
    const decided = !!r.decision
    const canStart = ['awaiting', 'start-failed', 'reviewing'].includes(r.state)
    const allLive = r.subjectsNow.every(x => x.live)
    const head = h('div.card.review-head',
      h('h1', 'Human review'),
      h(`span.chip.review-state.${r.state}`, r.text),
      h('p.muted.small', `${r.id} of ${workflow}/${run} · prepared by ${r.prepared.by} at ${when(r.prepared.at)}${r.reviewer ? ` · for ${r.reviewer}` : ''}${r.previous ? ' · answers the changes requested in ' : ''}`, r.previous ? h('a', { href: reviewHref(r.previous) }, r.previous) : null))
    const summary = h('section.card', h('h2', 'What was done, what to check'), h('p.review-summary', r.summary))
    const subjects = h('section.card', h('div.card-head', h('h2', `To look at (${r.subjects.length})`),
      canStart ? h('button.primary', { disabled: busy || r.state === 'starting', onclick: () => act('start', {}, 'Started: every page answered or says why not.') }, r.state === 'reviewing' ? (allLive ? 'Start review again' : 'Start review again (a page stopped)') : 'Start review') : null,
      r.state === 'starting' ? h('span.muted', 'Starting every page…') : null),
      h('ul.review-subjects', r.subjectsNow.map(x => subjectRow(x, r))),
      r.state === 'awaiting' ? h('p.small.muted', 'Nothing is served until you start the review: one button starts every page. Starting is not an approval.') : null)
    const decide = !decided && r.state !== 'cancelled' ? h('section.card', h('h2', 'Your decision'),
      h('label.small', 'Recording as ', nameInput),
      feedback,
      h('div.review-actions',
        h('button.primary', { disabled: busy || r.state !== 'reviewing', title: r.state === 'reviewing' ? '' : 'Every page must be available first (Start review)', onclick: () => act('decide', { outcome: 'approved', ...(feedback.value.trim() ? { feedback: feedback.value } : {}) }, 'Approved. WFE stops what the review started.') }, 'Approve'),
        h('button', { disabled: busy || !['awaiting', 'start-failed', 'reviewing'].includes(r.state), onclick: () => act('decide', { outcome: 'changes', feedback: feedback.value }, 'Changes requested. The agent continues with your feedback and prepares a new review.') }, 'Request changes')),
      h('p.small.muted', 'Approval records your assessment of exactly these revisions. It is not permission to run, deploy or integrate anything.')) : null
    const outcome = decided ? h('section.card', h('h2', r.decision!.outcome === 'approved' ? 'Approved' : 'Changes requested'),
      h('p', `${r.decision!.by}${r.decision!.synthetic ? ' (a synthetic check actor)' : ''}${r.decision!.relayed ? ` (relayed by ${r.decision!.relayed.by})` : ''} at ${when(r.decision!.at)}`),
      r.decision!.feedback ? h('p.review-summary', r.decision!.feedback) : null,
      r.cleanup ? h('p.small', r.cleanup.state === 'done' ? 'Cleanup verified: what the review started is stopped.' : r.cleanup.state === 'handed' ? `The pages the review started are ${r.cleanup.owner}'s now (kept to compare, or stopped).` : r.cleanup.state === 'failed' ? 'Cleanup failed for an instance; WFE retries. Your decision stands and is not asked again.' : 'Cleanup in progress…') : null,
      r.cleanup?.results.length ? h('ul.small', r.cleanup.results.map(c => h('li', `subject ${c.subject}: ${c.status} — ${c.detail}`))) : null,
      r.continuation ? h('p.small', r.continuation.addressed ? `The agent ${r.continuation.addressed.how === 'no-change' ? 'answered that nothing changes' : 'added work'}; a new review follows.` : r.continuation.takenUp ? 'The agent read your feedback and is working on it.' : 'Waiting for the agent to take up your feedback.') : null) : null
    const cancelled = r.state === 'cancelled' ? h('section.card', h('p', `The run was cancelled${r.cancelled ? `: ${r.cancelled.reason}` : ''}. Nothing more is decided here.`)) : null
    const past = others.length ? h('section.card', h('h2', 'Other rounds of this run'), h('ul', others.map(o => h('li', h('a', { href: reviewHref(o.id) }, o.id), ` — ${o.text}${o.decision ? ` (${o.decision.by})` : ''}`)))) : null
    body.replaceChildren(head, note ? h(`p.notice.${note.kind}`, note.text) : '', summary, subjects, decide ?? '', outcome ?? '', cancelled ?? '', past ?? '', h('p.small', h('a', { href: runHref }, 'The run view')))
  }

  load()
  return { dispose: () => { gone = true; clearTimeout(timer) }, isDirty: () => !!feedback.value.trim() }
}
