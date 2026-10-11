// p6 step 7: the run view of a run requested in a Zulip request topic —
// additional instructions (received, then acknowledged), the result decision
// from a confirmation, and both coordination topics — against a private
// service and its own area. Runs, posts and deliveries are made through the
// same server modules the intake, the executor and the transport use.
//
//   npm run build && node checks/conversation.ts [--port 8199] [--keep]
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8199)
const root = await mkdtemp(join(tmpdir(), 'wfe-conv-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { gitOk } = await import('../server/git.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { ExecStore } = await import('../server/exec.ts')
const { IntakeStore } = await import('../server/intake.ts')
const { NotifyStore } = await import('../server/notify.ts')
const { runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

const area = join(root, 'area')
const registry = join(area, 'registry.json')
const dir = join(area, 'pj-chk')
const made = await createProject({ dir, id: 'chk', name: 'Conversation check', intent: 'Checks.', goals: [], devdocs: 'directory', registryFile: registry })
if (!made.ok) throw new Error(made.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), `schema: ag.workflow.v2
documentation: {policy: manual}
id: make
name: Make
intent: |
  Make it and have the person confirm it.
execution: {agent: maker}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, name: Build, description: Build it.}
  present: {type: talk, name: Present, confirms: result, description: Present it.}
edges:
  - {from: build, to: present}
`)
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
await writeFile(join(area, 'zulip.json'), JSON.stringify({
  enabled: true, zulipUrl: 'https://chat.example', viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
  intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: { chk: {} }, requesters: [{ id: 8, name: 'Pat' }] },
}))

const service = new PrivateService({ registry, area, port: PORT })
await service.start()
const x = new ExecStore({ registryFile: registry, area })
const n = new NotifyStore({ area, registryFile: registry, exec: x })
const i = new IntakeStore({ area, registryFile: registry, exec: x, notify: n, posted: n.postedLookup() })
n.intake = i
await n.due()
n.recordTarget('channel:chk/make', { zulipId: 501 })
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const ref = { workflow: 'make', run: 'run-001' }
const post = (id: number, content: string) => i.receive({ realm: 'chat.example', streamId: 501, through: id, messages: [{ realm: 'chat.example', id, streamId: 501, topic: 'request-deck', sender: { id: 8, name: 'Pat Person', email: 'p@x', bot: false }, content, timestamp: 1_790_000_000, topicFirst: 100 }] })
let mid = 1000
async function deliverAll() {
  for (let k = 0; k < 10; k++) {
    const c = await n.claim({ owner: 'check', pid: process.pid })
    if (!c.deliveries.length) return
    for (const d of c.deliveries) { n.begin(d.delivery, d.claim, { destination: d.destination, events: d.events }); n.acknowledge(d.delivery, d.claim, { messageId: ++mid, destination: d.destination, events: d.events }) }
  }
}
const { browser, page, errors } = await open(1440, 1000)
const B = service.base
const waitText = (sel: string, re: RegExp, ms = 15_000) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source] as const, { timeout: ms }).then(() => true, () => false)

try {
  console.log('a run requested in Zulip, in the run view')
  post(100, 'Make a deck about tea.')
  await i.process()
  await deliverAll()
  const c = await x.claim('check', {})
  if (!('attempt' in c)) throw new Error('no attempt')
  const A = c.attempt.id
  const agent = (op: Parameters<typeof runOp>[2]) => runOp(ws, ref, { ...op, attempt: A }, { by: 'maker', via: 'cli' })
  await agent({ op: 'node.start', node: 'build' })
  post(1100, 'Use a dark theme, please.')
  await i.process()
  await page.goto(`${B}/#/ws/chk/run/make/run-001`)
  check(await waitText('.run-side', /Instructions \(1 not acknowledged\)/), 'a received instruction is shown as not acknowledged')
  check(await waitText('.run-side', /Use a dark theme, please\./), 'with the person\'s words')
  check(await waitText('.run-side', /from Pat via zulip/), 'who gave it and through what')
  check(await waitText('.run-side', /while build ran/), 'the node that was running when it arrived')
  check(await waitText('.run-side', /no node starts before it is acknowledged/), 'what waits for it')
  await shot(page, 'p6-instruction-received', false)
  await agent({ op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'the deck uses a dark theme' })
  check(await waitText('.run-side', /Instructions \(all acknowledged\)/), 'the acknowledgment is shown as it is recorded')
  check(await waitText('.run-side', /acknowledged: incorporate/) && await waitText('.run-side', /maker: the deck uses a dark theme/), 'with the response and the agent\'s note')
  await writeFile(join(dir, 'deck.pptx'), 'pptx bytes')
  await agent({ op: 'node.complete', node: 'build', outcome: 'built' })
  await agent({ op: 'node.start', node: 'present' })
  await agent({ op: 'question.ask', question: 'q1', node: 'present', text: 'Is the deck right?', to: 'Pat', subjects: ['deck.pptx'] })
  await x.finished(A, { code: 0, signal: null })
  await deliverAll()
  post(++mid, 'Yes, it is right.')
  await i.process()
  const c2 = await x.claim('check', {})
  if (!('attempt' in c2)) throw new Error('no second attempt')
  await runOp(ws, ref, { op: 'question.take-up', question: 'q1', attempt: c2.attempt.id }, { by: 'maker', via: 'cli' })
  await runOp(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1', attempt: c2.attempt.id }, { by: 'maker', via: 'cli' })
  check(await waitText('.run-side', /accepted by maker .*evidence: q1 answer 0 from Pat \(Zulip message \d+\), confirming deck\.pptx/), 'the decision from the confirmation, with its evidence')
  await page.reload()
  check(await waitText('.run-side', /Request and conversation: wf-chk\.make › request-deck/), 'the coordination panel links the request topic')
  check(await waitText('.run-side', /Progress: wf-chk\.make › run-001/), 'and the run topic')
  check(!(await page.locator('.run-side').innerText()).includes('messages tell readers to answer on the execution host'), 'no "answer on the execution host" for a request-topic run')
  await shot(page, 'p6-run-confirmed', false)
  const pageErrors = errors.filter(e => !/^Failed to load resource/.test(e))
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
  i.close(); n.close(); x.close()
  await service.stop()
  if (args.includes('--keep')) console.log(`data kept: ${root}`)
  else await rm(root, { recursive: true, force: true })
  done()
}
