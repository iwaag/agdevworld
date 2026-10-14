// project_migration p3/ex1: one approval path. A result changed after its
// acceptance asks for renewed acceptance (said as such, with the control
// beside it); the same result is never accepted or integrated twice, by the
// person's own decision or from a confirmation answer, while a changed one
// is accepted again; the latest decision's integration is the status, in the
// run view and in `wfe run integrate --status`, and the executor's queue
// never lets an older row overwrite it.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, Question, RunRecord, RunRef } from '../shared/run.ts'
import { approvalOf, integrationStatus } from '../shared/approval.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-approval-state-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Build it and confirm it with the person.
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build.
  confirm:
    type: talk
    confirms: result
    description: Present the result.
edges:
  - {from: build, to: confirm}
`

let n = 0
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-a${n}`)
  const id = `a${n}`
  const r = await createProject({ dir, id, name: `A${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await writeFile(join(dir, 'app.txt'), 'start\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-a${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote], { config: LOCAL_TRANSPORT }); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, remote, ws, id, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>
const PLACE = { kind: 'run-copy' as const, branch: null }
const review = (q: Question) => q.node === 'confirm'
const record = async (s: S, ref: RunRef) => (await readRun(s.ws, ref)).record!
const view = (s: S, ref: RunRef) => ({ integrations: s.x.integrations(s.id, ref).map(i => ({ ...i, steps: JSON.parse(i.steps) })) })
const approval = async (s: S, ref: RunRef) => approvalOf(await record(s, ref), view(s, ref), PLACE, review)

// A run whose confirmation is answered "ok" and taken up: the executor records
// the acceptance from it. `afterAcceptance` edits the copy before the run ends.
async function confirmed(s: S, receipt: string, afterAcceptance?: (cwd: string) => Promise<void>) {
  const { ref } = await s.x.request({ workspace: s.id, workflow: 'ship', text: 'Build it.', author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  const A = c.attempt.id
  const op = (o: OpInput) => runOp(s.ws, ref, { ...o, attempt: A }, { by: 'autolab', via: 'cli' })
  await op({ op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'app.txt'), 'built\n')
  await op({ op: 'node.complete', node: 'build', outcome: 'built' })
  await op({ op: 'node.start', node: 'confirm' })
  await op({ op: 'question.ask', question: '', node: 'confirm', text: 'Is app.txt right?', to: 'Test Person', subjects: ['app.txt'] })
  assert.equal((await approval(s, ref)).kind, 'review', 'an open confirmation is a review, answered — not a direct acceptance')
  assert.equal((await approval(s, ref)).canAccept, false)
  await runOp(s.ws, ref, { op: 'question.answer', question: 'q1', text: 'ok' }, { by: 'Test Person', via: 'browser' })
  const waiting = await approval(s, ref)
  assert.deepEqual([waiting.kind, waiting.chip, waiting.canAccept], ['answered', 'Answer recorded · waiting for autolab', false], 'a recorded answer waiting for the agent is its own state')
  await op({ op: 'question.take-up', question: 'q1' })
  await op({ op: 'run.decide', decision: 'accepted', question: 'q1' })
  if (afterAcceptance) await afterAcceptance(c.cwd)
  await op({ op: 'node.complete', node: 'confirm', outcome: 'confirmed' })
  await s.x.finished(A, { code: 0, signal: null })
  return { ref, cwd: c.cwd }
}
const accept = (s: S, ref: RunRef, evidence = 'looked at it') => runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', evidence }, { by: 'Test Person', via: 'browser' })
  .then(async r => { await s.x.afterDecision(s.ws, ref, 'accepted'); return r })

test('renewed acceptance: a result changed after the confirmation\'s acceptance is said as needing acceptance again, with the files and the control; accepting it again integrates', async () => {
  const s = await setup()
  const { ref, cwd } = await confirmed(s, 'ap-renew-0001', cwd => writeFile(join(cwd, 'devdocs/runs/ship/run-001/report.md'), 'written after the acceptance\n'))
  void cwd
  await s.x.integrateDue()
  const a = await approval(s, ref)
  assert.equal(a.kind, 'reaccept')
  assert.equal(a.chip, 'Changed since acceptance — accept again', 'the header does not say an unqualified Accepted')
  assert.equal(a.canAccept, true, 'the renewed-acceptance control is offered')
  assert.deepEqual(a.integration?.changed, ['devdocs/runs/ship/run-001/report.md'], 'what changed is named for the person to look at')
  const r = await accept(s, ref, 'read report.md')
  assert.equal(r.record.decisions.length, 2)
  assert.equal((await approval(s, ref)).kind, 'integrating')
  await s.x.integrateDue()
  const done = await approval(s, ref)
  assert.deepEqual([done.kind, done.chip, done.canAccept, done.integration?.text], ['integrated', 'Accepted · integrated', false, 'Integrated into main'])
  assert.equal(await gitOk(s.remote, ['show', 'main:devdocs/runs/ship/run-001/report.md']), 'written after the acceptance\n')
})

test('duplicate acceptance: the same result is refused by the person\'s decision after a confirmation\'s, before and after integration; nothing is queued; a changed result is accepted again', async () => {
  const s = await setup()
  const { ref, cwd } = await confirmed(s, 'ap-dup-0001')
  assert.equal((await approval(s, ref)).canAccept, false, 'an accepted result offers no acceptance')
  await assert.rejects(accept(s, ref), (e: Error & { detail?: { code?: string } }) => e.detail?.code === 'already-accepted' && /already accepted \(decision 0.*from q1\).*nothing was recorded/.test(e.message))
  assert.equal((await record(s, ref)).decisions.length, 1, 'no second decision')
  assert.deepEqual(s.x.integrations(s.id, ref).map(i => [i.decision, i.state]), [[0, 'queued']], 'no second integration')
  await s.x.integrateDue()
  assert.equal((await record(s, ref)).integrations?.length, 1)
  await assert.rejects(accept(s, ref), /already accepted/, 'still refused once integrated (run.json changed, the result did not)')
  assert.equal((await record(s, ref)).decisions.length, 1)
  // A changed result is a new acceptance, integrated on its own.
  await writeFile(join(cwd, 'app.txt'), 'changed later\n')
  await accept(s, ref, 'looked at the change')
  assert.equal((await record(s, ref)).decisions.length, 2)
  await s.x.integrateDue()
  const rec = await record(s, ref)
  assert.deepEqual(rec.integrations?.map(i => i.decision), [0, 1])
  assert.equal(await gitOk(s.remote, ['show', 'main:app.txt']), 'changed later\n')
})

test('the latest integration is the status: an older needs-agreement row and a stale queue never contradict it, in the view or in integrate --status', async () => {
  const s = await setup()
  const { ref, cwd } = await confirmed(s, 'ap-latest-0001', cwd => writeFile(join(cwd, 'app.txt'), 'edited after acceptance\n'))
  await s.x.integrateDue()
  assert.deepEqual(s.x.integrations(s.id, ref).map(i => i.state), ['needs-agreement'])
  // Two acceptances queued before the executor's next pass (as provide/run-002
  // had): the older row is superseded, the latest integrated, and it stays so.
  await writeFile(join(cwd, 'app.txt'), 'edited once more\n')
  await accept(s, ref, 'first look')
  await writeFile(join(cwd, 'app.txt'), 'final\n')
  await accept(s, ref, 'second look')
  await s.x.integrateDue()
  assert.deepEqual(s.x.integrations(s.id, ref).map(i => [i.decision, i.state]), [[0, 'needs-agreement'], [1, 'superseded'], [2, 'integrated']])
  const rec: RunRecord = await record(s, ref)
  assert.deepEqual(rec.integrations?.map(i => i.decision), [2])
  assert.equal(integrationStatus(rec, view(s, ref), PLACE)?.text, 'Integrated into main')
  const { main } = await import('../cli/wfe.ts')
  const out: string[] = []
  const log = console.log
  console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
  try { assert.equal(await main(['run', 'integrate', 'ship/run-001', '--status', '--workspace', s.id, '--registry', s.registry, '--area', s.area]), 0) } finally { console.log = log }
  const text = out.join('\n')
  assert.match(text.split('\n')[0], /^Now: Integrated into main \(decision 2, accepted by Test Person\)/, 'the current standing comes first')
  assert.match(text, /Journal \(newest first\):\nIntegration 3 of decision 2: integrated/)
  assert.match(text, /Integration 1 of decision 0: needs-agreement .*\[earlier decision; decision 2 is the latest\]/)
})
