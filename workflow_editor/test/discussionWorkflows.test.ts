// argue p4 ex3 (docs/discussions.md *Workflows in a discussion*): which
// workflow a discussion turn referenced, created, edited or executed, at the
// exact version, recorded once, after the operation succeeded, with
// interrupted operations resolved from their own evidence; versions read from
// their captured bytes and checked, compared by node id and edge; the
// conductor's own graph kept apart as progression; the archive carrying the
// records and the bytes; nothing dispatched by any of it.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { DiscussionArchive } from '../server/discussionArchive.ts'
import { DiscussionStore } from '../server/discussions.ts'
import { compareWorkflows, DiscussionWorkflows, type Turn } from '../server/discussionWorkflows.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import type { RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-dwf-ex3-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const CONDUCT = `schema: ag.workflow.v2
id: conduct
name: Conduct
intent: |
  Conduct a discussion.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ponderer-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  ponder:
    type: do
    activity: ponder
    description: Decide.
`
const DISCUSS = (agent: string) => `schema: ag.workflow.v2
id: discuss
name: discuss
intent: |
  Speak in a discussion.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ${agent}}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Speak.
`
const PROVIDE = `schema: ag.workflow.v2
id: provide
name: 画像の手配
intent: |
  Provide an image.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: forge-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  gather:
    type: study
    name: 参考資料を集める
    description: Gather references.
  make:
    type: do
    name: 画像を作る
    description: Make it.
edges:
  - {from: gather, to: make}
