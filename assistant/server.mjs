// Minimal assistant service for agdevworld.
//
// POST /api/chat
//   { "messages": [...], "context": "<what is on screen>" }
//   -> { "reply": "...", "tool_calls": [...], "backend": "..." }
// GET /api/guide -> GUIDE.md as text/plain
//
// Stateless: the conversation lives in the browser and is sent whole on each
// request. Tool calls are answered the same way — the assistant asks, the
// browser runs the call and posts the result back in the next message list.
// Tools run in the browser because that is where the screen and the same-origin
// paths are; this service stays a pure (system, messages, tools) -> reply seam.
//
// Backend selection (devpolicy/policy.md, Agent != Model), same shape as
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

// --- tools ------------------------------------------------------------------
//
// Declared here, executed in the browser. `fetch` is one tool rather than one
// tool per endpoint on purpose: an enumerated tool per endpoint is the same
// allowlist wearing a different hat. The paths below are facts; what is
// actually reachable is decided by the passthrough at request time, and its
// refusals reach the assistant verbatim.

const TOOLS = [
  {
    name: 'fetch',
    description:
      'Fetch any same-origin path of this app. Returns the HTTP status, the content type and the body, raw.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path starting with /' },
        method: { type: 'string', description: 'GET (default) or POST' },
        body: { type: 'string', description: 'Request body for POST, usually JSON' },
      },
      required: ['path'],
    },
  },
  {
    name: 'switch_view',
    description: 'Show one of the views on screen.',
    parameters: {
      type: 'object',
      properties: { view: { type: 'string', description: 'nodes, workspaces or autolab' } },
      required: ['view'],
    },
  },
  {
    name: 'wait',
    description: 'Pause before the next tool call, for something that takes time to finish.',
    parameters: {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    },
  },
  {
    name: 'show_image',
    description: 'Put a picture in the conversation.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
]

const ROLE_PROMPT = `You are the assistant inside agdevworld, an immersive development interface, and the human's conversational entrance to it.

Tools: fetch(path, method, body), wait(seconds), switch_view(view), show_image(url).

Paths reachable with fetch:
- /cluster/state.json, /cluster/workspaces.json, /cluster/actual.json — the live cluster snapshots (nctl drift, workspaces, actual with hardware facts). When a live one is absent the samples are /state.sample.json, /workspaces.sample.json, /actual.sample.json.
- /api/autolab/nodes — the autolab nodes this service is configured with, and whether each answers right now.
- /api/autolab/<node>/jobs, /api/autolab/<node>/jobs/<job>, /api/autolab/<node>/status — one node's autolab gateway.
- /api/autolab/<node>/jobs/<job>/summarize/<iter> — POST asks the node to summarize that iteration, GET reads the result; it takes about 15 seconds and may answer "pending".
- /api/autolab/<node>/window and /api/autolab/<node>/director — POST {"text":"..."} to a node's own conversational window, or to its director. The window is the node's entrance: asking it for work is how a mission gets started (it refuses while one is already running).
- /api/note — POST {"text":"..."} writes a note into this service's records; it is the one thing you can leave behind.
- /api/forge/requests — POST {"desire":"..."} starts an image generation on agforge; GET /api/forge/requests/<id> reads it back. It takes 20 to 105 seconds.
- /api/guide — the capability card below, raw.

The screen shows one view at a time: nodes, workspaces, autolab.

Budget: up to 16 tool rounds per reply. One call gets 60 seconds — a single wait lasts at most that, and a fetch that does not answer within it comes back as a timeout. Whatever a path answers, including a refusal and its reason, is returned to you as it stands; a path outside /api/ that does not exist answers 200 with this app's own HTML rather than 404.`

// --- backends ---------------------------------------------------------------
//
// A backend takes ({ system, messages, tools }) and returns
// { reply, tool_calls, meta }. It throws BackendError when it cannot answer;
// the caller turns that into a 502 and a `failed` record carrying the
// backend's own words.
//
// The wire message shape is neutral, and each backend translates it:
//   { role: 'user' | 'assistant', content: string }
//   { role: 'assistant', content: string, tool_calls: [{ id, name, arguments }] }
//   { role: 'tool', tool_call_id, name, content: string }

class BackendError extends Error {}

const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, '')
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'glm-4.7-flash:latest'

// Claude Opus 5 is the default rather than a cheaper tier on purpose: this is
// the opt-in "strong backend" of the switch, and the cheap path is the ollama
// default. Effort stays low — the assistant answers from what it fetches and a
// capability card, not from hard reasoning.
// `||`, not `??`, throughout: compose passes an empty string for a variable the
// operator has not set, and empty must mean "use the default" (the same trap
// AUTOLAB_NODES documents below).
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5'
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || 'low'
const CLAUDE_MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 4096)

function toOllamaMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content ?? '' }
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.tool_calls.map((call) => ({
          function: { name: call.name, arguments: call.arguments ?? {} },
        })),
      }
    }
    return { role: message.role, content: message.content ?? '' }
  })
}

