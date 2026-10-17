// project_migration p6 Step 4: shared areas — a logical reference resolved
// per host, input sets with manifests, external outputs published without a
// partial state, and confirmations bound to exactly the published bytes.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../shared/canonical.ts'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, runOp } from '../server/runs.ts'
import {
  availability, listFiles, publishOutput, resolveRef, selectInput, serveShare, setShareArea, verifyInput, verifyManifest, verifyOutput,
} from '../server/shares.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { main } from '../cli/wfe.ts'
import { outputBody, parseRef, refsIn } from '../shared/shares.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-shares-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { setShareArea(undefined); await rm(root, { recursive: true, force: true }) })

const FLOW = `schema: ag.workflow.v2
id: onboard
name: Onboard
intent: |
  Build from the supplied models, confirm.
documentation: {policy: manual}
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, description: Build.}
  check: {type: talk, confirms: result, description: Ask.}
edges:
  - {from: build, to: check}
`
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
let k = 0

// A share as a host sees it: a folder holding the marker, configured under
// a logical name in the area's shares.json.
async function share(area: string, id: string, rootDir: string, marker = true) {
  await mkdir(rootDir, { recursive: true })
  if (marker) await writeFile(join(rootDir, '.wfe-share.json'), JSON.stringify({ share: id }))
  await mkdir(area, { recursive: true })
  await writeFile(join(area, 'shares.json'), JSON.stringify({ shares: { [id]: { root: rootDir } } }))
}

async function setup(text = 'Build the wolf from shared://agshare/inputs/wolf/ please.') {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'onboard.yaml'), FLOW)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const shareRoot = join(root, `nfs-${k}`)
  await share(area, 'agshare', shareRoot)
  await mkdir(join(shareRoot, 'inputs', 'wolf', 'tex'), { recursive: true })
  await writeFile(join(shareRoot, 'inputs', 'wolf', 'wolf.glb'), Buffer.alloc(300_000, 7))
  await writeFile(join(shareRoot, 'inputs', 'wolf', 'tex', 'fur.png'), 'png bytes')
  await writeFile(join(shareRoot, 'inputs', 'wolf', '.DS_Store'), 'not content')
  setShareArea(area)
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const created = await createRun(ws, { workflow: 'onboard', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text, author: 'Pat' } })
  return { ws, ref: created.ref, dir, area, shareRoot }
}
const op = (ws: Workspace, ref: RunRef, o: OpInput, by = 'agent') => runOp(ws, ref, o, { by, via: 'cli' })
const rec = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!

test('references: parsed from the words, normalized, never a host path', () => {
  assert.deepEqual(parseRef('shared://agshare/inputs/wolf/'), { ref: 'shared://agshare/inputs/wolf/', share: 'agshare', path: 'inputs/wolf', folder: true })
  assert.equal(parseRef('shared://agshare')?.ref, 'shared://agshare/')
  assert.equal(parseRef('shared://agshare/../etc/passwd'), null)
  assert.equal(parseRef('shared://Bad Share/x'), null)
  assert.equal(parseRef('/mnt/agshare/x'), null)
  assert.deepEqual(refsIn('Use shared://agshare/inputs/wolf/, and `shared://agshare/ref/a.glb`. Again shared://agshare/inputs/wolf/.').map(r => r.ref),
    ['shared://agshare/inputs/wolf/', 'shared://agshare/ref/a.glb'])
})

test('a request names a folder; the record keeps the reference, the run view reads availability without hashing', async () => {
  const { ws, ref } = await setup()
  const r = await rec(ws, ref)
  assert.deepEqual(r.input.references?.map(x => x.ref), ['shared://agshare/inputs/wolf/'])
  const a = await availability(r)
  assert.equal(a.references[0].state, 'ok')
  // No physical location in the tracked record.
  assert.ok(!JSON.stringify(r).includes('nfs-'))
})