`

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  for (const [id, files] of [['ponderer', [['conduct', CONDUCT]]], ['forge', [['discuss', DISCUSS('forge-agent')], ['provide', PROVIDE]]], ['archive', [['synthesize', DISCUSS('archive-agent').replace(/discuss/g, 'synthesize')]]]] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    for (const [wf, text] of files) await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), text)
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  }
  const bare = join(area, 'archive-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
  await gitOk(join(area, 'pj-archive'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-archive'), ['remote', 'add', 'origin', bare])
  await gitOk(join(area, 'pj-archive'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat', targets: [],
    discussions: { facilitator: { workspace: 'ponderer', workflow: 'conduct' }, participants: [{ workspace: 'forge', workflow: 'discuss' }, { workspace: 'archive', workflow: 'synthesize' }], archive: { workspace: 'archive' } },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new DiscussionStore(cs)
  const wfs = new DiscussionWorkflows(ds)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, x, cs, ds, wfs, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const ref = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow, run: r } }
const op = (s: S, run: string, o: Parameters<typeof runOp>[2], by = 'exec') => runOp(s.ws(run.split('/')[0]), ref(run), o, { by, via: 'cli' })
const P = 'ponderer/conduct/run-001'
// Everything that would be work: messages, invitations, queued jobs, the
// discussion's order.
const work = (s: S, conv: string) => ({
  messages: s.cs.messages(conv).length, invitations: s.ds.invitations(conv).length,
  jobs: (s.x.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n, updated: s.cs.conversation(conv)!.updated, state: s.cs.conversation(conv)!.state,
})

async function opened(s: S, conv: string) {
  s.ds.create(conv, { title: 'Which workflow?', by: 'Pat', members: ['forge'] })
  const brief = (await s.ds.post(conv, { text: 'How does forge provide an image?', author: 'Pat', token: `tok-${conv}-001` })).message
  s.x.db.prepare('UPDATE jobs SET state = \'done\'').run()
  return brief
}
const turnOf = (conv: string, run: string, attempt: string, actor: string): Turn => ({ conv, run, attempt, actor, invitation: null, origin: null })

test('the conductor\'s revision is recorded once as progression with its ponder activity, before and after captured; the pinned graph replays the node states of that point', async () => {
  const s = await setup()
  const brief = await opened(s, 'wf-a')
  await op(s, P, { op: 'attempt.begin', attempt: 'a1', reason: 'test' } as never)
  const d = await s.ds.ponder('wf-a', { run: P, attempt: 'a1', author: 'ponderer-agent', node: 'ponder', decision: 'Ask forge.', sources: [brief.id], next: [{ activity: 'ask', node: 'ask-forge' }, { activity: 'ponder', node: 'after-forge' }] })
  assert.equal(d.revision, 'r2')
  const rows = s.wfs.rows('wf-a').map(r => s.wfs.view(r))
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.deepEqual([r.relation, r.role, r.target, r.activity, r.attempt, r.evidence, r.before?.revision, r.after?.revision], ['edited', 'progression', { kind: 'run', run: P }, d.activity.id, 'a1', 'operation', 'r1', 'r2'])
  assert.deepEqual(r.messages, [], 'no message is claimed for it')
  assert.ok(s.wfs.snapshot(r.after!.sha256) && s.wfs.snapshot(r.before!.sha256), 'both versions captured')
  // A repair finds it already recorded (same token): no duplicate.
  await s.wfs.repair({ conv: 'wf-a' })
  assert.equal(s.wfs.rows('wf-a').length, 1)
  const g = await s.wfs.graph('wf-a', r.id)
  assert.deepEqual(g.changes!.added.map(n => n.id), ['after-forge', 'ask-forge'])
  assert.deepEqual(g.changes!.edgesAdded, [['ask-forge', 'after-forge'], ['ponder', 'ask-forge']])
  assert.equal(g.changes!.behavioural, true)
  const st = g.state as { nodes: Record<string, string>; seq: number }
  assert.equal(st.nodes.ponder, 'completed', 'the revision was made at ponder\'s completion, one step with it')
  assert.equal(st.nodes['ask-forge'], 'pending')
  // Later the run moves on; the record's pinned state does not.
  await op(s, P, { op: 'node.start', node: 'ask-forge' } as never, 'ponderer-agent').catch(() => undefined)
  const again = await s.wfs.graph('wf-a', r.id)
  assert.deepEqual(again.state, g.state)
  const cur = await s.wfs.current('wf-a', r.id)
  assert.equal((cur.current as { available: boolean }).available, true)
  s.cs.close(); s.x.close()
})

test('a definition saved from a discussion turn is an edit with the replaced and the saved bytes; a later save does not change it; an unchanged save and a failed save record nothing', async () => {
  const s = await setup()
  await opened(s, 'wf-b')
  const forge = s.ws('forge')
  const turn = turnOf('wf-b', 'forge/discuss/run-001', 'f1', 'forge-agent')
  const before = work(s, 'wf-b')
  const read = await forge.readWorkflowFile('provide.yaml')
  const edit = (f: (w: NonNullable<typeof read.workflow>) => void) => { const w = structuredClone(read.workflow!); f(w); return w }
  const w1 = edit(w => { w.nodes.review = { type: 'talk', name: '結果レビュー', description: 'Review the result.', repositories: [] }; w.edges.push({ from: 'make', to: 'review' }); w.nodes.make.description = 'Make it, then show it.' })
  const j = await s.wfs.beginDefinitionWrite(turn, forge, 'provide.yaml', { operation: 'workflow.save', model: w1 })
  assert.ok(j)
  assert.equal(s.wfs.rows('wf-b').length, 0, 'a journal entry is never shown')
  await forge.saveWorkflow('provide.yaml', w1)
  const rec = (await s.wfs.finishDefinitionWrite(j, forge, 'provide.yaml'))!
  assert.deepEqual([rec.relation, rec.role, rec.before?.kind, rec.after?.kind, rec.state], ['edited', 'subject', 'committed', 'draft', 'recorded'])
  assert.deepEqual(rec.nodes.sort(), ['make', 'review'])
  const g = await s.wfs.graph('wf-b', rec.id)
  assert.deepEqual(g.changes!.added.map(n => [n.id, n.name]), [['review', '結果レビュー']])
  assert.deepEqual(g.changes!.changed.map(n => [n.id, n.props.map(p => p.prop)]), [['make', ['description']]])
  assert.deepEqual(g.changes!.edgesAdded, [['make', 'review']])
  assert.match((g.state as { unavailable: string }).unavailable, /definition has no execution state/)
  // Someone saves again: the record still shows what was saved at that turn.
  const w2 = edit(w => { delete (w.nodes as Record<string, unknown>).gather; w.edges = [] })
  await forge.saveWorkflow('provide.yaml', w2)
  const pinned = await s.wfs.graph('wf-b', rec.id)
  assert.deepEqual(Object.keys(pinned.after.workflow!.nodes).sort(), ['gather', 'make', 'review'])
  const cur = await s.wfs.current('wf-b', rec.id)
  assert.deepEqual(Object.keys((cur.current as { workflow: { nodes: object } }).workflow.nodes).sort(), ['make'], 'current is the file now, labelled apart')
  assert.equal((cur.current as { same: boolean }).same, false)
  // An unchanged save is no edit; a failed one leaves nothing.
  assert.equal(await s.wfs.beginDefinitionWrite(turn, forge, 'provide.yaml', { operation: 'workflow.save', model: (await forge.readWorkflowFile('provide.yaml')).workflow! }), null)
  const j3 = await s.wfs.beginDefinitionWrite(turn, forge, 'provide.yaml', { operation: 'workflow.save', model: w1 })
  s.wfs.abort(j3)
  assert.equal(s.wfs.rows('wf-b').length, 1)
  assert.deepEqual(work(s, 'wf-b'), before, 'recording sent nothing, started nothing, did not move the discussion')
  s.cs.close(); s.x.close()
})

test('an interrupted save is recovered from the file when it holds the saved bytes, otherwise unconfirmed and not shown; a retried operation is one record', async () => {
  const s = await setup()
  await opened(s, 'wf-c')
  const forge = s.ws('forge')
  const turn = turnOf('wf-c', 'forge/discuss/run-001', 'f2', 'forge-agent')
  const w = structuredClone((await forge.readWorkflowFile('provide.yaml')).workflow!)
  w.nodes.make.name = '画像を作って見せる'
  const j1 = await s.wfs.beginDefinitionWrite(turn, forge, 'provide.yaml', { operation: 'workflow.save', model: w })
  assert.equal(await s.wfs.beginDefinitionWrite(turn, forge, 'provide.yaml', { operation: 'workflow.save', model: w }), j1, 'the same operation retried is the same entry')
  await forge.saveWorkflow('provide.yaml', w) // …and the process died before its record
  const w2 = structuredClone((await forge.readWorkflowFile('provide.yaml')).workflow!); w2.intent = 'Something else.'
  const j2 = await s.wfs.beginDefinitionWrite(turn, forge, 'provide.yaml', { operation: 'workflow.save', model: w2 }) // died before the write
  s.ds.db.prepare('UPDATE workflow_refs SET at = ? WHERE state = \'pending\'').run('2026-01-01T00:00:00.000Z')
  const notes = await s.wfs.repair({ conv: 'wf-c' })
  assert.ok(notes.some(n => n.includes(`${j1}: recovered`)), notes.join('\n'))
  assert.ok(notes.some(n => n.includes(`${j2}: unconfirmed`)), notes.join('\n'))
  const shown = s.wfs.rows('wf-c').map(r => s.wfs.view(r))
  assert.deepEqual(shown.map(r => [r.id, r.state]), [[j1, 'recorded'], [j2, 'unconfirmed']])
  assert.match(shown[0].note, /recovered from the file/)
  assert.equal(shown[0].after?.kind, 'draft')
  s.cs.close(); s.x.close()
})

test('an explicit reference names the version WFE read (draft, committed or at a commit) and the nodes meant; it proves retrieval, is idempotent, and refuses a node or message that is not there', async () => {
  const s = await setup()
  const brief = await opened(s, 'wf-d')
  const turn = turnOf('wf-d', 'forge/discuss/run-001', 'f3', 'forge-agent')
  const a = await s.wfs.attach('wf-d', { project: 'forge', workflow: 'provide', nodes: ['gather'], messages: [brief.id], note: 'how references are gathered', turn, author: 'forge-agent' })
  assert.deepEqual([a.ref.relation, a.ref.evidence, a.ref.after?.kind, a.ref.nodes, a.ref.messages], ['referenced', 'claim', 'committed', ['gather'], [brief.id]])
  assert.match(a.ref.after!.commit!, /^[0-9a-f]{40}$/)
  assert.equal((await s.wfs.attach('wf-d', { project: 'forge', workflow: 'provide', nodes: ['gather'], messages: [brief.id], turn, author: 'forge-agent' })).duplicate, true)
  await assert.rejects(s.wfs.attach('wf-d', { project: 'forge', workflow: 'provide', nodes: ['nowhere'], turn, author: 'forge-agent' }), /node nowhere is not in provide/)
  await assert.rejects(s.wfs.attach('wf-d', { project: 'forge', workflow: 'provide', messages: [9999], turn, author: 'forge-agent' }), /#9999 is not in discussion wf-d/)
  // A working-tree edit makes the next reference a draft; the earlier one stays at its commit.
  const forge = s.ws('forge')
  const w = structuredClone((await forge.readWorkflowFile('provide.yaml')).workflow!); w.nodes.gather.name = '資料'
  await forge.saveWorkflow('provide.yaml', w)
  const b = await s.wfs.attach('wf-d', { project: 'forge', workflow: 'provide', turn, author: 'forge-agent' })
  assert.equal(b.ref.after?.kind, 'draft')
  const c = await s.wfs.attach('wf-d', { project: 'forge', workflow: 'provide', commit: a.ref.after!.commit, turn, author: 'forge-agent' })
  assert.equal(c.ref.after?.sha256, a.ref.after?.sha256, 'the commit holds the bytes the first reference saw')
  assert.equal((await s.wfs.graph('wf-d', a.ref.id)).after.workflow!.nodes.gather.name, '参考資料を集める')
  s.cs.close(); s.x.close()
})

test('comparison is by node id and edge: a new id is an addition and a removal, a move or a colour is layout only, generated steps are told apart', () => {
  const p = parseWorkflow(PROVIDE)
  assert.ok(p.ok)
  const a = p.model
  const renamed = structuredClone(a)
  renamed.nodes.collect = renamed.nodes.gather; delete (renamed.nodes as Record<string, unknown>).gather
  renamed.edges = [{ from: 'collect', to: 'make' }]
  const c = compareWorkflows(a, renamed, { before: 'x', after: 'y' })
  assert.deepEqual([c.added.map(n => n.id), c.removed.map(n => n.id), c.edgesAdded, c.edgesRemoved], [['collect'], ['gather'], [['collect', 'make']], [['gather', 'make']]])
  const moved = structuredClone(a)
  moved.layout.nodes.make = { x: 900, y: 40 }; moved.nodes.gather.appearance = { icon: 'flag', color: 'rose' }
  const m = compareWorkflows(a, moved, { before: 'same', after: 'same' })
  assert.equal(m.behavioural, false)
  assert.deepEqual([m.changed, m.restyled.map(n => [n.id, n.style, n.moved])], [[], [['gather', ['appearance'], false], ['make', [], true]]])
  const docs = structuredClone(a); docs.documentation = { policy: 'default' }
  const d = compareWorkflows(a, docs, { before: 'x', after: 'y' })
  assert.ok(d.generated.added.length > 0, 'the plan and report steps appear as generated')
  assert.deepEqual(d.fields.map(f => f.field), ['documentation'])
})

test('a later message association is an event; a run links only its own records; the record itself never changes', async () => {
  const s = await setup()
  const brief = await opened(s, 'wf-e')
  const turn = turnOf('wf-e', 'forge/discuss/run-001', 'f4', 'forge-agent')
  const a = await s.wfs.attach('wf-e', { project: 'forge', workflow: 'provide', turn, author: 'forge-agent' })
  const m = (await s.ds.post('wf-e', { text: 'and?', author: 'Pat', token: 'tok-wf-e-002' })).message
  assert.throws(() => s.wfs.link('wf-e', a.ref.id, { message: m.id, by: 'sage-agent', run: 'sage/discuss/run-001' }), /a run links only its own records/)
  const l = s.wfs.link('wf-e', a.ref.id, { message: m.id, by: 'forge-agent', run: 'forge/discuss/run-001' })
  assert.deepEqual(l.ref.messages, [m.id])
  assert.equal(s.wfs.link('wf-e', a.ref.id, { message: m.id, by: 'forge-agent', run: 'forge/discuss/run-001' }).duplicate, true)
  assert.equal(s.wfs.events('wf-e').length, 1)
  assert.equal(s.wfs.rows('wf-e')[0].messages, '[]', 'the record keeps what it said when recorded')
  void brief
  s.cs.close(); s.x.close()
})

test('a version whose bytes were never captured or no longer match is unavailable, never replaced by the current file', async () => {
  const s = await setup()
  await opened(s, 'wf-f')
  const turn = turnOf('wf-f', 'forge/discuss/run-001', 'f5', 'forge-agent')
  const a = await s.wfs.attach('wf-f', { project: 'forge', workflow: 'provide', turn, author: 'forge-agent' })
  s.ds.db.prepare('UPDATE workflow_snapshots SET text = text || \'\n# tampered\n\'').run()
  assert.match((await s.wfs.graph('wf-f', a.ref.id)).after.unavailable!, /digest mismatch/)
  s.ds.db.prepare('DELETE FROM workflow_snapshots').run()
  const g = await s.wfs.graph('wf-f', a.ref.id)
  assert.equal(g.after.available, false)
  assert.match(g.after.unavailable!, /not readable here|not captured/)
  const listed = (await s.wfs.list('wf-f'))[0]
  assert.deepEqual([listed.available, listed.preview], [false, null])
  s.cs.close(); s.x.close()
})

test('a requested child of a discussion run belongs to that turn (cross-project, through entrustedBy); the request is executed at the child\'s first revision, journaled by its receipt and recovered from the job', async () => {
  const s = await setup()
  const brief = await opened(s, 'wf-g')
  const inv = await s.ds.invite('wf-g', { participant: 'forge', question: 'How?', re: [brief.id], by: 'Pat' })
  const parent = inv.invitation.run!
  s.x.db.prepare('UPDATE jobs SET state = \'done\'').run()
  const turn: Turn = { conv: 'wf-g', run: parent, attempt: 'f6', actor: 'forge-agent', invitation: inv.invitation.id, origin: null }
  const j = s.wfs.beginRequest(turn, { workspace: 'forge', workflow: 'provide', receipt: 'attempt:f6:abc123def456' })
  const [, wf, run] = parent.split('/')
  const req = await s.x.request({ workspace: 'forge', workflow: 'provide', text: 'An icon, please.', author: 'forge-agent', receipt: 'attempt:f6:abc123def456', via: 'cli', input: { kind: 'request', text: 'An icon, please.', requester: 'forge-agent', entrustedBy: { kind: 'run', project: 'forge', workflow: wf, run } } })
  const child = `forge/provide/${req.ref.run}`
  // The process died before finishing the record: repair finds the job by its receipt.
  s.ds.db.prepare('UPDATE workflow_refs SET at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', j)
  await s.wfs.repair({ conv: 'wf-g' })
  const r = s.wfs.view(s.wfs.ref('wf-g', j))
  assert.deepEqual([r.relation, r.role, r.target, r.after?.revision, r.invitation], ['executed', 'subject', { kind: 'run', run: child }, 'r1', inv.invitation.id])
  assert.match(r.note, /recovered from the request's job/)
  const cr = (await readRun(await runSpace(s.ws('forge'), ref(child)), ref(child))).record!
  const ctx = await s.wfs.contextOfRun(child, cr, 0)
  assert.deepEqual(ctx, { conv: 'wf-g', invitation: inv.invitation.id, origin: parent }, 'the child works in its parent\'s turn')
  const g = await s.wfs.graph('wf-g', j)
  assert.equal((g.state as { nodes: Record<string, string> }).nodes.gather, 'pending', 'at the request the child had done nothing')
  s.cs.close(); s.x.close()
})

test('the archive carries every record, its message associations and each version\'s bytes, so a fresh reader resolves them without the source', async () => {
  const s = await setup()
  const brief = await opened(s, 'wf-h')
  const turn = turnOf('wf-h', 'forge/discuss/run-001', 'f7', 'forge-agent')
  const a = await s.wfs.attach('wf-h', { project: 'forge', workflow: 'provide', messages: [brief.id], turn, author: 'forge-agent' })
  s.wfs.link('wf-h', a.ref.id, { message: brief.id + 0, by: 'Pat', note: 'the brief' })
  const arch = new DiscussionArchive(s.ds)
  const p = await arch.publish(['wf-h'])
  assert.deepEqual(p.failed, [])
  const dir = join(s.area, '.local', 'discussions', 'archive', 'discussions', 'wf-h')
  const lines = (await readFile(join(dir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { type: string; id?: number })
  assert.ok(lines.some(l => l.type === 'workflow' && l.id === a.ref.id))
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { horizon: { workflow: number }; workflows: { id: number; snapshot: { after: string } }[] }
  assert.equal(manifest.horizon.workflow, a.ref.id)
  const snap = manifest.workflows[0].snapshot.after
  assert.ok(snap && existsSync(join(dir, snap)))
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(await readFile(join(dir, snap))).digest('hex'), a.ref.after!.sha256)
  assert.deepEqual((await arch.publish(['wf-h'])).published, [], 'nothing new: nothing is exported twice')
  s.cs.close(); s.x.close()
})
