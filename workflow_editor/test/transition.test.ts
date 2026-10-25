// workflow_editor p18 step 5: existing rooms get their one standing
// conductor through an explicit, recorded, idempotent transition. Rooms
// from before p18 are simulated as they are on disk: conductor runs created
// without `standing`, one per response, completed. The latest readable one
// continues the room (a completed one comes to rest, finalized again when
// the room is closed), what it left is held, earlier runs stay as history;
// a cancelled conductor is not revived; an unreadable one is recorded; a
// dry run records nothing; applying twice records once; nothing is executed,
// woken, replayed or sent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService } from '../server/conversationService.ts'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { applyTransition, planTransition } from '../server/transition.ts'
import { main } from '../cli/wfe.ts'
import { Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-transition-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, agent: string, node = 'ponder', type = 'do', activity = 'activity: ponder\n    ') => `schema: ag.workflow.v2
id: ${id}
name: ${id}
intent: |
  x
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ${agent}}
repositories:
  root: {path: ., access: editable}
nodes:
  ${node}:
    type: ${type}
    ${activity}description: x
`

async function setup() {
  const area = join(root, `area-${Math.random().toString(36).slice(2, 8)}`)
  const registry = join(area, 'registry.json')
  for (const [id, wfs] of [['ponderer', { conduct: WF('conduct', 'ponderer-agent'), converse: WF('converse', 'ponderer-agent', 'talk', 'talk', '') }], ['kid', { converse: WF('converse', 'kid-agent', 'talk', 'talk', ''), discuss: WF('discuss', 'kid-agent', 'talk', 'talk', '') }]] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    for (const [wf, text] of Object.entries(wfs)) await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), text)
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  }
  await writeFile(join(area, 'conversations.json'), JSON.stringify({ person: 'Pat', projects: [{ workspace: 'kid', converse: 'converse', discuss: 'discuss' }, { workspace: 'ponderer', converse: 'converse' }], facilitator: { workspace: 'ponderer', workflow: 'conduct' }, archive: { workspace: 'ponderer' } }))
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new ConversationService(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, registry, x, cs, ds, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const refOf = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow: workflow!, run: r! } }
const rec = async (s: S, run: string) => { const r = refOf(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]!), r), r)).record! }
const op = async (s: S, run: string, o: Parameters<typeof runOp>[2], by = 'ponderer-agent') => { const r = refOf(run); return runOp(await runSpace(s.ws(run.split('/')[0]!), r), r, o, { by, via: 'cli' }) }
const jobs = (s: S) => (s.x.db.prepare('SELECT count(*) AS n FROM jobs WHERE state = \'queued\'').get() as { n: number }).n
let tok = 0
// A room as before p18: each person message started a conductor run of its
// own (created without standing), which answered and completed.
async function legacyRoom(s: S, conv: string, turns: number, o: { complete?: boolean[]; closed?: boolean } = {}) {
  s.ds.create(conv, { title: conv, by: 'Pat', members: ['kid'], facilitate: true })
  const runs: string[] = []
  for (let t = 0; t < turns; t++) {
    const at = new Date().toISOString()
    const m = Number(s.cs.db.prepare('INSERT INTO messages (conv, role, author, text, at, token, re, kind, participant, addressed) VALUES (?, \'person\', \'Pat\', ?, ?, ?, \'[]\', \'message\', \'Pat\', \'["ponderer"]\')').run(conv, `turn ${t + 1}`, at, `tok-legacy-${++tok}`).lastInsertRowid)
    const r = await s.x.request({ workspace: 'ponderer', workflow: 'conduct', text: `turn ${t + 1}`, author: 'Pat', receipt: `legacy:${conv}:${t}`, via: 'conversation' })
    const run = `ponderer/${r.ref.workflow}/${r.ref.run}`
    s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE run = ?').run(r.ref.run)
    const inv = Number(s.cs.db.prepare('INSERT INTO invitations (conv, participant, workspace, workflow, question, source, by, horizon, token, state, run, role, created, updated) VALUES (?, \'ponderer\', \'ponderer\', \'conduct\', ?, ?, \'Pat\', ?, ?, \'answered\', ?, \'conduct\', ?, ?)').run(conv, `turn ${t + 1}`, JSON.stringify([m]), m, `message:${m}:ponderer`, run, at, at).lastInsertRowid)
    s.cs.db.prepare('UPDATE invitations SET receipt = ? WHERE id = ?').run(`conversation:${conv}:request:${inv}`, inv)
    s.cs.db.prepare('UPDATE conversations SET conductor = ? WHERE id = ?').run(run, conv)
    if (o.complete?.[t] ?? true) { await op(s, run, { op: 'node.start', node: 'ponder' } as never); await op(s, run, { op: 'node.complete', node: 'ponder', outcome: `answered turn ${t + 1}` } as never) }
    runs.push(run)
  }
  if (o.closed) await s.ds.close(conv, { by: 'Pat' })
  return runs
}

