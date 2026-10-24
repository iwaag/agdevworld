// project_migration p7: execution nodes. A coordinator (the service and its
// exec store) with a local worker and a remote one; the remote worker is a
// separate area driven through its own `wfe` (cli/remote.ts), over HTTP.
// Covered: assignment and per-worker slots (two runs at once, neither taking
// the other's job), a job its worker cannot serve waits instead of being
// dropped, unique allocation, claims and reports fenced and idempotent, the
// copy materialized on the worker from the dispatch, the agent's forwarded
// commands writing the coordinator's record, the worker's checkpoint and the
// record copy following it with run.json kept as the authority, explicit
// reassignment, and the end after a worker restart (exit file, lost).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'

const pexec = promisify(execFile)
const WFE = fileURLToPath(new URL('../cli/wfe.ts', import.meta.url))
let root = ''
const servers: Server[] = []
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-workers-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { for (const s of servers) s.close(); await rm(root, { recursive: true, force: true }) })

const WF = (id: string, extra = '') => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ${id}
name: ${id}
intent: |
  Build it.
${extra}repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build it.
`

let n = 0
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-w${n}`)
  const r = await createProject({ dir, id: `w${n}`, name: `W${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), WF('make'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'onpc.yaml'), WF('onpc', 'execution:\n  node: pc\n'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'picky.yaml'), WF('picky', 'execution:\n  node: pc\n  profile: opus\n'))
  await writeFile(join(dir, 'game.txt'), 'v1\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  const remote = join(area, 'remotes', `pj-w${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  await writeFile(join(area, 'pc.token'), 'secret-of-pc\n')
  await writeFile(join(area, 'workers.json'), JSON.stringify({ default: 'studio', workers: { studio: { local: true, label: 'the coordinator host' }, pc: { label: 'the PC', tokenFile: 'pc.token' } } }))
  const x = new ExecStore({ registryFile: registry, area })
  const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], exec: x }))
  servers.push(srv)
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`
  // The worker's own area.
  const warea = join(root, `worker-${n}`)
  await mkdir(warea, { recursive: true })
  await writeFile(join(warea, 'worker.json'), JSON.stringify({ coordinator: url, worker: 'pc', label: 'pc-host', facts: { os: 'Test Linux', godot: '4.7 at /opt/godot' } }))
  await writeFile(join(warea, 'worker.token'), 'secret-of-pc\n')
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `w${n}`)!)
  const wfe = async (args: string[], o: { cwd?: string; attempt?: string } = {}) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, WFE_WORKER_AREA: warea }
    delete env.WFE_REGISTRY; delete env.WFE_ATTEMPT
    if (o.attempt) env.WFE_ATTEMPT = o.attempt
    try {
      const r = await pexec(process.execPath, [WFE, ...args], { cwd: o.cwd ?? warea, env, maxBuffer: 16 * 1024 * 1024 })
      return { code: 0, stdout: r.stdout, stderr: r.stderr }
    } catch (e) { const er = e as { code: number; stdout: string; stderr: string }; return { code: er.code, stdout: er.stdout, stderr: er.stderr } }
  }
  return { area, registry, dir, remote, x, ws, id: `w${n}`, url, warea, wfe }
}
const OFFER = ['--backend', 'fake / m', '--profiles-json', JSON.stringify({ sonnet: 'fake / m' })]
const request = (x: ExecStore, id: string, workflow: string, receipt: string, node?: string) => x.request({ workspace: id, workflow, text: 'Build the thing.', author: 'Test Person', receipt, via: 'browser', ...(node ? { node } : {}) })

test('workers: assignment, two slots at once, a job waits for its own worker, fenced and repeated reports', async () => {
  const s = await setup()
  const a = await request(s.x, s.id, 'onpc', 'workers-req-0001') // the workflow's node
  const b = await request(s.x, s.id, 'make', 'workers-req-0002') // the area's default
  const c = await request(s.x, s.id, 'make', 'workers-req-0003', 'pc') // the request's choice
  assert.equal((await readRun(await runSpace(s.ws, a.ref), a.ref)).record!.executor.node, 'pc')
  assert.equal((await readRun(await runSpace(s.ws, b.ref), b.ref)).record!.executor.node, 'studio')
  assert.equal((await readRun(await runSpace(s.ws, c.ref), c.ref)).record!.executor.node, 'pc')
  assert.deepEqual([b.ref.run, c.ref.run], ['run-001', 'run-002'], 'one numbering per workflow, whichever node performs the run')
  await assert.rejects(request(s.x, s.id, 'make', 'workers-req-0004', 'nowhere'), /execution node "nowhere" \(from the request\) is not a worker/)

  // The local worker takes only its own job, even though older jobs are queued for pc.
  const local = await s.x.claim('fake / m', { profiles: { sonnet: 'fake / m' } })
  assert.ok('attempt' in local, JSON.stringify(local))
  assert.equal(local.ref.run, b.ref.run)
  assert.equal(local.attempt.worker, 'studio')
  const jobs = await s.x.runView(s.id, a.ref)
  assert.equal(jobs.jobs[0].state, 'queued', 'the pc job is left for pc')

  // pc claims through its own wfe while studio's attempt is open: two slots.
  const r1 = await s.wfe(['exec', 'claim', ...OFFER, '--json'])
  assert.equal(r1.code, 0, r1.stderr)
  const claim = JSON.parse(r1.stdout)
  assert.equal(claim.ref.run, a.ref.run)
  assert.equal(claim.worker, 'pc')
  const tree = join(s.warea, 'copies', s.id, 'onpc', a.ref.run, 'tree')
  assert.equal(claim.cwd, tree)
  assert.ok(existsSync(join(tree, 'game.txt')), 'the copy is materialized on the worker')
  assert.equal((await git(tree, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim(), `wfe/${s.id}/onpc/${a.ref.run}`)
  assert.ok(claim.brief.includes(tree), 'the brief names the worker\'s copy')
  assert.ok(!claim.brief.includes((await runSpace(s.ws, a.ref)).root), 'and never the coordinator\'s')
  assert.match(claim.brief, /godot: 4\.7 at \/opt\/godot/)
  assert.ok(existsSync(join(tree, `devdocs/runs/onpc/${a.ref.run}/run.json`)), 'the record snapshot came with it')
  // The record copy's tar carries no AppleDouble entries (a macOS tar adds
  // `._*` for extended attributes; a Linux worker committed them in the trial).
  const recDir = join((await runSpace(s.ws, a.ref)).root, `devdocs/runs/onpc/${a.ref.run}`)
  await pexec('xattr', ['-w', 'com.example.p7', '1', join(recDir, 'braindump.md')]).catch(() => null)
  const tarBody = Buffer.from(await (await fetch(new URL(`api/workers/pc/files?workspace=${s.id}&workflow=onpc&run=${a.ref.run}&path=devdocs/runs/onpc/${a.ref.run}`, s.url), { headers: { authorization: 'Bearer secret-of-pc' } })).arrayBuffer())
  const names: string[] = []
  for (let off = 0; off + 512 <= tarBody.length;) {
    const name = tarBody.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '')
    if (!name) break
    names.push(name)
    const size = parseInt(tarBody.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    off += 512 + Math.ceil(size / 512) * 512
  }
  assert.ok(names.length > 0 && !names.some(n => n.split('/').pop()!.startsWith('._')), names.join(', '))

  // pc's slot is held now; the next pc job waits.
  const r2 = JSON.parse((await s.wfe(['exec', 'claim', ...OFFER, '--json'])).stdout)
  assert.match(r2.idle, /the slot of pc is held by attempt/)

  // Reports are the owner's: started by studio's CLI for pc's attempt is refused.
  assert.throws(() => s.x.started(claim.attempt.id, 4242, 'studio'), /belongs to worker pc/)
  assert.equal((await s.wfe(['exec', 'started', claim.attempt.id, '--pid', String(process.pid), '--json'])).code, 0)
  assert.equal((await s.wfe(['exec', 'started', claim.attempt.id, '--pid', String(process.pid), '--json'])).code, 0, 'a repeated start is accepted')

  // The agent works in its copy; its wfe commands write the coordinator's record.
  const start = await s.wfe(['run', 'start', `onpc/${a.ref.run}`, 'build', '--json'], { cwd: tree, attempt: claim.attempt.id })
  assert.equal(start.code, 0, start.stderr + start.stdout)
  const recCopy = (await runSpace(s.ws, a.ref)).root
  assert.equal((await readRun(await runSpace(s.ws, a.ref), a.ref)).record!.nodes.build.state, 'running', 'the record on the coordinator')
  assert.equal(JSON.parse(await readFile(join(tree, `devdocs/runs/onpc/${a.ref.run}/run.json`), 'utf8')).nodes.build.state, 'running', 'and its snapshot here')
  await writeFile(join(tree, 'game.txt'), 'v2 from the pc\n')
  await writeFile(join(tree, `devdocs/runs/onpc/${a.ref.run}/notes.md`), 'what I did\n')
  const done = await s.wfe(['run', 'complete', `onpc/${a.ref.run}`, 'build', '--outcome', 'built on the pc', '--json'], { cwd: tree, attempt: claim.attempt.id })
  assert.equal(done.code, 0, done.stderr + done.stdout)
  assert.equal(await readFile(join(recCopy, `devdocs/runs/onpc/${a.ref.run}/notes.md`), 'utf8'), 'what I did\n', 'the run folder was uploaded')
  // A snapshot is never authority: editing it here changes nothing there.
  const snap = join(tree, `devdocs/runs/onpc/${a.ref.run}/run.json`)
  await writeFile(snap, (await readFile(snap, 'utf8')).replace('"completed"', '"bogus"'))

  // The end: the worker publishes its copy, the record copy follows.
  const fin = await s.wfe(['exec', 'finished', claim.attempt.id, '--exit-code', '0', '--json'])
  assert.equal(fin.code, 0, fin.stderr)
  const f = JSON.parse(fin.stdout)
  assert.equal(f.checkpoint.mode, 'worker')
  assert.equal(f.checkpoint.state, 'published', JSON.stringify(f.checkpoint))
  assert.equal(await readFile(join(recCopy, 'game.txt'), 'utf8'), 'v2 from the pc\n', 'the record copy follows the worker\'s commits')
  const rec = (await readRun(await runSpace(s.ws, a.ref), a.ref)).record!
  assert.equal(rec.execution.state, 'completed', 'run.json of the coordinator stays the authority')
  assert.equal(rec.nodes.build.outcome?.text, 'built on the pc')
  const remoteHead = (await git(s.remote, ['rev-parse', `wfe/${s.id}/onpc/${a.ref.run}`])).stdout.trim()
  assert.equal((await git(recCopy, ['rev-parse', 'HEAD'])).stdout.trim(), remoteHead)
  // A repeated end report answers what was recorded.
  const again = JSON.parse((await s.wfe(['exec', 'finished', claim.attempt.id, '--exit-code', '0', '--json'])).stdout)
  assert.equal(again.outcome, 'exited')

  // A job pc cannot serve (a profile it does not offer) waits for pc with the reason; studio leaves it alone.
  const p = await request(s.x, s.id, 'picky', 'workers-req-0005')
  const studioDone = await s.x.finished(local.attempt.id, { code: 0, signal: null }, 'studio')
  assert.ok(studioDone.outcome)
  // c (make on pc) is older and pc's slot is free: pc takes c first.
  const cc = JSON.parse((await s.wfe(['exec', 'claim', ...OFFER, '--json'])).stdout)
  assert.equal(cc.ref.run, c.ref.run)
  await s.wfe(['exec', 'started', cc.attempt.id, '--pid', String(process.pid), '--json'])
  await s.wfe(['exec', 'finished', cc.attempt.id, '--exit-code', '1', '--json'])
  const pw = JSON.parse((await s.wfe(['exec', 'claim', ...OFFER, '--json'])).stdout)
  assert.match(pw.idle, /waiting for worker pc: the workflow asks for execution profile "opus"/)
  assert.ok('idle' in await s.x.claim('fake / m', { profiles: { opus: 'fake / o' } }), 'studio does not take pc\'s job')
  const pjob = (await s.x.runView(s.id, p.ref)).jobs[0]
  assert.equal(pjob.state, 'queued')
  assert.match(pjob.note ?? '', /waiting for worker pc/)
  // An explicit reassignment lets studio take it.
  await s.x.assign(s.ws, p.ref, 'studio', 'Test Person', 'pc has no opus', 'cli')
  const moved = await s.x.claim('fake / o', { profiles: { opus: 'fake / o' } })
  assert.ok('attempt' in moved, JSON.stringify(moved))
  assert.equal(moved.ref.run, p.ref.run)
  const assigned = (await readRun(await runSpace(s.ws, p.ref), p.ref)).record!
  assert.deepEqual(assigned.assignments?.map(x => [x.previous, x.node, x.by]), [['pc', 'studio', 'Test Person']])

  // The views: two workers, pc's last contact and offer.
  const state = s.x.workersState()
  assert.deepEqual(state.map(w => w.id), ['studio', 'pc'])
  assert.equal(state.find(w => w.id === 'pc')!.state, 'unknown', 'pc has not sent a heartbeat yet')
  assert.equal((await s.wfe(['exec', 'heartbeat', '--pid', '1', '--detail', 'idle', '--json'])).code, 0)
  const pc = s.x.workersState().find(w => w.id === 'pc')!
  assert.equal(pc.state, 'available')
  assert.deepEqual(pc.profiles, ['sonnet'])
  assert.equal(pc.facts?.host?.os, 'Test Linux')
  s.x.close()
})

test('workers: a wrong token is refused; a retransmitted claim gets the same attempt; a restarted worker ends a vanished attempt from its exit file', async () => {
  const s = await setup()
  const bad = await fetch(new URL('api/workers/pc/heartbeat', s.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' })
  assert.equal(bad.status, 401)
  const a = await request(s.x, s.id, 'onpc', 'workers-req-0101')
  const body = { backend: 'fake / m', offer: { profiles: { sonnet: 'fake / m' } }, receipt: 'claim-0001', facts: { root: join(s.warea, 'copies') } }
  const post = (b: unknown) => fetch(new URL('api/workers/pc/claim', s.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-of-pc' }, body: JSON.stringify(b) }).then(r => r.json() as Promise<{ attempt?: { id: string }; idle?: string }>)
  // Two claims at once with different receipts: one attempt.
  const [one, two] = await Promise.all([post(body), post({ ...body, receipt: 'claim-0002' })])
  const got = [one, two].filter(x => x.attempt)
  assert.equal(got.length, 1, JSON.stringify([one, two]))
  const first = got[0]
  const firstReceipt = first === one ? body.receipt : 'claim-0002'
  const retry = await post({ ...body, receipt: firstReceipt })
  assert.equal(retry.attempt?.id, first.attempt!.id, 'the same receipt gets the same answer')
  assert.equal((await s.x.runView(s.id, a.ref)).attempts.length, 1)
  // The worker knew nothing of it (the answer was lost): its reconcile ends it as lost after the launch window.
  s.x.db.prepare('UPDATE attempts SET began = ? WHERE id = ?').run(new Date(Date.now() - 300_000).toISOString(), first.attempt!.id)
  const rc = JSON.parse((await s.wfe(['exec', 'reconcile', '--json'])).stdout)
  assert.match(rc.notes.join('\n'), /process gone; recorded unknown/)
  const rec = (await readRun(await runSpace(s.ws, a.ref), a.ref)).record!
  assert.equal(rec.control.hold?.kind, 'unknown', 'lost contact never becomes a success or a rerun')

  // A process that ended while the worker was down: its exit file says how.
  await s.x.resume(s.ws, a.ref, 'Test Person', 'again', 'cli')
  const c2 = JSON.parse((await s.wfe(['exec', 'claim', ...OFFER, '--json'])).stdout)
  assert.ok(c2.attempt, JSON.stringify(c2))
  await s.wfe(['exec', 'started', c2.attempt.id, '--pid', '999999', '--json'])
  await writeFile(`${c2.attempt.log}.exit`, 'exit 3\n')
  const rc2 = JSON.parse((await s.wfe(['exec', 'reconcile', '--json'])).stdout)
  assert.match(rc2.notes.join('\n'), new RegExp(`attempt ${c2.attempt.id}: process gone; recorded interrupted`))
  s.x.close()
})

test('workers: a forwarded command gets the same reminder as on the coordinator, records nothing, and --yes continues (workflow_editor fix5)', async () => {
  const s = await setup()
  const a = await request(s.x, s.id, 'onpc', 'workers-req-fix5')
  const claim = JSON.parse((await s.wfe(['exec', 'claim', ...OFFER, '--json'])).stdout)
  const tree = join(s.warea, 'copies', s.id, 'onpc', a.ref.run, 'tree')
  assert.equal((await s.wfe(['exec', 'started', claim.attempt.id, '--pid', String(process.pid), '--json'])).code, 0)
  assert.equal((await s.wfe(['run', 'start', `onpc/${a.ref.run}`, 'build', '--json'], { cwd: tree, attempt: claim.attempt.id })).code, 0)
  await mkdir(join(tree, 'out'), { recursive: true })
  await writeFile(join(tree, 'out', 'index.html'), '<p>built</p>')
  await writeFile(join(tree, 'review.md'), '# Review\n')
  const args = ['present', 'register', `onpc/${a.ref.run}`, 'build', '--source', 'out', '--entry', 'index.html', '--review', 'review.md', '--title', 'Built']
  const warned = await s.wfe(args, { cwd: tree, attempt: claim.attempt.id })
  assert.equal(warned.code, 1, warned.stdout)
  assert.match(warned.stderr, /Not recorded — a reminder before registering a presentation from build:\n- cleanup-unplanned/)
  assert.equal((await readRun(await runSpace(s.ws, a.ref), a.ref)).record!.presentations, undefined, 'nothing registered on the coordinator')
  const ok = await s.wfe([...args, '--yes', '--json'], { cwd: tree, attempt: claim.attempt.id })
  assert.equal(ok.code, 0, ok.stderr + ok.stdout)
  assert.equal((await readRun(await runSpace(s.ws, a.ref), a.ref)).record!.presentations?.p1?.node, 'build')
})
