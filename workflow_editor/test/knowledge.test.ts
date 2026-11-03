// improve_workflow p2: reusable findings read by qualified id, at a stated
// revision, from caches: no workspace is touched, nothing is substituted.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessError, type AccessContext, type RepoHost } from '../server/access.ts'
import { gitOk } from '../server/git.ts'
import type { GiteaRepo } from '../server/gitea.ts'
import { checkCollection, checkFolder, citation, collections, listFindings, parseFindingDocument, runDecisions, showFinding } from '../server/knowledge.ts'
import { RequestError } from '../server/workspace.ts'

let root = ''
let ctx: AccessContext
let gitea = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-knowledge-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
  gitea = join(root, 'gitea')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  const repos: Record<number, [string, string]> = { 1: ['dev', 'pj-a'], 2: ['dev', 'pj-b'], 3: ['dev', 'wedo-x'], 4: ['dev', 'pj-c'], 5: ['dev', 'study-y'] }
  const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(gitea, owner, `${name}.git`), htmlUrl: '', description: '', defaultBranch: 'main' } as GiteaRepo)
  const host: RepoHost = {
    url: 'http://gitea.test', cloneUrl: (o, n) => join(gitea, o, `${n}.git`), gitEnv: async () => ({}),
    repoById: async id => (repos[id] ? info(id, ...repos[id]) : null),
    repo: async (o, n) => { const hit = Object.entries(repos).find(([, [ow, nm]]) => ow === o && nm === n); return hit ? info(Number(hit[0]), o, n) : null },
  }
  const registry = join(root, 'registry.json')
  await writeFile(registry, JSON.stringify({
    schema: 'ag.workflow-editor.registry.v1', workspaces: [], approver: 'x',
    repositories: [
      { gitea: { id: 1, owner: 'dev', name: 'pj-a' }, category: 'root', description: '' },
      { gitea: { id: 2, owner: 'dev', name: 'pj-b' }, category: 'root', description: '' },
      { gitea: { id: 3, owner: 'dev', name: 'wedo-x' }, category: 'wedo', description: 'shared' },
      { gitea: { id: 4, owner: 'dev', name: 'pj-c' }, category: 'root', description: '' },
      { gitea: { id: 5, owner: 'dev', name: 'study-y' }, category: 'study', description: 'imported' },
    ],
    projects: [{ id: 'a', root: 'gitea:1' }, { id: 'b', root: 'gitea:2' }, { id: 'c', root: 'gitea:4' }],
  }))
  ctx = { registryFile: registry, area: join(root, 'area'), gitea: host, fetchTtlMs: 0 }
  await mkdir(ctx.area, { recursive: true })
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const doc = (id: string, title: string, extra: { categories?: string; tags?: string; refs?: string; body?: string } = {}) => `---
id: ${id}
title: ${title}
summary: Summary of ${title}.
categories: ${extra.categories ?? '[motion]'}
tags: ${extra.tags ?? '[cut-out]'}
references:
${extra.refs ?? '  - {role: evidence, ref: notes/run.md}\n  - {role: illustration, ref: notes/clip.mp4}'}
---
${extra.body ?? `Body of ${title}.\n`}`
const PROJECT = (id: string, more = '') => `schema: ag.project.v2\nid: ${id}\nname: ${id}\ndevdocs: directory\nintent: x\ngoals: []\n${more}`
const AREA = 'areas:\n  wedo: {description: Kept here}\n'
const KNOWLEDGE = (m: string) => `schema: ag.knowledge.v1\nkind: wedo\nmaintenance: project\nmaintainer: ${m}\n`

async function bare(name: string, files: Record<string, string>, submodule?: { path: string; url: string; commit: string }) {
  const src = join(root, 'src', name)
  await mkdir(src, { recursive: true })
  await gitOk(src, ['init', '-q'])
  for (const [p, t] of Object.entries(files)) { await mkdir(join(src, p, '..'), { recursive: true }); await writeFile(join(src, p), t) }
  if (submodule) {
    await writeFile(join(src, '.gitmodules'), `[submodule "${submodule.path}"]\n\tpath = ${submodule.path}\n\turl = ${submodule.url}\n`)
    await gitOk(src, ['add', '-A'])
    await gitOk(src, ['update-index', '--add', '--cacheinfo', `160000,${submodule.commit},${submodule.path}`])
  } else await gitOk(src, ['add', '-A'])
  await gitOk(src, ['commit', '-q', '-m', 'initial'])
  const dir = join(gitea, 'dev', `${name}.git`)
  await gitOk(root, ['clone', '-q', '--bare', src, dir])
  await gitOk(src, ['remote', 'add', 'origin', dir])
  return { src, dir, head: (await gitOk(src, ['rev-parse', 'HEAD'])).trim() }
}
async function change(src: string, files: Record<string, string | null>) {
  for (const [p, t] of Object.entries(files)) {
    if (t === null) await rm(join(src, p))
    else { await mkdir(join(src, p, '..'), { recursive: true }); await writeFile(join(src, p), t) }
  }
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', 'edit']); await gitOk(src, ['push', '-q', 'origin', 'HEAD:main'])
  return (await gitOk(src, ['rev-parse', 'HEAD'])).trim()
}

