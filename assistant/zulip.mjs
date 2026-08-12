// Zulip sender for the FreeForge workflow (zulip_channel_topic episode).
//
// The assistant posts each production request as its own `create-*` topic in
// the standing #FreeForge channel, and later resolves the topic. agforge's
// listener answers in the same topic, so the whole exchange is browsable and
// searchable by the Developer — the thing agent-to-agent DMs could never be.
// Topic-per-request, not channel-per-request: agents filter by topic rules in
// their own listeners, so channel subscribers who don't care never react.
//
// #FreeForge itself is standing infrastructure (participants: Forge,
// Devworld Assistant, Developer), created once — not by this module.
//
// Credentials are the mounted /run/secrets/zulip.env (ZULIP_URL, ZULIP_EMAIL,
// ZULIP_API_KEY). The realm's certificate is self-signed, so verification is
// disabled per-request here rather than process-wide.

import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

export const ZULIP_ENV_PATH = process.env.ZULIP_ENV_PATH || '/run/secrets/zulip.env'

export const FREEFORGE_CHANNEL = process.env.ZULIP_FREEFORGE_CHANNEL || 'FreeForge'
export const RESOLVED_TOPIC_PREFIX = '✔ ' // Zulip's "✔ " resolved marker

export function parseEnv(text) {
  const env = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at === -1) continue
    env[trimmed.slice(0, at)] = trimmed.slice(at + 1).replace(/^['"]|['"]$/g, '')
  }
  return env
}

export class ZulipError extends Error {}

export class ZulipSender {
  constructor({ url, email, apiKey }) {
    this.base = url.replace(/\/$/, '')
    this.auth = Buffer.from(`${email}:${apiKey}`).toString('base64')
  }

  static async fromEnvFile(path = ZULIP_ENV_PATH) {
    let env
    try {
      env = parseEnv(await readFile(path, 'utf8'))
    } catch (error) {
      throw new ZulipError(`no Zulip credentials at ${path}: ${error.message}`)
    }
    for (const key of ['ZULIP_URL', 'ZULIP_EMAIL', 'ZULIP_API_KEY']) {
      if (!env[key]) throw new ZulipError(`${path} is missing ${key}`)
    }
    return new ZulipSender({ url: env.ZULIP_URL, email: env.ZULIP_EMAIL, apiKey: env.ZULIP_API_KEY })
  }

  // One retry on a socket-level failure: the first call right after a
  // container start has been seen to lose its TLS socket while Zulip itself
  // was fine. HTTP-level errors are not retried.
  async call(method, path, params = {}) {
    try {
      return await this._call(method, path, params)
    } catch (error) {
      if (!(error instanceof ZulipError) || /HTTP \d/.test(error.message)) throw error
      return this._call(method, path, params)
    }
  }

  // Form-encoded call via node:http(s) — fetch/undici cannot skip
  // verification for one self-signed host without a custom dispatcher.
  _call(method, path, params = {}) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
    const url = new URL(`${this.base}/api/v1/${path.replace(/^\//, '')}`)
    const hasBody = method !== 'GET'
    if (!hasBody && form.size > 0) url.search = form.toString()
    const body = hasBody ? form.toString() : null
    const doRequest = url.protocol === 'http:' ? httpRequest : httpsRequest
    return new Promise((resolve, reject) => {
      const req = doRequest(
        url,
        {
          method,
          rejectUnauthorized: false,
          timeout: 30_000,
          headers: {
            authorization: `Basic ${this.auth}`,
            ...(body === null ? {} : {
              'content-type': 'application/x-www-form-urlencoded',
              'content-length': Buffer.byteLength(body),
            }),
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed
            try {
              parsed = JSON.parse(text)
            } catch {
              return reject(new ZulipError(`${method} ${path} -> HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
            }
            if (res.statusCode >= 400 || parsed.result === 'error') {
              return reject(new ZulipError(`${method} ${path} -> HTTP ${res.statusCode}: ${parsed.msg ?? text.slice(0, 200)}`))
            }
            resolve(parsed)
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', (error) => reject(new ZulipError(`${method} ${path} -> ${error.message}`)))
      if (body !== null) req.end(body)
      else req.end()
    })
  }

  async sendToChannel(channel, topic, content) {
    const result = await this.call('POST', 'messages', { type: 'stream', to: channel, topic, content })
    return Number(result.id)
  }

  async resolveTopic(messageId, topic) {
    if (topic.startsWith(RESOLVED_TOPIC_PREFIX)) return
    await this.call('PATCH', `messages/${messageId}`, {
      topic: `${RESOLVED_TOPIC_PREFIX}${topic}`,
      propagate_mode: 'change_all',
      send_notification_to_new_thread: false,
    })
  }
}

export function requestTopicName(now = new Date(), randomHex) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `create-${stamp}-${randomHex}`
}

// The whole send side of the workflow: one message opening a fresh `create-*`
// topic in #FreeForge. The topic list is its own index — no announcement
// message needed. Returns what a caller needs to watch and to resolve.
export async function openForgeRequest(sender, desire) {
  const topic = requestTopicName(new Date(), Math.random().toString(16).slice(2, 8))
  const messageId = await sender.sendToChannel(FREEFORGE_CHANNEL, topic, desire)
  return { channel: FREEFORGE_CHANNEL, topic, message_id: messageId }
}
