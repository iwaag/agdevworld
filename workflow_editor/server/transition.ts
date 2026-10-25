// The transition of existing conversations to one standing conductor
// (workflow_editor p18 step 5, docs/conversations.md *Transition*). Before
// p18 every response ended in a conductor run of its own; a room now needs
// the one run that continues it. For each room that ever had a conductor the
// transition decides, deterministically and visibly:
//
// - its conductor already stands: nothing to do;
// - its latest conductor run (conversations.conductor, else the newest run a
//   conductor request started) is readable and not cancelled: it is
//   established standing — a run still working keeps working, a completed
//   one comes to rest (idle; finalized again if the room is closed) — with
//   everything it had left unacknowledged held, so nothing starts by itself;
// - it was cancelled: nothing revives it, and a replacement stays the
//   person's explicit act (wfe conversation conductor --replace);
// - it cannot be read (a retired project, a missing copy): the room keeps its
//   history, and its next conductor request starts a new standing run.
//
// The decision is an activity event of the room (`conductor` / `transition`,
// with the plan), and the run records `standing.establish` under the receipt
// `transition:p18:<conv>`, so applying twice records once. Earlier conductor
// runs stay as they were: history, listed by the room's progression. Other
// conductor runs still open (several candidates) are named in the record and
// left alone. Nothing is executed, woken, replayed or replied to.
import { pendingEvents, isOpenDelegation } from '../shared/delegation.ts'
import { situation, type RunRecord, type StandingState } from '../shared/run.ts'
import { parseRunName } from './conversations.ts'
import type { ConversationService } from './conversationService.ts'
import { readRun, runOp } from './runs.ts'
import { loadRegistry } from './registry.ts'

export type TransitionDecision = 'already-standing' | 'establish' | 'cancelled' | 'unreadable' | 'no-conductor'
export interface TransitionPlan {
  conv: string
  room: 'open' | 'closed'
  facilitated: boolean
  decision: TransitionDecision
  run: string | null // the run that continues the room (or the one that cannot)
  before: string | null // its situation before the transition
  standing: StandingState | null // what it stands after
  rests: boolean // a completed run that comes to rest (idle), or is finalized again (closed room)
  held: string[] // what it had left: unacknowledged instructions, relayed child facts — held
  others: { run: string; situation: string }[] // other conductor runs still open: left as they are
  earlier: string[] // earlier conductor runs: history
  recorded: boolean // a transition record already exists for this room
  note: string
}

const TOKEN = (conv: string) => `transition:p18:${conv}`

