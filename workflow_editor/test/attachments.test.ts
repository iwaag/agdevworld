// Challenge attachments (challenge p1, docs/challenges.md *Carrying a
// challenge into work*): a person's message in a conversation or a
// discussion carries challenges pinned to the revision it was sent with; the
// run started for it is given that revision's text in its folder and the
// pinned reference in its input, and its brief names them; a later edit
// never changes what an earlier turn received, while the view shows the
// latest beside the attached one; a reply delivered to the run that asked
// carries the references in its source; the archive keeps them; the same
// submission twice is one set of attachments; nothing unpublished or unknown
// can be attached.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChallengeStore } from '../server/challenges.ts'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ConversationArchive } from '../server/conversationArchive.ts'
import { ConversationService } from '../server/conversationService.ts'
import { ExecStore, attachmentBrief } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runDir, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-attach-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, agent: string) => `schema: ag.workflow.v2
id: ${id}
name: ${id}
intent: |
  Serve what the person says.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ${agent}}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Speak.
`

async function setup() {
  const area = join(root, 'area')
  const registry = join(area, 'registry.json')
  for (const [id, wf] of [['front', 'converse'], ['ponderer', 'conduct'], ['forge', 'discuss']] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), WF(wf, `${id}-agent`))
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  const archive = join(area, 'ponderer-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', archive])
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'add', 'origin', archive])
  await gitOk(join(area, 'pj-ponderer'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat', targets: [{ workspace: 'front', workflow: 'converse' }],
    discussions: { facilitator: { workspace: 'ponderer', workflow: 'conduct' }, participants: [{ workspace: 'forge', workflow: 'discuss' }], archive: { workspace: 'ponderer' } },
  }))
  const challengesRemote = join(area, 'challenges.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', challengesRemote])
  await writeFile(join(area, 'challenges.json'), JSON.stringify({ repository: challengesRemote }))
  const x = new ExecStore({ registryFile: registry, area })
  const ch = new ChallengeStore({ area })
  const cs = new ConversationStore({ area, exec: x, challenges: ch })
  const ds = new ConversationService(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, x, ch, cs, ds, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const refOf = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow: workflow!, run: r! } }
const rec = async (s: S, run: string) => { const r = refOf(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]!), r), r)).record! }
const file = async (s: S, run: string, rel: string) => { const r = refOf(run); const sp = await runSpace(s.ws(run.split('/')[0]!), r); return readFile(join(sp.root, runDir(r), rel), 'utf8') }

let s: S
let first = '', second = ''
test('a conversation message carries a challenge; its turn gets that revision, not a later one', async () => {
  s = await setup()
  const c = await s.ch.create({ by: 'front-agent', via: 'cli', request: 'att-create-1', title: 'Edge remnants', body: 'Version one.', projects: ['gimmickimg'] })
  first = c.record!.commit
  const p = await s.ds.post('att-c1', { text: 'Let us think about this one.', author: 'Pat', token: 'tok-att-0001', with: 'front', challenges: [{ id: 'ch-0001' }] })
  const run = p.invitations[0]!.run!
  assert.ok(run, p.invitations[0]!.error ?? '')
  // the same submission again: one message, one attachment
  await s.ds.post('att-c1', { text: 'Let us think about this one.', author: 'Pat', token: 'tok-att-0001', challenges: [{ id: 'ch-0001' }] })
  assert.equal(s.cs.attachmentsOf([p.message.id]).length, 1)
  const r = await rec(s, run)
  assert.deepEqual(r.input.attachments, [{ kind: 'challenge', id: 'ch-0001', commit: first, title: 'Edge remnants', sha256: c.record!.sha256, file: `attachments/ch-0001@${first.slice(0, 12)}.md` }])
  assert.match(await file(s, run, r.input.attachments![0]!.file), /Version one\./)
  assert.match(attachmentBrief(r, 'devdocs/runs/converse/run-001').join('\n'), /ch-0001 "Edge remnants" at [0-9a-f]{12}: devdocs\/runs\/converse\/run-001\/attachments\/ch-0001@[0-9a-f]{12}\.md; evidence: wfe challenge evidence ch-0001 --at/)
  // the challenge is edited later: the earlier turn's input is unchanged; the view says what moved
  const e = await s.ch.edit('ch-0001', { by: 'Pat', via: 'page', request: 'att-edit-1', base: first, body: 'Version two.' })
  second = e.record!.commit
  assert.match(await file(s, run, r.input.attachments![0]!.file), /Version one\./)
  const v = await s.ds.view('att-c1')
  assert.deepEqual(v.messages[0]!.attachments!.map(a => [a.commit, a.latest?.commit]), [[first, second]])
  // a message may name a revision explicitly
  const p2 = await s.ds.post('att-c1', { text: 'And the earlier text.', author: 'Pat', token: 'tok-att-0002', challenges: [{ id: 'ch-0001', at: first.slice(0, 10) }] })
  assert.equal((await rec(s, p2.invitations[0]!.run!)).input.attachments![0]!.commit, first)
})

