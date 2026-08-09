// Minimal assistant service for agdevworld.
//
// POST /api/chat
//   { "messages": [{"role":"user"|"assistant","content":"..."}], "context": "<cluster summary text>" }
//   -> { "reply": "..." }
// GET /api/guide -> GUIDE.md as text/plain
//
// Stateless: conversation history lives in the browser and is sent whole on
// each request. This endpoint is the engine-agnostic seam: `handleChat` builds
// the system prompt and hands (system, messages) to a backend, and only the
// BACKENDS entries below know what engine answers.
//
// Backend selection (devpolicy/policy.md, Agent ≠ Model), same shape as
// agforge's AGFORGE_AGENT_BACKEND — process env, one default, unknown value is
// an error rather than a silent fallback:
//
//   ASSISTANT_BACKEND=ollama (default) | claude
//   OLLAMA_URL / OLLAMA_MODEL      the local default
//   CLAUDE_MODEL                   model for the claude backend
//   ANTHROPIC_API_KEY              required by the claude backend only
//
// Every reply is recorded per devpolicy/agent_records.md as one JSON line on
// stdout (`assistant.run.v1`) — the container has no writable volume, so its
// log is the record store. ASSISTANT_RECORDS_DIR, when set, also writes one
// file per run there.
//
// The assistant's entrance guide (devpolicy/policy.md) is GUIDE.md next to
// this file, read from disk on every chat request and appended to the role
// prompt. Reading per request rather than at boot is the cagent llms.txt
// pattern: editing the card changes the next answer without a restart, and
// with the file bind-mounted, without a rebuild either.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 8091)
const GUIDE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'GUIDE.md')

async function readGuide() {
  try {
    return await readFile(GUIDE_PATH, 'utf8')
  } catch (error) {
    console.warn('capability card unreadable:', error)
    return 'No capability card is installed on this assistant.'
  }
}

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
  'include this object unless the user asked for an image, and never mention or explain the JSON.\n\n' +
  'When the user asks what you can do, what you are, what something costs, or how long it takes, ' +
  'answer from the capability card below. Quote its figures as they stand — tentative ranges and ' +
  '"unknown" are correct answers, and you must never invent a price, a duration or a capability ' +
  'the card does not claim.'

// --- backends ---------------------------------------------------------------
//
// A backend takes ({ system, messages }) and returns { reply, meta }. It throws
// BackendError when it cannot answer; the caller turns that into a 502 and a
// `failed` record carrying the backend's own words.

class BackendError extends Error {}

const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, '')
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'glm-4.7-flash:latest'

// Claude Opus 5 is the default rather than a cheaper tier on purpose: this is
// the opt-in "strong backend" of the switch, and the cheap path is the ollama
// default. Effort stays low — the assistant answers from a cluster snapshot
// and a capability card, not from hard reasoning.
// `||`, not `??`, throughout: compose passes an empty string for a variable the
// operator has not set, and empty must mean "use the default" (the same trap
// AUTOLAB_NODES documents below).
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5'
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || 'low'
const CLAUDE_MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 4096)

