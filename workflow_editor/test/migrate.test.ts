// p9 step 6: migrating runs recorded before p9 without changing what they
// mean. Pre-p9 records are made here the way the old executor made them —
// in the project tree, published on main — then inventoried (dry run),
// migrated, migrated again, interrupted and resumed; the incident's held
// plan-only run stays held and readable without reserving its project.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { inventory, migrate } from '../server/migrate.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, readRunFile, runOp, runResponse } from '../server/runs.ts'
import { copyDir, reserve, runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { EntryMeta, OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-migrate-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: default}
id: experiment
name: Experiment
intent: |
  Plan an experiment, then run it.
execution: {agent: lab-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  run:
    type: do
    description: Run it.
edges: []
`

let n = 0
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-lab')
  const r = await createProject({ dir, id: 'lab', name: 'Lab', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'experiment.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', 'pj-lab.git')
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  await writeFile(join(area, 'zulip.json'), JSON.stringify({ enabled: true, zulipUrl: 'https://z.example', viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Test Person' }))
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, remote, ws, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>
const op = (s: S, ref: RunRef, o: OpInput & EntryMeta, by = 'lab-agent', via = 'cli') => runOp(s.ws, ref, o, { by, via })
// What the old executor's checkpoints did: commit the project tree on main and push.
const publishOld = async (s: S, message: string) => { await gitOk(s.dir, ['add', '-A', 'devdocs']); await gitOk(s.dir, ['commit', '-q', '-m', message]); await gitOk(s.dir, ['push', '-q', 'origin', 'main']) }

// The pre-p9 state: four runs in the project tree, as the old executor left them.
async function preP9(s: S) {
  const make = (text: string, executor: { host: string } | { name: string; backend: null } = { host: 'autolab' }) => createRun(s.ws, { workflow: 'experiment', input: { kind: 'braindump', text, author: 'iwaag' }, executor, by: 'iwaag', via: 'browser' }).then(r => r.ref)
  // run-001: the incident — planned, asked, answered "hold", stopped before agreement.
  const held = await make('Reproduce step 1.')
  await op(s, held, { op: 'attempt.begin', attempt: 'aold-000001', reason: 'start' }, 'autolab', 'exec')
  await op(s, held, { op: 'node.start', node: '_plan', attempt: 'aold-000001' })
  await writeFile(join(s.dir, 'devdocs/runs/experiment/run-001/plan.md'), '# Plan\n\nCopy p2 into lab/ and run it.\n')
  await op(s, held, { op: 'question.ask', question: '', node: '_plan', text: 'Agree?', to: 'iwaag', attempt: 'aold-000001' })
  await op(s, held, { op: 'attempt.end', attempt: 'aold-000001', outcome: 'exited' }, 'autolab', 'exec')
  await publishOld(s, 'experiment/run-001: after attempt aold-000001: awaiting-person')
  await op(s, held, { op: 'question.answer', question: 'q1', text: 'ちょっと事情が変わりました、この実験を保留としてください。' }, 'iwaag', 'browser')
  await op(s, held, { op: 'attempt.begin', attempt: 'aold-000002', reason: 'resume' }, 'autolab', 'exec')
  await op(s, held, { op: 'question.take-up', question: 'q1', attempt: 'aold-000002' })
  await op(s, held, { op: 'run.stop', reason: 'iwaag asked to hold' }, 'iwaag', 'cli')
  await op(s, held, { op: 'attempt.end', attempt: 'aold-000002', outcome: 'stopped' }, 'autolab', 'exec')
  await publishOld(s, 'experiment/run-001: after attempt aold-000002: stopped')
  // run-002: waiting for an answer, published.
  const waiting = await make('Another experiment.')
  await op(s, waiting, { op: 'attempt.begin', attempt: 'aold-000003', reason: 'start' }, 'autolab', 'exec')
  await op(s, waiting, { op: 'node.start', node: '_plan', attempt: 'aold-000003' })
  await writeFile(join(s.dir, 'devdocs/runs/experiment/run-002/plan.md'), '# Plan 2\n')
  await op(s, waiting, { op: 'question.ask', question: '', node: '_plan', text: 'Agree?', to: 'iwaag', attempt: 'aold-000003' })
  await op(s, waiting, { op: 'attempt.end', attempt: 'aold-000003', outcome: 'exited' }, 'autolab', 'exec')
  await publishOld(s, 'experiment/run-002: after attempt aold-000003: awaiting-person')
  // run-003: cancelled (terminal). run-004: an IDE agent's own run in progress.
  const cancelled = await make('Not wanted.')
  await op(s, cancelled, { op: 'run.cancel', reason: 'not wanted' }, 'iwaag', 'browser')
  const ide = await make('Omni works on it in the IDE.', { name: 'Omni Agent', backend: null })
  await op(s, ide, { op: 'node.start', node: '_plan' }, 'Omni Agent')
  await publishOld(s, 'runs 003 and 004')
  // run-002's last record (a note) was never published: its old checkpoint failed.
  await op(s, waiting, { op: 'node.progress', node: '_plan', text: 'waiting on iwaag' }, 'lab-agent')
  s.x.db.prepare('INSERT INTO checkpoints (workspace, workflow, run, kind, attempt, state, created, updated, steps, baseline) VALUES (?, ?, ?, ?, NULL, \'failed\', ?, ?, \'[]\', \'{}\')').run('lab', 'experiment', 'run-002', 'after attempt aold-000003: awaiting-person', new Date().toISOString(), new Date().toISOString())
  // And something of unknown origin in the project workspace.
  await writeFile(join(s.dir, 'scratch.txt'), 'whose is this?\n')
  return { held, waiting, cancelled, ide }
}

test('dry run, migration and again: non-terminal host runs move into their copies without changing their meaning; nothing is queued, resumed or announced', async () => {
  const s = await setup()
  const r = await preP9(s)
  const mainBefore = (await gitOk(s.remote, ['rev-parse', 'main'])).trim()
  const n1 = new NotifyStore({ area: s.area, registryFile: s.registry, exec: s.x })
  await n1.scan()
  const outboxBefore = n1.outbox().map(o => o.id).sort()
  n1.close()
  const before = { held: (await readRun(s.ws, r.held)).record!, waiting: (await readRun(s.ws, r.waiting)).record! }
  // The dry run: an inventory; nothing changes.
  const inv = await inventory(s.x)
  assert.deepEqual(inv.runs.map(x => [x.ref, x.action]), [['experiment/run-001', 'migrate'], ['experiment/run-002', 'migrate'], ['experiment/run-003', 'keep-terminal'], ['experiment/run-004', 'keep-ide']])
  assert.match(inv.runs[0].why, /held \(stopped\)/)
  assert.deepEqual(inv.runs[1].checkpoints.map(c => c.state), ['failed'])
  assert.deepEqual(inv.unattributed, [{ workspace: 'lab', paths: ['scratch.txt'] }])
  assert.equal(await stat(join(s.dir, '.local', 'wfe', 'runs', 'experiment')).then(() => true, () => false), false, 'the dry run makes no copy')
  // The migration (the executor is not running in this fixture).
  const res = await migrate(s.x, { by: 'Omni Agent (migration)' })
  assert.deepEqual(res.migrated, ['lab/experiment/run-001', 'lab/experiment/run-002'])
  assert.deepEqual(res.kept.map(k => k.split(':')[0]), ['lab/experiment/run-003', 'lab/experiment/run-004'])
  assert.match(res.problems.join('\n'), /uncommitted files outside run folders, not moved \(their owner is not recorded\): scratch\.txt/)
  for (const f of ['exec.sqlite', 'registry.json', 'zulip.json', 'refs-lab.txt', 'inventory.json']) assert.ok(await stat(join(res.backup, f)).then(() => true, () => false), `recovery copy ${f}`)
  // Meaning unchanged: nodes, questions, hold, attempts; only the storage is new.
  for (const [ref, was] of [[r.held, before.held], [r.waiting, before.waiting]] as const) {
    const now = (await readRun(s.ws, ref)).record!
    assert.equal((await runSpace(s.ws, ref)).copyOf?.ref.run, ref.run, `${ref.run} lives in its copy`)
    assert.equal(now.storage?.branch, `wfe/lab/experiment/${ref.run}`)
    assert.deepEqual(now.history.at(-1)!.op, 'run.relocate')
    assert.equal(now.seq, was.seq + 1)
    const strip = (x: typeof now) => ({ nodes: x.nodes, questions: x.questions, hold: x.control.hold, attempts: x.control.attempts, decisions: x.decisions, execution: x.execution })
    assert.deepEqual(strip(now), strip(was))
  }
  assert.equal((await readRun(s.ws, r.waiting)).record!.nodes._plan.notes.at(-1)?.text, 'waiting on iwaag', 'the unpublished last record moved with the run')
  const view = await s.x.runView('lab', r.held)
  assert.equal(view.jobs.filter(j => j.state === 'queued').length, 0, 'nothing is queued')
  assert.deepEqual(await s.x.claim('t'), { idle: 'no queued job' })
  assert.equal((await gitOk(s.remote, ['rev-parse', 'main'])).trim(), mainBefore, 'what was published stays as it is')
  assert.equal(await readFile(join(s.dir, 'scratch.txt'), 'utf8'), 'whose is this?\n', 'the stray file is untouched')
  // No duplicate notifications: the same outbox.
  const n2 = new NotifyStore({ area: s.area, registryFile: s.registry, exec: s.x })
  await n2.scan()
  assert.deepEqual(n2.outbox().map(o => o.id).sort(), outboxBefore)
  n2.close()
  // Terminal and IDE runs read as before, from the project tree.
  assert.equal((await runSpace(s.ws, r.cancelled)).root, s.ws.root)
  assert.equal((await readRun(s.ws, r.ide)).record!.executor.name, 'Omni Agent')
  // The old failed checkpoint keeps its mode: a retry publishes the project workspace's main, never a run branch.
  const cp = s.x.runView('lab', r.waiting).then(v => v.checkpoints[0])
  assert.equal((await cp).mode ?? null, null)
  const retried = await s.x.publishCheckpoint((await cp).id)
  assert.equal(retried.state, 'published', retried.error ?? '')
  assert.match(await gitOk(s.remote, ['log', '-1', '--format=%s', 'main']), /experiment\/run-002: after attempt aold-000003/)
  assert.notEqual((await gitOk(s.remote, ['for-each-ref', 'refs/heads/wfe/'])).trim().length > 0, true, 'no run branch was published by the old checkpoint')
  // Twice: the same result, nothing more written.
  const seqs = [(await readRun(s.ws, r.held)).record!.seq, (await readRun(s.ws, r.waiting)).record!.seq]
  const again = await migrate(s.x, { by: 'Omni Agent (migration)' })
  assert.deepEqual([again.migrated, again.already], [[], ['lab/experiment/run-001', 'lab/experiment/run-002']])
  assert.deepEqual([(await readRun(s.ws, r.held)).record!.seq, (await readRun(s.ws, r.waiting)).record!.seq], seqs)
})

test('the held incident run after migration: held, its plan readable, history links work, and its project takes new requests', async () => {
  const s = await setup()
  const r = await preP9(s)
  const published = (await gitOk(s.dir, ['rev-parse', 'HEAD~2'])).trim() // "after attempt aold-000002: stopped"
  await migrate(s.x, { by: 'Omni Agent (migration)' })
  const rec = (await readRun(s.ws, r.held)).record!
  assert.deepEqual([rec.control.hold?.kind, rec.questions.q1.answers[0].text], ['stopped', 'ちょっと事情が変わりました、この実験を保留としてください。'])
  assert.equal((await readRunFile(s.ws, r.held, 'plan.md')).text, '# Plan\n\nCopy p2 into lab/ and run it.\n')
  const hist = await runResponse(s.ws, r.held, { rev: published })
  assert.equal(hist.record?.control.hold?.kind, 'stopped', 'a history view of an old commit still resolves (in the run\'s copy)')
  // A new request in the same project: created, claimed, executed; the held run stays held.
  const b = await s.x.request({ workspace: 'lab', workflow: 'experiment', text: 'A new study.', author: 'iwaag', receipt: 'after-migration-0001', via: 'browser' })
  assert.equal(b.ref.run, 'run-005', 'numbering continues past every recorded run')
  const c = await s.x.claim('t')
  assert.ok('attempt' in c && c.ref.run === 'run-005')
  assert.equal((await readRun(s.ws, r.held)).record!.control.hold?.kind, 'stopped')
  // Resuming it later is the person's act; it continues in its copy.
  s.x.started(c.attempt.id, process.pid)
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  await s.x.resume(s.ws, r.held, 'iwaag', 'circumstances are back', 'browser')
  const c2 = await s.x.claim('t')
  assert.ok('attempt' in c2 && c2.ref.run === 'run-001')
  assert.equal(c2.cwd, (await runSpace(s.ws, r.held)).root)
  assert.equal(await readFile(join(c2.cwd, 'devdocs/runs/experiment/run-001/plan.md'), 'utf8'), '# Plan\n\nCopy p2 into lab/ and run it.\n')
})

test('an interrupted migration continues: a copy reserved before a crash is finished, not duplicated', async () => {
  const s = await setup()
  const r = await preP9(s)
  // The crash: the run's copy was reserved, nothing else happened (and no journal).
  await reserve(s.ws, { project: 'lab', workflow: 'experiment', name: 'run-001', receipt: 'migrate:lab/experiment/run-001', adopt: true })
  const inv = await inventory(s.x)
  assert.match(inv.runs.find(x => x.ref === 'experiment/run-001')!.why, /an interrupted migration: continues/)
  const res = await migrate(s.x, { by: 'Omni Agent (migration)' })
  assert.deepEqual(res.migrated, ['lab/experiment/run-001', 'lab/experiment/run-002'])
  assert.equal((await readRun(s.ws, r.held)).record!.storage?.branch, 'wfe/lab/experiment/run-001')
  assert.ok(await stat(join(copyDir(s.ws, r.held), 'tree', '.git')).then(() => true, () => false))
  // A refusal: the executor is reporting.
  s.x.heartbeat('autolab', process.pid, 'idle')
  await assert.rejects(migrate(s.x, { by: 'x' }), /the executor reported within the last 45 s; stop it/)
})