test('the same logical reference resolves on two hosts with different mount paths; a manifest from one verifies on the other', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  const s = await selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/' }, { by: 'agent', via: 'cli' })
  const set = s.record.inputs![s.input]
  assert.equal(set.count, 2) // dot entries are not content
  assert.equal(set.bytes, 300_000 + 'png bytes'.length)
  const manifestText = await readFile(join(ws.root, set.file), 'utf8')
  assert.ok(!manifestText.includes(shareRoot))
  // Another host: its own area and another mount path for the same share.
  const otherArea = join(root, `other-${k}`), otherMount = join(root, `mnt-other-${k}`)
  await cp(shareRoot, otherMount, { recursive: true })
  await mkdir(otherArea, { recursive: true })
  await writeFile(join(otherArea, 'shares.json'), JSON.stringify({ shares: { agshare: { root: otherMount } } }))
  setShareArea(otherArea)
  try {
    const v = await verifyManifest(manifestText)
    assert.equal(v.status, 'verified', v.detail)
    assert.match((await resolveRef('shared://agshare/inputs/wolf/')).abs ?? '', /mnt-other/)
    // A tampered manifest is not its own digest.
    assert.equal((await verifyManifest(manifestText.replace('"bytes": 9', '"bytes": 10'))).status, 'changed')
  } finally { setShareArea(join(root, `area-${k}`)) }
})

test('a missing mount is unmounted, not an empty folder; nothing is recorded', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  await rm(join(shareRoot, '.wfe-share.json'))
  assert.equal((await resolveRef('shared://agshare/inputs/wolf/')).state, 'unmounted')
  await assert.rejects(selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/' }, { by: 'agent', via: 'cli' }), (e: unknown) => code(e) === 'share-unmounted')
  assert.equal((await rec(ws, ref)).inputs, undefined)
  assert.equal((await resolveRef('shared://nosuch/x')).state, 'unknown-share')
})

test('a staged input does not see later changes; an in-place input that changed is recorded as changed, never silently re-read', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  const a = await selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/' }, { by: 'agent', via: 'cli' })
  const b = await selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/', staging: 'in-place' }, { by: 'agent', via: 'cli' })
  assert.deepEqual([a.input, b.input], ['i1', 'i2'])
  assert.equal(a.record.inputs!.i1.digest, b.record.inputs!.i2.digest) // same bytes, same digest
  assert.deepEqual((await readdir(join(ws.root, '.local', 'inputs'))).sort(), ['i1']) // no staging leftovers
  await writeFile(join(shareRoot, 'inputs', 'wolf', 'tex', 'fur.png'), 'PNG BYTES') // same size, other content
  assert.equal((await verifyInput(ws, ref, 'i1', { by: 'agent', via: 'cli' })).status, 'verified')
  assert.equal((await verifyInput(ws, ref, 'i2', { by: 'agent', via: 'cli', quick: true })).status, 'verified') // sizes only
  const full = await verifyInput(ws, ref, 'i2', { by: 'agent', via: 'cli' })
  assert.equal(full.status, 'changed')
  assert.match(full.detail, /fur\.png/)
  assert.equal((await rec(ws, ref)).inputs!.i2.last?.status, 'changed')
  await rm(join(shareRoot, 'inputs', 'wolf', 'wolf.glb'))
  assert.equal((await verifyInput(ws, ref, 'i2', { by: 'agent', via: 'cli', quick: true })).status, 'missing')
  // Input is selected only from a running node.
  await op(ws, ref, { op: 'node.complete', node: 'build', outcome: 'ok' })
  await assert.rejects(selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/' }, { by: 'agent', via: 'cli' }), (e: unknown) => code(e) === 'state')
})

async function outputDir(ws: Workspace, name: string, files: Record<string, string>) {
  const d = join(ws.root, '.local', name)
  await mkdir(d, { recursive: true })
  for (const [f, t] of Object.entries(files)) await writeFile(join(d, f), t)
  return `.local/${name}`
}

