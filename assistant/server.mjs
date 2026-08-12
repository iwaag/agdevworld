// Minimal assistant service for agdevworld.
//
// POST /api/chat
//   { "messages": [...], "context": "<what is on screen>" }
//   -> { "reply": "...", "actions": [...], "run": {...} }
// GET /api/guide -> GUIDE.md as text/plain
//
// Stateless: the browser owns conversation history and sends it whole. One
// fresh harness process owns the complete bounded tool loop for one request.
// Server tools execute through the agdevworld MCP service; UI-only operations
// are returned as actions for the browser to apply after the run finishes.
//
// Every reply is recorded per devpolicy/agent_records.md as one JSON line on
// stdout (`assistant.run.v1`) and as a durable JSON file. The neighboring
// `.agent.jsonl` is the raw harness transcript (JSONL for OpenCode, one JSON
// envelope for Claude Code).
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

import { AgentConfigError, loadConfig, resolveRole } from './agent-config.mjs'
import { AgentRunError, composePrompt, runAgent } from './harness.mjs'
import {
  PROJECT_NAME,
  ProjectStartError,
  readGiteaConfig,
  readPlaneWorkspaceConfig,
  startProject,
} from './autolab-projects.mjs'
import { proxyPlaneRequest, readPlaneConfig } from './plane-passthrough.mjs'
import { ZulipError, ZulipSender, openForgeRequest, openMissionTopic } from './zulip.mjs'

const PORT = Number(process.env.PORT ?? 8091)
const ASSISTANT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = dirname(ASSISTANT_DIR)
const GUIDE_PATH = join(ASSISTANT_DIR, 'GUIDE.md')
const AGENTS_CONFIG = join(PROJECT_ROOT, 'agents.toml')
const AGENTS_LOCAL_CONFIG = join(PROJECT_ROOT, '.local', 'agents.local.toml')
const AGENT_TIMEOUT_MS = Number(process.env.AGDEVWORLD_AGENT_TIMEOUT_MS || 300_000)
const TOOL_BASE_URL = process.env.AGDEVWORLD_TOOL_BASE_URL || 'http://127.0.0.1:8090'
const PLANE_CONFIG = readPlaneConfig()
const GITEA_CONFIG = readGiteaConfig()
const PLANE_WORKSPACE_CONFIG = readPlaneWorkspaceConfig()

async function readGuide() {
  try {
    return await readFile(GUIDE_PATH, 'utf8')
  } catch (error) {
    console.warn('capability card unreadable:', error)
    return 'No capability card is installed on this assistant.'
  }
}

const ROLE_PROMPT = `You are the assistant inside agdevworld, an immersive development interface, and the human's conversational entrance to it.

Tools: fetch(path, method, body), wait(seconds), switch_view(view), show_image(url).

Paths reachable with fetch:
- /cluster/state.json, /cluster/workspaces.json, /cluster/actual.json — the live cluster snapshots (nctl drift, workspaces, actual with hardware facts). When a live one is absent the samples are /state.sample.json, /workspaces.sample.json, /actual.sample.json.
- /api/autolab/nodes — the autolab nodes this service is configured with, and whether each answers right now.
- /api/autolab/<node>/projects — projects, their current coding/director profiles, their sources, and the available profiles.
- /api/autolab/<node>/jobs, /api/autolab/<node>/jobs/<job>, /api/autolab/<node>/status — one node's autolab gateway.
- /api/autolab/<node>/jobs/<job>/summarize/<iter> — POST asks the node to summarize that iteration, GET reads the result; it takes about 15 seconds and may answer "pending".
- /api/autolab/<node>/window and /api/autolab/<node>/director — POST {"text":"..."} to a node's own conversational window, or to its director. The window is the node's entrance: asking it for work is how a mission gets started (it refuses while one is already running).
- /api/plane/issues and /api/plane/states — the default Plane project's task list and state vocabulary. /api/plane/projects/<project-uuid>/issues|states reaches any project by UUID (project starts return it). POST an issue with a state_name field; the server resolves it without exposing Plane credentials or live state IDs.
- To change a project's coding or director profile, read that node's /projects, ask its /window in ordinary words to make the change, then re-read /projects to confirm it. There is no direct settings-write route.
- /api/note — POST {"text":"..."} writes a note into this service's records; it is the one thing you can leave behind.
- /api/forge/requests — POST {"desire":"..."} starts an image generation on agforge; GET /api/forge/requests/<id> reads it back. It takes 20 to 105 seconds.
- /api/freeforge/requests — POST {"desire":"..."} posts the request as a fresh create-* topic in the #FreeForge Zulip channel; agforge answers in that topic where the Developer can watch. Returns {channel, topic, message_id}. POST /api/freeforge/resolve {"message_id":..., "topic":"..."} marks the topic resolved when the exchange is done.
- /api/autolab/projects — POST {"project":"<lowercase-hyphen name>","concept":"..."} starts a new autolab project: the autodev/<name> + <name>-direction Gitea repo pair (direction seeded), a fresh Plane project (its UUID and state ids are returned — mission briefings must carry them), and the standing #pj-<name> Zulip channel with every agent and the Developer subscribed. It creates no issue and starts no mission: development starts separately.
- /api/autolab/missions — POST {"project":"<name>","briefing":"..."} posts the briefing as a fresh mission-* topic in #pj-<name>; the autolab listener bridges it to a node window and reports the outcome in the same topic. Returns {channel, topic, message_id}. The briefing is the whole mission: include the goal, the repositories, and the Plane project/issue/state ids to report to. POST /api/autolab/missions/resolve {"message_id":..., "topic":"..."} marks the topic resolved when the mission's outcome is settled.
- /api/guide — the capability card below, raw.

The screen shows one view at a time: nodes, workspaces, autolab, tasks.

Budget: the complete agent run is bounded by the service timeout. Each wait or fetch tool call lasts at most 60 seconds. Whatever a path answers, including a refusal and its reason, is returned as-is; a path outside /api/ that does not exist answers 200 with this app's HTML rather than 404.`

