// retire_old_ui p1: Usage from the exec store's attempts and their logs —
// attribution to the attempt's project/workflow/run, a resumed claude session
// whose USD is cumulative, codex tokens without USD, missing and running usage
// never counted as zero, and relay failures that mark only their own section.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecStore } from '../server/exec.ts'
import { normalizeUsage, summarize, UsageReader } from '../server/usage.ts'

let dir = ''
before(async () => { dir = await mkdtemp(join(tmpdir(), 'wfe-usage-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

const line = (v: unknown) => `${JSON.stringify(v)}\n`
const claudeResult = (session: string, usd: number, output: number) => line({
  type: 'result', subtype: 'success', session_id: session, total_cost_usd: usd,
  usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: output, output_tokens_details: { thinking_tokens: 5 } },
  modelUsage: { 'claude-sonnet-5': { costBasis: 'list', costUSD: usd } },
})

let seq = 0
async function attempt(over: Record<string, unknown>, log?: string) {
  const id = `a${++seq}`
  const file = join(dir, `${id}.jsonl`)
  if (log !== undefined) await writeFile(file, log)
  return {
    id, job: seq, workspace: 'front', workflow: 'converse', run: `run-00${seq}`, host: 'studio-host', pid: null, state: 'ended',
    began: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(), ended: new Date(Date.UTC(2026, 9, 1, 0, seq, 30)).toISOString(), exit_code: 0, signal: null, outcome: 'exited',
    log: file, stop_requested: null, backend: 'claude_code / anthropic/sonnet', baseline: null, worker: 'studio', claim: null, response: null, lane: null,
    ...over,
  }
}

const store = (rows: unknown[]) => ({ allAttempts: () => rows }) as unknown as ExecStore
const relayDown: typeof fetch = async () => { throw new TypeError('connect ECONNREFUSED') }

test('tokens are read per harness; codex input includes the cached part', () => {
  assert.deepEqual(normalizeUsage('codex', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20, reasoning_output_tokens: 3 }),
    { input: 200, cached_input: 800, cache_write: 0, output: 20, reasoning: 3 })
  assert.deepEqual(normalizeUsage('claude_code', { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, output_tokens_details: { thinking_tokens: 1 } }),
    { input: 1, cached_input: 2, cache_write: 3, output: 4, reasoning: 1 })
  assert.equal(normalizeUsage('claude_code', null), null)
})

test('a resumed claude session: tokens are the process\'s own, USD is the session total minus the previous attempt\'s', async () => {
  const first = await attempt({ run: 'run-r' }, claudeResult('s-1', 0.10, 700))
  const second = await attempt({ run: 'run-r' }, claudeResult('s-1', 0.25, 1100))
  const reader = new UsageReader(store([second, first]), 'http://relay.invalid', relayDown)
  const rows = await reader.attempts()
  const [a, b] = rows
  assert.equal(a.attempt, first.id)
  assert.equal(a.usd, 0.10)
  assert.equal(a.adjusted, null)
  assert.equal(b.usd, 0.15)
  assert.equal(b.adjusted, 'resumed')
  assert.equal(b.tokens?.output, 1100)
  assert.equal(b.usdBasis, 'api-equivalent')
  const t = summarize(rows, 'all', new Date('2026-10-20T12:00:00Z')).periods.all
  assert.equal(t.usd['api-equivalent'], 0.25)
  assert.equal(t.tokens.output, 1800)
})

test('codex: tokens summed over turns, no USD invented; a thread seen again is flagged', async () => {
  const log = line({ type: 'thread.started', thread_id: 't-1' }) +
    line({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }) +
    line({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 } })
  const one = await attempt({ backend: 'codex / openai/gpt-6-luna', workspace: 'cagent' }, log)
  const two = await attempt({ backend: 'codex / openai/gpt-6-luna', workspace: 'cagent' }, log)
  const rows = await new UsageReader(store([one, two]), 'http://relay.invalid', relayDown).attempts()
  assert.equal(rows[0].state, 'measured')
  assert.equal(rows[0].usd, null)
  assert.equal(rows[0].usdBasis, null)
  assert.deepEqual(rows[0].tokens, { input: 110, cached_input: 40, cache_write: 0, output: 15, reasoning: 0 })
  assert.equal(rows[1].adjusted, 'continued')
  const t = summarize(rows, 'all').periods.all
  assert.equal(t.withoutUsd, 2)
  assert.equal(t.withUsd, 0)
  assert.equal(t.usd['api-equivalent'] + t.usd.reported, 0)
})

test('missing, unreadable and running usage are unknown or running, never zero, and give their reasons', async () => {
  const interrupted = await attempt({}, line({ type: 'system', subtype: 'init' }) + line({ type: 'assistant', message: { usage: { output_tokens: 9 } } }))
  const noLog = { ...(await attempt({ worker: 'gpupc' })), log: join(dir, 'nowhere.jsonl') }
  const running = await attempt({ state: 'running', ended: null }, line({ type: 'system', subtype: 'init' }))
  const other = await attempt({ backend: 'opencode / ollama/qwen' }, '')
  const rows = await new UsageReader(store([interrupted, noLog, running, other]), 'http://relay.invalid', relayDown).attempts()
  assert.deepEqual(rows.map(r => r.state), ['unknown', 'unknown', 'running', 'unknown'])
  assert.equal(rows[0].reason, 'no result event in its log')
  assert.match(rows[1].reason ?? '', /log missing on the coordinator \(worker gpupc\)/)
  assert.match(rows[3].reason ?? '', /harness opencode is not read/)
  for (const r of rows) { assert.equal(r.tokens, null); assert.equal(r.usd, null) }
  const s = summarize(rows, 'all')
  assert.equal(s.periods.all.measured, 0)
  assert.equal(s.periods.all.unknown, 3)
  assert.equal(s.periods.all.running, 1)
  assert.equal(s.coverage.reasons['no result event in its log'], 1)
})

test('attribution: groups by project, workflow, model and worker, each attempt counted once', async () => {
  const a = await attempt({ workspace: 'lowerpoly', workflow: 'lod-chain', worker: 'gpupc' }, claudeResult('s-a', 1, 10))
  const b = await attempt({ workspace: 'lowerpoly', workflow: 'freework' }, claudeResult('s-b', 2, 20))
  const c = await attempt({ workspace: 'front' }, claudeResult('s-c', 4, 40))
  const rows = await new UsageReader(store([a, b, c]), 'http://relay.invalid', relayDown).attempts()
  const s = summarize(rows, 'all')
  const lp = s.groups.project.find(g => g.key === 'lowerpoly')!
  assert.equal(lp.attempts, 2)
  assert.equal(lp.usd['api-equivalent'], 3)
  assert.equal(lp.href, '#/ws/lowerpoly')
  assert.deepEqual(s.groups.workflow.map(g => g.key).sort(), ['front/converse', 'lowerpoly/freework', 'lowerpoly/lod-chain'])
  assert.deepEqual(s.groups.worker.map(g => [g.key, g.attempts]).sort(), [['gpupc', 1], ['studio', 2]])
  assert.equal(s.groups.project.reduce((n, g) => n + g.attempts, 0), 3)
})

test('periods: an attempt counts by its end; today starts at local midnight', async () => {
  const now = new Date(2026, 9, 20, 12, 0, 0)
  const old = await attempt({ began: new Date(2026, 9, 1, 9).toISOString(), ended: new Date(2026, 9, 1, 10).toISOString() }, claudeResult('p-1', 1, 1))
  const week = await attempt({ began: new Date(2026, 9, 17, 9).toISOString(), ended: new Date(2026, 9, 17, 10).toISOString() }, claudeResult('p-2', 1, 1))
  const today = await attempt({ began: new Date(2026, 9, 19, 23, 50).toISOString(), ended: new Date(2026, 9, 20, 0, 10).toISOString() }, claudeResult('p-3', 1, 1))
  const rows = await new UsageReader(store([old, week, today]), 'http://relay.invalid', relayDown).attempts()
  const s = summarize(rows, '7d', now)
  assert.deepEqual([s.periods.today.attempts, s.periods['7d'].attempts, s.periods['30d'].attempts, s.periods.all.attempts], [1, 2, 3, 3])
  assert.equal(s.attempts.length, 2)
  assert.equal(s.days.length, 14)
  assert.equal(s.days.at(-1)!.attempts, 1)
})

test('relay sources: a failure is marked with its reason and the last good answer, the other source is unaffected', async () => {
  let budgetUp = true
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/budget') {
      if (!budgetUp) return new Response(JSON.stringify({ error: 'the budget read is not configured' }), { status: 503 })
      return new Response(JSON.stringify({ schema: 'ag.budget.v1', harnesses: { codex: { ok: false, error: 'codex app-server did not answer' } } }))
    }
    return new Response(JSON.stringify({ totals: { all: { runs: 3 } }, table: [], roots: [], prices: null, routines: ['dropped'] }))
  }
  const reader = new UsageReader(store([]), 'http://relay.invalid', fetcher)
  const ok = await reader.budget()
  assert.equal(ok.state, 'ok')
  // A provider's own failure is the relay's card, passed through as it is.
  assert.equal((ok as { data: { harnesses: { codex: { ok: boolean } } } }).data.harnesses.codex.ok, false)
  const history = await reader.history()
  assert.equal(history.state, 'ok')
  assert.deepEqual(Object.keys((history as { data: object }).data).sort(), ['generated_at', 'prices', 'roots', 'table', 'totals'])
  budgetUp = false
  ;(reader as unknown as { budgetCache: null }).budgetCache = null
  const down = await reader.budget()
  assert.equal(down.state, 'unavailable')
  if (down.state === 'unavailable') {
    assert.match(down.error, /\/budget on the agentroom relay: the budget read is not configured/)
    assert.ok(down.last, 'the last good answer is kept, marked with its time')
  }
  const usage = await reader.usage('all')
  assert.equal(usage.history.state, 'ok')
  const unreachable = await new UsageReader(store([]), 'http://relay.invalid', relayDown).usage('7d')
  assert.equal(unreachable.history.state, 'unavailable')
  assert.equal(unreachable.periods['7d'].attempts, 0)
})
