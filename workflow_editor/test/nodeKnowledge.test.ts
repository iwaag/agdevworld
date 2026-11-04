// improve_workflow p3: knowledge on a node. A category alone, several findings,
// unknown values and malformed references in the definition; what the digest
// counts; frozen selections, specialization and run adjustments, whose history is
// derived from revisions and keeps what was removed.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instantiate, normalizeContent, contentProblems, type NodeTemplate } from '../shared/catalog.ts'
import { semanticDigest } from '../shared/canonical.ts'
import { compile } from '../shared/compile.ts'
import { limitSections, replacingFinding, shortTitle, withCategory, withFinding, withoutCategory, withoutFinding, type KnowledgeRef } from '../shared/knowledge.ts'
import { cloneWorkflow, emptyWorkflow } from '../shared/model.ts'
import { checkRecord, definitionMeaningBrief, effectiveOf, knowledgeHistory } from '../shared/run.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import { newWorkflowText, parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'

const sha = (c: string) => c.repeat(64)
const REF_A = `{id: "gimmickimg:wedo#f-1", repository: dev/pj-g, commit: aaaaaaa1, path: wedo/findings/one.md, sha256: ${sha('a')}, title: "First - with a qualifier", summary: Moves a part., status: observed-once}`
const REF_B = `{id: "repo:dev/wedo-x#f-2", repository: dev/wedo-x, commit: bbbbbbb2, path: findings/two.md, sha256: ${sha('b')}, title: Second}`
const REF_C = `{id: "gimmickimg:wedo#f-1", repository: dev/pj-g, commit: ccccccc3, path: wedo/findings/one.md, sha256: ${sha('c')}, title: First edited}`
const def = (knowledge: string, extra = '', more = '') => `schema: ag.workflow.v2
id: world
name: World
intent: Build a world.
documentation: {policy: custom, plan: false, reports: false, final: false}
nodes:
  work:
    type: do
    description: The work.
${extra}${knowledge ? `    knowledge:\n${knowledge}` : ''}
${more}edges: []
`
const model = (text: string) => { const p = parseWorkflow(text); assert.ok(p.ok, JSON.stringify(p)); return p.model }
const codes = (text: string) => validateWorkflow(model(text)).map(i => i.code)
const WHOLE = `      - category: motion\n        note: Why it points here.\n        findings:\n          - ${REF_A}\n          - ${REF_B}\n      - category: extraction\n      - category: hologram\n`

test('the file keeps a category alone, several findings and an unknown category through a round trip', () => {
  const w = model(def(WHOLE))
  assert.deepEqual(w.nodes.work.knowledge?.map(a => a.category), ['motion', 'extraction', 'hologram'])
  assert.equal(w.nodes.work.knowledge?.[0].findings?.length, 2)
  assert.equal(w.nodes.work.knowledge?.[0].findings?.[0].status, 'observed-once')
  const parsed = parseWorkflow(def(WHOLE))
  assert.ok(parsed.ok)
  assert.equal(renderWorkflow(parsed.doc, parsed.model), def(WHOLE), 'an unchanged file stays as written')
  const again = model(newWorkflowText(w))
  assert.deepEqual(again.nodes.work.knowledge, w.nodes.work.knowledge)
  assert.deepEqual(cloneWorkflow(w).nodes.work.knowledge, w.nodes.work.knowledge)
  assert.deepEqual(validateWorkflow(w).filter(i => /knowledge/.test(i.code)).map(i => [i.code, i.severity]), [['knowledge-category-unknown', 'warning']])
})

test('a malformed reference is reported, and what was written stays readable', () => {
  assert.ok(codes(def(`      - findings:\n          - {id: no-collection, repository: x, commit: aaaaaaa, path: p, sha256: ${sha('a')}}\n`)).includes('knowledge-finding-id'))
  assert.ok(codes(def(`      - findings:\n          - {id: "a:b#c", commit: nothex, path: p, sha256: short}\n`)).includes('knowledge-finding-commit'))
  assert.ok(codes(def(`      - findings:\n          - {id: "a:b#c", commit: aaaaaaa, sha256: short}\n`)).includes('knowledge-finding-sha256'))
  assert.ok(codes(def(`      - findings:\n          - {id: "a:b#c", commit: aaaaaaa, sha256: ${sha('a')}}\n`)).includes('knowledge-finding-source'))
  assert.ok(codes(def(`      - note: nothing else\n`)).includes('knowledge-empty'))
  assert.ok(codes(def(`      - category: motion\n      - category: motion\n`)).includes('knowledge-category-duplicate'))
  assert.ok(codes(def(`      - category: motion\n        findings:\n          - ${REF_A}\n      - category: process\n        findings:\n          - ${REF_C}\n`)).includes('knowledge-finding-duplicate'))
  const kept = model(def(`      - findings:\n          - {id: wrong, commit: nope}\n`))
  assert.equal(kept.nodes.work.knowledge?.[0].findings?.[0].id, 'wrong')
})