// --- run records (devpolicy/agent_records.md) -------------------------------

const RECORDS_DIR = process.env.ASSISTANT_RECORDS_DIR || join(PROJECT_ROOT, '.local', 'assistant-records')

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
  if (value.role !== 'user' && value.role !== 'assistant') return false
  return typeof value.content === 'string'
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
      detail: 'messages must be a non-empty array of user or assistant messages.',
    })
  }

  const screen = typeof context === 'string' && context.trim() !== '' ? `\n\n${context}` : ''
  const system = `${ROLE_PROMPT}${screen}\n\n=== CAPABILITY CARD ===\n${await readGuide()}`

  const record = {
    id: randomUUID(),
    started: new Date().toISOString(),
    outcome: 'failed',
  }
  let answer
  try {
    const { config, overlay } = await loadConfig(AGENTS_CONFIG, AGENTS_LOCAL_CONFIG)
    const agent = await resolveRole(config, overlay, 'front')
    const transcriptPath = join(RECORDS_DIR, `${record.id}.agent.jsonl`)
    await mkdir(RECORDS_DIR, { recursive: true })
    answer = await runAgent({
      agent,
      prompt: composePrompt({ system, messages }),
      timeoutMs: AGENT_TIMEOUT_MS,
      transcriptPath,
      toolBaseUrl: TOOL_BASE_URL,
    })
  } catch (error) {
    if (!(error instanceof AgentConfigError) && !(error instanceof AgentRunError)) throw error
    if (error instanceof AgentRunError) Object.assign(record, error.meta)
    record.failure = error.message
    record.outcome = error.outcome ?? 'failed'
    await recordRun(record)
    return sendJson(res, 502, { error: 'assistant_offline', detail: error.message })
  }
  Object.assign(record, answer.meta)
  record.actions = answer.actions.map((action) => action.action)
  record.outcome = 'done'
  await recordRun(record)
  return sendJson(res, 200, {
    reply: answer.reply,
    actions: answer.actions,
    run: {
      id: record.id,
      role: record.role,
      profile: record.profile,
      harness: record.harness,
      provider: record.provider,
      model: record.model,
      outcome: record.outcome,
    },
  })
}

// The FreeForge workflow (zulip_channel_topic): the assistant's own Zulip
// account posts each desire as a fresh create-* topic in #FreeForge;
// agforge's listener answers in the topic. Unlike /api/forge/requests, the
// conversation is public — the Developer watches and searches it in Zulip.
let zulipSender
async function getZulipSender() {
  if (!zulipSender) zulipSender = await ZulipSender.fromEnvFile()
  return zulipSender
}

async function handleFreeForge(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  let parsed
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be JSON.' })
  }
  try {
    if (req.url === '/api/freeforge/requests') {
      const desire = parsed?.desire
      if (typeof desire !== 'string' || desire.trim() === '') {
        return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be {"desire": "..."}.' })
      }
      const opened = await openForgeRequest(await getZulipSender(), desire.trim())
      return sendJson(res, 201, { kind: 'freeforge.request.v1', ...opened })
    }
    if (req.url === '/api/freeforge/resolve') {
      const { message_id: messageId, topic } = parsed ?? {}
      if (!Number.isInteger(messageId) || typeof topic !== 'string' || topic === '') {
        return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be {"message_id": N, "topic": "..."}.' })
      }
      await (await getZulipSender()).resolveTopic(messageId, topic)
      return sendJson(res, 200, { kind: 'freeforge.resolve.v1', message_id: messageId })
    }
  } catch (error) {
    if (!(error instanceof ZulipError)) throw error
    console.error('zulip send failed:', error)
    return sendJson(res, 502, { error: 'zulip_unavailable', detail: error.message })
  }
  return sendJson(res, 404, { error: 'not_found' })
}

