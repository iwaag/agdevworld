// Minimal assistant service for agdevworld.
//
// POST /api/chat
//   { "messages": [{"role":"user"|"assistant","content":"..."}], "context": "<cluster summary text>" }
//   -> { "reply": "..." }
//
// Stateless: conversation history lives in the browser and is sent whole on
// each request. This endpoint is the engine-agnostic seam — only the code
// below this comment knows that ollama is the engine.

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8091)

// Role and action protocol are engine-agnostic; keep them above the ollama
// configuration below.
const ROLE_PROMPT =
  'You are the assistant inside agdevworld, an immersive development interface. ' +
  'Answer questions about the cluster described below, concisely and in plain text. ' +
  'If the answer is not in the cluster summary, say you do not know.\n\n' +
  'You can also control the screen. There are three views: "nodes" (cluster nodes), ' +
  '"workspaces" (development workspaces), and "autolab" (agent-driven jobs running on the ' +
  'autolab nodes). When the user asks to see, show, or switch to a view, include this exact ' +
  'JSON object on its own line in your reply: {"action":"switch_view","view":"nodes"}, ' +
  '{"action":"switch_view","view":"workspaces"} or {"action":"switch_view","view":"autolab"} ' +
  'and add one short confirming sentence. Do not include the JSON object unless the user asked ' +
  'to change the view, and never mention or explain the JSON itself.\n\n' +
  'You can also generate images. When the user asks you to draw, paint, create, or generate a ' +
  'picture or image, include this exact JSON object on its own line in your reply: ' +
  '{"action":"generate_image","desire":"<short English image prompt>"} ' +
  'where the desire describes what to draw, on a single line, using no double quotes, braces, or ' +
  'backslashes inside it. Add one short sentence saying the image is being generated. Do not ' +
  'include this object unless the user asked for an image, and never mention or explain the JSON.'

const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, '')
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'glm-4.7-flash:latest'

// agforge request service (see agforge/README_DEV.md for the contract).
// Real endpoint values belong in env / compose, never committed defaults.
const AGFORGE_URL = (process.env.AGFORGE_URL ?? 'http://host.docker.internal:8092').replace(/\/$/, '')

// autolab nodes (agautolab/agent/gateway.py, `autolab.monitor.v1`).
// AUTOLAB_NODES="<name>=<url>,<name>=<url>"; the committed default is the
// local node only, real cluster hostnames come from env like every other
// endpoint here.
const AUTOLAB_NODES = parseNodes(
  // `||`, not `??`: compose passes an empty string when the operator has not
  // set one, and an empty string must mean "use the default", not "no nodes".
  process.env.AUTOLAB_NODES || 'agstudio=http://host.docker.internal:8791',
)

// The one place constraint 1 of the ex1 plan is enforced: raw evidence is
// summarized on the node it lives on, and nothing but the summary text crosses
// into agdevworld. Blocking the path here means no caller — page, assistant or
// curl — can reach around it.
const EVIDENCE_PATH = /(^|\/)evidence(\/|$)/

function parseNodes(spec) {
  const nodes = new Map()
  for (const entry of spec.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    const name = at === -1 ? '' : trimmed.slice(0, at).trim()
    const url = at === -1 ? '' : trimmed.slice(at + 1).trim().replace(/\/$/, '')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !/^https?:\/\//.test(url)) {
      console.warn(`ignoring malformed AUTOLAB_NODES entry: ${trimmed}`)
      continue
    }
    nodes.set(name, url)
  }
  return nodes
}

function isValidMessage(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string'
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function handleChat(req, res) {
  let parsed
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be JSON.' })
  }

  const { messages, context } = parsed ?? {}
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isValidMessage)) {
    return sendJson(res, 400, {
      error: 'bad_request',
      detail: 'messages must be a non-empty array of {role: "user"|"assistant", content: string}.',
    })
  }

  const system =
    typeof context === 'string' && context.trim() !== ''
      ? `${ROLE_PROMPT}\n\nCurrent cluster summary:\n${context}`
      : `${ROLE_PROMPT}\n\nNo cluster summary is available right now.`

  let ollamaResponse
  try {
    ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    })
  } catch (error) {
    console.error('ollama unreachable:', error)
    return sendJson(res, 502, {
      error: 'assistant_offline',
      detail: `The language model at ${OLLAMA_URL} is unreachable.`,
    })
  }

  if (!ollamaResponse.ok) {
    console.error('ollama error status:', ollamaResponse.status, await ollamaResponse.text().catch(() => ''))
    return sendJson(res, 502, {
      error: 'assistant_offline',
      detail: `The language model returned HTTP ${ollamaResponse.status}.`,
    })
  }

  const data = await ollamaResponse.json().catch(() => null)
  const reply = data?.message?.content
  if (typeof reply !== 'string') {
    return sendJson(res, 502, { error: 'assistant_offline', detail: 'The language model returned an unexpected shape.' })
  }
  return sendJson(res, 200, { reply })
}

