// The integration's configuration (README.md, "Configuration"): an ignored
// JSON file beside its store. Tokens never leave this file and the process.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface Config {
  appToken: string // xapp-…, connections:write (Socket Mode)
  botToken: string // xoxb-…, the bot's scopes (manifest.yaml)
  developer: string // the one Slack member whose words are the configured person's
  team: string | null // the workspace; null: the bot token's own (auth.test)
  wfe: string // the WFE service, e.g. http://localhost:8098/
  linkBase: string // where the Developer's phone reaches WFE (run views), e.g. the tailnet name
  linkMap: Record<string, string> // origins in reply text mapped to phone-reachable ones
  target: string // the WFE destination of every new conversation, <workspace>/<workflow> (workflow_editor p15)
  conversationUrl: string // where a conversation opens in a browser, {conv} replaced by its id (aghangout)
  trialAuthor: string // who trial messages are recorded as (never the Developer)
  store: string // the transport store (SQLite)
}

export class ConfigError extends Error {}

export function loadConfig(file: string): Config {
  let o: Record<string, unknown>
  try { o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch (e) { throw new ConfigError(`${file} cannot be read: ${(e as Error).message}`) }
  const problems: string[] = []
  const str = (k: string, test: RegExp, what: string): string => {
    const v = o[k]
    if (typeof v !== 'string' || !test.test(v) || v.includes('PASTE')) { problems.push(`${k}: ${what}`); return '' }
    return v
  }
  const url = (k: string, fallback?: string): string => {
    const v = o[k] ?? fallback
    try { return new URL(String(v)).toString() } catch { problems.push(`${k}: an absolute URL`); return '' }
  }
  const appToken = str('appToken', /^xapp-[A-Za-z0-9-]{20,}$/, 'the app-level token (xapp-…, connections:write)')
  const botToken = str('botToken', /^xoxb-[A-Za-z0-9-]{20,}$/, 'the Bot User OAuth Token (xoxb-…)')
  const developer = str('developer', /^[UW][A-Z0-9]{6,}$/, 'the Developer\'s Slack member ID (U…)')
  const team = o.team === undefined || o.team === null ? null : str('team', /^T[A-Z0-9]{6,}$/, 'a workspace ID (T…)')
  const wfe = url('wfe', 'http://localhost:8098/')
  const linkBase = url('linkBase')
  const linkMap: Record<string, string> = {}
  for (const [from, to] of Object.entries((o.linkMap ?? {}) as Record<string, unknown>)) {
    try { linkMap[new URL(from).origin] = new URL(String(to)).origin } catch { problems.push(`linkMap: ${from} → ${String(to)} is not origin → origin`) }
  }
  const target = str('target', /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/, 'the destination of new conversations, <workspace>/<workflow> (e.g. front/converse)')
  const conversationUrl = typeof o.conversationUrl === 'string' ? o.conversationUrl : linkBase ? `${new URL(linkBase).origin}/hangout/?conv={conv}` : ''
  if (conversationUrl && !conversationUrl.includes('{conv}')) problems.push('conversationUrl: a URL with {conv} where the conversation id goes')
  const trialAuthor = typeof o.trialAuthor === 'string' && o.trialAuthor.trim() ? o.trialAuthor.trim() : 'Omni Agent (for Developer)'
  if (problems.length) throw new ConfigError(`${file}:\n  ${problems.join('\n  ')}`)
  const store = typeof o.store === 'string' ? resolve(dirname(file), o.store) : join(dirname(file), 'slack.sqlite')
  return { appToken, botToken, developer, team, wfe, linkBase, linkMap, target, conversationUrl, trialAuthor, store }
}
