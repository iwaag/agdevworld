// Delegation in the browser (p10, docs/delegation.md), on a private registry,
// area and service with two synthetic projects: the delegate inspector
// offers the other project's workflows and the acceptance scope; a parent's
// run view shows its delegation — the child, whose move it is, what the
// child asked, its links — on the node card and in Detail's Delegations; the
// child's run view links back to the parent; and the CLI (`wfe delegate`,
// `wfe run show`), the API (`/delegations`, `/api/observe`) and the browser
// agree on who waits for whom. Zulip is played in-process by the stores'
// transport interface. Nothing outside the temporary area is touched.
//
//   npm run build && node checks/delegation.ts [--port 8241]
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8241')
const root = await mkdtemp(join(tmpdir(), 'wfe-delegation-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n[protocol "file"]\n\tallow = always\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { gitOk } = await import('../server/git.ts')
const { ExecStore } = await import('../server/exec.ts')
const { NotifyStore } = await import('../server/notify.ts')
const { IntakeStore } = await import('../server/intake.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { readRun, runOp } = await import('../server/runs.ts')
const { runSpace } = await import('../server/runspace.ts')
const { Workspace } = await import('../server/workspace.ts')
const { holderOf } = await import('../shared/run.ts')
const { main } = await import('../cli/wfe.ts')

const PARENT_WF = `schema: ag.workflow.v2
id: use
name: Use an asset
intent: |
  Get an icon from the kid project and use it.
documentation: {policy: manual}
execution: {agent: par-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  asset: {type: delegate, name: Get the icon, description: Ask kid for the icon., project: kid, workflow: make, accepts: parent}
  use: {type: do, name: Use it, description: Use the icon.}
edges:
  - {from: asset, to: use}
`
const KID_WF = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make what is asked.
documentation: {policy: manual}
execution: {agent: kid-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  scope: {type: talk, name: Agree the scope, description: Agree on the scope.}
edges: []
`
const registry = join(root, 'registry.json')
for (const [id, file, text] of [['par', 'use.yaml', PARENT_WF], ['kid', 'make.yaml', KID_WF]] as const) {
  const dir = join(root, `pj-${id}`)
  const made = await createProject({ dir, id, name: id === 'par' ? 'Parent project' : 'Kid project', intent: 'A synthetic project for the delegation check.', goals: [], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
  if (!made.ok) throw new Error(made.message)
  await writeFile(join(dir, 'devdocs', 'workflows', file), text)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await gitOk(root, ['init', '-q', '--bare', '--initial-branch=main', join(root, `${id}.git`)])
  await gitOk(dir, ['remote', 'add', 'origin', join(root, `${id}.git`)]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
}
const REALM = 'chat.example'
await writeFile(join(root, 'zulip.json'), JSON.stringify({ enabled: true, zulipUrl: `https://${REALM}`, viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
  intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: {}, requesters: [{ id: 8, name: 'Pat' }] } }))
