// The delegation test fixture (p10, shared since project_migration p8 ex1):
// two projects (par with workflow use, kid with workflow make), an
// executor, the notifier and the intake, and the Zulip transport played
// in-process (posts get message ids; a send can be begun and never
// acknowledged), so every crash point can be exercised.
import { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboundMessage } from '../shared/intake.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { IntakeStore } from '../server/intake.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRecord, RunRef } from '../shared/run.ts'

let root = ''
// Registers the suite's temporary root (one per test file).
export function delegationSuite(prefix = 'wfe-delegate-') {
  before(async () => {
  root = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })
}

export const REALM = 'chat.example:8543'
export const PARENT_STREAM = 601, KID_STREAM = 701, PERSON = 8, BOT = 11, STRANGER = 9

export const PARENT_WF = `schema: ag.workflow.v2
id: use
name: Use an asset
intent: |
  Get an asset from the kid project and use it.
documentation: {policy: manual}
execution: {agent: par-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  asset:
    type: delegate
    description: Ask the kid project for the asset.
    project: kid
    workflow: make
    accepts: parent
  use:
    type: do
    description: Use it.
edges:
  - {from: asset, to: use}
`
export const KID_WF = `schema: ag.workflow.v2
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
  scope:
    type: talk
    description: Agree on the scope.
  build:
    type: do
    description: Build it.
  confirm:
    type: talk
    confirms: result
    description: Confirm the result.
edges:
  - {from: scope, to: build}
  - {from: build, to: confirm}
`

let k = 0
async function project(area: string, registry: string, id: string, wf: { file: string; text: string }) {
  const dir = join(area, `pj-${id}`)
  const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', wf.file), wf.text)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, `${id}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
}

// `parent` / `kid`: the workflows of par (id use) and kid (id make).
export async function setup(o: { parent?: string; kid?: string } = {}) {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  await project(area, registry, 'par', { file: 'use.yaml', text: o.parent ?? PARENT_WF })
  await project(area, registry, 'kid', { file: 'make.yaml', text: o.kid ?? KID_WF })
  await writeFile(join(area, 'zulip.json'), JSON.stringify({
    enabled: true, zulipUrl: `https://${REALM}`, viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
    intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: {}, requesters: [{ id: PERSON, name: 'Pat' }] },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const n = new NotifyStore({ area, registryFile: registry, exec: x })
  await n.due()
  for (const [key, id] of [['folder:par', 100], ['folder:kid', 101], ['channel:par/use', PARENT_STREAM], ['channel:kid/make', KID_STREAM]] as const) n.recordTarget(key, { zulipId: id })
  // The request topic of a question posted there (what the notifier's sent deliveries record).
  const i = new IntakeStore({ area, registryFile: registry, exec: x, notify: n, posted: n.postedLookup() })
  n.intake = i
  const regs = (await loadRegistry(registry)).workspaces
  const par = new Workspace(regs.find(w => w.project === 'par')!)
  const kid = new Workspace(regs.find(w => w.project === 'kid')!)
  const zulip = new Zulip(n, i)
  return { area, registry, x, n, i, par, kid, zulip }
}

// The transport, in-process: what the notifier hands out is posted (or
// begun and lost), what is posted is handed to the intake per channel.
export class Zulip {
  posts: InboundMessage[] = []
  next = 50_000
  firsts = new Map<string, number>()
  n: NotifyStore
  i: IntakeStore
  constructor(n: NotifyStore, i: IntakeStore) { this.n = n; this.i = i }
  post(o: { streamId: number; topic: string; content: string; sender?: InboundMessage['sender'] }): InboundMessage {
    const id = ++this.next
    const key = `${o.streamId}\0${o.topic}`
    if (!this.firsts.has(key)) this.firsts.set(key, id)
    const m: InboundMessage = { realm: REALM, id, streamId: o.streamId, topic: o.topic, sender: o.sender ?? { id: BOT, name: 'autolab', email: 'bot@x', bot: true }, content: o.content, timestamp: 1_790_000_000, topicFirst: this.firsts.get(key)! }
    this.posts.push(m)
    return m
  }
  // Delivers everything the notifier owes. `lose`: the delivery whose first
  // event matches is posted but its acknowledgment is lost (a crash).
  async deliver(o: { lose?: (events: string[]) => boolean } = {}): Promise<number> {
    let sent = 0
    for (let round = 0; round < 30; round++) {
      const c = await this.n.claim({ owner: 'test-transport', pid: process.pid })
      if (!c.deliveries.length) break
      let progress = 0
      for (const d of c.deliveries) {
        if (d.reconcile) {
          const found = this.posts.find(p => p.content.trimEnd().split('\n').at(-1) === d.marker && d.reconcile!.searchIn.concat([d.destination]).some(s => s.streamId === p.streamId))
          if (found) { this.n.acknowledge(d.delivery, d.claim, { messageId: found.id, destination: { ...d.destination, topic: found.topic }, found: true, events: d.events }); progress++; continue }
          this.n.begin(d.delivery, d.claim, { destination: d.destination, checkedAbsent: 'absent (test transport)', events: d.events })
        } else this.n.begin(d.delivery, d.claim, { destination: d.destination, events: d.events })
        const m = this.post({ streamId: d.destination.streamId, topic: d.destination.topic, content: d.content })
        if (o.lose?.(d.events)) return sent // the process "crashed" here
        this.n.acknowledge(d.delivery, d.claim, { messageId: m.id, destination: d.destination, events: d.events })
        sent++; progress++
      }
      if (!progress) break
    }
    return sent
  }
  // The intake's side: every post of a routed channel after its cursor.
  async receive() {
    for (const stream of [PARENT_STREAM, KID_STREAM]) {
      const cursor = this.i.cursor(REALM, stream)
      const msgs = this.posts.filter(p => p.streamId === stream && p.id > cursor)
      if (msgs.length) this.i.receive({ realm: REALM, streamId: stream, through: Math.max(...msgs.map(m => m.id)), messages: JSON.parse(JSON.stringify(msgs)) })
    }
    return this.i.process()
  }
  async cycle() { await this.deliver(); const notes = await this.receive(); if (process.env.DEBUG_DELEGATE) console.error(notes); return notes }
}

export type S = Awaited<ReturnType<typeof setup>>
export const rec = async (ws: Workspace, ref: RunRef): Promise<RunRecord> => (await readRun(await runSpace(ws, ref), ref)).record!
export const claim = async (s: S) => { const c = await s.x.claim('test'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }
export const as = (ws: Workspace, ref: RunRef, attempt: string, by: string) => (op: OpInput) => runOp(ws, ref, { ...op, attempt } as never, { by, via: 'cli' })

// The parent requested by the person, its delegate node started and dispatched.
export async function dispatched(s: S) {
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'I need a blue icon for the game.', author: 'Pat', receipt: 'person-request-1', via: 'browser' })
  const a = await claim(s)
  assert.deepEqual(a.ref, ref)
  await as(s.par, ref, a.attempt.id, 'par-agent')({ op: 'node.start', node: 'asset' })
  const d1 = await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Make a 64x64 blue icon (PNG) for a game button.', attempt: a.attempt.id, by: 'par-agent', via: 'cli' })
  return { ref, a, d1 }
}

