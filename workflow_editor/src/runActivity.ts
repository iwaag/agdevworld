// The run's activity line (p8/ex2): one short line under Simple's progress
// that says the run is moving, without the log. It keeps apart what the
// record says (the current work, a wait, a hold), what this host observes of
// the executing session (its process, its turns, its last write) and the
// connection. Nothing is said that was not observed: on another host, with
// a log whose format is not counted, or while disconnected, the line says so
// instead of a number. A history view shows no current activity.
//
// The count is the current attempt's turns (server/activity.ts): one
// session of the agent. It starts again with the next session.
import type { RunExecView } from './api.ts'
import { h } from './dom.ts'

export type ActivityTone = 'working' | 'quiet' | 'waiting' | 'held' | 'done' | 'warn' | 'muted'
export interface ActivityLine {
  tone: ActivityTone
  text: string // what the run is doing, from the record and this host
  count?: { n: number; unit: 'turn'; attempt: string } // turns of the current session
  last?: string // the session's last observed write (ISO)
  note?: string // what could not be observed
}

export interface ActivityInput {
  rev: boolean
  connected: boolean
  execError: boolean
  exec: RunExecView | null
  situation: string // shared/run.ts situation()
  state: string // execution state
  active: string[] // labels of running nodes
  waitingFor: string | null // who holds the next move when the run waits on a person
  failed: string[]
  holdKind: string | null
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function describeActivity(i: ActivityInput): ActivityLine | null {
  if (i.rev) return null
  if (!i.connected) return { tone: 'warn', text: 'Not connected', note: 'activity is not observed until the view reconnects' }
  const doing = i.active.length ? `Working on ${i.active[0]}${i.active.length > 1 ? ` and ${i.active.length - 1} more` : ''}` : 'Between steps'
  if (i.state === 'cancelled' || i.situation === 'cancelled') return { tone: 'muted', text: 'Cancelled' }
  if (i.state === 'completed') return { tone: 'done', text: 'Finished' }
  if (i.holdKind) return { tone: 'held', text: 'Held', note: 'its work is kept; nothing runs until it is resumed' }
  if (i.situation === 'stopping') return { tone: 'warn', text: 'Stopping', note: 'waiting for the session to end' }
  if (i.execError) return { tone: 'warn', text: i.active.length ? doing : 'Activity unknown', note: 'this host\'s execution facts cannot be read' }
  const open = i.exec?.attempts.find(a => a.state !== 'ended')
  if (open) {
    if (open.alive === null) return { tone: 'muted', text: doing, note: 'the session runs on another host; its activity is observed there' }
    if (open.alive === false && open.pid) return { tone: 'warn', text: doing, note: 'the session\'s process is not running' }
    if (open.alive === false) return { tone: 'muted', text: 'Starting a session' }
    const act = open.activity
    if (act?.problem) return { tone: 'muted', text: doing, note: 'its output cannot be read on this host' }
    const line: ActivityLine = { tone: 'working', text: doing }
    if (act?.unit === 'turn' && act.count !== null) line.count = { n: act.count, unit: 'turn', attempt: open.id }
    if (act?.last) line.last = act.last
    if (!act?.last) line.note = 'no output yet'
    return line
  }
  if (i.situation === 'awaiting-person' || i.waitingFor) return { tone: 'waiting', text: i.waitingFor ? `Waiting for ${i.waitingFor}` : 'Waiting for a person' }
  if (i.failed.length) return { tone: 'warn', text: `${i.failed[0]} failed` }
  const queued = i.exec?.jobs.some(j => j.state === 'queued' || j.state === 'claimed')
  if (queued) return { tone: 'quiet', text: 'Queued', note: 'starts when the executor is free' }
  if (!i.exec) return { tone: 'muted', text: 'Checking the executor' }
  if (i.state === 'not-started') return { tone: 'muted', text: 'Not started' }
  return { tone: 'muted', text: 'Waiting for the executor' }
}

// Seconds for the first minutes: the line is read at a glance while the
// session works.
export function since(at: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

// The line as a persistent element. A new turn makes the count pulse once
// (no motion when the person asks for reduced motion, styles.css); the age
// is updated every second without announcing anything.
export class ActivityView {
  readonly el = h('p.run-activity', { dataset: { tone: 'muted', key: 'run-activity' } }) // keyed: patchContent keeps this element
  private readonly words = h('span.act-text')
  private readonly countEl = h('span.act-count')
  private readonly lastEl = h('span.act-last')
  private readonly noteEl = h('span.act-note')
  private shown: { attempt: string; n: number } | null = null
  private line: ActivityLine | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  constructor() {
    this.el.append(h('span.act-dot', { 'aria-hidden': 'true' }), this.words, this.countEl, this.lastEl, this.noteEl)
  }

  update(line: ActivityLine | null) {
    this.line = line
    this.el.hidden = !line
    if (!line) { this.stop(); return }
    if (this.el.dataset.tone !== line.tone) this.el.dataset.tone = line.tone
    if (this.words.textContent !== line.text) this.words.textContent = line.text
    const c = line.count
    const countText = c ? ` · ${plural(c.n, 'turn')} this session` : ''
    if (this.countEl.textContent !== countText) this.countEl.textContent = countText
    this.countEl.title = c ? 'Responses of the agent in its current session, counted from its own output on this host. A new session starts again from zero.' : ''
    if (c && this.shown && this.shown.attempt === c.attempt && c.n > this.shown.n) this.bump()
    this.shown = c ? { attempt: c.attempt, n: c.n } : null
    this.noteEl.textContent = line.note ? ` · ${line.note}` : ''
    this.age()
    if (line.last && !this.timer) this.timer = setInterval(() => this.age(), 1000)
    if (!line.last) this.stop()
  }

  private age() {
    const t = this.line?.last ? ` · last activity ${since(this.line.last)}` : ''
    if (this.lastEl.textContent !== t) this.lastEl.textContent = t
    if (this.line?.last) this.lastEl.title = new Date(this.line.last).toLocaleString()
  }

  private bump() {
    this.el.classList.remove('bump')
    void this.el.offsetWidth // restart the animation
    this.el.classList.add('bump')
  }

  private stop() { if (this.timer) { clearInterval(this.timer); this.timer = undefined } }
  dispose() { this.stop() }
}
