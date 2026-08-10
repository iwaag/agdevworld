import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AgentRunError, composePrompt, extractEventText, runAgent } from '../harness.mjs'

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