test('the digest counts what is selected, not its order or display snapshot', async () => {
  const base = await semanticDigest('definition', model(def(WHOLE)))
  const reordered = `      - category: hologram\n      - category: extraction\n      - category: motion\n        note: Why it points here.\n        findings:\n          - ${REF_B}\n          - ${REF_A}\n`
  assert.equal(await semanticDigest('definition', model(def(reordered))), base)
  const w = model(def(WHOLE))
  w.nodes.work.knowledge![0].findings![0].title = 'Retitled for display'
  delete w.nodes.work.knowledge![0].findings![0].summary
  assert.equal(await semanticDigest('definition', w), base)
  const other = model(def(WHOLE.replace(REF_A, REF_C)))
  assert.notEqual(await semanticDigest('definition', other), base, 'a newer revision is an edit')
  assert.notEqual(await semanticDigest('definition', model(def(WHOLE.replace('      - category: extraction\n', '')))), base)
  assert.notEqual(await semanticDigest('definition', model(def(''))), base)
})

test('compile freezes the references with their snapshot', () => {
  const c = compile(model(def(WHOLE)))
  assert.ok(c.ok)
  assert.equal(c.graph.nodes.work.knowledge?.[0].findings?.[0].title, 'First - with a qualifier')
  assert.equal(c.graph.nodes.work.knowledge?.[1].category, 'extraction')
})

test('edits keep the intent: removing a finding keeps its category; a finding is stored once', () => {
  const a: KnowledgeRef = { id: 'a:b#1', repository: 'r', commit: 'aaaaaaa', path: 'p', sha256: sha('a') }
  const b: KnowledgeRef = { ...a, id: 'a:b#2' }
  let l = withCategory([], 'motion')
  assert.deepEqual(withCategory(l, 'motion'), l)
  l = withFinding(l, 'motion', a)
  l = withFinding(l, 'motion', b)
  assert.equal(l[0].findings?.length, 2)
  l = withFinding(l, 'process', a)
  assert.deepEqual(l.map(x => [x.category, x.findings?.map(f => f.id)]), [['motion', ['a:b#2']], ['process', ['a:b#1']]])
  l = withoutFinding(l, 'a:b#2')
  assert.deepEqual(l[0], { category: 'motion' })
  assert.equal(withFinding([], undefined, a)[0].category, undefined)
  assert.equal(replacingFinding(l, { ...a, commit: 'bbbbbbb' })[1].findings?.[0].commit, 'bbbbbbb')
  assert.equal(withoutCategory(l, 'process').length, 1)
})

test('limits are what the body has; a short title stops at its qualifier', () => {
  const s = limitSections('# T\n\nintro\n\n## What was observed\nx\n\n## Limits and contrary observations\nIt failed once.\n\n## Whose judgement\nAn agent.\n\n## Not established\nMuch.\n')
  assert.deepEqual(s.map(x => x.heading), ['Limits and contrary observations', 'Whose judgement', 'Not established'])
  assert.deepEqual(limitSections('# T\n\nFree prose only.\n'), [])
  assert.equal(shortTitle('Looping a generated clip - first=last conditioning'), 'Looping a generated c…')
  assert.equal(shortTitle('Short (the bee)'), 'Short')
  assert.ok(shortTitle('A very long title with no qualifier whatsoever in it').length <= 22)
})

test('a template carries knowledge into the node it makes', () => {
  const content = { name: 'Move', type: 'do', description: 'Moves.', expectation: 'As a step.', knowledge: [{ category: 'motion' }] }
  assert.deepEqual(contentProblems(content), [])
  assert.deepEqual(normalizeContent(content).knowledge, [{ category: 'motion' }])
  assert.ok(contentProblems({ ...content, knowledge: [{}] }).length)
  const t = { ...normalizeContent(content), id: 'move', revision: 1, updated: 'now', by: 'x' } as NodeTemplate
  const r = instantiate(emptyWorkflow('w', 'W'), t)
  assert.deepEqual(r.workflow.nodes[r.node].knowledge, [{ category: 'motion' }])
})

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-node-knowledge-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(() => rm(root, { recursive: true, force: true }))