test('publication: never partial, retries adopt the same publication, a foreign folder is left alone, concurrent candidates coexist', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  await selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/' }, { by: 'agent', via: 'cli' })
  const runDir = join(shareRoot, 'runs', 'p', ref.workflow, ref.run)
  // An interrupted publication left a partial folder and someone's o1 folder without a manifest.
  await mkdir(join(runDir, '.partial-dead'), { recursive: true }); await writeFile(join(runDir, '.partial-dead', 'half.bin'), 'x')
  await mkdir(join(runDir, 'o1'), { recursive: true }); await writeFile(join(runDir, 'o1', 'stray.txt'), 'someone else')
  const srcA = await outputDir(ws, 'out-a', { 'scene.tscn': 'A scene', 'wolf.glb': 'A model' })
  const srcB = await outputDir(ws, 'out-b', { 'scene.tscn': 'B scene' })
  const [pa, pb] = await Promise.all([
    publishOutput(ws, ref, { node: 'build', source: srcA, title: 'Rig A', candidate: 'rig-a', share: 'agshare' }, { by: 'agent', via: 'cli' }),
    publishOutput(ws, ref, { node: 'build', source: srcB, title: 'Rig B', candidate: 'rig-b', share: 'agshare' }, { by: 'agent', via: 'cli' }),
  ])
  assert.deepEqual([pa.output, pb.output].sort(), ['o2', 'o3']) // o1 belongs to nobody we know: skipped
  assert.equal(await readFile(join(runDir, 'o1', 'stray.txt'), 'utf8'), 'someone else')
  const r = await rec(ws, ref)
  assert.notEqual(r.outputs![pa.output].digest, r.outputs![pb.output].digest)
  assert.deepEqual(r.outputs![pa.output].inputs, [r.inputs!.i1.digest])
  // Only finished publications are visible as content.
  assert.deepEqual((await readdir(runDir)).filter(n => n.startsWith('.partial-') && n !== '.partial-dead'), [])
  assert.deepEqual((await listFiles(join(runDir, pa.output))).map(f => f.path).sort(), ['scene.tscn', 'wolf.glb'])
  const srcC = await outputDir(ws, 'out-c', { 'scene.tscn': 'C scene' })
  // Same receipt twice records once.
  const again = await publishOutput(ws, ref, { node: 'build', source: srcC, title: 'Rig C', candidate: 'rig-c', share: 'agshare' }, { by: 'agent', via: 'cli', receipt: 'rc-1' })
  const dup = await publishOutput(ws, ref, { node: 'build', source: srcC, title: 'Rig C', candidate: 'rig-c', share: 'agshare' }, { by: 'agent', via: 'cli', receipt: 'rc-1' })
  assert.equal(dup.duplicate, true); assert.equal(dup.output, again.output)
})

test('a folder finished on the share but not recorded (a crash before the record) is adopted by the retry', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  const src = await outputDir(ws, 'out', { 'a.txt': 'aaa', 'b.bin': 'bbbb' })
  // What the crashed attempt left: the finished folder with its manifest, no record.
  const outRef = `shared://agshare/runs/p/${ref.workflow}/${ref.run}/o1/`
  const files = [{ path: 'a.txt', bytes: 3, sha256: createHash('sha256').update('aaa').digest('hex') }, { path: 'b.bin', bytes: 4, sha256: createHash('sha256').update('bbbb').digest('hex') }]
  const body = outputBody(outRef, 'main', [], files)
  const digest = `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`
  const folder = join(shareRoot, 'runs', 'p', ref.workflow, ref.run, 'o1')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'a.txt'), 'aaa'); await writeFile(join(folder, 'b.bin'), 'bbbb')
  await writeFile(join(folder, '.wfe-output.json'), JSON.stringify({ ...body, id: 'o1', digest }))
  const p = await publishOutput(ws, ref, { node: 'build', source: src, title: 'A', candidate: 'main', share: 'agshare' }, { by: 'agent', via: 'cli' })
  assert.equal(p.output, 'o1') // adopted: a rename onto the non-empty folder would have failed
  assert.equal(p.record.outputs!.o1.digest, digest)
  // The same folder with altered files is not adopted silently.
  const second = await createRun(ws, { workflow: 'onboard', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'again', author: 'Pat' } })
  await op(ws, second.ref, { op: 'node.start', node: 'build' })
  const ref2 = `shared://agshare/runs/p/${second.ref.workflow}/${second.ref.run}/o1/`
  const body2 = outputBody(ref2, 'main', [], files)
  const folder2 = join(shareRoot, 'runs', 'p', second.ref.workflow, second.ref.run, 'o1')
  await mkdir(folder2, { recursive: true })
  await writeFile(join(folder2, 'a.txt'), 'aaX'); await writeFile(join(folder2, 'b.bin'), 'bbbb')
  await writeFile(join(folder2, '.wfe-output.json'), JSON.stringify({ ...body2, id: 'o1', digest: `sha256:${createHash('sha256').update(canonicalJson(body2)).digest('hex')}` }))
  await assert.rejects(publishOutput(ws, second.ref, { node: 'build', source: src, title: 'A', candidate: 'main', share: 'agshare' }, { by: 'agent', via: 'cli' }), (e: unknown) => code(e) === 'output-altered')
})

