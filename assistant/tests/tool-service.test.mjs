import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { callTool, TOOLS } from '../tool-service.mjs'

test('tool catalog exposes server and UI tools', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['fetch', 'wait', 'switch_view', 'show_image'])
})

test('fetch boundary refuses cross-origin-shaped paths', async () => {
  const result = await callTool('fetch', { path: '//example.com/private' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /refused/)
})

test('fetch returns status, content type, and raw body', async () => {
  const previous = process.env.AGDEVWORLD_TOOL_BASE_URL
  const originalFetch = globalThis.fetch
  process.env.AGDEVWORLD_TOOL_BASE_URL = 'http://agdevworld.example'
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'http://agdevworld.example/state')
    return new Response('{"ok":true}', { status: 202, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await callTool('fetch', { path: '/state' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /^HTTP 202 application\/json\n\n\{"ok":true\}$/)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.AGDEVWORLD_TOOL_BASE_URL
    else process.env.AGDEVWORLD_TOOL_BASE_URL = previous
  }
})

test('stdio MCP lists tools and collects a UI action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agdevworld-mcp-'))
  const actions = join(dir, 'actions.jsonl')
  const child = spawn(process.execPath, [resolve('assistant/tool-service.mjs')], {
    env: { ...process.env, AGDEVWORLD_ACTIONS_FILE: actions },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'switch_view', arguments: { view: 'tasks' } } })}\n`)
  child.stdin.end()
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  })
  const replies = stdout.trim().split('\n').map(JSON.parse)
  assert.equal(replies[0].result.serverInfo.name, 'agdevworld-tools')
  assert.equal(replies[1].result.tools.length, 4)
  assert.match(replies[2].result.content[0].text, /switch to tasks/)
  assert.deepEqual(JSON.parse((await readFile(actions, 'utf8')).trim()), { action: 'switch_view', view: 'tasks' })
})
