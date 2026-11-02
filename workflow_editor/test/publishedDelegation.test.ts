// improve_wfrun p1: delegating to a published workflow. The kid project's
// workflow is on its default branch while its registered workspace is
// behind (the gimmickimg case); the parent dispatches to it, the dispatch
// records the target's revision, and the child is created from that
// revision even when the kid's default branch moves on before the request
// post is delivered. A repeated delivery creates no second child.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitOk } from '../server/git.ts'
import { listRuns, runOp } from '../server/runs.ts'
import { readCopy, runSpace } from '../server/runspace.ts'
import { KID_STREAM, KID_WF, delegationSuite, dispatched, rec, setup } from './delegateFixture.ts'

delegationSuite('wfe-pubdelegate-')

const head = (dir: string, ref = 'HEAD') => gitOk(dir, ['rev-parse', ref]).then(s => s.trim())

test('a stale target workspace: dispatch reaches the published workflow, records its revision, and a delayed post creates exactly one child from it', async () => {
  const s = await setup({ published: true })
  const kidRemote = join(s.area, 'kid.git')
  // The kid's workspace goes back to before make.yaml: the workflow exists only on Gitea.
  await gitOk(s.kid.root, ['reset', '-q', '--hard', 'HEAD~1'])
  assert.ok(!(await s.kid.workflowSummaries()).list.some(w => w.id === 'make'), 'the workspace lacks the workflow')
  const before = await gitOk(s.kid.root, ['for-each-ref', '--format=%(refname) %(objectname)'])
  const published = await head(kidRemote, 'main')
  const { ref, a, d1 } = await dispatched(s)
  assert.deepEqual(d1.delegation.target, {
    project: 'kid', workflow: 'make', workspace: s.kid.reg.id,
    source: { kind: 'published', repository: 'dev/pj-kid', branch: 'main', commit: published, definitions: { path: 'devdocs/workflows', repository: 'dev/pj-kid', commit: published } },
  })
  // The parent itself was created from par's published source.
  const parent = await rec(s.par, ref)
  assert.equal(parent.definition.source?.kind, 'published')
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  // The kid's default branch moves on before the request post is delivered.
  const other = await mkdtemp(join(tmpdir(), 'wfe-pubdelegate-push-'))
  await gitOk(other, ['clone', '-q', kidRemote, 'c'])
  await writeFile(join(other, 'c', 'devdocs', 'workflows', 'make.yaml'), KID_WF.replace('Make what is asked.', 'Changed after the dispatch.'))
  await gitOk(join(other, 'c'), ['commit', '-q', '-am', 'later']); await gitOk(join(other, 'c'), ['push', '-q', 'origin', 'HEAD:main'])
  assert.notEqual(await head(kidRemote, 'main'), published)
  await s.zulip.cycle()
  const runs = await listRuns(s.kid)
  assert.equal(runs.length, 1, JSON.stringify(runs))
  const childRef = { workflow: runs[0].workflow, run: runs[0].run }
  const child = await rec(s.kid, childRef)
  assert.equal(child.definition.source?.kind === 'published' && child.definition.source.commit, published, 'the dispatched revision, not the newer default branch')
  assert.equal(child.definition.source?.kind === 'published' && child.definition.source.selector, 'commit')
  const copy = (await readCopy(s.kid, childRef))!
  assert.equal(copy.manifest!.repositories[0].base, published)
  const frozen = await readFile(join((await runSpace(s.kid, childRef)).root, 'devdocs', 'runs', 'make', childRef.run, 'definition', 'make.yaml'), 'utf8')
  assert.doesNotMatch(frozen, /Changed after the dispatch/)
  assert.equal(frozen, await readFile(join(copy.tree, 'devdocs', 'workflows', 'make.yaml'), 'utf8'))
  // Bound to the parent; a repeated delivery adds nothing.
  assert.equal((await rec(s.par, ref)).delegations!.d1.child?.run, childRef.run)
  const post = s.zulip.posts.find(p => p.streamId === KID_STREAM)!
  s.i.receive({ realm: post.realm, streamId: KID_STREAM, through: post.id, messages: [JSON.parse(JSON.stringify(post))] })
  await s.zulip.cycle()
  assert.equal((await listRuns(s.kid)).length, 1, 'one child')
  assert.equal(await gitOk(s.kid.root, ['for-each-ref', '--format=%(refname) %(objectname)']), before, 'the kid workspace refs are unchanged')
  s.i.close(); s.n.close(); s.x.close()
})

