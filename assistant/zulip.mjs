// Zulip sender for the FreeForge workflow (zulip_channel_topic episode).
//
// The assistant opens a per-request `create-*` channel, announces it in
// #FreeForge, posts the production request there, and later resolves the
// topic. agforge's listener answers in the same topic, so the whole exchange
// is browsable and searchable by the Developer — the thing agent-to-agent DMs
// could never be.
//
// Credentials are the mounted /run/secrets/zulip.env (ZULIP_URL, ZULIP_EMAIL,
// ZULIP_API_KEY). The realm's certificate is self-signed, so verification is
// disabled per-request here rather than process-wide.

import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

export const ZULIP_ENV_PATH = process.env.ZULIP_ENV_PATH || '/run/secrets/zulip.env'

// Realm user ids (this realm hides emails, everything keys on ids).
export const FORGE_USER_ID = Number(process.env.ZULIP_FORGE_USER_ID || 13)
export const DEVELOPER_USER_ID = Number(process.env.ZULIP_DEVELOPER_USER_ID || 8)

export const FREEFORGE_CHANNEL = process.env.ZULIP_FREEFORGE_CHANNEL || 'FreeForge'
export const REQUEST_TOPIC = 'request'
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

  async selfId() {
    if (this._selfId === undefined) this._selfId = Number((await this.call('GET', 'users/me')).user_id)
    return this._selfId
  }

  async createChannel(name, description, principals) {
    return this.call('POST', 'users/me/subscriptions', {
      subscriptions: [{ name, description }],
      principals,
      announce: false,
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

export function requestChannelName(now = new Date(), randomHex) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `create-${stamp}-${randomHex}`
}

// The whole send side of the workflow, one call: open the channel, announce
// it, post the desire. Returns what a caller needs to watch and to resolve.
export async function openForgeRequest(sender, desire) {
  const name = requestChannelName(new Date(), Math.random().toString(16).slice(2, 8))
  const principals = [FORGE_USER_ID, DEVELOPER_USER_ID, await sender.selfId()]
  await sender.createChannel(name, 'One-off agforge request (opened by the devworld assistant).', principals)
  await sender.sendToChannel(FREEFORGE_CHANNEL, 'requests', `Opened #**${name}** for a new request.`)
  const messageId = await sender.sendToChannel(name, REQUEST_TOPIC, desire)
  return { channel: name, topic: REQUEST_TOPIC, message_id: messageId }
}