test('confirmation binds the exact output; altered, missing or superseded outputs are refused', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  const src = await outputDir(ws, 'out', { 'scene.tscn': 'v1' })
  const p1 = await publishOutput(ws, ref, { node: 'build', source: src, title: 'Wolf', candidate: 'main', share: 'agshare' }, { by: 'agent', via: 'cli' })
  await op(ws, ref, { op: 'node.complete', node: 'build', outcome: 'ok' })
  await op(ws, ref, { op: 'node.start', node: 'check' })
  const folder = join(shareRoot, 'runs', 'p', ref.workflow, ref.run, p1.output)
  // Altered on the share: not presented.
  await writeFile(join(folder, 'scene.tscn'), 'v!')
  await assert.rejects(op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'OK?', to: 'Pat', output: p1.output }), (e: unknown) => code(e) === 'output-altered')
  assert.equal((await verifyOutput(ws, ref, p1.output, { by: 'agent', via: 'cli' })).status, 'changed')
  await writeFile(join(folder, 'scene.tscn'), 'v1') // repaired
  await op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'Does the wolf work?', to: 'Pat', output: p1.output })
  let r = await rec(ws, ref)
  assert.deepEqual(r.questions.q1.output, { id: p1.output, digest: r.outputs![p1.output].digest })
  assert.ok(r.questions.q1.subject!.some(s => s.path === r.outputs![p1.output].file))
  await op(ws, ref, { op: 'question.answer', question: 'q1', text: 'Yes', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: 'q1' })
  // Missing on the share at decision time: not accepted as the verified result.
  await rm(join(folder, 'scene.tscn'))
  await assert.rejects(op(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1' }, 'Pat'), (e: unknown) => code(e) === 'output-missing')
  await writeFile(join(folder, 'scene.tscn'), 'v1')
  await op(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1' }, 'Pat')
  r = await rec(ws, ref)
  assert.deepEqual(r.decisions.at(-1)!.confirmation?.output, { id: p1.output, digest: r.outputs![p1.output].digest })
  assert.match(r.decisions.at(-1)!.evidence, /output o1/)
})

test('a later output of the same candidate supersedes the asked one; another candidate does not', async () => {
  for (const [later, refused] of [['alt', false], ['main', true]] as const) {
    const { ws, ref } = await setup()
    await op(ws, ref, { op: 'node.start', node: 'build' })
    const src = await outputDir(ws, 'out', { 'scene.tscn': 'v1' })
    await publishOutput(ws, ref, { node: 'build', source: src, title: 'Wolf', candidate: 'main', share: 'agshare' }, { by: 'agent', via: 'cli' })
    await writeFile(join(ws.root, src, 'scene.tscn'), 'v2')
    await publishOutput(ws, ref, { node: 'build', source: src, title: 'Wolf 2', candidate: later, share: 'agshare' }, { by: 'agent', via: 'cli' })
    await op(ws, ref, { op: 'node.complete', node: 'build', outcome: 'ok' })
    await op(ws, ref, { op: 'node.start', node: 'check' })
    await op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'OK?', to: 'Pat', output: 'o1' })
    await op(ws, ref, { op: 'question.answer', question: 'q1', text: 'Yes', from: 'Pat' }, 'Pat')
    await op(ws, ref, { op: 'question.take-up', question: 'q1' })
    const decide = op(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1' }, 'Pat')
    if (refused) await assert.rejects(decide, (e: unknown) => code(e) === 'output-superseded')
    else await decide
  }
})

test('ordinary project artifacts are unchanged: attach and loose-file confirmation work without any share', async () => {
  const { ws, ref, dir } = await setup('No shared data here.')
  assert.equal((await rec(ws, ref)).input.references, undefined)
  await op(ws, ref, { op: 'node.start', node: 'build' })
  await writeFile(join(dir, 'report.md'), '# done\n')
  await op(ws, ref, { op: 'artifact.attach', path: 'report.md', node: 'build', title: 'Report' })
  await op(ws, ref, { op: 'node.complete', node: 'build', outcome: 'ok' })
  await op(ws, ref, { op: 'node.start', node: 'check' })
  await op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'OK?', to: 'Pat', subjects: ['report.md'] })
  await op(ws, ref, { op: 'question.answer', question: 'q1', text: 'Yes', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: 'q1' })
  await op(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1' }, 'Pat')
  const r = await rec(ws, ref)
  assert.equal(r.outputs, undefined)
  assert.equal(r.decisions.at(-1)!.confirmation?.output, undefined)
})

