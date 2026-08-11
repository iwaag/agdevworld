import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ACTIONS_FILE = process.env.AGDEVWORLD_ACTIONS_FILE ?? ''
const MAX_BODY_BYTES = 1_000_000

export const TOOLS = [
  {
    name: 'fetch',
    description: 'Fetch a same-origin agdevworld path. Returns the raw HTTP status, content type, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path beginning with /' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        body: { type: 'string', description: 'POST body, normally JSON' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wait',
    description: 'Wait before polling again. One call is capped at 60 seconds.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    },
  },
  {
    name: 'switch_view',
    description: 'Ask the browser to switch to the nodes, workspaces, autolab, or tasks view.',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['nodes', 'workspaces', 'autolab', 'tasks'] } },
      required: ['view'],
    },
  },
  {
    name: 'show_image',
    description: 'Ask the browser to put an image URL in the conversation.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
]

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) }
}

async function fetchTool(args) {
  const path = String(args.path ?? '')
  if (!path.startsWith('/') || path.startsWith('//')) return text('fetch refused: path must begin with one /', true)
  const base = new URL(process.env.AGDEVWORLD_TOOL_BASE_URL ?? 'http://127.0.0.1:8090')
  const target = new URL(path, base)
  if (target.origin !== base.origin) return text('fetch refused: target must stay on the configured agdevworld origin', true)
  const method = String(args.method ?? 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) return text(`fetch refused: method ${method} is not GET or POST`, true)
  try {
    const response = await fetch(target, {
      method,
      headers: args.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: method === 'POST' ? String(args.body ?? '') : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const clipped = bytes.byteLength > MAX_BODY_BYTES ? bytes.slice(0, MAX_BODY_BYTES) : bytes
    const suffix = bytes.byteLength > MAX_BODY_BYTES ? `\n\n[body clipped at ${MAX_BODY_BYTES} bytes]` : ''
    return text(`HTTP ${response.status} ${response.headers.get('content-type') ?? ''}\n\n${new TextDecoder().decode(clipped)}${suffix}`)
  } catch (error) {
    return text(`fetch ${method} ${path} failed: ${error.message}`, true)
  }
}

async function waitTool(args) {
  const asked = Number(args.seconds)
  const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 60) : 0
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  return text(seconds === asked ? `waited ${seconds} seconds` : `waited ${seconds} seconds (${args.seconds} was requested)`)
}

async function actionTool(name, args) {
  if (!ACTIONS_FILE) return text('UI action channel is unavailable', true)
  let action
  if (name === 'switch_view') {
    const view = String(args.view ?? '')
    if (!['nodes', 'workspaces', 'autolab', 'tasks'].includes(view)) return text(`unknown view: ${view}`, true)
    action = { action: name, view }
  } else {
    const url = String(args.url ?? '')
    if (!url) return text('show_image requires a URL', true)
    action = { action: name, url }
  }
  await appendFile(ACTIONS_FILE, `${JSON.stringify(action)}\n`)
  return text(name === 'switch_view' ? `the browser will switch to ${action.view}` : `the browser will show ${action.url}`)
}

export async function callTool(name, args = {}) {
  if (name === 'fetch') return fetchTool(args)
  if (name === 'wait') return waitTool(args)
  if (name === 'switch_view' || name === 'show_image') return actionTool(name, args)
  return text(`unknown tool: ${name}`, true)
}

async function handle(message) {
  if (message.method === 'initialize') {
    return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agdevworld-tools', version: '1.0.0' } }
  }
  if (message.method === 'tools/list') return { tools: TOOLS }
  if (message.method === 'tools/call') return callTool(message.params?.name, message.params?.arguments)
  if (message.method === 'ping') return {}
  throw new Error(`method not found: ${message.method}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
      if (message.id === undefined) continue
      const result = await handle(message)
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    } catch (error) {
      if (message?.id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: error.message } })}\n`)
      }
    }
  }
}
