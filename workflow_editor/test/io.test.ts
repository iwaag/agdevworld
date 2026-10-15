// p10 step 4: detailed IO — one Zulip channel per run, fed from each
// attempt's log (server/io.ts, server/notify.ts). What is shown and what is
// left out, redaction, message size, positions that survive restarts, gaps
// said as gaps, attempt boundaries, a delivery failure that keeps what is
// owed, the receipt's links, and that IO is output only.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, truncate, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunk, entriesOf, entryAt, IO_MESSAGE_MAX, readFrom, Redactor, renderEntry, type ReaderState } from '../server/io.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { IntakeStore } from '../server/intake.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-io-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const L = (o: unknown) => JSON.stringify(o)
const init = L({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-x', claude_code_version: '2.9.0', cwd: '/secret/path', tools: ['Bash'], mcp_servers: [{ name: 'private' }], apiKeySource: 'none', memory_paths: ['/Users/someone/.claude'] })
const said = (text: string) => L({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text }] } })
const call = (id: string, command: string) => L({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
const result = (id: string, content: string, is_error = false) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })
const done = L({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 4200, total_cost_usd: 0.12, modelUsage: { secret: 1 } })
const lines = (...l: string[]) => l.map((text, i) => ({ n: i + 1, text }))
// A log the agent stopped writing to a while ago (the quiet that flushes small increments).
const quiet = (path: string) => utimes(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

test('entries: public output only — no reasoning, no harness configuration, no bookkeeping', () => {
  const st: ReaderState = { tools: {}, format: null }
  const e = entriesOf(lines(init, said('I read the run.'), call('t1', 'wfe run show x'), result('t1', 'Run x — in-progress'), L({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), L({ type: 'system', subtype: 'thinking_tokens', n: 5 }), done), st)
  assert.deepEqual(e.map(x => x.kind), ['session', 'text', 'tool', 'result', 'end'])
  const all = JSON.stringify(e)
  for (const hidden of ['PRIVATE REASONING', '/secret/path', 'mcp_servers', 'private', 'memory_paths', 'rate_limit', 'modelUsage']) assert.ok(!all.includes(hidden), hidden)
  assert.equal(e[3].head, '← Bash', 'a result names the call it answers')
  assert.match(e[4].head, /session ended: success, 3 turns, 4 s, \$0\.12/)
  // A log in another format is shown as raw text.
  const raw = entriesOf(lines('plain output', 'more'), { tools: {}, format: null })
  assert.deepEqual(raw.map(x => x.kind), ['raw', 'raw'])
})

test('redaction: credential patterns, and the exact values of the host\'s secret files', async () => {
  const env = join(root, 'secrets.env')
  await writeFile(env, 'ZULIP_API_KEY=abcd1234efgh5678\nFORGE_S3_SECRET="s3-very-secret-value"\n')
  const json = join(root, 'gitea.json')
  await writeFile(json, JSON.stringify({ url: 'http://gitea', token: 'tok-0123456789abcdef', user: 'developer' }))
  const r = await Redactor.from([env, json])
  const text = r.apply('key abcd1234efgh5678 / s3-very-secret-value / tok-0123456789abcdef / sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV / ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 / https://bob:hunter22@example.com/x / Authorization: Bearer abcdefghijklmnop / password=letmein123 / user developer')
  for (const s of ['abcd1234efgh5678', 's3-very-secret-value', 'tok-0123456789abcdef', 'ABCDEFGHIJKLMNOPQRSTUV', 'ABCDEFGHIJKLMNOPQRSTUVWX12', 'hunter22', 'abcdefghijklmnop', 'letmein123']) assert.ok(!text.includes(s), `${s} leaked: ${text}`)
  assert.match(text, /user developer/, 'ordinary words stay')
})

test('messages: long output is cut with a pointer to the whole; mentions do not notify; fences survive backticks; size is bounded', () => {
  const r = new Redactor()
  const long = 'x'.repeat(5000)
  const t = renderEntry({ line: 7, kind: 'result', head: '← Bash', body: `\`\`\`\nnested fence\n\`\`\`\n${long}` }, r, n => `<full ${n}>`)
  assert.ok(t.length < 1500)
  assert.match(t, /5\d{3} characters; the whole: <full 7>/)
  assert.match(t, /````/, 'a fence longer than any run of backticks inside')
  const m = renderEntry({ line: 1, kind: 'text', head: '', body: 'ask @**Front** and @_**Observer** and @*team*' }, r, () => '')
  assert.ok(!/@\*\*Front/.test(m) && !/@_\*\*Observer/.test(m) && !/@\*team/.test(m), m)
  const parts = chunk(Array.from({ length: 40 }, (_, i) => ({ line: i + 1, text: 'y'.repeat(400) })))
  assert.ok(parts.length > 1 && parts.every(p => p.text.length <= IO_MESSAGE_MAX), 'bounded messages')
  assert.deepEqual([parts[0].from, parts.at(-1)!.to], [1, 40], 'the line ranges cover everything once')
})

// ---- through the notifier ----------------------------------------------------------------

test('log reading: a line can exceed the batch budget; incomplete UTF-8 lines wait for their newline', async () => {
  const path = join(root, 'long-lines.jsonl')
  const text = 'a'.repeat(7) + '日本語'.repeat(20)
  await writeFile(path, text)
  const partial = await readFrom(path, 0, 0, 8)
  assert.ok(partial)
  assert.deepEqual([partial.lines, partial.offset, partial.line], [[], 0, 0], 'an unfinished line is not parsed or consumed')
  await appendFile(path, '\nnext\n')
  const first = await readFrom(path, 0, 0, 8)
  assert.ok(first)
  assert.deepEqual(first.lines, [{ n: 1, text }], 'chunks are decoded together without corrupting multibyte characters')
  assert.equal(first.offset, Buffer.byteLength(text + '\n'))
  const next = await readFrom(path, first.offset, first.line, 8)
  assert.ok(next)
  assert.deepEqual(next.lines, [{ n: 2, text: 'next' }])
  assert.equal(next.offset, next.size)
})

const WF = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make it.
documentation: {policy: manual}
execution: {agent: maker}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, description: Build it.}
edges: []
`
let k = 0
async function setup(o: { viewBase?: string | null; provisionIo?: boolean } = {}) {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'wf'])
  const remote = join(area, 'p.git')
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  await writeFile(join(area, 'zulip.json'), JSON.stringify({ enabled: true, zulipUrl: 'https://chat.example', viewBase: o.viewBase === undefined ? 'http://host.lan:8093/wfe/' : o.viewBase, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
    io: { enabled: true, since: '2026-01-01T00:00:00.000Z' },
    intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: {}, requesters: [{ id: 8, name: 'Pat' }] } }))
  const x = new ExecStore({ registryFile: registry, area })
  const n = new NotifyStore({ area, registryFile: registry, exec: x })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, x, n, ws }
}
type S = Awaited<ReturnType<typeof setup>>
// The transport: provisions what is due and takes every delivery, as sent.
let mid = 7000
async function pass(s: S, o: { provision?: boolean; fail?: boolean } = {}) {
  // Folders first, then the channels in them (the transport's order).
  for (let i = 0; i < 3; i++) {
    const due = await s.n.due()
    const tasks = due.provision.filter(t => o.provision !== false || !t.key.includes('@'))
    if (!tasks.length) break
    for (const t of tasks) s.n.recordTarget(t.key, { zulipId: t.key.includes('@') ? 900 + k : t.kind === 'folder' ? 100 : 500 })
  }
  const sent: { stream: number; topic: string; content: string; run: string }[] = []
  for (let round = 0; round < 40; round++) {
    const c = await s.n.claim({ owner: 'test', pid: process.pid })
    if (!c.deliveries.length) break
    for (const d of c.deliveries) {
      if (o.fail) { s.n.fail(d.delivery, d.claim, 'Zulip is down', false, { events: d.events }); continue }
      s.n.begin(d.delivery, d.claim, { destination: d.destination, events: d.events, ...(d.reconcile ? { checkedAbsent: 'test' } : {}) })
      s.n.acknowledge(d.delivery, d.claim, { messageId: ++mid, destination: d.destination, events: d.events })
      sent.push({ stream: d.destination.streamId, topic: d.destination.topic, content: d.content, run: d.run })
    }
    if (o.fail) break
  }
  return sent
}
const io = <T extends { run: string }>(sent: T[]) => sent.filter(m => m.run.endsWith('/io'))

test('a tool result larger than 2 MiB is relayed once, links to the full entry and does not block later output', async () => {
  const s = await setup()
  try {
    await s.x.request({ workspace: s.ws.reg.id, workflow: 'make', text: 'Make it.', author: 'Pat', receipt: 'io-long-result', via: 'browser' })
    const c = await s.x.claim('test')
    assert.ok('attempt' in c)
    const log = c.attempt.log!
    const output = 'large result: ' + '日本語'.repeat(250_000) + ' END OF LARGE RESULT'
    const large = result('big', output)
    assert.ok(Buffer.byteLength(large) > 2 * 1024 * 1024)
    await writeFile(log, [init, call('big', 'produce a large result'), large, said('Work after the large result.'), done, ''].join('\n'))
    await s.x.finished(c.attempt.id, { code: 0, signal: null })
    const sent = io(await pass(s))
    const body = sent.map(m => m.content).join('\n')
    assert.match(body, /← Bash/)
    assert.match(body, /open the whole entry/)
    assert.match(body, /Work after the large result\./)
    assert.match(body, new RegExp(`Attempt ${c.attempt.id} ended`))
    assert.ok(!body.includes('PRIVATE REASONING'))
    const full = await entryAt(log, 3)
    assert.equal(full[0].body, output, 'the linked line retains the complete result')
    assert.equal(full[0].head, '← Bash')
    const status = await s.n.runStatusOf('p', s.ws, c.ref)
    assert.deepEqual(status.io?.attempts.map(a => [a.line, a.ended, a.gap]), [[5, true, null]])
    s.n.close()
    s.n = new NotifyStore({ area: s.area, registryFile: s.registry, exec: s.x })
    assert.equal(io(await pass(s)).length, 0, 'restart does not replay the large result')
  } finally { s.n.close(); s.x.close() }
})

test('one IO channel per run: attempts, entries and boundaries in order; positions survive a restart; gaps are said; output only', async () => {
  const s = await setup()
  const { ref } = await s.x.request({ workspace: s.ws.reg.id, workflow: 'make', text: 'Make it.', author: 'Pat', receipt: 'io-request-1', via: 'browser' })
  const c = await s.x.claim('test')
  assert.ok('attempt' in c)
  const log = c.attempt.log!
  await writeFile(log, [init, said('Starting with the record.'), call('t1', 'wfe run show make/run-001'), result('t1', 'x'.repeat(3000)), ''].join('\n'))
  await quiet(log)
  let sent = await pass(s)
  const ioMsgs = io(sent)
  assert.ok(ioMsgs.length >= 2, JSON.stringify(sent.map(m => [m.run, m.content.slice(0, 60)])))
  assert.ok(ioMsgs.every(m => m.topic === 'io'))
  assert.match(ioMsgs[0].content, new RegExp(`^\\*\\*Attempt ${c.attempt.id} began\\*\\*`))
  const body = ioMsgs.map(m => m.content).join('\n')
  assert.match(body, /Starting with the record\./)
  assert.match(body, /→ Bash/)
  assert.match(body, /\[open the whole entry\]\(http:\/\/host\.lan:8093\/wfe\/#\/ws\/p\/run\/make\/run-001\/io\/a[^/]+\/4\)/, 'the cut result links to its whole entry')
  assert.ok(!body.includes('PRIVATE REASONING') && !body.includes('/secret/path'))
  // The receipt in the request-less run topic carries the IO link.
  const started = sent.find(m => /\*\*Started\*\*/.test(m.content))
  assert.match(started?.content ?? '', /Detailed IO: https:\/\/chat\.example\/#narrow\/channel\/9\d\d-/)
  // Nothing new: nothing sent. A restart (a new store over the same files) replays nothing.
  assert.equal(io(await pass(s)).length, 0)
  s.n.close()
  s.n = new NotifyStore({ area: s.area, registryFile: s.registry, exec: s.x })
  assert.equal(io(await pass(s)).length, 0, 'no replay after a restart')
  // Appended lines: only they are relayed.
  await appendFile(log, [said('Second thought, public.'), ''].join('\n'))
  await new Promise(r => setTimeout(r, 10))
  await s.x.finished(c.attempt.id, { code: 0, signal: null }) // nothing started yet: a plain exit
  sent = io(await pass(s))
  assert.equal(sent.filter(m => /Second thought/.test(m.content)).length, 1)
  assert.ok(!sent.some(m => /Starting with the record/.test(m.content)), 'earlier lines are not sent again')
  assert.match(sent.at(-1)!.content, new RegExp(`\\*\\*Attempt ${c.attempt.id} ended\\*\\* — exited \\(process exit 0\\)`))
  // The IO channel is not a request channel: the intake does not read it.
  const intake = new IntakeStore({ area: s.area, registryFile: s.registry, exec: s.x, notify: s.n })
  const due = await intake.due()
  assert.ok(!due.channels.some(ch => ch.streamId >= 900), 'the IO channel is never routed to intake')
  intake.close()
  // A second attempt: its own boundary in the same channel; a truncated log is a gap.
  s.x.enqueue(s.ws.reg.id, ref, 'resume', 'io-resume-2', 'resume: a second attempt')
  const c2 = await s.x.claim('test')
  assert.ok('attempt' in c2, JSON.stringify(c2))
  await writeFile(c2.attempt.log!, [init, said('Attempt two.'), said('more words '.repeat(200)), ''].join('\n'))
  await quiet(c2.attempt.log!)
  sent = io(await pass(s))
  assert.match(sent[0].content, new RegExp(`Attempt ${c2.attempt.id} began`))
  await truncate(c2.attempt.log!, 10)
  sent = io(await pass(s))
  assert.ok(sent.some(m => /was truncated after line \d+ .*a gap/.test(m.content)), sent.map(m => m.content).join('\n---\n'))
  // A missing log of an ended attempt is a gap too, said once.
  await unlink(c2.attempt.log!)
  s.x.db.prepare('UPDATE attempts SET state = \'ended\', ended = ?, outcome = \'interrupted\' WHERE id = ?').run(new Date().toISOString(), c2.attempt.id)
  sent = io(await pass(s))
  assert.ok(sent.some(m => /is not on this host/.test(m.content)))
  assert.equal(io(await pass(s)).filter(m => /is not on this host/.test(m.content)).length, 0, 'said once')
  // Status for views: the link and the per-attempt positions.
  const st = await s.n.runStatusOf('p', s.ws, ref)
  assert.equal(st.io?.state, 'provisioned')
  assert.ok(st.io?.url)
  assert.deepEqual(st.io?.attempts.map(a => [a.attempt, a.ended, !!a.gap]), [[c.attempt.id, true, false], [c2.attempt.id, true, true]])
  s.n.close(); s.x.close()
})

test('a Zulip outage keeps the IO owed and the work going; the receipt says IO is being set up until its channel exists, then a follow-up gives the link', async () => {
  const s = await setup({ viewBase: null })
  const { ref } = await s.x.request({ workspace: s.ws.reg.id, workflow: 'make', text: 'Make it.', author: 'Pat', receipt: 'io-request-2', via: 'browser' })
  const c = await s.x.claim('test')
  assert.ok('attempt' in c)
  await writeFile(c.attempt.log!, [init, call('t1', 'ls'), result('t1', 'y'.repeat(2000)), ''].join('\n'))
  await quiet(c.attempt.log!)
  // Zulip is down: every delivery fails; nothing is lost and the attempt is unaffected.
  await pass(s, { fail: true })
  const owed = (s.n.db.prepare('SELECT count(*) AS n FROM outbox WHERE run_key LIKE ? AND state != \'sent\'').get('%/io') as { n: number }).n
  assert.ok(owed >= 2, `owed ${owed}`)
  assert.equal(s.x.attemptRow(c.attempt.id)?.state, 'launching', 'the attempt is untouched')
  // Zulip is back (the retry time is reached).
  s.n.db.prepare('UPDATE deliveries SET next_try = NULL').run()
  const sent = io(await pass(s))
  assert.ok(sent.length >= 2)
  assert.match(sent.map(m => m.content).join('\n'), /`wfe run io make\/run-001 --attempt a[^ ]+ --line 3` on the execution host/, 'without a remote view, the whole entry is named on the host')
  void ref
  s.n.close(); s.x.close()
})

test('a request receipt names Progress and Detailed IO; while the IO channel is not provisioned it says so and a follow-up brings the link', async () => {
  const s = await setup()
  // Zulip intake makes a request run: its receipt goes to the request topic.
  const intake = new IntakeStore({ area: s.area, registryFile: s.registry, exec: s.x, notify: s.n, posted: s.n.postedLookup() })
  s.n.intake = intake
  await s.n.due()
  for (const key of ['folder:p', 'channel:p/make']) s.n.recordTarget(key, { zulipId: key.startsWith('folder') ? 100 : 500 })
  intake.receive({ realm: 'chat.example', streamId: 500, through: 42, messages: [{ realm: 'chat.example', id: 42, streamId: 500, topic: 'request-thing', sender: { id: 8, name: 'Pat', email: 'p@x', bot: false }, content: 'Make a thing.', timestamp: 1_790_000_000, topicFirst: 42 }] })
  await intake.process()
  // The IO channel is not provisioned in this pass (the transport could not create it yet).
  let sent = await pass(s, { provision: false })
  const receipt = sent.find(m => /Request received/.test(m.content))
  assert.ok(receipt, sent.map(m => m.content.slice(0, 50)).join(' | '))
  assert.match(receipt!.content, /Progress: https:\/\/chat\.example/)
  assert.match(receipt!.content, /Detailed IO: being set up; a follow-up message here gives its link\./, 'no link that does not open yet')
  assert.match(receipt!.content, /Run: http:\/\/host\.lan:8093\/wfe\/#\/ws\/p\/run\/make\/run-001/)
  // Next pass: the channel exists; the follow-up goes to the request topic.
  sent = await pass(s)
  const follow = sent.find(m => /\*\*Detailed IO\*\* of run make\/run-001 is ready: https:\/\/chat\.example\/#narrow\/channel\/9/.test(m.content))
  assert.ok(follow, sent.map(m => m.content.slice(0, 80)).join(' | '))
  assert.equal(follow!.topic, 'request-thing')
  assert.equal((await pass(s)).filter(m => /is ready:/.test(m.content)).length, 0, 'once')
  intake.close(); s.n.close(); s.x.close()
})
