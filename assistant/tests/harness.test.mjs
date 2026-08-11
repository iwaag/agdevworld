import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AgentRunError, buildArgv, composePrompt, extractClaude, extractEventText, runAgent } from '../harness.mjs'

test('OpenCode JSONL extraction preserves text and reported usage', () => {
  const raw = [
    JSON.stringify({ type: 'text', part: { text: 'hello' } }),
    JSON.stringify({ type: 'step_finish', part: { cost: 0.25, tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 2, write: 1 } } } }),
  ].join('\n')
  assert.deepEqual(extractEventText(raw), {
    text: 'hello',
    stats: { num_turns: 1, cost_usd: 0.25, usage: { input: 3, output: 4, reasoning: 1, cache_read: 2, cache_write: 1 } },
  })
})

test('Claude argv uses the native model and only the agdevworld MCP tools', () => {
  const argv = buildArgv({
    command: '/opt/claude',
    harness: 'claude_code',
    model: 'anthropic/claude-sonnet-5',
  }, { mcpConfigPath: '/tmp/mcp.json' })
  assert.deepEqual(argv.slice(0, 9), [
    '/opt/claude', '-p', '--output-format', 'json', '--model', 'claude-sonnet-5',
    '--mcp-config', '/tmp/mcp.json', '--strict-mcp-config',
  ])
  assert.equal(argv[9], '--allowedTools')
  assert.equal(argv[10], 'mcp__agdevworld__fetch,mcp__agdevworld__wait,mcp__agdevworld__switch_view,mcp__agdevworld__show_image')
  assert.ok(!argv.includes('--dangerously-skip-permissions'))
})

test('Claude JSON extraction keeps native usage and normalized cost fields', () => {
  const raw = JSON.stringify({
    result: 'hello from Claude',
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: 0.031,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
    is_error: false,
    subtype: 'success',
  })
  assert.deepEqual(extractClaude(raw), {
    text: 'hello from Claude',
    stats: {
      duration_ms: 1234,
      num_turns: 2,
      cost_usd: 0.031,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
      is_error: false,
      subtype: 'success',
    },
  })
  assert.deepEqual(extractClaude('not json'), { text: 'not json', stats: {} })
})

test('Claude is_error envelope fails while preserving reported metadata and raw output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-claude-error-'))
  const command = join(dir, 'claude')
  const transcript = join(dir, 'raw.json')
  const envelope = JSON.stringify({ result: 'authentication required', is_error: true, subtype: 'auth_error', duration_ms: 12 })
  await writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${envelope}'\n`)
  await chmod(command, 0o755)
  await assert.rejects(
    runAgent({
      agent: { role: 'front', profile: 'sonnet', harness: 'claude_code', provider: 'anthropic', model: 'anthropic/claude-sonnet-5', command },
      prompt: 'x', timeoutMs: 1000, transcriptPath: transcript, toolBaseUrl: 'http://127.0.0.1:1',
    }),
    (error) => error instanceof AgentRunError
      && error.meta.is_error === true
      && error.meta.duration_ms === 12
      && /authentication required/.test(error.message),
  )
  assert.equal(await readFile(transcript, 'utf8'), envelope + '\n')
})

test('Claude process failure keeps the stderr tail in the run error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-claude-stderr-'))
  const command = join(dir, 'claude')
  await writeFile(command, '#!/bin/sh\nprintf "login required" >&2\nexit 1\n')
  await chmod(command, 0o755)
  await assert.rejects(
    runAgent({
      agent: { role: 'front', profile: 'sonnet', harness: 'claude_code', provider: 'anthropic', model: 'anthropic/claude-sonnet-5', command },
      prompt: 'x', timeoutMs: 1000, toolBaseUrl: 'http://127.0.0.1:1',
    }),
    (error) => error instanceof AgentRunError && /login required/.test(error.message),
  )
})

test('one fake process receives full browser history and returns normalized metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-run-'))
  const command = join(dir, 'fake')
  const captured = join(dir, 'prompt.txt')
  const transcript = join(dir, 'raw.txt')
  await writeFile(command, `#!/bin/sh\ntee "${captured}" >/dev/null\nprintf 'stub answer\\n'\n`)
  await chmod(command, 0o755)
  const prompt = composePrompt({ system: 'system', messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'latest' }] })
  const result = await runAgent({
    agent: { role: 'front', profile: 'stub', harness: 'fake', provider: 'ollama', model: 'ollama/test', command },
    prompt,
    timeoutMs: 1000,
    transcriptPath: transcript,
    toolBaseUrl: 'http://127.0.0.1:1',
  })
  assert.equal(result.reply, 'stub answer')
  assert.equal(result.meta.harness, 'fake')
  assert.match(await readFile(captured, 'utf8'), /USER:\nlatest/)
  assert.equal(await readFile(transcript, 'utf8'), 'stub answer\n')
})

test('timeout is recorded as aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-timeout-'))
  const command = join(dir, 'fake')
  await writeFile(command, '#!/bin/sh\nsleep 2\n')
  await chmod(command, 0o755)
  await assert.rejects(
    runAgent({
      agent: { role: 'front', profile: 'stub', harness: 'fake', provider: 'ollama', model: 'ollama/test', command },
      prompt: 'x', timeoutMs: 20, toolBaseUrl: 'http://127.0.0.1:1',
    }),
    (error) => error instanceof AgentRunError && error.outcome === 'aborted',
  )
})
