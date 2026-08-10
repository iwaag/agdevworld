import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join, parse, sep } from 'node:path'
import { homedir } from 'node:os'

export const SCHEMA = 'ag.agent-config.v1'
const HARNESSES = new Set(['opencode', 'claude_code', 'fake'])
const INTRINSIC = {
  opencode: new Set(['agentic_tools', 'workspace_fs']),
  claude_code: new Set(['agentic_tools', 'workspace_fs']),
  fake: new Set(),
}
const MODEL_ID = /^[a-z0-9_-]+\/[^/\s]+$/

export class AgentConfigError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'AgentConfigError'
    this.code = code
  }
}

function splitDotted(value) {
  const parts = []
  let part = ''
  let quoted = false
  for (const char of value) {
    if (char === '"') quoted = !quoted
    else if (char === '.' && !quoted) {
      parts.push(part)
      part = ''
    } else part += char
  }
  if (quoted) throw new Error('unterminated quoted table key')
  parts.push(part)
  if (parts.some((item) => item === '')) throw new Error('empty table key')
  return parts
}

function parseValue(raw) {
  const value = raw.trim()
  if (value.startsWith('"')) return JSON.parse(value)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    const items = []
    let current = ''
    let quoted = false
    for (const char of inner) {
      if (char === '"') quoted = !quoted
      current += char
      if (char === ',' && !quoted) {
        items.push(parseValue(current.slice(0, -1)))
        current = ''
      }
    }
    if (quoted) throw new Error('unterminated array string')
    items.push(parseValue(current))
    return items
  }
  throw new Error(`unsupported TOML value: ${value}`)
}

export function parseToml(text) {
  const root = {}
  let table = root
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    let line = ''
    let quoted = false
    for (const char of source) {
      if (char === '"') quoted = !quoted
      if (char === '#' && !quoted) break
      line += char
    }
    line = line.trim()
    if (line === '') continue
    if (line.startsWith('[') && line.endsWith(']')) {
      table = root
      for (const key of splitDotted(line.slice(1, -1).trim())) {
        if (table[key] === undefined) table[key] = {}
        if (table[key] === null || typeof table[key] !== 'object' || Array.isArray(table[key])) {
          throw new Error(`line ${index + 1}: table conflicts with value`)
        }
        table = table[key]
      }
      continue
    }
    const equals = line.indexOf('=')
    if (equals < 1) throw new Error(`line ${index + 1}: expected key = value`)
    const key = line.slice(0, equals).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`line ${index + 1}: invalid key`)
    table[key] = parseValue(line.slice(equals + 1))
  }
  return root
}

function object(value, key) {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentConfigError('E_SCHEMA', `${key} must be a table`)
  }
  return value
}

function strings(value, key) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AgentConfigError('E_SCHEMA', `${key} must be an array of strings`)
  }
  return value
}

async function readToml(path, required) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return {}
    throw new AgentConfigError('E_SCHEMA', `cannot read ${path}: ${error.message}`)
  }
  let value
  try {
    value = parseToml(text)
  } catch (error) {
    throw new AgentConfigError('E_SCHEMA', `cannot parse ${path}: ${error.message}`)
  }
  if (value.schema !== SCHEMA) throw new AgentConfigError('E_SCHEMA', `${path} must declare schema = ${SCHEMA}`)
  return value
}