test('a dispatch to a workflow that is not on the target\'s default branch is refused with the revision it looked at', async () => {
  const s = await setup({ published: true, parent: undefined })
  // Only the workspace has it: an uncommitted, unpublished workflow.
  await gitOk(join(s.area, 'pj-kid'), ['rm', '-q', 'devdocs/workflows/make.yaml'])
  await gitOk(join(s.area, 'pj-kid'), ['commit', '-q', '-m', 'drop make'])
  await gitOk(join(s.area, 'pj-kid'), ['push', '-q', 'origin', 'HEAD:main'])
  await writeFile(join(s.area, 'pj-kid', 'devdocs', 'workflows', 'make.yaml'), KID_WF)
  await assert.rejects(dispatched(s), /project kid at dev\/pj-kid@[0-9a-f]{10} has no workflow "make" \(a workflow is offered once it is on the default branch\)/)
  s.i.close(); s.n.close(); s.x.close()
})

test('live discovery: a workflow integrated while the service runs gets its channel target and, once provisioned, its route — without a restart or a workspace pull', async () => {
  const s = await setup({ published: true })
  const kidRemote = join(s.area, 'kid.git')
  const other = await mkdtemp(join(tmpdir(), 'wfe-pubdelegate-live-'))
  await gitOk(other, ['clone', '-q', kidRemote, 'c'])
  await writeFile(join(other, 'c', 'devdocs', 'workflows', 'animate.yaml'), KID_WF.replace('id: make', 'id: animate').replace('name: Make', 'name: Animate'))
  await gitOk(join(other, 'c'), ['add', '-A']); await gitOk(join(other, 'c'), ['commit', '-q', '-m', 'animate']); await gitOk(join(other, 'c'), ['push', '-q', 'origin', 'HEAD:main'])
  // As the executor does after integrating: the caches are due.
  const { invalidate } = await import('../server/access.ts')
  await invalidate(s.x.accessContext(), 'kid')
  await s.n.scan()
  assert.equal(s.n.target('channel:kid/animate')?.state, 'pending', 'the notifier owes its channel')
  const pending = await s.i.routes()
  assert.ok(!('disabled' in pending))
  assert.ok(pending.problems.some(p => p === 'intake: kid/animate: its channel is not provisioned yet (the notifier creates it)'), JSON.stringify(pending.problems))
  s.n.recordTarget('channel:kid/animate', { zulipId: 702 })
  const routed = await s.i.routes()
  assert.ok(!('disabled' in routed))
  assert.ok(routed.routes.some(r => r.project === 'kid' && r.workflow === 'animate' && r.streamId === 702))
  assert.ok(!(await s.kid.workflowSummaries()).list.some(w => w.id === 'animate'), 'the workspace was not pulled')
  s.i.close(); s.n.close(); s.x.close()
})

test('the result evidence says which workflow and revision the child ran, against the dispatched one', async () => {
  const { ranLine } = await import('../shared/assessment.ts')
  const d = { target: { project: 'kid', workflow: 'make', workspace: 'kid', source: { kind: 'published', repository: 'dev/pj-kid', branch: 'main', commit: 'a'.repeat(40), definitions: null } } } as never
  const child = (source: unknown, workflow = 'make') => ({ project: 'kid', workflow, run: 'run-001', definition: { source } }) as never
  const pub = (commit: string) => ({ kind: 'published', project: 'kid', selector: 'commit', repository: 'dev/pj-kid', branch: 'main', commit, definitions: null, fetch: { state: 'fresh', at: '' } })
  assert.equal(ranLine(d, child(pub('a'.repeat(40)))), 'kid/make (run-001) with the published definition and code of dev/pj-kid@aaaaaaaaaa, the revision dispatched')
  assert.match(ranLine(d, child(pub('b'.repeat(40))))!, /not the dispatched aaaaaaaaaa/)
  assert.match(ranLine(d, child(pub('a'.repeat(40)), 'freework'))!, /^kid\/freework \(run-001\), not the dispatched kid\/make/)
  assert.match(ranLine(d, child(undefined))!, /not recorded/)
})

