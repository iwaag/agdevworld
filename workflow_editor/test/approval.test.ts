// Step 5: approval actions on saved content, and stale states.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seed } from '../scripts/seed.ts'
import { approvalStates } from '../shared/canonical.ts'
import { cloneWorkflow, type Workflow } from '../shared/model.ts'
import { loadRegistry } from '../server/registry.ts'
import { RequestError, Workspace } from '../server/workspace.ts'

let root = ''
let ws: Workspace
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-approve-'))
  await rm(root, { recursive: true })
  await seed(root, false)
  ws = new Workspace((await loadRegistry(join(root, 'registry.json'))).workspaces.find(w => w.id === 'a')!)
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const file = (f: string) => join(ws.root, 'devdocs/workflows', f)
async function load(f: string): Promise<Workflow> {
  const r = await ws.readWorkflowFile(f)
  assert.ok(r.workflow)
  return r.workflow
}
const status = async (w: Workflow) => { const s = await approvalStates(w); return [s.intent.status, s.definition.status] }

test('approving records digest, declared approver and time in the file', async () => {
  const at = new Date('2026-10-10T03:00:00.000Z')
  const r1 = await ws.approve('onboarding.yaml', 'intent', 'alice', at)
  assert.equal(r1.state.status, 'approved')
  const r2 = await ws.approve('onboarding.yaml', 'definition', 'bob', at)
  assert.equal(r2.state.status, 'approved')
  const text = await readFile(file('onboarding.yaml'), 'utf8')
  assert.match(text, /approvals:\n {2}intent:\n {4}digest: "?sha256:[0-9a-f]{64}"?\n {4}approver: alice\n {4}at: "?2026-10-10T03:00:00.000Z"?\n {2}definition:\n {4}digest: "?sha256:[0-9a-f]{64}"?\n {4}approver: bob\n/)
  assert.match(text, /^# Onboarding/) // comments survive approval writes
  assert.deepEqual(await status(await load('onboarding.yaml')), ['approved', 'approved'])
})

test('editing makes the right approval stale without erasing the record', async () => {
  const w = await load('onboarding.yaml')
  const desc = cloneWorkflow(w)
  desc.nodes.review.description = 'Agree on scope only.'
  await ws.saveWorkflow('onboarding.yaml', desc)
  const afterDesc = await load('onboarding.yaml')
  assert.deepEqual(await status(afterDesc), ['approved', 'stale'])
  assert.equal(afterDesc.approvals.definition?.approver, 'bob', 'stale record kept')
  const intent = cloneWorkflow(afterDesc)
  intent.intent = `${intent.intent}It also has to be reviewed.\n`
  await ws.saveWorkflow('onboarding.yaml', intent)
  assert.deepEqual(await status(await load('onboarding.yaml')), ['stale', 'stale'])
  await ws.approve('onboarding.yaml', 'intent', 'alice')
  await ws.approve('onboarding.yaml', 'definition', 'alice')
  const moved = await load('onboarding.yaml')
  assert.deepEqual(await status(moved), ['approved', 'approved'])
  moved.layout.nodes = { survey: { x: 10, y: 10 }, provision: { x: 300, y: 10 } }
  await ws.saveWorkflow('onboarding.yaml', moved)
  assert.deepEqual(await status(await load('onboarding.yaml')), ['approved', 'approved'], 'layout keeps both approvals')
})

test('a definition with errors cannot be approved; its intent can', async () => {
  await assert.rejects(ws.approve('draft-gaps.yaml', 'definition', 'alice'), (e: unknown) => e instanceof RequestError && e.status === 409 && /validation errors/.test(e.message))
  const r = await ws.approve('draft-gaps.yaml', 'intent', 'alice')
  assert.equal(r.state.status, 'approved')
})

test('approval needs a name, an intent, and readable content', async () => {
  await assert.rejects(ws.approve('repo-setup.yaml', 'intent', '  '), /approver name is required/)
  const w = await load('repo-setup.yaml')
  w.intent = ''
  await ws.saveWorkflow('repo-setup.yaml', w)
  await assert.rejects(ws.approve('repo-setup.yaml', 'intent', 'alice'), /intent is empty/)
  await assert.rejects(ws.approve('repo-setup.yaml', 'definition', 'alice'), /validation errors/)
  await writeFile(file('repo-setup.yaml'), 'schema: [\n')
  await assert.rejects(ws.approve('repo-setup.yaml', 'definition', 'alice'), /cannot be approved/)
  assert.equal(await readFile(file('repo-setup.yaml'), 'utf8'), 'schema: [\n')
})

test('an approval edited by hand to a wrong digest shows as stale', async () => {
  const text = await readFile(file('onboarding.yaml'), 'utf8')
  await writeFile(file('onboarding.yaml'), text.replace(/(definition:\n {4}digest: "?sha256:)[0-9a-f]{4}/, '$1beef'))
  assert.deepEqual(await status(await load('onboarding.yaml')), ['approved', 'stale'])
})