const EXAMPLE = def('      - category: motion\n        note: How it might move.\n', '    example: true\n', '')
async function setup(text: string) {
  const area = join(root, 'area')
  await rm(area, { recursive: true, force: true })
  const dir = join(area, 'pj-p')
  const registry = join(area, 'registry.json')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'world.yaml'), text)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const ref = (await createRun(ws, { workflow: 'world', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'a world', author: 'Pat' } })).ref
  return { ws, ref, dir }
}
const node = (id: string, knowledge: string, extra = '') => `  ${id}:\n    type: do\n    description: ${id}.\n${extra}${knowledge ? `    knowledge:\n${knowledge}` : ''}\n`
const graph = (nodes: string) => `schema: ag.workflow.v2\nid: world\nname: World\nintent: Build a world.\ndocumentation: {policy: custom, plan: false, reports: false, final: false}\nnodes:\n${nodes}edges: []\n`

test('a category-only example specializes into a chosen finding, is changed later, and the history stays', async () => {
  const { ws, ref, dir } = await setup(EXAMPLE)
  const read = async () => { const r = await readRun(ws, ref); assert.ok(r.record, r.problem?.message); return r.record! }
  const first = await read()
  assert.equal(first.definition.effective?.nodes.work.knowledge?.[0].findings, undefined)
  assert.match(definitionMeaningBrief(first).join('\n'), /work \(example; carry the intent onto what replaces it\): motion \(How it might move\.\): nothing selected/)

  const adjust = async (text: string, reason: string) => { const a = await adjustRun(ws, ref, { text, reason, source: { kind: 'agent' } }, { by: 'agent', via: 'cli' }); assert.ok(a.ok, JSON.stringify(a.problems)); return a }
  const one = await adjust(graph(node('coast', `      - category: motion\n        findings:\n          - ${REF_A}\n`, '    specializes: {examples: [work], revision: r1}\n')), 'A cut-out suits the coast.')
  assert.deepEqual(one.graph.added, ['coast'])
  let h = knowledgeHistory(await read(), 'coast')
  assert.deepEqual(h.origin?.from, { examples: ['work'], revision: 'r1' })
  assert.deepEqual(h.origin?.knowledge, [{ category: 'motion', note: 'How it might move.' }])
  assert.equal(h.changes.length, 1)
  assert.equal(h.changes[0].reason, 'A cut-out suits the coast.')

  // Replace by a different finding, then take away everything but the category.
  const two = await adjust(graph(node('coast', `      - category: motion\n        findings:\n          - ${REF_B}\n`, '    specializes: {examples: [work], revision: r1}\n')), 'The other method fits the tide better.')
  assert.ok(two.authored.changed.some(c => c.id === 'coast' && c.fields.includes('knowledge')), JSON.stringify(two.authored))
  await adjust(graph(node('coast', '      - category: motion\n', '    specializes: {examples: [work], revision: r1}\n')), 'Neither held up; declining both.')
  const rec = await read()
  h = knowledgeHistory(rec, 'coast')
  assert.deepEqual(h.current, [{ category: 'motion' }])
  assert.deepEqual(h.changes.map(c => c.reason), ['A cut-out suits the coast.', 'The other method fits the tide better.', 'Neither held up; declining both.'])
  assert.equal(h.changes[1].before[0].findings?.[0].id, 'gimmickimg:wedo#f-1')
  assert.equal(h.changes[2].before[0].findings?.[0].id, 'repo:dev/wedo-x#f-2')
  // Earlier revisions keep their words and the original example.
  assert.equal(rec.definition.effective?.nodes.work.example, true)
  assert.equal(rec.definition.revisions?.[0].effective?.nodes.coast.knowledge?.[0].findings?.[0].commit, 'aaaaaaa1')
  assert.equal(effectiveOf(rec)!.nodes.coast.knowledge?.[0].findings, undefined)
  // The record replays from its history.
  const raw = JSON.parse(await readFile(join(dir, 'devdocs', 'runs', 'world', ref.run, 'run.json'), 'utf8'))
  const original = compile(model(EXAMPLE))
  assert.ok(original.ok)
  const check = checkRecord(raw, { nodes: original.graph.nodes, edges: original.graph.edges, groups: original.graph.groups })
  assert.ok(check.ok, check.ok ? '' : check.message)
})

test('a run freezes a selected revision; a node never selected has no origin knowledge', async () => {
  const { ws, ref } = await setup(def(`      - category: motion\n        findings:\n          - ${REF_A}\n`))
  const r = await readRun(ws, ref)
  const h = knowledgeHistory(r.record!, 'work')
  assert.equal(h.origin?.revision, 'r1')
  assert.equal(h.current[0].findings?.[0].commit, 'aaaaaaa1')
  assert.deepEqual(h.changes, [])
  assert.match(definitionMeaningBrief(r.record!).join('\n'), /gimmickimg:wedo#f-1@aaaaaaa1 "First - with a qualifier"/)
  assert.deepEqual(knowledgeHistory(r.record!, 'absent'), { current: [], origin: null, changes: [] })
})
