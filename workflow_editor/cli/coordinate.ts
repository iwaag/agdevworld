// `wfe coordinate` (improve_wfrun p4, docs/coordination.md): how warden reads
// the queue and the workers, and records what starts, moves or waits. Thin
// over server/exec.ts (ExecStore.coordinationView, decide, takeEvents).
import type { CoordinationEventRow, DecisionRow, ExecStore, Reconsider } from '../server/exec.ts'
import type { Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

export const COORDINATE_HELP = `wfe coordinate <subcommand> …   (execution coordination; docs/coordination.md)

Ordinary work starts when warden decided it does: a queued job awaits a
decision until one says start (or defer), on whichever node the run is
assigned to; the coordination lane itself needs no decision. A decision names
its reason and what it looked at; it is applied to the job it names, and a
"start" or "defer" of scope run stands for the run's later jobs on that node
until a later decision. Nothing here judges compatibility: the facts (open
attempts, load, requests, constraints) are evidence for whoever decides.

A run is <workflow>/<run> with --workspace <id>, or <workspace>:<workflow>/<run>.

view [--json]                   what warden decides from: workers (contact, load, open attempts
                                with their requests and progress), queued jobs (awaiting, deferred,
                                admitted; constraint; a basis token per job), recent decisions,
                                pending events, the coordination path's own state
events [--take] [--all]         the events not yet taken (--take: take them for this attempt);
                                --all: the last 30, taken or not
start <run> [--worker <id>] [--scope run|job] --reason <text>
      [--observation <text>]… [--assumption <text>]… [--basis <token>] [--by <name>]
                                the run's queued job starts when its node's executor next claims
                                (scope run, the default: so do its later jobs there, without
                                another decision). --worker: move it first (run.assign, between
                                attempts; refused when the request or a person placed it:
                                placement-constraint). --basis: the view's token for the job; a
                                changed one makes the decision stale and applies nothing
defer <run> --reason <text> [--until <ISO time|+<n>m|+<n>h>] [--on <event>,…] [--scope run|job]
      [--observation <text>]… [--assumption <text>]… [--basis <token>] [--by <name>]
                                the job waits; warden looks again at --until, or when one of the
                                named events happens (queued, attempt-ended, worker-available,
                                worker-unavailable, reconsider), or at its next look otherwise
assign <run> --worker <id> --reason <text> [--by <name>]
                                move the run to another node between attempts, without admitting it
note <run> --text <text> [--by <name>]
                                a note the run's agent reads in its next brief (wfe coordinate notes
                                shows it now): why another run shares its node, an agreed path, …
notes <run>                     the notes left for a run, and its decisions
decisions [<run>] [-n <count>]  recent decisions, or one run's
reconsider --reason <text> [--run <run>]
                                ask warden to look again (from a working attempt: at this run's
                                situation; from anywhere: in general). Wakes the coordination path
wake                            open a coordination turn now, even while a stall pauses automatic
                                turns (and when nothing awaits a decision)
apply --file <json>             several decisions in one go: [{"action": "start"|"defer"|"assign"|
                                "note", "run": "<ws>:<wf>/<run>", "worker", "scope", "reason",
                                "observations": [], "assumptions": [], "until", "on": [], "basis",
                                "text"}]; each is applied or refused on its own and reported

From a coordination run's attempt (WFE_ATTEMPT) the decider is that run's
agent; outside one, --by names it. Every decision is a row warden and people
can read back (view, decisions); a refused or stale one is recorded as such.`

export interface CoordinateCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, d?: unknown) => Error
  exec: () => Promise<ExecStore>
  workspace: (id?: string) => Promise<Workspace>
  resolveRun: (ws: Workspace, text: string) => Promise<RunRef>
}

// `+10m` / `+2h` / an ISO time.
export function untilOf(text: string | undefined, now = new Date()): string | undefined {
  if (!text) return undefined
  const m = /^\+(\d+)([mh])$/.exec(text.trim())
  if (m) return new Date(now.getTime() + Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000)).toISOString()
  const t = Date.parse(text)
  if (Number.isNaN(t)) throw new Error(`--until is an ISO time or +<n>m / +<n>h, not "${text}"`)
  return new Date(t).toISOString()
}
const EVENT_KINDS = ['queued', 'attempt-ended', 'worker-available', 'worker-unavailable', 'reconsider', 'wake']