const x = new ExecStore({ registryFile: registry, area: root })
const n = new NotifyStore({ area: root, registryFile: registry, exec: x })
await n.due()
for (const [key, id] of [['folder:par', 100], ['folder:kid', 101], ['channel:par/use', 601], ['channel:kid/make', 701]] as const) n.recordTarget(key, { zulipId: id })
const i = new IntakeStore({ area: root, registryFile: registry, exec: x, notify: n, posted: n.postedLookup() })
n.intake = i
const regs = (await loadRegistry(registry)).workspaces
const par = new Workspace(regs.find(w => w.project === 'par')!), kid = new Workspace(regs.find(w => w.project === 'kid')!)
const posts: { realm: string; id: number; streamId: number; topic: string; sender: { id: number; name: string; email: string; bot: boolean }; content: string; timestamp: number; topicFirst: number }[] = []
let mid = 3000
const firsts = new Map<string, number>()
async function zulip() {
  for (let r = 0; r < 20; r++) {
    const c = await n.claim({ owner: 'check', pid: process.pid })
    if (!c.deliveries.length) break
    for (const d of c.deliveries) {
      n.begin(d.delivery, d.claim, { destination: d.destination, events: d.events, ...(d.reconcile ? { checkedAbsent: 'check' } : {}) })
      const id = ++mid, key = `${d.destination.streamId}\0${d.destination.topic}`
      if (!firsts.has(key)) firsts.set(key, id)
      posts.push({ realm: REALM, id, streamId: d.destination.streamId, topic: d.destination.topic, sender: { id: 11, name: 'autolab', email: 'b@x', bot: true }, content: d.content, timestamp: 1_790_000_000, topicFirst: firsts.get(key)! })
      n.acknowledge(d.delivery, d.claim, { messageId: id, destination: d.destination, events: d.events })
    }
  }
  for (const stream of [601, 701]) {
    const cursor = i.cursor(REALM, stream)
    const msgs = posts.filter(p => p.streamId === stream && p.id > cursor)
    if (msgs.length) i.receive({ realm: REALM, streamId: stream, through: Math.max(...msgs.map(m => m.id)), messages: JSON.parse(JSON.stringify(msgs)) })
  }
  await i.process()
}
const parRef = { workflow: 'use', run: 'run-001' }, kidRef = { workflow: 'make', run: 'run-001' }
const rec = async (ws: InstanceType<typeof Workspace>, ref: typeof parRef) => (await readRun(await runSpace(ws, ref), ref)).record!
const claim = async () => { const c = await x.claim('check'); if (!('attempt' in c)) throw new Error(JSON.stringify(c)); return c }
// The parent dispatches; the child asks q1; the parent answers it: the parent then waits on its child.
await x.request({ workspace: par.reg.id, workflow: 'use', text: 'I need a blue icon.', author: 'Pat', receipt: 'check-request-1', via: 'browser' })
const a1 = await claim()
await runOp(par, parRef, { op: 'node.start', node: 'asset', attempt: a1.attempt.id }, { by: 'par-agent', via: 'cli' })
await x.delegate.dispatch(par, parRef, 'asset', { request: 'Make a 64px blue icon.', attempt: a1.attempt.id, by: 'par-agent', via: 'cli' })
await x.finished(a1.attempt.id, { code: 0, signal: null })
await zulip()
const c1 = await claim()
await runOp(kid, kidRef, { op: 'node.start', node: 'scope', attempt: c1.attempt.id }, { by: 'kid-agent', via: 'cli' })
await runOp(kid, kidRef, { op: 'question.ask', question: 'q1', node: 'scope', text: 'Transparent background?', to: 'par-agent', attempt: c1.attempt.id }, { by: 'kid-agent', via: 'cli' })
await x.finished(c1.attempt.id, { code: 0, signal: null })
await zulip()
const p1 = await claim()
await runOp(par, parRef, { op: 'delegation.take-up', delegation: 'd1', events: [1], attempt: p1.attempt.id } as never, { by: 'par-agent', via: 'cli' })
await x.delegate.answer(par, parRef, 'd1', 'q1', 'Yes, transparent.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
await x.finished(p1.attempt.id, { code: 0, signal: null })
await zulip()
x.heartbeat('autolab', process.pid, 'idle')

const service = new PrivateService({ registry, area: root, port: PORT })
await service.start()
const { browser, page, errors } = await open(1400, 900, { display: 'detail' })
try {
  console.log('Who waits for whom: the record, the CLI, the API')
  const parent = await rec(par, parRef), child = await rec(kid, kidRef)
  const parentHolder = holderOf(parent, 'asset')
  check(parentHolder === 'kid/make', `the parent's delegate node waits on its target (${parentHolder})`)
  check(holderOf(child, 'scope') === 'kid-agent (answer recorded, not yet taken up)', `the child holds the next move: ${holderOf(child, 'scope')}`)
  const logs: string[] = []
  const log = console.log
  console.log = (...m: unknown[]) => { logs.push(m.join(' ')) }
  try { await main(['delegate', 'show', 'use/run-001', 'd1', '--registry', registry, '--workspace', par.reg.id]) } finally { console.log = log }
  const shown = logs.join('\n')
  check(/node asset: waiting; next move: kid\/make/.test(shown), 'wfe delegate show names the same next move')
  check(/child: kid make\/run-001/.test(shown), 'and the same child')
  const dv = await (await fetch(`${service.base}/api/workspaces/${par.reg.id}/runs/use/run-001/delegations`)).json() as { delegations: { state: string; childNow: { waiting: { node: string; holder: string }[] } }[] }
  check(dv.delegations[0].state === 'working', `GET …/delegations: ${dv.delegations[0].state}`)
  check(dv.delegations[0].childNow.waiting[0]?.holder === 'kid-agent (answer recorded, not yet taken up)', 'GET …/delegations says the child holds the next move')
  const obs = await (await fetch(`${service.base}/api/observe`)).json() as { runs: { identity: { workflow: string; uid: string }; waiting: { responsible: string } | null; delegations?: { child: { uid: string } | null }[] }[] }
  const po = obs.runs.find(r => r.identity.workflow === 'use')!, co = obs.runs.find(r => r.identity.workflow === 'make')!
  check(po.waiting?.responsible === `delegation:${co.identity.uid}`, `GET /api/observe: the parent waits on its child (${po.waiting?.responsible})`)
  check(co.waiting?.responsible === 'executor' || /queue|job/.test(JSON.stringify(co)), 'and the child is the executor\'s to continue (its answer is queued)')

  console.log('The parent\'s run view')
  await page.goto(`${service.base}/#/ws/${par.reg.id}/run/use/run-001`)
  await page.waitForSelector('.node')
  const card = page.locator('.node[data-id="asset"]')
  const cardText = (await card.innerText()).replace(/\s+/g, ' ')
  check(/→ kid\/make/.test(cardText) && !/missing/.test(cardText), `the delegate card names its target: ${cardText}`)
  check(/Waiting · child waiting/.test(cardText), `and says where its child stands: ${cardText}`)
  await page.locator('[data-section="delegations"] .sec-toggle').click()
  const sec = page.locator('[data-section="delegations"]')
  const text = (await sec.innerText()).replace(/\s+/g, ' ')
  check(/d1 · asset → kid\/make/.test(text), 'Detail lists the delegation')
  check(/Next move: the child: scope waits for kid-agent/.test(text), `and the same next move: ${text.match(/Next move:[^.]*/)?.[0]}`)
  check(/q1: Transparent background\? — taken up; answered “Yes, transparent\.” \(par-agent\)/.test(text), 'what the child asked and how it was answered')
  check(await sec.getByRole('link', { name: 'child run view' }).count() === 1, 'a link to the child\'s run view')
  await card.click()
  const sel = (await page.locator('.node-detail').innerText()).replace(/\s+/g, ' ')
  check(/Next move: the child/.test(sel), 'the selected delegate node shows its delegation too')
  await shot(page, 'delegation-parent')

  console.log('The child\'s run view links back')
  await sec.getByRole('link', { name: 'child run view' }).click()
  await page.waitForURL(/\/run\/make\/run-001/)
  await page.waitForSelector('.node')
  await page.locator('[data-section="related"] .sec-toggle').click().catch(() => undefined)
  const related = (await page.locator('[data-section="related"]').innerText()).replace(/\s+/g, ' ')
  check(/Delegated by: par use\/run-001 \(node asset\)/.test(related), `Related runs: ${related}`)
  await shot(page, 'delegation-child')

  console.log('The delegate inspector offers the other project\'s workflows')
  await page.goto(`${service.base}/#/ws/${par.reg.id}/wf/use.yaml`)
  await page.waitForSelector('.node')
  await page.locator('.node[data-id="asset"]').click()
  const projectSel = page.getByLabel('Delegate target project')
  check(await projectSel.count() === 1, 'a project selection')
  check((await projectSel.locator('option').allInnerTexts()).some(t => /^kid/.test(t)), 'listing the registered kid project')
  check(await page.getByLabel('Delegate target', { exact: true }).inputValue() === 'make', 'the target workflow of that project')
  check(await page.getByLabel('Delegate acceptance').inputValue() === 'parent', 'and who accepts the child\'s result')
  const issues = (await page.locator('body').innerText())
  check(!/delegate-target-unknown|delegate-project-unknown/.test(issues), 'the cross-project target validates')
  await shot(page, 'delegation-inspector')
  check(!errors.length, `no browser errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close(); await service.stop()
  i.close(); n.close(); x.close()
}
done()