// improve_wfrun p2 step 4: a workflow a run adds, validated where it lands
// (gimmickimg freework/run-018 added an invalid one and finished unaware).
const REVIEW_CONFIRMS = (id: string) => KID_WF.replace('id: make', `id: ${id}`).replace('name: Make', `name: ${id}`).replace('intake: {zulip: requests}\n', '').replace('    type: do\n    description: Build it.', '    type: review\n    description: Build it.\n    confirms: result')

async function addWorkflow(s: Awaited<ReturnType<typeof setup>>, receipt: string, file: string, text: string) {
  const { ref } = await s.x.request({ workspace: s.kid.reg.id, workflow: 'make', text: 'Add a workflow.', author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  const say = (o: object) => runOp(s.kid, ref, { ...o, attempt: c.attempt.id } as never, { by: 'kid-agent', via: 'cli' })
  await say({ op: 'node.start', node: 'scope' }); await say({ op: 'node.complete', node: 'scope', outcome: 'small' })
  await say({ op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'devdocs/workflows', file), text)
  await say({ op: 'node.complete', node: 'build', outcome: 'added' })
  for (const id of Object.keys((await rec(s.kid, ref)).nodes)) if ((await rec(s.kid, ref)).nodes[id].state === 'pending') { await say({ op: 'node.start', node: id }); await say({ op: 'node.complete', node: id, outcome: 'done' }) }
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  await runOp(s.kid, ref, { op: 'run.decide', decision: 'accepted', evidence: 'looked at it' } as never, { by: 'Test Person', via: 'browser' })
  await s.x.afterDecision(s.kid, ref, 'accepted')
  const r = await s.x.integrateRun(s.kid, ref, { by: 'test', via: 'test' })
  assert.equal(r.state, 'integrated', r.error)
  return { ref, record: await rec(s.kid, ref) }
}

test('an invalid workflow a run adds is integrated and reported against the integrated revision, not the stale workspace; a valid one reads valid; a check that cannot finish is no verdict', async () => {
  const s = await setup({ published: true })
  const bad = await addWorkflow(s, 'definition-bad', 'partial.yaml', REVIEW_CONFIRMS('partial'))
  const check = bad.record.integrations![0].definitions!
  assert.equal(check.state, 'invalid', JSON.stringify(check))
  assert.equal(check.findings[0].file, 'partial.yaml')
  assert.match(check.findings[0].issues!.join(), /confirms the result but is "review"; only a talk node asks the person/)
  assert.equal(check.revision, await head(join(s.area, 'kid.git'), 'main'))
  assert.ok(!(await s.kid.workflowSummaries()).list.some(w => w.id === 'partial'), 'the editing workspace never had it: only the integrated revision did')
  const told = bad.record.history.find(h => h.op === 'run.integrate') as unknown as { definitions: { state: string } }
  assert.equal(told.definitions.state, 'invalid', 'in the record, so its replay and its timeline keep it')
  // No approval gate: the run stays integrated, and the record replays.
  assert.equal(bad.record.integrations!.length, 1)
  const good = await addWorkflow(s, 'definition-good', 'fine.yaml', KID_WF.replace('id: make', 'id: fine').replace('name: Make', 'name: Fine'))
  assert.equal(good.record.integrations![0].definitions!.state, 'valid')
  // Peers unavailable: neither valid nor invalid.
  const orig = s.x.accessContext.bind(s.x)
  const { checkDefinitions } = await import('../server/definitionCheck.ts')
  const broken = await checkDefinitions({ ...orig(), registryFile: join(s.area, 'no-such-registry.json') }, s.kid.reg, await head(join(s.area, 'kid.git'), 'main'), [{ file: 'fine.yaml', status: 'A' }])
  assert.equal(broken!.state, 'incomplete', JSON.stringify(broken))
  assert.notEqual(broken!.findings[0].state, 'invalid')
  assert.match(broken!.detail ?? '', /cannot be read/)
})