let a: Awaited<ReturnType<typeof bare>>
let x: Awaited<ReturnType<typeof bare>>
test('setup: a local area, a second one with the same local id, a pinned shared repository', async () => {
  a = await bare('pj-a', {
    'project.yaml': PROJECT('a', AREA), 'wedo/knowledge.yaml': KNOWLEDGE('a'), 'notes/run.md': 'run\n', 'notes/clip.mp4': 'clip',
    'wedo/findings/one.md': doc('f-1', 'A one', { tags: '[cut-out, godot]' }),
    'wedo/findings/deep/two.md': doc('f-2', 'A two', { categories: '[extraction, motion]', tags: '[sam2]', refs: '  - {role: evidence, ref: notes/gone.md}\n  - {role: context, ref: "https://example.test/x"}\n  - {role: unchecked, ref: notes/run.md}\n  - {role: context, ref: "shared://agshare/x"}\n  - {role: context, ref: "a talk we had"}' }),
    'wedo/topic.md': 'no header, not in findings\n',
  })
  await bare('pj-b', { 'project.yaml': PROJECT('b', AREA), 'wedo/findings/one.md': doc('f-1', 'B one', { categories: '[generation]' }) })
  x = await bare('wedo-x', { 'knowledge.yaml': KNOWLEDGE('c'), 'findings/s.md': doc('s-1', 'Shared, first'), 'findings/plain.md': 'A topic file with no header.\n', 'evidence.md': 'e\n' })
  await bare('study-y', { 'knowledge.yaml': 'schema: ag.knowledge.v1\nkind: study\nmaintenance: project\nmaintainer: c\n', 'findings/i.md': doc('i-1', 'Imported claim', { refs: '  - {role: evidence, ref: "https://example.test/paper"}' }) })
  await bare('pj-c', { 'project.yaml': PROJECT('c') }, { path: 'wedo/wedo-x', url: '../wedo-x.git', commit: x.head })
  const ids = (await collections(ctx)).map(c => c.id)
  assert.deepEqual(ids, ['a:wedo', 'b:wedo', 'repo:dev/study-y', 'repo:dev/wedo-x'])
})

test('qualified ids distinguish equal local ids; the mount names the same collection', async () => {
  assert.equal((await showFinding(ctx, 'a:wedo#f-1')).finding.title, 'A one')
  assert.equal((await showFinding(ctx, 'b:wedo#f-1')).finding.title, 'B one')
  const viaMount = await showFinding(ctx, 'c:wedo/wedo-x#s-1')
  assert.equal(viaMount.finding.qid, 'repo:dev/wedo-x#s-1')
})

test('filters combine, results carry what a chooser needs; the body and header are the source', async () => {
  const l = await listFindings(ctx, { category: ['motion'] })
  assert.deepEqual(l.findings.map(f => f.qid).sort(), ['a:wedo#f-1', 'a:wedo#f-2', 'repo:dev/study-y#i-1', 'repo:dev/wedo-x#s-1'])
  assert.deepEqual((await listFindings(ctx, { category: ['motion'], tag: ['sam2'] })).findings.map(f => f.qid), ['a:wedo#f-2'])
  assert.deepEqual((await listFindings(ctx, { text: 'b one' })).findings.map(f => f.qid), ['b:wedo#f-1'])
  const f = l.findings.find(y => y.qid === 'a:wedo#f-1')!
  assert.equal(f.summary, 'Summary of A one.'); assert.equal(f.collection, 'a:wedo'); assert.equal(f.commit, a.head); assert.equal(f.repository, 'dev/pj-a')
  const d = await showFinding(ctx, 'a:wedo#f-1')
  assert.equal(d.finding.body, 'Body of A one.\n')
  assert.match(d.finding.references.find(r => r.role === 'illustration')!.view!, /^api\/projects\/a\/raw\?path=notes%2Fclip\.mp4/)
})

test('an id or a sha made of digits stays what was written', () => {
  const d = parseFindingDocument('---\nid: 0001\ntitle: t\nsummary: s\ncategories: [motion]\nreferences:\n  - {role: evidence, ref: x}\n---\n')!
  assert.deepEqual(d.errors, []); assert.equal(d.meta.id, '0001')
})

test('a study finding keeps its kind: an imported claim is not a local result', async () => {
  const d = await showFinding(ctx, 'repo:dev/study-y#i-1')
  assert.equal(d.finding.kind, 'study')
  assert.equal(d.finding.references[0].state, 'unchecked')
})