test('unknown, unpublished or malformed references are refused and the message is not stored', async () => {
  const before = s.cs.messages('att-c1').length
  await assert.rejects(s.ds.post('att-c1', { text: 'x', author: 'Pat', token: 'tok-att-0003', challenges: [{ id: 'ch-0099' }] }), (e: unknown) => e instanceof RequestError && e.status === 404)
  await assert.rejects(s.ds.post('att-c1', { text: 'x', author: 'Pat', token: 'tok-att-0004', challenges: [{ id: 'nope' }] }), /not a challenge id/)
  await assert.rejects(s.ds.post('att-c1', { text: 'x', author: 'Pat', token: 'tok-att-0005', challenges: [{ id: 'ch-0001', at: 'deadbeef' }] }), /no commit/)
  assert.equal(s.cs.messages('att-c1').length, before)
})

test('a discussion message carries a challenge to whom it invites, and to the run that asked', async () => {
  s.ds.create('att-d1', { facilitate: true, title: 'Edges', by: 'Pat', members: ['forge'] })
  const p = await s.ds.post('att-d1', { text: 'Forge, can you look at ch-0001?', author: 'Pat', token: 'tok-att-d001', to: ['forge'], challenges: [{ id: 'ch-0001' }] })
  const inv = p.invitations[0]!
  assert.equal(inv.state, 'started', inv.error ?? '')
  const r = await rec(s, inv.run!)
  assert.equal(r.input.attachments![0]!.commit, second)
  assert.match(await file(s, inv.run!, r.input.attachments![0]!.file), /Version two\./)
  // forge asks the person; the reply goes to that run with the references in its source
  const run = inv.run!
  const ws = s.ws('forge'), ref = refOf(run)
  const sp = await runSpace(ws, ref)
  await runOp(sp, ref, { op: 'node.start', node: 'talk' }, { by: 'forge-agent', via: 'cli' })
  await runOp(sp, ref, { op: 'question.ask', question: 'q1', node: 'talk', text: 'Which revision matters?', to: 'Pat' }, { by: 'forge-agent', via: 'cli' })
  const q = 'q1'
  await s.ds.postQuestions({ run })
  const qm = s.ds.messages('att-d1').find(m => m.kind === 'question' && m.run === run)!
  const reply = await s.ds.post('att-d1', { text: 'The first one.', author: 'Pat', token: 'tok-att-d002', to: ['forge'], re: [qm.id], challenges: [{ id: 'ch-0001', at: first }] })
  assert.equal(reply.invitations[0]!.run, run)
  const after = await rec(s, run)
  const answer = after.questions[q]!.answers[0]!
  assert.equal(answer.source?.kind, 'conversation')
  assert.deepEqual((answer.source as { attachments?: { commit: string }[] }).attachments!.map(a => a.commit), [first])
  // the view and the archive keep them
  const v = await s.ds.view('att-d1')
  assert.equal(v.messages.find(m => m.id === p.message.id)!.attachments![0]!.id, 'ch-0001')
  const a = await new ConversationArchive(s.ds).publish(['att-d1'])
  assert.deepEqual(a.failed, [])
  const clone = join(s.area, '.local', 'discussions', 'archive')
  const lines = (await readFile(join(clone, 'conversations', 'att-d1', 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; id?: number; attachments?: { id: string; commit: string }[] })
  assert.deepEqual(lines.find(l => l.type === 'message' && l.id === p.message.id)!.attachments!.map(x => [x.id, x.commit]), [['ch-0001', second]])
})

test('reading and attaching start no run', async () => {
  const jobs = () => (s.x.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n
  const n = jobs()
  await s.ch.sync({ force: true })
  s.ch.list({ text: 'edge' })
  await s.ch.at('ch-0001', first)
  await s.cs.pinAll([{ id: 'ch-0001' }])
  await s.ds.view('att-c1')
  await s.ds.view('att-d1')
  assert.equal(jobs(), n)
  s.cs.close(); s.ch.close(); s.x.close()
})