// Same-origin passthrough so the browser can reach the agforge request
// service without CORS: /api/forge/<rest> -> AGFORGE_URL/api/<rest>.
async function handleForge(req, res) {
  const rest = req.url.slice('/api/forge'.length)
  const target = `${AGFORGE_URL}/api${rest}`
  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
    })
  } catch (error) {
    console.error('agforge unreachable:', error)
    return sendJson(res, 502, {
      error: 'forge_offline',
      detail: `The agforge service at ${AGFORGE_URL} is unreachable.`,
    })
  }
  const body = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'content-length': body.byteLength,
  })
  res.end(body)
}

// GET /api/autolab/nodes -> the configured nodes and whether each answers.
// A node being down is normal (agautolab1 often is), so reachability is part
// of the answer rather than an error.
async function handleAutolabNodes(res) {
  const nodes = await Promise.all(
    [...AUTOLAB_NODES.entries()].map(async ([name, url]) => {
      try {
        const probe = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })
        return { name, reachable: probe.ok, status: probe.status }
      } catch (error) {
        return { name, reachable: false, detail: String(error.cause?.code ?? error.name) }
      }
    }),
  )
  return sendJson(res, 200, { kind: 'autolab.nodes.v1', nodes })
}

// Same-origin passthrough to one node's gateway, the handleForge template:
// /api/autolab/<node>/<rest> -> <node url>/<rest>.
async function handleAutolab(req, res) {
  const [pathname, query] = req.url.slice('/api/autolab'.length).split('?')
  if (pathname === '/nodes' || pathname === '/nodes/') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    return handleAutolabNodes(res)
  }
  const [, node, ...rest] = pathname.split('/')
  const path = `/${rest.join('/')}`
  const url = AUTOLAB_NODES.get(node)
  if (!url) {
    return sendJson(res, 404, {
      error: 'unknown_node',
      detail: `No autolab node named "${node}" is configured.`,
    })
  }
  if (EVIDENCE_PATH.test(path)) {
    return sendJson(res, 403, {
      error: 'evidence_not_proxied',
      detail: 'Raw evidence stays on its node; ask for the iteration summary instead.',
    })
  }
  const isSummarize = /\/summarize\//.test(path)
  if (req.method !== 'GET' && !(req.method === 'POST' && isSummarize)) {
    return sendJson(res, 405, {
      error: 'method_not_allowed',
      detail: 'Only GET, and POST to a summarize route, are proxied.',
    })
  }
  const target = `${url}${path}${query ? `?${query}` : ''}`
  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' ? undefined : await readBody(req),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    console.error(`autolab node ${node} unreachable:`, error)
    return sendJson(res, 502, {
      error: 'node_offline',
      detail: `The autolab node "${node}" is unreachable.`,
    })
  }
  const body = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'content-length': body.byteLength,
  })
  res.end(body)
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true })
  if (req.url?.startsWith('/api/forge/')) {
    handleForge(req, res).catch((error) => {
      console.error('unhandled forge passthrough error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected passthrough failure.' })
    })
    return
  }
  if (req.url?.startsWith('/api/autolab/')) {
    handleAutolab(req, res).catch((error) => {
      console.error('unhandled autolab passthrough error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected passthrough failure.' })
    })
    return
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    handleChat(req, res).catch((error) => {
      console.error('unhandled chat error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected assistant failure.' })
    })
    return
  }
  sendJson(res, 404, { error: 'not_found' })
})

server.listen(PORT, () => {
  console.log(`assistant listening on :${PORT}, model=${OLLAMA_MODEL}, ollama=${OLLAMA_URL}`)
})