function eventLine(e: CoordinationEventRow): string {
  const where = e.run ? `${e.workspace} ${e.workflow}/${e.run}` : e.worker ?? ''
  return `${String(e.id).padStart(5)} ${e.at} ${e.kind.padEnd(18)} ${where}${e.detail ? ` — ${e.detail}` : ''}${e.taken_by ? ` (taken by ${e.taken_by})` : ''}`
}
function decisionLine(d: DecisionRow | (Omit<DecisionRow, 'reconsider'> & { reconsider: Reconsider | null })): string {
  const rc = typeof d.reconsider === 'string' ? JSON.parse(d.reconsider) as Reconsider : d.reconsider
  const when = rc ? [rc.until ? `until ${rc.until}` : '', rc.on?.length ? `on ${rc.on.join(', ')}` : ''].filter(Boolean).join(' or ') : ''
  return `${String(d.id).padStart(4)} ${d.at} ${d.action.padEnd(6)} ${d.workspace} ${d.workflow}/${d.run}${d.worker ? ` → ${d.worker}` : ''} [${d.scope}, ${d.state}${d.attempt ? `, attempt ${d.attempt}` : ''}] by ${d.by}: ${d.reason}${when ? ` (${when})` : ''}${d.detail ? ` — ${d.detail}` : ''}`
}