// The autolab project workflow trio (zulip_channel_topic2), mirroring the
// freeforge pair: project start provisions the standing pieces (Gitea repo
// pair, Plane project, #pj-<name> channel) and deliberately nothing else —
// no Plane issue, no mission, so prep and dev start stay separable. Missions
// are one disposable `mission-*` topic each in the project channel; the
// autolab listener reacts to the topic, nothing here talks to a node.
async function handleAutolabWorkflow(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  let parsed
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be JSON.' })
  }
  try {
    if (req.url === '/api/autolab/projects') {
      const { project, concept } = parsed ?? {}
      if (typeof project !== 'string' || !PROJECT_NAME.test(project)) {
        return sendJson(res, 400, {
          error: 'bad_request',
          detail: 'Body must be {"project": "<lowercase-hyphen name>", "concept": "..."}.',
        })
      }
      if (typeof concept !== 'string' || concept.trim() === '') {
        return sendJson(res, 400, { error: 'bad_request', detail: 'A non-empty "concept" is required.' })
      }
      const missing = [...GITEA_CONFIG.missing, ...PLANE_WORKSPACE_CONFIG.missing]
      if (missing.length > 0) {
        return sendJson(res, 503, {
          error: 'project_start_unconfigured',
          detail: `Missing configuration: ${missing.join(', ')}.`,
        })
      }
      const created = await startProject({ project, concept }, {
        gitea: GITEA_CONFIG,
        plane: PLANE_WORKSPACE_CONFIG,
        sender: await getZulipSender(),
      })
      return sendJson(res, 201, { kind: 'autolab.project.v1', project, ...created })
    }
    if (req.url === '/api/autolab/missions') {
      const { project, briefing } = parsed ?? {}
      if (typeof project !== 'string' || !PROJECT_NAME.test(project)
        || typeof briefing !== 'string' || briefing.trim() === '') {
        return sendJson(res, 400, {
          error: 'bad_request',
          detail: 'Body must be {"project": "<name>", "briefing": "..."}.',
        })
      }
      const opened = await openMissionTopic(await getZulipSender(), project, briefing.trim())
      return sendJson(res, 201, { kind: 'autolab.mission.v1', ...opened })
    }
    if (req.url === '/api/autolab/missions/resolve') {
      const { message_id: messageId, topic } = parsed ?? {}
      if (!Number.isInteger(messageId) || typeof topic !== 'string' || topic === '') {
        return sendJson(res, 400, { error: 'bad_request', detail: 'Body must be {"message_id": N, "topic": "..."}.' })
      }
      await (await getZulipSender()).resolveTopic(messageId, topic)
      return sendJson(res, 200, { kind: 'autolab.mission-resolve.v1', message_id: messageId })
    }
  } catch (error) {
    if (error instanceof ProjectStartError) {
      console.error('project start failed:', error)
      return sendJson(res, 502, { error: 'project_start_failed', step: error.step, detail: error.message })
    }
    if (error instanceof ZulipError) {
      console.error('zulip send failed:', error)
      return sendJson(res, 502, { error: 'zulip_unavailable', detail: error.message })
    }
    throw error
  }
  return sendJson(res, 404, { error: 'not_found' })
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

// Same-origin, project-scoped Plane passthrough. The API key never crosses
// this boundary, and callers cannot widen the configured workspace/project by
// putting identifiers in a URL. Human-readable state_name values are resolved
// against the running instance so environment-specific UUIDs stay out of the
// guide and browser.
async function handlePlane(req, res) {
  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req)
  let result
  try {
    result = await proxyPlaneRequest({
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'],
      body,
    }, PLANE_CONFIG)
  } catch (error) {
    console.error('Plane unreachable:', error)
    return sendJson(res, 502, {
      error: 'plane_offline',
      detail: 'The configured Plane service is unreachable.',
    })
  }
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.body.byteLength,
  })
  res.end(result.body)
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
  if (req.url?.startsWith('/api/freeforge/')) {
    handleFreeForge(req, res).catch((error) => {
      console.error('unhandled freeforge error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected FreeForge failure.' })
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
  if (req.url === '/api/autolab/projects' || req.url === '/api/autolab/missions'
    || req.url === '/api/autolab/missions/resolve') {
    handleAutolabWorkflow(req, res).catch((error) => {
      console.error('unhandled autolab workflow error:', error)
      sendJson(res, 500, { error: 'internal_error', detail: 'Unexpected autolab workflow failure.' })
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
  if (req.url?.startsWith('/api/plane/')) {
    handlePlane(req, res).catch((error) => {
      console.error('unhandled Plane passthrough error:', error)
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
  console.log(`assistant listening on :${PORT}; front resolves through agents.toml per request`)
})