export async function planTransition(ds: ConversationService, only: string[] = []): Promise<TransitionPlan[]> {
  const cfg = ds.config()
  if ('disabled' in cfg) return []
  const exec = ds.exec
  const registered = exec ? new Set((await loadRegistry(exec.ctx.registryFile)).workspaces.map(w => w.id)) : new Set<string>()
  const rows = ds.db.prepare('SELECT id, state, conductor FROM conversations ORDER BY created, id').all() as { id: string; state: 'open' | 'closed'; conductor: string | null }[]
  const out: TransitionPlan[] = []
  for (const c of rows) {
    if (only.length && !only.includes(c.id)) continue
    const runs = (ds.db.prepare('SELECT DISTINCT run FROM invitations WHERE conv = ? AND run IS NOT NULL AND (role = \'conduct\' OR (workspace = ? AND workflow = ? AND delivery IS NULL AND awaits IS NULL)) ORDER BY id').all(c.id, cfg.facilitator.workspace, cfg.facilitator.workflow) as { run: string }[]).map(r => r.run)
    const conductor = c.conductor ?? runs.at(-1) ?? null
    if (!conductor && !runs.length) continue // never led: nothing to transition
    const facilitated = !!ds.facilitation(c.id)
    const recorded = !!ds.db.prepare('SELECT 1 FROM activity_events WHERE conv = ? AND kind = \'conductor\' AND state = \'transition\'').get(c.id)
    const earlier = runs.filter(r => r !== conductor)
    const read = async (run: string): Promise<RunRecord | null | 'unregistered'> => {
      try {
        const { workspace, ref } = parseRunName(run)
        if (!registered.has(workspace)) return 'unregistered'
        return (await readRun(await exec!.workspace(workspace), ref)).record as RunRecord | null
      } catch { return null }
    }
    const others: TransitionPlan['others'] = []
    for (const r of earlier) {
      const rec = await read(r)
      if (rec && rec !== 'unregistered' && !['completed', 'cancelled'].includes(situation(rec))) others.push({ run: r, situation: situation(rec) })
    }
    const base = { conv: c.id, room: c.state, facilitated, run: conductor, others, earlier, recorded }
    if (!conductor) { out.push({ ...base, decision: 'no-conductor', before: null, standing: null, rests: false, held: [], note: 'no conductor run is named or was started here' }); continue }
    const rec = await read(conductor)
    if (rec === 'unregistered' || !rec) {
      out.push({ ...base, decision: 'unreadable', before: null, standing: null, rests: false, held: [], note: `${conductor} cannot be read here (${rec === 'unregistered' ? 'its project is not registered: retired' : 'no readable record'}); the room keeps its history, and its next conductor request starts a new standing run` })
      continue
    }
    const before = situation(rec)
    if (rec.standing) { out.push({ ...base, decision: 'already-standing', before, standing: rec.standing.state, rests: false, held: rec.standing.held, note: `${conductor} already stands ${rec.standing.state}` }); continue }
    if (rec.cancelled) { out.push({ ...base, decision: 'cancelled', before, standing: null, rests: false, held: [], note: `${conductor} was cancelled (${rec.cancelled.reason}); nothing revives it, and a replacement is the person's explicit act (wfe conversation conductor ${c.id} --replace --reason …)` }); continue }
    const standing: StandingState = c.state === 'closed' ? 'closed' : facilitated ? 'open' : 'suspended'
    const held = [...Object.values(rec.instructions ?? {}).filter(i => !i.ack).map(i => i.id), ...Object.values(rec.delegations ?? {}).filter(isOpenDelegation).flatMap(d => pendingEvents(d).map(x => `${d.id}#${x.n}`))]
    const rests = rec.execution.state === 'completed'
    out.push({ ...base, decision: 'establish', before, standing, rests, held,
      note: `${conductor} (${before}) continues the room, standing ${standing}${rests ? standing === 'closed' ? ' (the room is closed: it stays finalized until it reopens)' : ' (it comes to rest: idle until the next message)' : ' (its work goes on as it was)'}${held.length ? `; held: ${held.join(', ')}` : ''}${earlier.length ? `; ${earlier.length} earlier conductor run${earlier.length === 1 ? '' : 's'} kept as history` : ''}${others.length ? `; still open, left as they are: ${others.map(o => `${o.run} (${o.situation})`).join(', ')}` : ''}` })
  }
  return out
}

// Applies the plans: one activity event per room (once), and the run's
// standing.establish for the rooms whose conductor continues them. Returns
// what was recorded. A dry run is planTransition alone.
export async function applyTransition(ds: ConversationService, plans: TransitionPlan[], o: { by: string }): Promise<{ conv: string; recorded: boolean; established: boolean; note: string }[]> {
  const out: { conv: string; recorded: boolean; established: boolean; note: string }[] = []
  const now = () => new Date().toISOString()
  for (const p of plans) {
    if (p.decision === 'already-standing' && p.recorded) { out.push({ conv: p.conv, recorded: false, established: false, note: p.note }); continue }
    let established = false
    if (p.decision === 'establish' && p.run && ds.exec) {
      const { workspace, ref } = parseRunName(p.run)
      await runOp(await ds.exec.workspace(workspace), ref, { op: 'standing.establish', conversation: p.conv, state: p.standing!, reason: `workflow_editor p18 transition: one conductor run per conversation; ${p.note}`, receipt: TOKEN(p.conv) } as never, { by: o.by, via: 'migration' })
      established = true
    }
    let recorded = false
    if (!p.recorded) {
      ds.db.exec('BEGIN IMMEDIATE')
      try {
        if (!ds.db.prepare('SELECT 1 FROM activity_events WHERE conv = ? AND kind = \'conductor\' AND state = \'transition\'').get(p.conv)) {
          if (p.decision === 'establish' && p.run && !ds.conversation(p.conv)?.conductor) ds.db.prepare('UPDATE conversations SET conductor = ? WHERE id = ?').run(p.run, p.conv)
          ds.db.prepare('INSERT INTO activity_events (conv, activity, kind, state, at, by, note, data) VALUES (?, NULL, \'conductor\', \'transition\', ?, ?, ?, ?)')
            .run(p.conv, now(), o.by, `workflow_editor p18 transition (${p.decision}): ${p.note}`, JSON.stringify({ decision: p.decision, run: p.run, before: p.before, standing: p.standing, held: p.held, others: p.others, earlier: p.earlier, receipt: TOKEN(p.conv) }))
          recorded = true
        }
        ds.db.exec('COMMIT')
      } catch (e) { ds.db.exec('ROLLBACK'); throw e }
    }
    out.push({ conv: p.conv, recorded, established, note: p.note })
  }
  return out
}
