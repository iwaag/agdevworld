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
const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, '')
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'glm-4.7-flash:latest'

const ROLE_PROMPT =
  'You are the assistant inside agdevworld, an immersive development interface. ' +
  'Answer questions about the cluster nodes described below, concisely and in plain text. ' +
  'If the answer is not in the cluster summary, say you do not know.'

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

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true })
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