function validateCommitted(config) {
  const models = object(config.models, 'models')
  const profiles = object(config.profiles, 'profiles')
  const roles = object(config.roles, 'roles')
  for (const [model, options] of Object.entries(models)) {
    if (!MODEL_ID.test(model)) throw new AgentConfigError('E_BAD_MODEL_ID', `malformed model ID ${model}`)
    object(options, `models.${model}`)
  }
  for (const [name, profileValue] of Object.entries(profiles)) {
    const profile = object(profileValue, `profiles.${name}`)
    if (!HARNESSES.has(profile.harness)) throw new AgentConfigError('E_UNKNOWN_HARNESS', `profile ${name}: ${profile.harness}`)
    if (typeof profile.model !== 'string' || !MODEL_ID.test(profile.model)) {
      throw new AgentConfigError('E_BAD_MODEL_ID', `profile ${name}: malformed model ${profile.model}`)
    }
    if (!(profile.model in models)) throw new AgentConfigError('E_UNKNOWN_MODEL', `profile ${name}: undeclared model ${profile.model}`)
    if (profile.harness === 'claude_code' && !profile.model.startsWith('anthropic/')) {
      throw new AgentConfigError('E_INCOMPATIBLE', `profile ${name}: claude_code cannot serve ${profile.model}`)
    }
  }
  for (const [name, roleValue] of Object.entries(roles)) {
    const role = object(roleValue, `roles.${name}`)
    if (!(role.profile in profiles)) throw new AgentConfigError('E_UNKNOWN_PROFILE', `role ${name}: unknown profile ${role.profile}`)
    strings(role.requires, `roles.${name}.requires`)
  }
  strings(object(config.capabilities, 'capabilities').provides, 'capabilities.provides')
}

function validateOverlay(overlay) {
  if (Object.keys(overlay).length === 0) return
  const extras = Object.keys(overlay).filter((key) => !['schema', 'local', 'roles', 'capabilities'].includes(key))
  if (extras.length) throw new AgentConfigError('E_OVERLAY_SCOPE', `overlay keys not allowed: ${extras}`)
  const local = object(overlay.local, 'local')
  const localExtras = Object.keys(local).filter((key) => !['harness', 'provider', 'secrets'].includes(key))
  if (localExtras.length) throw new AgentConfigError('E_OVERLAY_SCOPE', `overlay local keys not allowed: ${localExtras}`)
  for (const [name, factsValue] of Object.entries(object(local.harness, 'local.harness'))) {
    if (!HARNESSES.has(name)) throw new AgentConfigError('E_UNKNOWN_HARNESS', `unknown harness ${name}`)
    const facts = object(factsValue, `local.harness.${name}`)
    if (Object.keys(facts).some((key) => !['command', 'command_glob'].includes(key)) || Boolean(facts.command) === Boolean(facts.command_glob)) {
      throw new AgentConfigError('E_OVERLAY_SCOPE', `local.harness.${name} must set exactly one command source`)
    }
  }
  for (const [name, factsValue] of Object.entries(object(local.provider, 'local.provider'))) {
    const facts = object(factsValue, `local.provider.${name}`)
    if (Object.keys(facts).some((key) => key !== 'base_url')) throw new AgentConfigError('E_OVERLAY_SCOPE', `invalid local.provider.${name} keys`)
  }
  for (const [key, value] of Object.entries(object(local.secrets, 'local.secrets'))) {
    if (!key.endsWith('_file') && !key.endsWith('_env')) throw new AgentConfigError('E_SECRET_VALUE', `secret ${key} must be a reference`)
    if (typeof value !== 'string') throw new AgentConfigError('E_SECRET_VALUE', `secret reference ${key} must be a string`)
  }
  for (const [name, value] of Object.entries(object(overlay.roles, 'roles'))) {
    const role = object(value, `roles.${name}`)
    if (Object.keys(role).length !== 1 || typeof role.profile !== 'string') throw new AgentConfigError('E_OVERLAY_SCOPE', `role override ${name} may only set profile`)
  }
  const capabilities = object(overlay.capabilities, 'capabilities')
  if (Object.keys(capabilities).some((key) => key !== 'provides')) throw new AgentConfigError('E_OVERLAY_SCOPE', 'overlay capabilities may only set provides')
  strings(capabilities.provides, 'capabilities.provides')
}

export async function loadConfig(committedPath, overlayPath) {
  const config = await readToml(committedPath, true)
  const overlay = overlayPath ? await readToml(overlayPath, false) : {}
  validateCommitted(config)
  validateOverlay(overlay)
  return { config, overlay }
}

