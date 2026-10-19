// Text between Slack and WFE (README.md, "Presentation"). Inbound: Slack's
// markup reduced to the plain text a person typed (the raw event stays in the
// inbox). Outbound: Front's Markdown as Slack mrkdwn, split deterministically,
// with links that open from the phone.

// Slack's escaped text as the person wrote it: entities unescaped, links and
// mentions spelled out.
export function slackToPlain(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => label === url || `mailto:${label}` === url ? label : `${label} (${url})`)
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, name?: string) => `@${name ?? id}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name?: string) => name ?? '@group')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A URL from WFE or Front, reachable from the phone: an origin listed in the
// map (the LAN name of the same service) is replaced by its mapped origin.
export function phoneUrl(url: string, map: Record<string, string>): string {
  try {
    const u = new URL(url)
    const to = map[u.origin]
    return to ? to + url.slice(u.origin.length) : url
  } catch { return url }
}

// Front's Markdown as Slack mrkdwn. Code spans and fences are kept as they
// are; outside them: headings and **bold** become *bold*, [label](url) a
// Slack link, list markers bullets, and bare URLs are mapped for the phone.
export function markdownToMrkdwn(md: string, map: Record<string, string> = {}): string {
  const out: string[] = []
  let fence = false
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; out.push(line.trim().startsWith('```') ? '```' : line); continue }
    if (fence) { out.push(escape(line)); continue }
    out.push(inline(line, map))
  }
  if (fence) out.push('```')
  return out.join('\n')
}

function inline(line: string, map: Record<string, string>): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) return `*${inline(heading[2], map).replace(/\*/g, '')}*`
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (bullet) return `${bullet[1]}• ${inline(bullet[2], map)}`
  // Split off code spans; convert the rest.
  return line.split(/(`[^`]+`)/).map(part => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return part
    const links: string[] = []
    const hold = (s: string) => `\u0000${links.push(s) - 1}\u0000`
    let s = part
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => hold(`<${phoneUrl(url, map)}|${escape(label).replace(/\|/g, '/')}>`))
      .replace(/<?(https?:\/\/[^\s<>)]+)>?/g, (_m, url: string) => hold(`<${phoneUrl(url, map)}>`))
    s = escape(s)
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '*$1*')
      .replace(/~~([^~]+)~~/g, '~$1~')
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)])
  }).join('')
}

// Plain text for Slack (a mirrored Front Desk message: the person's own
// words, shown as they were typed).
export const plainForSlack = (text: string) => escape(text)

export const MAX_CHUNK = 3500

// A long text as numbered parts, cut at paragraph, then line, then character
// boundaries; a part that ends inside a code fence closes it and the next
// reopens it. The same text always gives the same parts.
export function chunk(text: string, max = MAX_CHUNK): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  let reopen = false
  const budget = max - 8 // room for a closing/opening fence
  while (rest.length) {
    let head = reopen ? '```\n' : ''
    if (head.length + rest.length <= max) { parts.push(head + rest); break }
    const room = budget - head.length
    let cut = rest.lastIndexOf('\n\n', room)
    if (cut < room / 2) cut = rest.lastIndexOf('\n', room)
    if (cut < room / 2) cut = room
    const piece = rest.slice(0, cut)
    rest = rest.slice(cut).replace(/^\n+/, '')
    head += piece
    const open: boolean = ((reopen ? 1 : 0) + (piece.match(/^```/gm)?.length ?? 0)) % 2 === 1
    parts.push(open ? `${head}\n\`\`\`` : head)
    reopen = open
  }
  return parts
}