test('reference states: resolved, missing, unchecked, each said', async () => {
  const d = await showFinding(ctx, 'a:wedo#f-2')
  const by = Object.fromEntries(d.finding.references.map(r => [r.ref, r.state]))
  assert.deepEqual(by, { 'notes/gone.md': 'missing', 'https://example.test/x': 'unchecked', 'notes/run.md': 'unchecked', 'shared://agshare/x': 'unchecked', 'a talk we had': 'unchecked' })
  const c = await checkCollection(ctx, 'a:wedo')
  assert.ok(c.items.some(i => i.code === 'missing-reference' && i.severity === 'error'))
  assert.deepEqual(c.references, { resolved: 2, missing: 1, unchecked: 4 })
})

test('a duplicate id is an actionable error and refuses the read; other ids stay readable', async () => {
  const src = join(root, 'src', 'pj-b')
  await change(src, { 'wedo/findings/again.md': doc('f-1', 'B again'), 'wedo/findings/other.md': doc('f-9', 'B other') })
  const c = await checkCollection(ctx, 'b:wedo')
  const dup = c.items.find(i => i.code === 'duplicate-id')!
  assert.equal(dup.severity, 'error'); assert.match(dup.path!, /again\.md/); assert.match(dup.path!, /one\.md/); assert.match(dup.message, /give each its own id/)
  await assert.rejects(showFinding(ctx, 'b:wedo#f-1'), (e: RequestError) => e.status === 409 && /again\.md/.test(e.message))
  assert.equal((await showFinding(ctx, 'b:wedo#f-9')).finding.title, 'B other')
})

test('an invalid header is reported, a document with none is not a finding, and neither hides the rest', async () => {
  assert.equal(parseFindingDocument('# just text\n'), null)
  assert.deepEqual(parseFindingDocument('---\nid: a b\ntitle: t\nsummary: s\ncategories: []\nreferences: []\n---\n')!.errors.length, 3)
  const src = join(root, 'src', 'study-y')
  await change(src, { 'findings/bad.md': '---\nid: [unclosed\n---\nbody\n', 'findings/thin.md': '---\nid: thin\ntitle: only a title\n---\n' })
  const l = await listFindings(ctx, { collection: 'repo:dev/study-y' })
  assert.deepEqual(l.findings.map(f => f.id), ['i-1'])
  assert.deepEqual(l.collections[0].problems.map(p => p.path).sort(), ['findings/bad.md', 'findings/thin.md'])
  const w = (await listFindings(ctx, { collection: 'repo:dev/wedo-x' })).collections[0]
  assert.deepEqual(w.unstructured, ['findings/plain.md'])
})

test('a title or path change keeps the identity; a later edit does not change a recorded revision', async () => {
  const before = await showFinding(ctx, 'a:wedo#f-1')
  const old = before.finding
  const later = await change(a.src, { 'wedo/findings/one.md': null, 'wedo/findings/renamed.md': doc('f-1', 'A one, renamed', { body: 'A later statement.\n' }) })
  const now = await showFinding(ctx, 'a:wedo#f-1')
  assert.equal(now.finding.title, 'A one, renamed'); assert.equal(now.finding.path, 'wedo/findings/renamed.md'); assert.equal(now.finding.commit, later)
  const then = await showFinding(ctx, 'a:wedo#f-1', { rev: old.commit })
  assert.equal(then.finding.title, 'A one'); assert.equal(then.finding.path, 'wedo/findings/one.md'); assert.equal(then.finding.sha256, old.sha256); assert.equal(then.finding.body, 'Body of A one.\n')
  // At a revision that has no such id it is absent, not the nearest thing.
  await change(a.src, { 'wedo/findings/three.md': doc('f-3', 'A three') })
  await assert.rejects(showFinding(ctx, 'a:wedo#f-3', { rev: old.commit }), (e: AccessError) => e.state === 'absent' && /no finding "f-3"/.test(e.message) && /f-1/.test(e.message))
  await assert.rejects(showFinding(ctx, 'a:wedo#f-1', { rev: '0'.repeat(40) }), (e: AccessError) => e.state === 'absent')
})

