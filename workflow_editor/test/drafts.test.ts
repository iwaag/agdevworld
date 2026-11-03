// workflow_editor p20: durable drafts and applying them through the service. The
// registered checkout stays behind, dirty or without the workflow throughout;
// what is published, and what a new run would read, moves only through Apply.
// Project g keeps devdocs in its root; project h pins devdocs as a submodule.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AccessContext, RepoHost } from '../server/access.ts'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { applyDraft, compareDraft, discardDraft, DraftStore, newWorkflowDraft, readDraft, resolveDraft, saveDraft, startDraft, type ApplyResult } from '../server/drafts.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import type { GiteaRepo } from '../server/gitea.ts'
import { importEdit, localEdits } from '../server/localEdits.ts'
import { digestOf, publishedHead, publishedWorkspace, resolvePublished } from '../server/published.ts'
import { loadRegistry, type Registration } from '../server/registry.ts'
import { createRunInCopy } from '../server/runs.ts'
import { readCopy } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-drafts-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const wf = (id: string, a = 'Build.', b = 'Ship.') => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ${id}
name: ${id}
intent: |
  Build it.
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: ${a}
  spacer1:
    type: do
    description: Spacer one.
  spacer2:
    type: do
    description: Spacer two.
  spacer3:
    type: do
    description: Spacer three.
  ship:
    type: do
    description: ${b}