test('the transition plans and records one standing conductor per room, explicitly, once; nothing is executed, replayed or sent', async () => {
  const s = await setup()
  const a = await legacyRoom(s, 'old-open', 3)
  // The latest run had an instruction recorded after it completed (kept for an attempt that reopens work).
  await op(s, a[2]!, { op: 'instruction.receive', text: 'late words', from: 'Pat' } as never, 'Pat')
  const b = await legacyRoom(s, 'old-closed', 2, { closed: true })
  const c = await legacyRoom(s, 'old-working', 2, { complete: [false, false] })
  const d = await legacyRoom(s, 'old-cancelled', 1)
  await op(s, d[0]!, { op: 'run.cancel', reason: 'cancelled before p18' } as never, 'Pat')
  s.ds.create('old-retired', { title: 'retired', by: 'Pat', members: ['kid'], facilitate: true })
  s.cs.db.prepare('UPDATE conversations SET conductor = \'argue/facilitate/run-001\' WHERE id = \'old-retired\'').run()
  s.ds.create('direct', { title: 'direct', by: 'Pat', members: ['kid'] })
  const messages = (s.cs.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n
  const queued = jobs(s)

  // Dry run: the plan, nothing recorded.
  const plans = await planTransition(s.ds)
  const by = Object.fromEntries(plans.map(p => [p.conv, p]))
  assert.deepEqual(Object.keys(by).sort(), ['old-cancelled', 'old-closed', 'old-open', 'old-retired', 'old-working'], 'rooms never led are not touched')
  assert.deepEqual([by['old-open']!.decision, by['old-open']!.run, by['old-open']!.standing, by['old-open']!.rests, by['old-open']!.held, by['old-open']!.earlier], ['establish', a[2], 'open', true, ['i1'], [a[0], a[1]]])
  assert.deepEqual([by['old-closed']!.decision, by['old-closed']!.standing, by['old-closed']!.rests], ['establish', 'closed', true])
  assert.deepEqual([by['old-working']!.decision, by['old-working']!.rests, by['old-working']!.others.map(x => x.run)], ['establish', false, [c[0]]], 'another open candidate is named, left as it is')
  assert.equal(by['old-cancelled']!.decision, 'cancelled')
  assert.match(by['old-retired']!.note, /retired/)
  assert.equal((await rec(s, a[2]!)).standing, undefined, 'a dry run records nothing')
  assert.equal(s.cs.db.prepare('SELECT count(*) AS n FROM activity_events WHERE state = \'transition\'').get()!.n, 0)

  // Apply.
  const done = await applyTransition(s.ds, plans, { by: 'Omni Agent (p18 transition test)' })
  assert.equal(done.filter(x => x.recorded).length, 5)
  assert.equal(done.filter(x => x.established).length, 3)
  let r = await rec(s, a[2]!)
  assert.deepEqual([r.execution.state, r.standing!.state, r.standing!.held], ['idle', 'open', ['i1']], 'the latest completed run rests, its late words held')
  assert.equal(r.history.at(-1)!.op, 'standing.establish')
  assert.equal(r.history.at(-1)!.via, 'migration')
  for (const old of [a[0]!, a[1]!]) assert.deepEqual([(await rec(s, old)).execution.state, (await rec(s, old)).standing], ['completed', undefined], 'earlier runs stay history')
  r = await rec(s, b[1]!)
  assert.deepEqual([r.execution.state, r.standing!.state], ['completed', 'closed'], 'a closed room\'s conductor stays finalized')
  r = await rec(s, c[1]!)
  assert.deepEqual([r.execution.state, r.standing!.state], ['not-started', 'open'], 'an unfinished run keeps its state; only its standing is added')
  assert.equal((await rec(s, c[0]!)).standing, undefined)
  assert.ok((await rec(s, d[0]!)).cancelled, 'not revived')
  const ev = s.cs.db.prepare('SELECT conv, note, data FROM activity_events WHERE kind = \'conductor\' AND state = \'transition\' ORDER BY id').all() as { conv: string; note: string; data: string }[]
  assert.deepEqual(ev.map(e => [e.conv, JSON.parse(e.data).decision]).sort(), [['old-cancelled', 'cancelled'], ['old-closed', 'establish'], ['old-open', 'establish'], ['old-retired', 'unreadable'], ['old-working', 'establish']])

  // Nothing executed, woken, replayed or sent — also after the reconciles.
  await s.x.reconcile(); await s.ds.reconcile(); await s.x.reconcile()
  assert.equal(jobs(s), queued, 'no job queued')
  assert.equal((s.cs.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n, messages, 'no message')
  assert.equal((await rec(s, a[2]!)).standing!.wakes.length, 0, 'the held words woke nothing')
  assert.equal((await rec(s, a[2]!)).execution.state, 'idle')

  // Applying again records nothing more.
  const again = await applyTransition(s.ds, await planTransition(s.ds), { by: 'Omni Agent (p18 transition test)' })
  assert.equal(again.filter(x => x.recorded || x.established).length, 0)
  assert.equal((await rec(s, a[2]!)).history.filter(h => h.op === 'standing.establish').length, 1)

  // After the transition the room continues with the same run: the next message wakes it.
  await s.ds.post('old-open', { text: 'Back again.', author: 'Pat', token: 'tok-after-0001' })
  r = await rec(s, a[2]!)
  assert.deepEqual([r.standing!.wakes.length, r.execution.ready], [1, ['ponder-w1']])
  assert.equal(s.cs.conversation('old-open')!.conductor, a[2], 'no new run')
  // The cancelled room's request fails visibly until an explicit replacement.
  const p = await s.ds.post('old-cancelled', { text: 'Hello?', author: 'Pat', token: 'tok-after-0002' })
  assert.equal(p.invitations[0]!.state, 'failed')
  const v = await s.ds.view('old-open')
  assert.deepEqual(v.progression.earlier.map(e => e.run), [a[0], a[1]], 'the room lists its earlier runs as history')
  s.cs.close(); s.x.close()
})

test('wfe conversation transition: --apply --author records through the command line (a boolean --apply must not take --author as its value)', async () => {
  const s = await setup()
  const a = await legacyRoom(s, 'old-cli', 2)
  const log = console.log
  console.log = () => {}
  try {
    assert.equal(await main(['conversation', 'transition', '--registry', s.registry, '--area', s.area]), 0)
    assert.equal((await rec(s, a[1]!)).standing, undefined, 'without --apply: a dry run')
    assert.equal(await main(['conversation', 'transition', '--apply', '--author', 'Omni Agent (p18 transition test)', '--registry', s.registry, '--area', s.area]), 0)
  } finally { console.log = log }
  const r = await rec(s, a[1]!)
  assert.deepEqual([r.standing?.state, r.history.at(-1)!.by], ['open', 'Omni Agent (p18 transition test)'])
  s.cs.close(); s.x.close()
})