function expandHome(value) {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

function globPattern(value) {
  return new RegExp(`^${value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`)
}

async function expandGlob(pattern) {
  const { root } = parse(pattern)
  let candidates = [root || '.']
  for (const part of pattern.slice(root.length).split(sep).filter(Boolean)) {
    if (!part.includes('*') && !part.includes('?')) {
      candidates = candidates.map((base) => join(base, part))
      continue
    }
    const matcher = globPattern(part)
    const next = []
    for (const base of candidates) {
      try {
        next.push(...(await readdir(base)).filter((name) => matcher.test(name)).map((name) => join(base, name)))
      } catch {}
    }
    candidates = next
  }
  return candidates
}

async function resolveCommand(harness, overlay, checkAvailable) {
  const facts = object(object(object(overlay.local, 'local').harness, 'local.harness')[harness], `local.harness.${harness}`)
  let configured = facts.command
  if (!configured && facts.command_glob) {
    const pattern = expandHome(facts.command_glob)
    const candidates = await expandGlob(pattern)
    if (candidates.length) {
      const times = await Promise.all(candidates.map(async (candidate) => [candidate, (await stat(candidate)).mtimeMs]))
      configured = times.sort((left, right) => right[1] - left[1])[0][0]
    }
    if (!configured && checkAvailable) {
      throw new AgentConfigError('E_UNAVAILABLE', `command_glob matched no executable: ${facts.command_glob}`)
    }
  }
  const command = expandHome(configured || ({ opencode: 'opencode', claude_code: 'claude' }[harness] ?? ''))
  let resolved = command
  if (command && !isAbsolute(command)) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(dir, command)
      try {
        await access(candidate, constants.X_OK)
        resolved = candidate
        break
      } catch {}
    }
  }
  if (checkAvailable) {
    try {
      const info = await stat(resolved)
      await access(resolved, constants.X_OK)
      if (!info.isFile()) throw new Error('not a file')
    } catch {
      throw new AgentConfigError('E_UNAVAILABLE', `executable for ${harness} is unavailable: ${command}`)
    }
  }
  return resolved
}

export async function resolveRole(config, overlay, roleName, { checkAvailable = true } = {}) {
  const roles = object(config.roles, 'roles')
  if (!(roleName in roles)) throw new AgentConfigError('E_UNKNOWN_PROFILE', `unknown role ${roleName}`)
  const overlayRoles = object(overlay.roles, 'roles')
  if (Object.keys(overlayRoles).some((name) => !(name in roles))) throw new AgentConfigError('E_OVERLAY_SCOPE', 'overlay may not introduce roles')
  const profileName = overlayRoles[roleName]?.profile ?? roles[roleName].profile
  const profiles = object(config.profiles, 'profiles')
  if (!(profileName in profiles)) throw new AgentConfigError('E_UNKNOWN_PROFILE', `unknown profile ${profileName}`)
  const { harness, model } = profiles[profileName]
  const provided = new Set([
    ...strings(object(config.capabilities, 'capabilities').provides, 'provides'),
    ...strings(object(overlay.capabilities, 'capabilities').provides, 'provides'),
    ...INTRINSIC[harness],
  ])
  const missing = strings(roles[roleName].requires, `roles.${roleName}.requires`).filter((item) => !provided.has(item))
  if (missing.length) throw new AgentConfigError('E_CAPABILITY_UNMET', `role ${roleName} lacks ${missing.join(', ')}`)
  const provider = model.split('/', 1)[0]
  const providerBaseUrl = object(object(object(overlay.local, 'local').provider, 'local.provider')[provider], `local.provider.${provider}`).base_url
  if (checkAvailable && harness === 'opencode' && provider === 'ollama' && !providerBaseUrl) {
    throw new AgentConfigError('E_UNAVAILABLE', 'local.provider.ollama.base_url is required by agdevworld OpenCode')
  }
  return {
    role: roleName,
    profile: profileName,
    harness,
    provider,
    model,
    modelOptions: { ...object(config.models, 'models')[model] },
    command: await resolveCommand(harness, overlay, checkAvailable),
    providerBaseUrl,
  }
}