edges: []
`

const net = { down: false }
// Runs once when Git next needs credentials: the moment a step of an apply reaches for the remote.
const nextGit: { hook: null | (() => Promise<void>) } = { hook: null }
function stubHost(dir: string, repos: Record<number, [string, string]>): RepoHost {
  const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(dir, owner, `${name}.git`), htmlUrl: '', description: '', empty: false, defaultBranch: 'main', archived: false })
  const up = () => { if (net.down) throw new Error('connect ECONNREFUSED gitea.test') }
  return {
    url: 'http://gitea.test',
    cloneUrl: (o, n) => join(dir, o, `${n}.git`),
    gitEnv: async () => { const f = nextGit.hook; if (f) await f(); return {} },
    repoById: async id => { up(); return repos[id] ? info(id, ...repos[id]) : null },
    repo: async (o, n) => { up(); const hit = Object.entries(repos).find(([, [ow, nm]]) => ow === o && nm === n); return hit ? info(Number(hit[0]), o, n) : null },
  }
}

const rev = (dir: string, ref = 'HEAD') => gitOk(dir, ['rev-parse', ref]).then(s => s.trim())
const show = (dir: string, spec: string) => gitOk(dir, ['show', spec])
let n = 0
async function pushTo(bare: string, files: Record<string, string | null>) {
  const other = join(root, `push-${++n}`)
  await gitOk(root, ['clone', '-q', bare, other], { config: LOCAL_TRANSPORT })
  for (const [p, t] of Object.entries(files)) {
    if (t === null) await rm(join(other, p))
    else { await mkdir(join(other, p, '..'), { recursive: true }); await writeFile(join(other, p), t) }
  }
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'an external writer']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
}

let s: { area: string; ctx: AccessContext; store: DraftStore; g: Registration; h: Registration; gDir: string; gRemote: string; hRemote: string; hDefs: string }
const by = 'Ada'
const fileG = 'devdocs/workflows/freework.yaml'
const state = async (dir: string) => [await rev(dir), await gitOk(dir, ['status', '--porcelain=v1']), await gitOk(dir, ['for-each-ref', '--format=%(refname) %(objectname)'])].join('\n')

test('setup', async () => {
  const area = join(root, 'area'), gitea = join(root, 'gitea'), registry = join(area, 'registry.json')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  const gDir = join(area, 'pj-g')
  const c = await createProject({ dir: gDir, id: 'g', name: 'G', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(c.ok, c.message)
  await writeFile(join(gDir, fileG), wf('freework'))
  await gitOk(gDir, ['add', '-A']); await gitOk(gDir, ['commit', '-q', '-m', 'freework'])
  const gRemote = join(gitea, 'dev', 'pj-g.git')
  await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', gRemote])
  await gitOk(gDir, ['remote', 'add', 'origin', gRemote]); await gitOk(gDir, ['push', '-q', '-u', 'origin', 'main'])
  // h: devdocs in its own repository, pinned by the root.
  const hDefs = join(gitea, 'dev', 'pj-h-devdocs.git')
  const dSrc = join(root, 'hd-src')
  await gitOk(root, ['init', '-q', dSrc]); await mkdir(join(dSrc, 'workflows')); await writeFile(join(dSrc, 'workflows', 'freework.yaml'), wf('freework'))
  await gitOk(dSrc, ['add', '-A']); await gitOk(dSrc, ['commit', '-q', '-m', 'start']); await gitOk(root, ['clone', '-q', '--bare', dSrc, hDefs])
  const hRemote = join(gitea, 'dev', 'pj-h.git'), hSrc = join(root, 'h-src')
  await gitOk(root, ['init', '-q', hSrc]); await gitOk(hSrc, ['remote', 'add', 'origin', hRemote])
  await writeFile(join(hSrc, 'project.yaml'), 'schema: ag.project.v2\nid: h\nname: H\ndevdocs: submodule\nintent: x\ngoals: []\n')
  await gitOk(hSrc, ['submodule', 'add', '-q', '../pj-h-devdocs.git', 'devdocs'], { config: LOCAL_TRANSPORT })
  await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', hRemote])
  await gitOk(hSrc, ['add', '-A']); await gitOk(hSrc, ['commit', '-q', '-m', 'start']); await gitOk(hSrc, ['push', '-q', 'origin', 'HEAD:main'])
  const hDir = join(area, 'pj-h')
  await gitOk(root, ['clone', '-q', hRemote, hDir])
  // Registry: both projects, one workspace each; ids of a Gitea stand-in.
  const reg = JSON.parse(await readFile(registry, 'utf8'))
  const repoEntry = (id: number, name: string, category: string) => ({ key: `gitea:${id}`, gitea: { id, owner: 'dev', name }, category })
  reg.repositories = [repoEntry(1, 'pj-g', 'root'), repoEntry(2, 'pj-h', 'root'), repoEntry(3, 'pj-h-devdocs', 'devdocs')]
  reg.projects = [{ id: 'g', root: 'gitea:1' }, { id: 'h', root: 'gitea:2' }]
  reg.workspaces = [...reg.workspaces.map((w: Registration) => ({ ...w, project: 'g' })), { id: 'h', label: 'H', host: reg.workspaces[0].host, path: hDir, project: 'h' }]
  await writeFile(registry, JSON.stringify(reg, null, 2))
  const ctx: AccessContext = { registryFile: registry, area, gitea: stubHost(gitea, { 1: ['dev', 'pj-g'], 2: ['dev', 'pj-h'], 3: ['dev', 'pj-h-devdocs'] }), fetchTtlMs: 0 }
  const loaded = await loadRegistry(registry)
  s = { area, ctx, store: new DraftStore(area), g: loaded.workspaces.find(w => w.project === 'g')!, h: loaded.workspaces.find(w => w.project === 'h')!, gDir, gRemote, hRemote, hDefs }
  const pub = await publishedWorkspace(ctx, s.h, { fresh: true })
  assert.equal(pub.source.definitions?.repository, 'dev/pj-h-devdocs')
})

test('a draft is saved durably, with revision checks, and ordinary execution still reads the published definition', async () => {
  const before = await state(s.gDir)
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  assert.equal(d.revision, 1)
  assert.equal(d.base.source?.kind, 'published')
  assert.equal(d.base.source?.root?.commit, await rev(s.gRemote, 'main'))
  // An existing draft is offered rather than silently competed with.
  await assert.rejects(startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by: 'Bea' }), (e: Error & { detail?: { code: string; drafts: unknown[] } }) => e.detail?.code === 'draft-exists' && e.detail.drafts.length === 1)
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: wf('freework', 'Build carefully.') })
  assert.equal(saved.revision, 2)
  // A second tab holding revision 1 overwrites nothing.
  await assert.rejects(saveDraft(s.store, d.id, { revision: 1, by: 'Bea', text: wf('freework', 'Other tab.') }), (e: Error & { detail?: { code: string; revision: number } }) => e.detail?.code === 'draft-revision-conflict' && e.detail.revision === 2)
  await assert.rejects(saveDraft(s.store, d.id, { revision: 2, by, text: ' \n' }), /empty definition/)
  // A new store (a restart) reads the same bytes.
  const again = await new DraftStore(s.area).read(d.id)
  assert.match(again.text, /Build carefully/)
  assert.equal(again.revisions.length, 2)
  const pub = await publishedWorkspace(s.ctx, s.g, { fresh: true })
  assert.doesNotMatch((await pub.readWorkflowFile('freework.yaml')).text!, /Build carefully/)
  assert.equal(await state(s.gDir), before)
  const view = await readDraft(s.ctx, s.store, s.g, d.id)
  assert.equal(view.descriptor.kind, 'draft')
  assert.deepEqual(view.descriptor.draft, { id: d.id, revision: 2 })
  assert.equal(view.latest?.changed, false)
  await discardDraft(s.store, d.id, { revision: 2, by })
  assert.deepEqual(await s.store.list({ project: 'g' }), [])
})

test('apply: publishes only the definition, from a checkout that is dirty and behind; the resolver reads it back; a repeat publishes nothing', async () => {
  await writeFile(join(s.gDir, 'unrelated.txt'), 'dirty\n')
  await writeFile(join(s.gDir, 'README.local'), 'dirty\n')
  const before = await state(s.gDir)
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: wf('freework', 'Applied once.') })
  const head = await rev(s.gRemote, 'main')
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(r.ok, r.apply.error)
  assert.equal(r.apply.outcome, 'applied')
  assert.equal(r.draft.state, 'applied')
  const after = await rev(s.gRemote, 'main')
  assert.notEqual(after, head)
  assert.equal(await rev(s.gRemote, 'main^'), head)
  assert.deepEqual((await gitOk(s.gRemote, ['diff', '--name-only', head, after])).trim().split('\n'), [fileG])
  assert.match(await show(s.gRemote, `main:${fileG}`), /Applied once/)
  assert.match(await gitOk(s.gRemote, ['log', '-1', '--format=%an %B', 'main']), /Ada Apply workflow draft: freework.yaml[\s\S]*WFE-Draft:/)
  assert.equal(r.apply.result?.root?.commit, after)
  assert.equal(await state(s.gDir), before)
  // A second tab or a lost response: the same outcome, no second commit.
  const dup = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(dup.ok && dup.duplicate)
  assert.equal(await rev(s.gRemote, 'main'), after)
})

test('improve_wfnode p1: expectations, example status and list order survive save, apply and the published read', async () => {
  const { parseWorkflow } = await import('../server/yamlDoc.ts')
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const edited = d.text
    .replace('  build:\n    type: do\n', '  build:\n    type: do\n    example: true\n    expectations:\n      - {key: webbrowser, strength: required, note: On the review PC.}\n')
    .replace(/^edges:/m, 'groups:\n  work:\n    name: Work\n    kind: list\n    cardinality: variable\n    members: [spacer1, build]\n    description: Items.\nedges:')
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: edited })
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(r.ok, r.apply.error)
  const back = parseWorkflow(await show(s.gRemote, `main:${fileG}`))
  assert.ok(back.ok)
  assert.equal(back.model.nodes.build.example, true)
  assert.deepEqual(back.model.nodes.build.expectations, [{ key: 'webbrowser', strength: 'required', note: 'On the review PC.' }])
  assert.deepEqual(back.model.groups?.work.members, ['spacer1', 'build'])
  // The next test reads a definition without them.
  const again = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const plain = await saveDraft(s.store, again.id, { revision: 1, by, text: wf('freework', 'Applied once.') })
  assert.ok((await applyDraft(s.ctx, s.store, s.g, again.id, { revision: plain.revision, by })).ok)
})

test('compatible upstream changes survive the merge; conflicting ones keep the draft and are resolved through the service', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const base = d.text
  const mine = base.replace('Ship.', 'Ship mine.')
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: mine })
  // An external writer changes another place of the same file, and another file.
  const theirs = base.replace('Applied once.', 'Applied upstream.')
  await pushTo(s.gRemote, { [fileG]: theirs, 'NOTES.md': 'unrelated upstream\n' })
  const preview = await compareDraft(s.ctx, s.store, s.g, d.id)
  assert.equal(preview.comparison.state, 'merged')
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(r.ok, r.apply.error)
  const text = await show(s.gRemote, `main:${fileG}`)
  assert.match(text, /Applied upstream/)
  assert.match(text, /Ship mine/)
  assert.equal(await show(s.gRemote, 'main:NOTES.md'), 'unrelated upstream\n')

  const c = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const c2 = await saveDraft(s.store, c.id, { revision: 1, by, text: c.text.replace('Ship mine.', 'Ship draft.') })
  await pushTo(s.gRemote, { [fileG]: c.text.replace('Ship mine.', 'Ship upstream.') })
  const head = await rev(s.gRemote, 'main')
  const conflict = await applyDraft(s.ctx, s.store, s.g, c.id, { revision: c2.revision, by })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.apply.outcome, 'conflict')
  assert.equal(conflict.conflict?.kind, 'text')
  const hunks = conflict.conflict!.segments!.filter(x => typeof x !== 'string') as { mine: string; latest: string; base: string }[]
  assert.equal(hunks.length, 1)
  assert.match(hunks[0]!.mine, /Ship draft/); assert.match(hunks[0]!.latest, /Ship upstream/); assert.match(hunks[0]!.base, /Ship mine/)
  assert.equal(await rev(s.gRemote, 'main'), head)
  assert.equal(conflict.draft.state, 'open')
  assert.match((await s.store.read(c.id)).text, /Ship draft/)
  // The person's choice, against what they looked at.
  const chosen = conflict.conflict!.segments!.map(x => (typeof x === 'string' ? x : x.mine.replace('Ship draft.', 'Ship both.'))).join('')
  await assert.rejects(resolveDraft(s.ctx, s.store, s.g, c.id, { revision: c2.revision, by, latest: 'not-what-is-there', text: chosen }), /changed again/)
  const resolved = await resolveDraft(s.ctx, s.store, s.g, c.id, { revision: c2.revision, by, latest: conflict.conflict!.latest.sha256, text: chosen })
  const done = await applyDraft(s.ctx, s.store, s.g, c.id, { revision: resolved.revision, by })
  assert.ok(done.ok, done.apply.error)
  assert.match(await show(s.gRemote, `main:${fileG}`), /Ship both/)
  assert.equal(await rev(s.gRemote, 'main^'), head)
})

test('an invalid or malformed definition is not published and the draft stays', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const head = await rev(s.gRemote, 'main')
  const bad = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('  root: {path: ., access: editable}\n', '  root: {path: ., access: editable}\nedges_broken: [\n') })
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: bad.revision, by })
  assert.equal(r.apply.outcome, 'invalid')
  assert.ok(r.problem)
  const wrong = await saveDraft(s.store, d.id, { revision: bad.revision, by, text: d.text.replace('edges: []', 'edges: [{from: build, to: nowhere}]') })
  const r2: ApplyResult = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: wrong.revision, by })
  assert.equal(r2.apply.outcome, 'invalid')
  assert.ok(r2.issues?.length)
  assert.equal(await rev(s.gRemote, 'main'), head)
  assert.equal(r2.draft.state, 'open')
  await discardDraft(s.store, d.id, { revision: wrong.revision, by })
})

// Fires the first time the apply of `id` has built its commit and is about to push it.
const whenBuilt = (id: string, f: () => Promise<void>) => {
  nextGit.hook = async () => {
    if ((await s.store.read(id)).apply?.phase !== 'definition-built') return
    nextGit.hook = null
    await f()
  }
}

test('newer edits saved during an apply stay as an open draft based on what was applied', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const one = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Spacer one.', 'Spacer applied.') })
  let two = one
  whenBuilt(d.id, async () => { two = await saveDraft(s.store, d.id, { revision: one.revision, by: 'Bea', text: one.text.replace('Spacer two.', 'Spacer later.') }) })
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: one.revision, by })
  assert.ok(r.ok, r.apply.error)
  assert.equal(r.draft.state, 'open')
  const published = await show(s.gRemote, `main:${fileG}`)
  assert.match(published, /Spacer applied/); assert.doesNotMatch(published, /Spacer later/)
  const now = await s.store.read(d.id)
  assert.equal(now.revision, two.revision); assert.notEqual(two.revision, one.revision)
  assert.equal(now.base.sha256, r.apply.merged)
  assert.match(now.text, /Spacer later/)
  const next = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: two.revision, by })
  assert.ok(next.ok, next.apply.error)
  assert.equal(next.draft.state, 'applied')
  assert.match(await show(s.gRemote, `main:${fileG}`), /Spacer later/)
})

test('another writer wins the push: reconciled on the new head, nothing forced; simultaneous applies take turns', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Ship both.', 'Ship raced.') })
  whenBuilt(d.id, () => pushTo(s.gRemote, { 'RACE.md': 'the other writer\n' }))
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(r.ok, r.apply.error)
  assert.equal(await show(s.gRemote, 'main:RACE.md'), 'the other writer\n')
  assert.match(await show(s.gRemote, `main:${fileG}`), /Ship raced/)
  assert.equal(await gitOk(s.gRemote, ['log', '-1', '--format=%s', 'main^']), 'an external writer\n')

  const a = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const b = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by: 'Bea', another: true })
  const a2 = await saveDraft(s.store, a.id, { revision: 1, by, text: a.text.replace('Spacer later.', 'Spacer A.') })
  const b2 = await saveDraft(s.store, b.id, { revision: 1, by: 'Bea', text: b.text.replace('Applied upstream.', 'Spacer B.') })
  const before = await rev(s.gRemote, 'main')
  const [ra, rb] = await Promise.all([applyDraft(s.ctx, s.store, s.g, a.id, { revision: a2.revision, by }), applyDraft(s.ctx, s.store, s.g, b.id, { revision: b2.revision, by: 'Bea' })])
  assert.ok(ra.ok && rb.ok, `${ra.apply.error} ${rb.apply.error}`)
  const both = await show(s.gRemote, `main:${fileG}`)
  assert.match(both, /Spacer A/); assert.match(both, /Spacer B/)
  assert.equal((await gitOk(s.gRemote, ['rev-list', '--count', `${before}..main`])).trim(), '2')
})

test('a retry recognizes a push whose response was lost, and a moved head is reconciled', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Spacer three.', 'Spacer lost.') })
  const first = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(first.ok, first.apply.error)
  const after = await rev(s.gRemote, 'main')
  // As if the process died after the push, before the journal said so.
  await s.store.update(d.id, x => { x.state = 'open'; x.apply = { ...x.apply!, outcome: 'in-progress', phase: 'definition-built', definition: { ...x.apply!.definition!, pushed: false } }; delete x.apply.result })
  const retry = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.ok(retry.ok, retry.apply.error)
  assert.equal(retry.apply.outcome, 'applied')
  assert.equal(await rev(s.gRemote, 'main'), after)
  assert.match(await show(s.gRemote, `main:${fileG}`), /Spacer lost/)
})

test('deleted and renamed definitions are explicit, and resolved without losing the draft', async () => {
  const text = wf('other')
  await pushTo(s.gRemote, { 'devdocs/workflows/other.yaml': text })
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'other.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: text.replace('Ship.', 'Ship edited.') })
  await pushTo(s.gRemote, { 'devdocs/workflows/other.yaml': null })
  const gone = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.equal(gone.apply.outcome, 'conflict')
  assert.equal(gone.conflict?.kind, 'deleted')
  const view = await readDraft(s.ctx, s.store, s.g, d.id)
  assert.equal(view.latest?.deleted, true)
  // Renamed: the same workflow id under another file.
  await pushTo(s.gRemote, { 'devdocs/workflows/other-renamed.yaml': text })
  const moved = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
  assert.equal(moved.conflict?.kind, 'renamed')
  assert.equal(moved.conflict?.renamedTo, 'other-renamed.yaml')
  const re = await resolveDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by, latest: null, retarget: 'other-renamed.yaml' })
  assert.equal(re.file, 'other-renamed.yaml')
  await assert.doesNotReject(discardDraft(s.store, d.id, { revision: re.revision, by }))
  await pushTo(s.gRemote, { 'devdocs/workflows/other-renamed.yaml': null })
})

test('a new workflow is a draft until applied, then a run can be made of it', async () => {
  const d = await newWorkflowDraft(s.ctx, s.store, s.g, { id: 'fresh', name: 'Fresh', template: 'empty', by })
  assert.equal(d.base.text, null)
  assert.equal(d.file, 'fresh.yaml')
  assert.equal((await publishedWorkspace(s.ctx, s.g, { fresh: true }).then(p => p.workflowFiles())).includes('fresh.yaml'), false)
  await assert.rejects(newWorkflowDraft(s.ctx, s.store, s.g, { id: 'fresh', name: 'Fresh', by: 'Bea' }), /already exists/)
  const ok = await saveDraft(s.store, d.id, { revision: 1, by, text: wf('fresh') })
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: ok.revision, by })
  assert.ok(r.ok, r.apply.error)
  assert.equal((await publishedWorkspace(s.ctx, s.g, { fresh: true }).then(p => p.workflowFiles())).includes('fresh.yaml'), true)
  assert.equal(await gitOk(s.gDir, ['ls-files', 'devdocs/workflows/fresh.yaml']), '')
})

test('a trial runs the exact saved revision on the published code and says so; a published run stays published', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Ship raced.', 'Ship tried.') })
  assert.equal(saved.revision, 2)
  const ws = new Workspace(s.g)
  const pubHead = await rev(s.gRemote, 'main')
  const created = await createRunInCopy(ws, {
    workflow: 'freework.yaml', input: { kind: 'braindump', text: 'try it', author: by }, executor: { host: 'h1' }, by, via: 'test', area: s.area, receipt: 'request:trial-1', access: s.ctx,
    trial: { file: 'freework.yaml', sha256: saved.sha256, draft: { id: saved.id, revision: saved.revision, author: saved.author, text: saved.text } },
  }, {})
  const src = created.record.definition.source
  assert.equal(src?.kind, 'trial')
  if (src?.kind === 'trial') {
    assert.deepEqual(src.draft, { id: saved.id, revision: saved.revision, author: by })
    assert.equal(src.sha256, saved.sha256)
    assert.equal(src.baseline.commit, pubHead)
  }
  const normal = await createRunInCopy(ws, { workflow: 'freework', input: { kind: 'braindump', text: 'run it', author: by }, executor: { host: 'h1' }, by, via: 'test', area: s.area, receipt: 'request:plain-1', access: s.ctx }, {})
  assert.equal(normal.record.definition.source?.kind, 'published')
  await discardDraft(s.store, d.id, { revision: saved.revision, by })
})

test('submodule mode: the definition is published to its repository and the root pin follows; execution resolves it', async () => {
  const d = await startDraft(s.ctx, s.store, s.h, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Ship.', 'Ship through the pin.') })
  // The definitions repository has moved past the pin: unrelated work survives.
  await pushTo(s.hDefs, { 'notes.md': 'unpinned work\n' })
  const rootBefore = await rev(s.hRemote, 'main')
  const r = await applyDraft(s.ctx, s.store, s.h, d.id, { revision: saved.revision, by })
  assert.ok(r.ok, r.apply.error)
  assert.equal(r.apply.root?.pushed, true)
  assert.equal(await rev(s.hRemote, 'main^'), rootBefore)
  assert.match(await show(s.hDefs, 'main:workflows/freework.yaml'), /Ship through the pin/)
  assert.equal(await show(s.hDefs, 'main:notes.md'), 'unpinned work\n')
  const link = (await gitOk(s.hRemote, ['ls-tree', 'main', 'devdocs'])).split(/\s+/)[2]
  assert.equal(link, await rev(s.hDefs, 'main'))
  assert.equal(r.apply.root?.pinTo, link)
  assert.deepEqual((await gitOk(s.hRemote, ['diff', '--name-only', rootBefore, 'main'])).trim().split('\n'), ['devdocs'])
  const src = await resolvePublished(s.ctx, 'h', { fresh: true })
  assert.equal(src.definitions?.commit, link)
  const pub = await publishedWorkspace(s.ctx, s.h, { fresh: true })
  assert.match((await pub.readWorkflowFile('freework.yaml')).text!, /Ship through the pin/)
})

test('submodule mode: a new run takes the applied definition at the new pin', async () => {
  const pub = await publishedWorkspace(s.ctx, s.h, { fresh: true })
  const created = await createRunInCopy(new Workspace(s.h), { workflow: 'freework', input: { kind: 'braindump', text: 'run it', author: by }, executor: { host: 'h1' }, by, via: 'test', area: s.area, receipt: 'request:h-1', access: s.ctx }, {})
  const src = created.record.definition.source
  assert.equal(src?.kind, 'published')
  if (src?.kind === 'published') {
    assert.equal(src.commit, pub.source.commit)
    assert.equal(src.definitions?.repository, 'dev/pj-h-devdocs')
    assert.equal(src.definitions?.commit, pub.source.definitions?.commit)
  }
  const copy = (await readCopy(new Workspace(s.h), created.ref))!
  assert.match(await readFile(join(copy.tree, created.dir, 'definition', 'freework.yaml'), 'utf8'), /Ship through the pin/)
})

test('submodule mode: a pin that did not arrive is finished by a retry, not published twice', async () => {
  const d = await startDraft(s.ctx, s.store, s.h, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Spacer one.', 'Spacer partial.') })
  // Simulate partial publication: the definition pushed, the root not.
  const r = await applyDraft(s.ctx, s.store, s.h, d.id, { revision: saved.revision, by })
  assert.ok(r.ok, r.apply.error)
  const defsHead = await rev(s.hDefs, 'main'), rootAfter = await rev(s.hRemote, 'main')
  await gitOk(s.hRemote, ['update-ref', 'refs/heads/main', `${rootAfter}^`])
  await s.store.update(d.id, x => { x.state = 'open'; x.apply = { ...x.apply!, outcome: 'uncertain', phase: 'root-push-unknown' }; delete x.apply.result })
  const retry = await applyDraft(s.ctx, s.store, s.h, d.id, { revision: saved.revision, by })
  assert.ok(retry.ok, retry.apply.error)
  assert.equal(await rev(s.hDefs, 'main'), defsHead)
  assert.equal((await gitOk(s.hRemote, ['ls-tree', 'main', 'devdocs'])).split(/\s+/)[2], defsHead)
})

test('source unavailable: no fetch means no publication, no false success, and the draft remains', async () => {
  const d = await startDraft(s.ctx, s.store, s.g, { file: 'freework.yaml', by })
  const saved = await saveDraft(s.store, d.id, { revision: 1, by, text: d.text.replace('Spacer lost.', 'Spacer offline.') })
  assert.equal(saved.revision, 2)
  const head = await rev(s.gRemote, 'main')
  net.down = true
  try {
    const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: saved.revision, by })
    assert.equal(r.ok, false)
    assert.equal(r.apply.outcome, 'failed')
    assert.equal(r.draft.state, 'open')
    const src = await publishedHead(s.ctx, 'g', { refresh: true })
    assert.equal(src.fetch.state, 'stale')
    assert.ok(src.fetch.error)
  } finally { net.down = false }
  assert.equal(await rev(s.gRemote, 'main'), head)
  await discardDraft(s.store, d.id, { revision: saved.revision, by })
})

test('existing edits: a checkout merely behind has none; uncommitted, local-commit and untracked ones import with their own base and stay in place', async () => {
  // Behind by many commits, with unrelated dirty files, from the tests above.
  const v0 = await localEdits(s.ctx, s.store, s.g)
  assert.deepEqual(v0.edits, [])
  const headBefore = await rev(s.gDir)
  const baseText = await show(s.gDir, `HEAD:${fileG}`)
  await writeFile(join(s.gDir, fileG), baseText.replace('Build.', 'Build locally.'))
  await writeFile(join(s.gDir, 'devdocs/workflows/only-here.yaml'), wf('only-here'))
  const v1 = await localEdits(s.ctx, s.store, s.g)
  assert.deepEqual(v1.edits.map(e => [e.file, e.edit]).sort(), [['freework.yaml', 'uncommitted'], ['only-here.yaml', 'untracked']])
  const edit = v1.edits.find(e => e.file === 'freework.yaml')!
  const d = await importEdit(s.ctx, s.store, s.g, { file: 'freework.yaml', sha256: edit.sha256, by })
  assert.equal(d.provenance.kind, 'import')
  assert.equal(d.base.text, baseText)
  assert.match(d.text, /Build locally/)
  assert.equal(await rev(s.gDir), headBefore)
  assert.match(await gitOk(s.gDir, ['status', '--porcelain=v1']), /freework\.yaml/)
  assert.equal((await localEdits(s.ctx, s.store, s.g)).edits.find(e => e.file === 'freework.yaml')?.draft?.id, d.id)
  // Applying it merges over everything the checkout never saw.
  const r = await applyDraft(s.ctx, s.store, s.g, d.id, { revision: 1, by })
  // The project changed the same line since: a conflict to resolve, the import intact.
  assert.equal(r.apply.outcome, 'conflict')
  assert.match((await s.store.read(d.id)).text, /Build locally/)
  // A local commit.
  await gitOk(s.gDir, ['checkout', '-q', '--', fileG])
  await rm(join(s.gDir, 'devdocs/workflows/only-here.yaml'))
  await writeFile(join(s.gDir, fileG), baseText.replace('Build.', 'Build committed.'))
  await gitOk(s.gDir, ['add', fileG]); await gitOk(s.gDir, ['commit', '-q', '-m', 'local'])
  const v2 = await localEdits(s.ctx, s.store, s.g)
  const e2 = v2.edits.find(e => e.file === 'freework.yaml')!
  assert.equal(e2.edit, 'local-commits')
  assert.equal(e2.ahead, 1)
  assert.equal(e2.baseCommit, headBefore)
  await gitOk(s.gDir, ['reset', '-q', '--hard', headBefore])
  assert.ok((await readdir(s.gDir)).includes('unrelated.txt'))
})

test('HTTP: published reads and drafts answer without the checkout; a draft is refused for another project; a read names its source', async () => {
  const reg = JSON.parse(await readFile(s.ctx.registryFile, 'utf8'))
  const moved = join(root, 'no-checkout-registry.json')
  // The same project with its checkout gone from this host.
  await writeFile(moved, JSON.stringify({ ...reg, workspaces: reg.workspaces.map((w: Registration) => (w.project === 'h' ? { ...w, path: join(root, 'nothing-here') } : w)) }))
  await writeFile(join(s.area, 'moved.json'), await readFile(moved, 'utf8'))
  const server = createServer(createHandler({ registryFile: join(s.area, 'moved.json'), area: s.area, allowedOrigins: [], gitea: s.ctx.gitea as never }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(`${base}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() as Record<string, unknown> } }
  try {
    const head = await call('GET', '/h/published-head')
    assert.equal(head.status, 200)
    assert.equal((head.body.source as { project: string }).project, 'h')
    const read = await call('GET', '/h/published/freework.yaml')
    assert.equal(read.status, 200)
    const descriptor = read.body.descriptor as { kind: string; definition: { repository: string; revision: string }; root: { repository: string; commit: string }; digest: string }
    assert.equal(descriptor.kind, 'published')
    assert.equal(descriptor.definition.repository, 'dev/pj-h-devdocs')
    assert.equal(descriptor.root.repository, 'dev/pj-h')
    assert.notEqual(descriptor.definition.revision, descriptor.root.commit)
    assert.equal(descriptor.digest, digestOf(read.body.text as string))
    const list = await call('GET', '/h/published')
    assert.equal(list.status, 200)
    assert.match((list.body.relation as { problem: string }).problem, /no checkout/)
    const started = await call('POST', '/h/drafts', { file: 'freework.yaml', by })
    assert.equal(started.status, 201)
    const id = (started.body.draft as { id: string }).id
    const edits = await call('GET', '/h/drafts/local-edits')
    assert.equal(edits.body.available, false)
    // A draft is reached through its own project only.
    assert.equal((await call('GET', `/g/drafts/${id}`)).status, 404)
    const stale = await call('PUT', `/h/drafts/${id}`, { revision: 9, by, text: 'x: 1\n' })
    assert.equal(stale.status, 409)
    assert.equal((stale.body.detail as { code: string }).code, 'draft-revision-conflict')
    const absent = await call('GET', '/h/published/nothing.yaml')
    assert.equal((absent.body.problem as { kind: string }).kind, 'missing')
    assert.equal((await call('DELETE', `/h/drafts/${id}`, { revision: 1, by })).status, 200)
  } finally { server.close(); server.closeAllConnections() }
})
