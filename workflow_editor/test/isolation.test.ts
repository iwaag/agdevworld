// p9 step 2: execution and records go through each run's own working copy.
// Two runs of one project change the same tracked path independently; the
// CLI, the HTTP API, the watcher and the notifier all see both, each with
// its own content; nothing reaches the shared branch or the project
// workspace; one run's files never appear in the other's copy.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli/wfe.ts'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk } from '../server/git.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { listRuns, readRun, readRunFile, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Watcher } from '../server/watch.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-isolation-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Build it.
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build.
edges: []
`

async function setup() {
  const area = join(root, 'area')
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-demo')
  const r = await createProject({ dir, id: 'demo', name: 'Demo', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await mkdir(join(dir, 'out'), { recursive: true })
  await writeFile(join(dir, 'out', 'same.txt'), 'the project\'s own\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remote.git')
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  await writeFile(join(area, 'zulip.json'), JSON.stringify({ enabled: true, zulipUrl: 'https://z.example', viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Test Person' }))
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const x = new ExecStore({ registryFile: registry, area })
  return { area, registry, dir, remote, ws, x }
}

const report = (ws: Workspace, ref: RunRef, attempt: string, op: OpInput) => runOp(ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })

// One run, start to completion, writing `same.txt` in its own copy.
async function perform(s: Awaited<ReturnType<typeof setup>>, receipt: string, text: string) {
  const { ref } = await s.x.request({ workspace: 'demo', workflow: 'ship', text: `Write ${text}.`, author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('test')
  assert.ok('attempt' in c, JSON.stringify(c))
  assert.equal(c.ref.run, ref.run)
  s.x.started(c.attempt.id, process.pid)
  assert.equal(await readFile(join(c.cwd, 'out', 'same.txt'), 'utf8'), 'the project\'s own\n', 'every copy starts from the committed project')
  await report(s.ws, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'out', 'same.txt'), `${text}\n`)
  await report(s.ws, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: `wrote ${text}`, artifacts: ['out/same.txt'] })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  return { ref, cwd: c.cwd }
}

test('two runs change the same tracked path independently; CLI, API, watcher and notifier see each in its own copy; the shared branch and the workspace are untouched', async () => {
  const s = await setup()
  const mainBefore = (await gitOk(s.remote, ['rev-parse', 'main'])).trim()
  const watcher = new Watcher(1000, { registryFile: s.registry })
  const before = await watcher.snapshot({ ws: s.ws, snapshot: null })
  const a = await perform(s, 'iso-req-a-0001', 'A')
  const b = await perform(s, 'iso-req-b-0001', 'B')
  assert.deepEqual([a.ref.run, b.ref.run], ['run-001', 'run-002'])
  assert.notEqual(a.cwd, b.cwd)
  // Files: each copy has its own; the workspace has neither.
  assert.equal(await readFile(join(a.cwd, 'out', 'same.txt'), 'utf8'), 'A\n')
  assert.equal(await readFile(join(b.cwd, 'out', 'same.txt'), 'utf8'), 'B\n')
  assert.equal(await readFile(join(s.dir, 'out', 'same.txt'), 'utf8'), 'the project\'s own\n')
  assert.equal((await gitOk(s.dir, ['status', '--porcelain'])).trim(), '', 'the project workspace is clean')
  assert.equal(await stat(join(s.dir, 'devdocs', 'runs')).then(() => true, () => false), false, 'no run record in the project tree')
  // Remote: each on its run branch; main unchanged.
  assert.equal(await gitOk(s.remote, ['show', 'wfe/demo/ship/run-001:out/same.txt']), 'A\n')
  assert.equal(await gitOk(s.remote, ['show', 'wfe/demo/ship/run-002:out/same.txt']), 'B\n')
  assert.equal((await gitOk(s.remote, ['rev-parse', 'main'])).trim(), mainBefore)
  assert.notEqual((await git(s.remote, ['cat-file', '-e', 'wfe/demo/ship/run-002:devdocs/runs/ship/run-001'])).code, 0, 'run B carries nothing of run A')
  // Records and artifacts through the module, as the CLI and the service use it.
  const list = await listRuns(s.ws)
  assert.deepEqual(list.map(r => [r.ref, r.execution]), [['ship/run-001', 'completed'], ['ship/run-002', 'completed']])
  assert.equal((await readRunFile(s.ws, a.ref, 'out/same.txt')).text, 'A\n')
  assert.equal((await readRunFile(s.ws, b.ref, 'out/same.txt')).text, 'B\n')
  // The HTTP API.
  const srv = createServer(createHandler({ registryFile: s.registry, area: s.area, allowedOrigins: [], allowedHosts: ['127.0.0.1'], exec: s.x }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/workspaces/demo/runs`
    const runs = await (await fetch(base)).json() as { ref: string }[]
    assert.deepEqual(runs.map(r => r.ref), ['ship/run-001', 'ship/run-002'])
    for (const [ref, text] of [[a.ref, 'A\n'], [b.ref, 'B\n']] as const) {
      const one = await (await fetch(`${base}/${ref.workflow}/${ref.run}`)).json() as { place: { kind: string; branch: string } }
      assert.deepEqual(one.place, { kind: 'run-copy', branch: `wfe/demo/ship/${ref.run}` })
      const f = await (await fetch(`${base}/${ref.workflow}/${ref.run}/file?path=out/same.txt`)).json() as { text: string }
      assert.equal(f.text, text)
    }
  } finally { srv.close() }
  // The CLI, from inside run A's copy: the workspace and the paths are found there.
  const cwd = process.cwd()
  const lines: string[] = []
  const log = console.log
  console.log = (...m: unknown[]) => { lines.push(m.join(' ')) }
  try {
    process.chdir(a.cwd)
    assert.equal(await main(['run', 'list', '--registry', s.registry, '--area', s.area]), 0)
    assert.equal(await main(['run', 'attach', 'run-001', 'out/same.txt', '--title', 'from inside the copy', '--by', 'Test Person', '--registry', s.registry, '--area', s.area]), 0)
  } finally { process.chdir(cwd); console.log = log }
  assert.match(lines.join('\n'), /ship\/run-001\s+completed[\s\S]*ship\/run-002\s+completed/)
  assert.deepEqual((await readRun(s.ws, a.ref)).record!.artifacts.map(x => x.path), ['out/same.txt', 'out/same.txt'], 'a path given inside the copy is project-relative')
  // The watcher sees both runs' records where they are.
  const after = await watcher.snapshot({ ws: s.ws, snapshot: before })
  const events = watcher.diff('demo', before, after).filter(e => e.kind === 'run').map(e => (e as { run: string }).run).sort()
  assert.deepEqual(events, ['ship/run-001', 'ship/run-002'])
  // The notifier announces both runs, each under its own identity.
  const n = new NotifyStore({ area: s.area, registryFile: s.registry, exec: s.x })
  try {
    await n.scan()
    for (const run of ['run-001', 'run-002']) assert.ok(n.outbox(`demo/ship/${run}`).some(o => o.type === 'completed'), `${run}: its completion is owed`)
  } finally { n.close() }
  // A copy is where the run's own work stays; the resolver sends each run there.
  assert.equal((await runSpace(s.ws, a.ref)).root, a.cwd)
})