async function askOllama({ system, messages }) {
  let response
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    })
  } catch (error) {
    throw new BackendError(`the language model at ${OLLAMA_URL} is unreachable: ${error}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new BackendError(`the language model returned HTTP ${response.status}: ${detail.slice(0, 400)}`)
  }
  const data = await response.json().catch(() => null)
  const reply = data?.message?.content
  if (typeof reply !== 'string' || reply.trim() === '') {
    throw new BackendError('the language model returned an unexpected shape')
  }
  return {
    reply,
    meta: {
      model: OLLAMA_MODEL,
      // ollama reports tokens but never a price; never invent one.
      cost_usd: null,
      prompt_tokens: data.prompt_eval_count ?? null,
      output_tokens: data.eval_count ?? null,
    },
  }
}

// Loaded lazily so the ollama default never pays for the import, and a missing
// dependency only breaks the backend that needs it.
let anthropicClient = null
async function getAnthropic() {
  if (anthropicClient) return anthropicClient
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new BackendError('ANTHROPIC_API_KEY is not set in the assistant container')
  }
  let Anthropic
  try {
    ;({ default: Anthropic } = await import('@anthropic-ai/sdk'))
  } catch (error) {
    throw new BackendError(`the @anthropic-ai/sdk package is not installed: ${error}`)
  }
  anthropicClient = new Anthropic()
  return anthropicClient
}

async function askClaude({ system, messages }) {
  const client = await getAnthropic()
  let response
  try {
    response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      output_config: { effort: CLAUDE_EFFORT },
      system,
      messages,
    })
  } catch (error) {
    throw new BackendError(`the claude backend failed: ${error?.message ?? error}`)
  }
  if (response.stop_reason === 'refusal') {
    throw new BackendError(
      `the claude backend declined the request (${response.stop_details?.category ?? 'no category'})`,
    )
  }
  // Thinking blocks come first when the model thinks; only text is the reply.
  const reply = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (reply.trim() === '') throw new BackendError('the claude backend produced no text')
  return {
    reply,
    meta: {
      model: response.model,
      // The Messages API reports tokens, not dollars — record what it says.
      cost_usd: null,
      prompt_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      stop_reason: response.stop_reason,
    },
  }
}

const BACKENDS = { ollama: askOllama, claude: askClaude }

function chosenBackend() {
  const name = process.env.ASSISTANT_BACKEND || 'ollama'
  if (!(name in BACKENDS)) throw new BackendError(`unknown ASSISTANT_BACKEND: ${name}`)
  return name
}

// --- run records (devpolicy/agent_records.md) -------------------------------

const RECORDS_DIR = process.env.ASSISTANT_RECORDS_DIR || ''

async function recordRun(record) {
  console.log(JSON.stringify({ kind: 'assistant.run.v1', ...record }))
  if (!RECORDS_DIR) return
  try {
    await mkdir(RECORDS_DIR, { recursive: true })
    await writeFile(join(RECORDS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n')
  } catch (error) {
    console.warn('could not write the run record to disk:', error)
  }
}

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

  const cluster =
    typeof context === 'string' && context.trim() !== ''
      ? `Current cluster summary:\n${context}`
      : 'No cluster summary is available right now.'
  const system = `${ROLE_PROMPT}\n\n${cluster}\n\n=== CAPABILITY CARD ===\n${await readGuide()}`

  const record = { id: randomUUID(), started: new Date().toISOString(), backend: null, outcome: 'failed' }
  const started = Date.now()
  let answer
  try {
    record.backend = chosenBackend()
    answer = await BACKENDS[record.backend]({ system, messages })
  } catch (error) {
    if (!(error instanceof BackendError)) throw error
    // The engine never spoke, so the free-text failure report the record policy
    // asks for is the failing party's own words.
    record.failure = error.message
    record.duration_ms = Date.now() - started
    await recordRun(record)
    return sendJson(res, 502, { error: 'assistant_offline', detail: error.message })
  }
  Object.assign(record, answer.meta)
  record.backend_model = `${record.backend}/${answer.meta.model}`
  record.outcome = 'done'
  record.duration_ms = Date.now() - started
  await recordRun(record)
  return sendJson(res, 200, { reply: answer.reply, backend: record.backend_model })
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

// The card, raw. Same content the chat answers from, for a caller that would
// rather read it than ask.
async function handleGuide(res) {
  const body = Buffer.from(await readGuide(), 'utf8')
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.byteLength,
  })
  res.end(body)
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true })
  if (req.method === 'GET' && (req.url === '/api/guide' || req.url === '/guide')) {
    handleGuide(res).catch((error) => {
      console.error('unhandled guide error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected guide failure.' })
    })
    return
  }
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
  const backend = process.env.ASSISTANT_BACKEND || 'ollama'
  const model = backend === 'claude' ? CLAUDE_MODEL : `${OLLAMA_MODEL} @ ${OLLAMA_URL}`
  console.log(`assistant listening on :${PORT}, backend=${backend}, model=${model}`)
})
