import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TOKEN_FILE = resolve(homedir(), '.local/state/cagent/human_token')
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

// One cagent request per artifact: sequential requests are simpler and more
// robust than teaching cagent to zip multiple files into one upload.
const ARTIFACTS = [
  {
    command: 'nctl drift --json',
    schema: 'nctl.drift.v1',
    outputEnv: 'CLUSTER_STATE_OUTPUT',
    defaultOutput: resolve(SCRIPT_DIR, '../public/cluster/state.json'),
    validate: validateDriftEnvelope,
  },
  {
    command: 'nctl workspaces --json',
    schema: 'nctl.workspaces.v1',
    outputEnv: 'CLUSTER_WORKSPACES_OUTPUT',
    defaultOutput: resolve(SCRIPT_DIR, '../public/cluster/workspaces.json'),
    validate: validateWorkspacesEnvelope,
  },
  {
    command: 'nctl actual --json --detail',
    schema: 'nctl.actual.v2',
    outputEnv: 'CLUSTER_ACTUAL_OUTPUT',
    defaultOutput: resolve(SCRIPT_DIR, '../public/cluster/actual.json'),
    validate: validateActualEnvelope,
  },
]

function artifactPrompt(command) {
  return `Please run \`${command}\`, save the output as a file, upload it with \`nctl upload\`, and reply with only the download URL.`
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function loadToken() {
  if (process.env.CAGENT_TOKEN?.trim()) return process.env.CAGENT_TOKEN.trim()

  const tokenFile = resolve(process.env.CAGENT_TOKEN_FILE ?? DEFAULT_TOKEN_FILE)
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim()
    if (token) return token
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  throw new Error(`No cagent token found; set CAGENT_TOKEN or CAGENT_TOKEN_FILE (checked ${tokenFile})`)
}

function request(url, { method = 'GET', headers = {}, body, redirects = 5 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const requestHeaders = body
      ? { ...headers, 'Content-Length': Buffer.byteLength(body) }
      : headers
    const req = transport.request(
      url,
      {
        method,
        headers: requestHeaders,
        rejectUnauthorized: process.env.CAGENT_TLS_REJECT_UNAUTHORIZED === '1',
      },
      (response) => {
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume()
          if (redirects === 0) {
            reject(new Error(`Too many redirects while downloading ${url.origin}`))
            return
          }
          const redirectUrl = new URL(response.headers.location, url)
          const redirectMethod = status === 303 ? 'GET' : method
          request(redirectUrl, {
            method: redirectMethod,
            headers: redirectMethod === 'GET' ? {} : headers,
            body: redirectMethod === 'GET' ? undefined : body,
            redirects: redirects - 1,
          }).then(resolvePromise, reject)
          return
        }

        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks)
          if (status < 200 || status >= 300) {
            reject(new Error(`${method} ${url.pathname} returned HTTP ${status}: ${responseBody.toString('utf8')}`))
            return
          }
          resolvePromise(responseBody)
        })
      },
    )
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${url.pathname} timed out`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function requestJson(url, options) {
  const body = await request(url, options)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error(`Expected JSON from ${url.pathname}`)
  }
}

function validateDriftEnvelope(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schema !== 'nctl.drift.v1' ||
    typeof value.ok !== 'boolean' ||
    value.data === null ||
    typeof value.data !== 'object' ||
    !Array.isArray(value.data.targets) ||
    value.data.summary === null ||
    typeof value.data.summary !== 'object'
  ) {
    throw new Error('Downloaded artifact is not a valid nctl.drift.v1 envelope')
  }
}

function validateWorkspacesEnvelope(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schema !== 'nctl.workspaces.v1' ||
    typeof value.ok !== 'boolean' ||
    value.data === null ||
    typeof value.data !== 'object' ||
    !Array.isArray(value.data.rows) ||
    value.data.summary === null ||
    typeof value.data.summary !== 'object'
  ) {
    throw new Error('Downloaded artifact is not a valid nctl.workspaces.v1 envelope')
  }
}

function validateActualEnvelope(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schema !== 'nctl.actual.v2' ||
    typeof value.ok !== 'boolean' ||
    value.data === null ||
    typeof value.data !== 'object' ||
    !Array.isArray(value.data.devices)
  ) {
    throw new Error('Downloaded artifact is not a valid nctl.actual.v2 envelope')
  }
}

function extractDownloadUrl(responseText) {
  const match = responseText.match(/https?:\/\/[^\s<>"']+/u)
  if (!match) throw new Error('Completed cagent response did not contain a download URL')
  return new URL(match[0].replace(/[),.\]}]+$/u, ''))
}

async function fetchArtifact(baseUrl, authHeaders, artifact) {
  const created = await requestJson(new URL('requests', baseUrl), {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ message: artifactPrompt(artifact.command) }),
  })
  if (!created.request_id) throw new Error('cagent did not return a request_id')

  console.log(`Submitted cagent request ${created.request_id} (${artifact.command})`)
  const deadline = Date.now() + positiveInteger('CAGENT_DEADLINE_SECONDS', 360) * 1000
  const pollMilliseconds = positiveInteger('CAGENT_POLL_SECONDS', 8) * 1000
  let result = created
  while (!TERMINAL_STATES.has(result.state)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for cagent request ${created.request_id}`)
    await sleep(pollMilliseconds)
    result = await requestJson(new URL(`requests/${encodeURIComponent(created.request_id)}`, baseUrl), {
      headers: authHeaders,
    })
    console.log(`cagent request ${created.request_id}: ${result.state}`)
  }

  if (result.state !== 'completed' || typeof result.response !== 'string') {
    throw new Error(`cagent request ended in ${result.state}: ${JSON.stringify(result.error ?? null)}`)
  }

  const downloadUrl = extractDownloadUrl(result.response)
  const downloaded = await request(downloadUrl)
  let envelope
  try {
    envelope = JSON.parse(downloaded.toString('utf8'))
  } catch {
    throw new Error('Downloaded artifact is not JSON')
  }
  artifact.validate(envelope)

  const output = resolve(process.env[artifact.outputEnv] ?? artifact.defaultOutput)
  const temporaryOutput = `${output}.tmp`
  await mkdir(dirname(output), { recursive: true })
  try {
    await writeFile(temporaryOutput, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryOutput, output)
  } catch (error) {
    await unlink(temporaryOutput).catch(() => {})
    throw error
  }
  console.log(`Saved validated ${envelope.schema} snapshot to ${output}`)
}

async function main() {
  const baseUrlValue = process.env.CAGENT_URL?.trim()
  if (!baseUrlValue) throw new Error('CAGENT_URL is required (for example, https://agstudio:8789)')

  const baseUrl = new URL(baseUrlValue.endsWith('/') ? baseUrlValue : `${baseUrlValue}/`)
  const token = await loadToken()
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  for (const artifact of ARTIFACTS) {
    await fetchArtifact(baseUrl, authHeaders, artifact)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