async function askOllama({ system, messages, tools }) {
  let response
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        messages: [{ role: 'system', content: system }, ...toOllamaMessages(messages)],
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
  const message = data?.message
  if (message === undefined || message === null) {
    throw new BackendError('the language model returned an unexpected shape')
  }
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? {},
      }))
    : []
  return {
    reply: typeof message.content === 'string' ? message.content : '',
    tool_calls: calls,
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

// Tool results are user-turn content blocks for this API, and turns must
// alternate, so consecutive results merge into one message.
function toClaudeMessages(messages) {
  const out = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content ?? '',
      }
      const last = out[out.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
      continue
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    out.push({ role: message.role, content: message.content ?? '' })
  }
  return out
}

async function askClaude({ system, messages, tools }) {
  const client = await getAnthropic()
  let response
  try {
    response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      output_config: { effort: CLAUDE_EFFORT },
      system,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
      messages: toClaudeMessages(messages),
    })
  } catch (error) {
    throw new BackendError(`the claude backend failed: ${error?.message ?? error}`)
  }
  if (response.stop_reason === 'refusal') {
    throw new BackendError(
      `the claude backend declined the request (${response.stop_details?.category ?? 'no category'})`,
    )
  }
  // Thinking blocks come first when the model thinks; text is the reply and
  // tool_use blocks are the calls.
  const reply = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const calls = response.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }))
  if (reply.trim() === '' && calls.length === 0) {
    throw new BackendError('the claude backend produced no text')
  }
  return {
    reply,
    tool_calls: calls,
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

// Safety device, not a wrongness guard: raw iteration evidence belongs to the
// agautolab node that produced it. Blocking the path here means no caller —
// page, assistant or curl — reaches around it. Nothing tells the assistant not
// to try; the 403 and its reason are returned as the answer.
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
  if (value === null || typeof value !== 'object') return false
  if (value.role === 'tool') return typeof value.content === 'string'
  if (value.role !== 'user' && value.role !== 'assistant') return false
  return typeof value.content === 'string' || Array.isArray(value.tool_calls)
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
      detail: 'messages must be a non-empty array of chat or tool messages.',
    })
  }

  const screen = typeof context === 'string' && context.trim() !== '' ? `\n\n${context}` : ''
  const system = `${ROLE_PROMPT}${screen}\n\n=== CAPABILITY CARD ===\n${await readGuide()}`

  const record = {
    id: randomUUID(),
    started: new Date().toISOString(),
    backend: null,
    outcome: 'failed',
    tool_rounds: messages.filter((message) => message.role === 'tool').length,
  }
  const started = Date.now()
  let answer
  try {
    record.backend = chosenBackend()
    answer = await BACKENDS[record.backend]({ system, messages, tools: TOOLS })
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
  record.tool_calls = answer.tool_calls.map((call) => call.name)
  record.outcome = 'done'
  record.duration_ms = Date.now() - started
  await recordRun(record)
  return sendJson(res, 200, {
    reply: answer.reply,
    tool_calls: answer.tool_calls,
    backend: record.backend_model,
  })
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
//
// Two safety devices live here, both about reach rather than correctness: the
// node list is finite (otherwise this is an open relay into the LAN), and raw
// evidence stays on the node that produced it. Both answer with their own
// reason, which the assistant reads like any other result. The node routes
// themselves are open (zero_auth episode) — what a POST may do is decided by
// the node, not by a gate here.
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
      detail: `No autolab node named "${node}" is configured. Configured: ${[...AUTOLAB_NODES.keys()].join(', ') || 'none'}.`,
    })
  }
  if (EVIDENCE_PATH.test(path)) {
    return sendJson(res, 403, {
      error: 'evidence_not_proxied',
      detail: 'Raw evidence stays on the node that produced it; the iteration summary crosses instead.',
    })
  }
  const target = `${url}${path}${query ? `?${query}` : ''}`
  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' ? undefined : await readBody(req),
      // 60 s, the same bound one `wait` gets: a node's own window answers in
      // 3–28 s on its local model, so the 10 s this used to hold turned an
      // open door into `node_offline` — a closed door reporting a wrong reason.
      signal: AbortSignal.timeout(60_000),
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

// POST /api/note {"text": "..."} -> an `assistant.note.v1` record.
//
// The assistant had no way to write anything down: it reads the card on every
// request and has no file, so a card line it discovers to be false died with
// the reply. This is that missing half of the record policy — a free-text
// report in the agent's own words, whose path is fixed here and whose content
// never is. No new tool: `fetch` already reaches it, and the card names it.
async function handleNote(req, res) {
  let parsed
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be JSON.' })
  }
  const text = parsed?.text
  if (typeof text !== 'string' || text.trim() === '') {
    return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be {"text": "..."}.' })
  }
  const record = { id: randomUUID(), written: new Date().toISOString(), text }
  console.log(JSON.stringify({ kind: 'assistant.note.v1', ...record }))
  if (RECORDS_DIR) {
    try {
      await mkdir(RECORDS_DIR, { recursive: true })
      await writeFile(join(RECORDS_DIR, `${record.id}.note.json`), JSON.stringify(record, null, 2) + '\n')
    } catch (error) {
      console.warn('could not write the note to disk:', error)
    }
  }
  return sendJson(res, 201, { kind: 'assistant.note.v1', id: record.id, written: record.written })
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
  if (req.method === 'POST' && req.url === '/api/note') {
    handleNote(req, res).catch((error) => {
      console.error('unhandled note error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected note failure.' })
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
