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
import { readRun } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { Question, RunRef } from '../shared/run.ts'
import { approvalOf } from '../shared/approval.ts'

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

test('integration is available before any decision; historical decisions remain optional records', async () => {
  const s = await setup()
  try {
    const { ref } = await s.x.request({ workspace: s.id, workflow: 'ship', text: 'build', author: 'Agent', receipt: 'p11-status', via: 'cli' })
    const status = await approval(s, ref)
    assert.equal(status.kind, 'none')
    assert.equal(status.integration?.state, 'none')
    assert.match(status.integration!.text, /integration available/)
    assert.equal((await record(s, ref)).decisions.length, 0)
  } finally { s.x.close() }
})
