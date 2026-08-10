import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const OUTPUT_TAIL = 800

export class AgentRunError extends Error {
  constructor(message, meta = {}, outcome = 'failed') {
    super(message)
    this.name = 'AgentRunError'
    this.meta = meta
    this.outcome = outcome
  }
}

export function buildArgv(agent) {
  if (agent.harness === 'fake') return [agent.command]
  if (agent.harness !== 'opencode') throw new AgentRunError(`harness ${agent.harness} is not implemented by Phase 4`)
  return [agent.command, 'run', '--format', 'json', '-m', agent.model]
}

export function extractEventText(raw) {
  const texts = []
  let turns = 0
  let cost = 0
  let sawEvent = false
  const usage = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }
  for (const line of raw.split(/\r?\n/)) {
    let event
    try {
      event = line.trim().startsWith('{') ? JSON.parse(line) : null
    } catch {
      event = null
    }
    if (!event || typeof event !== 'object' || !('type' in event)) {
      if (line !== '') texts.push(line)
      continue
    }
    sawEvent = true
    const part = event.part && typeof event.part === 'object' ? event.part : {}
    if (event.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    if (event.type === 'step_finish') {
      turns += 1
      if (typeof part.cost === 'number') cost += part.cost
      const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : {}
      const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {}
      for (const key of ['input', 'output', 'reasoning']) if (Number.isInteger(tokens[key])) usage[key] += tokens[key]
      if (Number.isInteger(cache.read)) usage.cache_read += cache.read
      if (Number.isInteger(cache.write)) usage.cache_write += cache.write
    }
  }
  return {
    text: texts.join('\n').trim(),
    stats: sawEvent ? { num_turns: turns, cost_usd: Number(cost.toFixed(6)), usage } : {},
  }
}

export function composePrompt({ system, messages }) {
  const history = messages
    .map((message) => `${message.role === 'assistant' ? 'ASSISTANT' : 'USER'}:\n${message.content ?? ''}`)
    .join('\n\n')
  return `${system}\n\n=== CONVERSATION SUPPLIED BY THE BROWSER ===\n${history}\n\nAnswer the latest USER message. Use the agdevworld tools whenever the request needs current state or a UI action.`
}

async function readActions(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function runAgent({ agent, prompt, timeoutMs, transcriptPath, toolBaseUrl }) {
  const argv = buildArgv(agent)
  const meta = {
    role: agent.role,
    profile: agent.profile,
    harness: agent.harness,
    provider: agent.provider,
    model: agent.model,
  }
  const runTemp = await mkdtemp(join(tmpdir(), 'agdevworld-agent-'))
  const actionsPath = join(runTemp, 'actions.jsonl')
  const started = performance.now()
  let stdout = ''
  let stderr = ''
  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        NO_COLOR: '1',
        AGENT_PROVIDER_OLLAMA_BASE_URL: agent.providerBaseUrl ?? '',
        AGDEVWORLD_TOOL_BASE_URL: toolBaseUrl,
        AGDEVWORLD_ACTIONS_FILE: actionsPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.end(prompt)
    const result = await new Promise((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 1000).unref()
      }, timeoutMs)
      child.once('error', reject)
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, timedOut })
      })
    })
    meta.duration_ms = Math.round(performance.now() - started)
    const raw = stdout.replace(ANSI, '')
    if (transcriptPath && raw.trim()) await writeFile(transcriptPath, raw)
    if (result.timedOut) throw new AgentRunError(`agent run timed out after ${Math.round(timeoutMs / 1000)}s`, meta, 'aborted')
    const extracted = agent.harness === 'opencode' ? extractEventText(raw) : { text: raw.trim(), stats: {} }
    Object.assign(meta, extracted.stats)
    if (result.code !== 0) {
      const tail = (stderr.replace(ANSI, '').trim() || extracted.text || 'no output').slice(-OUTPUT_TAIL)
      throw new AgentRunError(`agent exited ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${tail}`, meta)
    }
    if (!extracted.text) throw new AgentRunError('agent produced no text', meta)
    return { reply: extracted.text, actions: await readActions(actionsPath), meta }
  } catch (error) {
    if (error instanceof AgentRunError) throw error
    meta.duration_ms = Math.round(performance.now() - started)
    throw new AgentRunError(`could not launch agent (${argv[0]}): ${error.message}`, meta)
  } finally {
    await rm(runTemp, { recursive: true, force: true })
  }
}