test('download: a file streamed with byte ranges, a folder listed, dot entries and escapes never served', async () => {
  const { shareRoot } = await setup()
  await mkdir(join(shareRoot, 'runs', '.partial-x'), { recursive: true })
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x')
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    serveShare(req, res, parts[0], parts.slice(1).join('/'), u.pathname.endsWith('/')).catch((e: RequestError) => { res.writeHead(e.status ?? 500); res.end(e.message) })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const whole = await fetch(`${base}/agshare/inputs/wolf/wolf.glb`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal((await whole.arrayBuffer()).byteLength, 300_000)
    const part = await fetch(`${base}/agshare/inputs/wolf/wolf.glb`, { headers: { range: 'bytes=10-19' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/300000')
    assert.equal((await part.arrayBuffer()).byteLength, 10)
    const list = await (await fetch(`${base}/agshare/inputs/wolf/`)).json() as { entries: { name: string }[] }
    assert.deepEqual(list.entries.map(e => e.name), ['tex', 'wolf.glb'])
    assert.equal((await fetch(`${base}/agshare/.wfe-share.json`)).status, 404)
    assert.equal((await fetch(`${base}/agshare/runs/.partial-x/`)).status, 404)
    assert.equal((await fetch(`${base}/agshare/inputs/nothing.bin`)).status, 404)
  } finally { server.close() }
})

test('CLI: share list/resolve/verify and run inputs take their flags; --quick and --verify-all need no value', async () => {
  const { ws, ref, area } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  const s = await selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/', staging: 'in-place' }, { by: 'agent', via: 'cli' })
  const lines: string[] = []
  const log = console.log, err = console.error
  const run = async (argv: string[]) => {
    lines.length = 0
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }; console.error = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try { return await main([...argv, '--registry', join(area, 'registry.json'), '--json']) } finally { console.log = log; console.error = err; setShareArea(area) }
  }
  assert.equal(await run(['share', 'list']), 0)
  assert.equal(JSON.parse(lines.join('\n')).shares[0].state, 'ok')
  assert.equal(await run(['share', 'resolve', 'shared://agshare/inputs/wolf/']), 0)
  assert.equal(await run(['share', 'verify', join(ws.root, s.record.inputs!.i1.file), '--quick']), 0, lines.join('\n'))
  assert.equal(await run(['run', 'inputs', `${ref.workflow}/${ref.run}`, '--workspace', 'p', '--verify-all', '--quick', '--by', 'Pat']), 0, lines.join('\n'))
  assert.equal(await run(['share', 'resolve', 'shared://agshare/nothing/']), 1)
})

test('a copy killed mid-way leaves an unfinished folder that the next copy on this host removes; another host\'s or a live one is kept', async () => {
  const { ws, ref, shareRoot } = await setup()
  await op(ws, ref, { op: 'node.start', node: 'build' })
  const runDir = join(shareRoot, 'runs', 'p', ref.workflow, ref.run)
  await mkdir(runDir, { recursive: true })
  const dead = `.partial-${hostname()}-999999-0badf00d`, other = '.partial-elsewhere.local-1-0badf00d', live = `.partial-${hostname()}-${process.pid}-0badf00d`
  for (const d of [dead, other, live]) { await mkdir(join(runDir, d)); await writeFile(join(runDir, d, 'half.bin'), 'x') }
  const src = await outputDir(ws, 'out', { 'a.txt': 'a' })
  await publishOutput(ws, ref, { node: 'build', source: src, title: 'A', candidate: 'main', share: 'agshare' }, { by: 'agent', via: 'cli' })
  const left = await readdir(runDir)
  assert.ok(!left.includes(dead))
  assert.ok(left.includes(other) && left.includes(live))
  assert.ok(left.includes('o1'))
  // the same for an input's staging folder in the run copy
  await mkdir(join(ws.root, '.local', 'inputs', `.staging-${hostname()}-999999-0badf00d`), { recursive: true })
  await selectInput(ws, ref, { node: 'build', ref: 'shared://agshare/inputs/wolf/' }, { by: 'agent', via: 'cli' })
  assert.deepEqual(await readdir(join(ws.root, '.local', 'inputs')), ['i1'])
})