test('a shared collection reads what the consumer adopted, not the latest; the choice is named', async () => {
  const tip = await change(x.src, { 'findings/s.md': doc('s-1', 'Shared, later') })
  assert.notEqual(tip, x.head)
  const pinned = await showFinding(ctx, 'repo:dev/wedo-x#s-1', { as: 'c' })
  assert.equal(pinned.finding.title, 'Shared, first'); assert.equal(pinned.finding.commit, x.head); assert.match(pinned.revision.resolvedBy, /c pins/); assert.equal(pinned.revision.selector, 'pinned')
  const dflt = await showFinding(ctx, 'repo:dev/wedo-x#s-1')
  assert.equal(dflt.finding.commit, x.head); assert.match(dflt.revision.resolvedBy, /maintainer c/)
  const up = await showFinding(ctx, 'repo:dev/wedo-x#s-1', { upstream: true })
  assert.equal(up.finding.title, 'Shared, later'); assert.equal(up.finding.commit, tip); assert.match(up.revision.resolvedBy, /upstream/)
  const rev = await showFinding(ctx, 'repo:dev/wedo-x#s-1', { rev: x.head })
  assert.equal(rev.finding.title, 'Shared, first')
  await assert.rejects(showFinding(ctx, 'repo:dev/wedo-x#s-1', { as: 'a' }), (e: AccessError) => e.state === 'absent' && /a does not use/.test(e.message))
})

test('missing and unavailable are not empty', async () => {
  await assert.rejects(showFinding(ctx, 'nope:wedo#x'), (e: AccessError) => e.state === 'absent' && /no knowledge collection/.test(e.message))
  await assert.rejects(showFinding(ctx, 'not-qualified'), (e: RequestError) => e.status === 400)
  const dir = join(gitea, 'dev', 'wedo-x.git'), moved = `${dir}.moved`
  await gitOk(root, ['clone', '-q', '--bare', dir, moved])
  await rm(dir, { recursive: true, force: true })
  await rm(join(ctx.area, '.local', 'access-cache'), { recursive: true, force: true })
  const l = await listFindings(ctx, { collection: 'repo:dev/wedo-x' })
  assert.equal(l.collections[0].state === 'read', false)
  assert.equal(l.findings.length, 0)
  assert.ok(l.collections[0].problem)
  await gitOk(root, ['clone', '-q', '--bare', moved, dir]); await rm(moved, { recursive: true, force: true })
})

test('a recorded decision reads back at its revision; a later edit does not rewrite it; a wrong record is said', async () => {
  const live = await showFinding(ctx, 'a:wedo#f-1')
  const cite = await citation(ctx, 'a:wedo#f-1', {}, 'adapted')
  assert.match(cite.block, /^```knowledge-decisions\n/)
  assert.equal(cite.entries[0].commit, live.finding.commit); assert.equal(cite.entries[0].sha256, live.finding.sha256)
  assert.equal((await citation(ctx, ['a:wedo#f-1', 'a:wedo#f-2'])).entries.length, 2)
  const entries = `\`\`\`knowledge-decisions
- finding: a:wedo#f-1
  commit: ${live.finding.commit}
  path: ${live.finding.path}
  sha256: ${live.finding.sha256}
  decision: adapted
  reason: because
  work: [notes/run.md]
  verification: [devdocs/runs/w/run-001/nothing.md]
- finding: a:wedo#f-1
  commit: ${live.finding.commit}
  sha256: ${'0'.repeat(64)}
  decision: adopted
- finding: a:wedo#never
  commit: ${live.finding.commit}
  decision: rejected
- finding: a:wedo#f-2
  decision: adopted
- finding: a:wedo#f-1
  decision: adopted
  unpublished: true
  sha256: ${'1'.repeat(64)}
- decision: none
  reason: nothing applied
\`\`\`
`
  await change(a.src, { 'devdocs/runs/w/run-001/report.md': entries, 'devdocs/runs/w/run-001/run.json': '{}' })
  const edited = await change(a.src, { 'wedo/findings/renamed.md': doc('f-1', 'A one, edited again') })
  const r = await runDecisions(ctx, 'a', 'w/run-001')
  assert.deepEqual(r.decisions.map(d => d.state), ['resolved', 'different', 'missing', 'invalid', 'unpublished', 'none'])
  const first = r.decisions[0]
  assert.equal(first.atRevision!.title, 'A one, renamed')
  assert.ok(first.current && 'changed' in first.current && first.current.changed && first.current.commit === edited)
  assert.deepEqual(first.work, [{ ref: 'notes/run.md', state: 'found' }])
  assert.deepEqual(first.verification, [{ ref: 'devdocs/runs/w/run-001/nothing.md', state: 'missing' }])
})

test('check --dir reads a folder as it stands, before anything is published', async () => {
  const dir = join(a.src, 'wedo')
  await writeFile(join(dir, 'findings', 'draft.md'), doc('f-1', 'A second f-1', { refs: '  - {role: evidence, ref: notes/run.md}\n  - {role: evidence, ref: notes/absent.md}\n  - {role: context, ref: "https://example.test/x"}' }))
  const r = await checkFolder(dir)
  assert.ok(r.items.some(i => i.code === 'duplicate-id'))
  assert.ok(r.items.some(i => i.code === 'missing-reference' && /notes\/absent\.md/.test(i.message)))
  assert.ok(r.references.unchecked >= 1)
  await rm(join(dir, 'findings', 'draft.md'))
})