export async function coordinateCommand(c: CoordinateCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') { c.out(COORDINATE_HELP, { help: COORDINATE_HELP }); return 0 }
  const x = await c.exec()
  const runOf = async (text: string | undefined): Promise<{ ws: Workspace; ref: RunRef }> => {
    if (!text) throw c.usage('<run> is required: <workflow>/<run> with --workspace, or <workspace>:<workflow>/<run>')
    const m = /^([^:]+):(.+)$/.exec(text)
    const ws = await c.workspace(m ? m[1] : c.opt('workspace'))
    return { ws, ref: await c.resolveRun(ws, m ? m[2] : text) }
  }
  const lists = (k: string) => c.opts(k).filter(Boolean)
  const decide = async (action: DecisionRow['action'], run: string | undefined, extra: Partial<{ worker: string; scope: 'run' | 'job'; reason: string; observations: string[]; assumptions: string[]; reconsider: Reconsider; basis: string; by: string }> = {}) => {
    const { ws, ref } = await runOf(run)
    const reason = extra.reason ?? (action === 'note' ? c.opt('text') : c.opt('reason'))
    if (!reason) throw c.usage(action === 'note' ? '--text <text> is required' : '--reason <text> is required: why')
    const scopeText = extra.scope ?? c.opt('scope')
    if (scopeText !== undefined && scopeText !== 'run' && scopeText !== 'job') throw c.usage('--scope is run or job')
    const on = extra.reconsider?.on ?? (c.opt('on') ? c.opt('on')!.split(',').map(s => s.trim()).filter(Boolean) : undefined)
    for (const k of on ?? []) if (!EVENT_KINDS.includes(k)) throw c.usage(`--on names events: ${EVENT_KINDS.join(', ')}`)
    let until: string | undefined
    try { until = extra.reconsider?.until ?? untilOf(c.opt('until')) } catch (e) { throw c.usage((e as Error).message) }
    return x.decide({
      action, workspace: ws.reg.id, ref, worker: extra.worker ?? c.opt('worker'), scope: scopeText, reason,
      observations: extra.observations ?? lists('observation'), assumptions: extra.assumptions ?? lists('assumption'),
      reconsider: action === 'defer' ? { ...(until ? { until } : {}), ...(on?.length ? { on } : {}) } : undefined,
      basis: extra.basis ?? c.opt('basis'), by: extra.by ?? c.opt('by'), attempt: process.env.WFE_ATTEMPT, via: 'cli',
    })
  }
  try {
    switch (sub) {
      case 'view': {
        const v = await x.coordinationView()
        const lines: string[] = [`Coordination view ${v.observedAt}${v.configured ? ` (coordination runs: ${v.coordination!.workspace} ${v.coordination!.workflow} on ${v.coordination!.worker}/${v.coordination!.lane})` : ' — not configured: every job is admitted as queued'}`]
        if (v.turn) lines.push(`Turn ${v.turn.id} open since ${v.turn.since}: ${v.turn.run ?? '(creating)'}${v.turn.attempt ? `, attempt ${v.turn.attempt}` : ''}`)
        if (v.stalled) lines.push(`STALLED: ${v.stalled.failures} turns ended without a decision since ${v.stalled.since} (last: ${v.stalled.last}); the next automatic turn waits until ${v.stalled.until}; wfe coordinate wake opens one now`)
        if (v.needs.yes) lines.push(`Needs a decision: ${v.needs.why.join('; ')}`)
        for (const w of v.workers) {
          const load = w.load ? [w.load.cpus ? `${w.load.cpus} cpus` : '', w.load.load1 !== undefined ? `load ${w.load.load1}${w.load.load5 !== undefined ? `/${w.load.load5}` : ''}` : '', w.load.memFreeMB !== undefined ? `mem free ${Math.round(w.load.memFreeMB / 1024 * 10) / 10}/${w.load.memTotalMB ? Math.round(w.load.memTotalMB / 1024 * 10) / 10 : '?'} GB` : '', ...(w.load.gpu ?? []).map(g => `gpu ${g.name ?? ''} ${g.memUsedMB ?? '?'}/${g.memTotalMB ?? '?'} MB ${g.utilPercent ?? '?'}%`), `measured ${w.load.at}`].filter(Boolean).join(', ') : 'load: not measured'
          lines.push('', `Worker ${w.id} (${w.label})${w.default ? ', default' : ''}${w.coordination ? ', coordination' : ''}: ${w.state}${w.ageSeconds !== null ? ` (heard ${w.ageSeconds} s ago)` : ''}; ${load}${w.profiles ? `; profiles ${w.profiles.join(', ')}` : ''}`)
          for (const [k, val] of Object.entries(w.host ?? {})) lines.push(`    ${k}: ${val}`)
          if (!w.attempts.length) lines.push('  no open attempt')
          for (const a of w.attempts) lines.push(`  attempt ${a.attempt} ${a.workspace} ${a.workflow}/${a.run}${a.coordination ? ' (coordination)' : ''} [${a.lane}] since ${a.began}${a.stopRequested ? ', STOP requested' : ''}${a.decision ? `, decision ${a.decision}` : ''}`,
            `    doing: ${a.active.join(', ') || '(between nodes)'}${a.progress ? `; last ${a.progress.op} ${a.progress.at}${a.progress.text ? `: ${a.progress.text.slice(0, 120)}` : ''}` : ''}${a.logLast ? `; log ${a.logLast}` : ''}`,
            `    request: ${a.request ?? '(not readable)'}`)
        }
        lines.push('', `Queued (${v.queued.length}):`)
        if (!v.queued.length) lines.push('  nothing')
        for (const q of v.queued) {
          lines.push(`  job ${q.job} ${q.workspace} ${q.workflow}/${q.run} (${q.kind}) on ${q.worker}: ${q.admission.toUpperCase()}${q.decision ? ` by decision ${q.decision.id} (${q.decision.by}: ${q.decision.reason}${q.decision.reconsider ? `; ${q.decision.reconsider.until ? `until ${q.decision.reconsider.until}` : ''}${q.decision.reconsider.on?.length ? ` on ${q.decision.reconsider.on.join(', ')}` : ''}` : ''})` : ''}; queued ${q.created}; basis ${q.basis ?? '?'}`,
            `    why: ${q.reason}${q.note ? `; note: ${q.note}` : ''}${!q.servable ? ' — NOT SERVABLE by its worker now' : ''}${q.constraint ? `; placement constraint: ${q.constraint}` : ''}`,
            `    request${q.requester ? ` (${q.requester})` : ''}: ${q.request ?? '(not readable)'}`,
            `    ready: ${q.ready.join(', ') || '(none)'}${q.situation ? `; situation ${q.situation}` : ''}`)
        }
        if (v.decisions.length) lines.push('', 'Recent decisions:', ...v.decisions.map(d => `  ${decisionLine(d as never)}`))
        if (v.events.length) lines.push('', `Pending events (${v.events.length}; wfe coordinate events --take):`, ...v.events.slice(-20).map(e => `  ${eventLine(e)}`))
        if (v.recentTurns.length) lines.push('', 'Recent turns:', ...v.recentTurns.map(b => `  ${b.id} ${b.state} ${b.run ?? ''} ${b.created}${b.ended ? ` → ${b.ended}` : ''}: ${b.outcome ?? b.error ?? ''}`))
        c.out(lines.join('\n'), v)
        return 0
      }
      case 'events': {
        if (c.flag('take')) {
          const attempt = process.env.WFE_ATTEMPT
          if (!attempt) throw c.usage('--take is for a coordination run\'s attempt (WFE_ATTEMPT)')
          const taken = x.takeEvents(attempt)
          c.out(taken.length ? taken.map(eventLine).join('\n') : 'No pending event.', { taken })
          return 0
        }
        const events = c.flag('all') ? x.recentEvents(30) : x.pendingEvents()
        c.out(events.length ? events.map(eventLine).join('\n') : 'No pending event.', { events })
        return 0
      }
      case 'start': case 'defer': case 'assign': case 'note': {
        if (sub === 'assign' && !c.opt('worker')) throw c.usage('--worker <id> is required')
        const r = await decide(sub, args[0])
        if (!r.applied) { c.out(`Stale: ${r.decision.detail}\nNow: ${JSON.stringify(r.changed?.facts)}`, { ok: false, ...r }); return 1 }
        c.out([`Recorded decision ${r.decision.id} (${r.decision.action}, ${r.decision.scope}) by ${r.decision.by}.`, ...r.notes].join('\n'), { ok: true, ...r })
        return 0
      }
      case 'notes': {
        const { ws, ref } = await runOf(args[0])
        const all = x.decisionsOf(ws.reg.id, ref, 50)
        c.out(all.length ? all.map(decisionLine).join('\n') : 'No decision about this run.', { decisions: all })
        return 0
      }
      case 'decisions': {
        const n = c.opt('n') ? Number(c.opt('n')) : 20
        const all = args[0] ? await runOf(args[0]).then(({ ws, ref }) => x.decisionsOf(ws.reg.id, ref, n)) : x.recentDecisions(n)
        c.out(all.length ? all.map(decisionLine).join('\n') : 'No decision yet.', { decisions: all })
        return 0
      }
      case 'reconsider': {
        const reason = c.opt('reason')
        if (!reason) throw c.usage('--reason <text> is required: what warden should look at')
        let where: { workspace?: string; workflow?: string; run?: string; attempt?: string; worker?: string } = {}
        const attempt = process.env.WFE_ATTEMPT
        const own = attempt ? x.attemptRow(attempt) : undefined
        if (c.opt('run')) { const { ws, ref } = await runOf(c.opt('run')); where = { workspace: ws.reg.id, workflow: ref.workflow, run: ref.run } }
        else if (own && own.state !== 'ended') where = { workspace: own.workspace, workflow: own.workflow, run: own.run, attempt: own.id, worker: own.worker ?? undefined }
        const id = x.event('reconsider', { ...where, detail: `${own ? `${own.workflow}/${own.run} (attempt ${own.id})` : c.opt('by') ?? 'someone'}: ${reason}` })
        const turn = await x.ensureCoordination()
        c.out(`Recorded event ${id}; ${turn ? `coordination turn ${turn.id} ${turn.state === 'open' ? 'is open' : 'opens'} (${turn.run ?? 'creating'})` : 'no coordination is configured on this host'}.`, { ok: true, event: id, turn })
        return 0
      }
      case 'wake': {
        const turn = await x.ensureCoordination({ force: true })
        c.out(turn ? `Coordination turn ${turn.id}: ${turn.state} (${turn.run ?? 'creating'}).` : 'No coordination is configured on this host.', { ok: !!turn, turn })
        return turn ? 0 : 1
      }
      case 'apply': {
        const file = c.opt('file')
        if (!file) throw c.usage('--file <json> is required')
        const { readFileSync } = await import('node:fs')
        const items = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')) as Record<string, unknown>[]
        if (!Array.isArray(items)) throw c.usage('the file holds a list of decisions')
        const results: unknown[] = []
        let failed = 0
        for (const it of items) {
          const action = String(it.action ?? '') as DecisionRow['action']
          try {
            if (!['start', 'defer', 'assign', 'note'].includes(action)) throw c.usage(`action "${action}" is start, defer, assign or note`)
            const r = await decide(action, String(it.run ?? ''), {
              worker: it.worker as string | undefined, scope: it.scope as 'run' | 'job' | undefined, reason: String(it.reason ?? it.text ?? ''), observations: it.observations as string[] | undefined, assumptions: it.assumptions as string[] | undefined,
              reconsider: action === 'defer' ? { ...(it.until ? { until: untilOf(String(it.until)) } : {}), ...(Array.isArray(it.on) ? { on: it.on as string[] } : {}) } : undefined, basis: it.basis as string | undefined, by: it.by as string | undefined,
            })
            results.push({ run: it.run, action, ok: r.applied, decision: r.decision.id, notes: r.notes, ...(r.applied ? {} : { stale: r.decision.detail, now: r.changed?.facts }) })
            if (!r.applied) failed++
          } catch (e) { failed++; results.push({ run: it.run, action, ok: false, error: (e as Error).message }) }
        }
        c.out(results.map(r => JSON.stringify(r)).join('\n'), { ok: !failed, results })
        return failed ? 1 : 0
      }
    }
  } catch (e) {
    const err = e as Error & { detail?: unknown; status?: number }
    if (err.status !== undefined) throw c.refused(err.message, err.detail)
    throw e
  } finally { x.close() }
  throw c.usage('wfe coordinate view|events|start|defer|assign|note|notes|decisions|reconsider|wake|apply')
}
