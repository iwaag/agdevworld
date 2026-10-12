// The review screen's explanation (p7, docs/presentations.md): a safe
// Markdown subset rendered to HTML on the server. Headings, paragraphs,
// lists, emphasis, inline code, fenced code and links; everything else is
// text. Raw HTML is escaped, and a link is kept only when its target is
// http(s) or a relative path that stays inside the presentation.

export const MANIFEST_KIND = 'ag.wfe-presentation.v1'

export const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// A link target the review may use, or null: http and https URLs, or a
// relative path without "..", a scheme or a leading slash.
export function safeHref(raw: string): string | null {
  const t = raw.trim()
  if (/^https?:\/\/[^\s<>"']+$/i.test(t)) {
    try { const u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null } catch { return null }
  }
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('\\') || t.includes('\\')) return null
  const path = t.split(/[?#]/)[0]
  if (path.split('/').some(seg => seg === '..')) return null
  return t
}

// Inline spans of one line of already-split text.
function inline(text: string): string {
  const out: string[] = []
  let rest = text
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/
  for (;;) {
    const m = pattern.exec(rest)
    if (!m) { out.push(escapeHtml(rest)); break }
    out.push(escapeHtml(rest.slice(0, m.index)))
    if (m[1] !== undefined) out.push(`<code>${escapeHtml(m[1])}</code>`)
    else if (m[2] !== undefined) out.push(`<strong>${inline(m[2])}</strong>`)
    else if (m[3] !== undefined) out.push(`<em>${inline(m[3])}</em>`)
    else {
      const href = safeHref(m[5])
      out.push(href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inline(m[4])}</a>` : `${escapeHtml(m[4])} (${escapeHtml(m[5])})`)
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out.join('')
}

export function renderReview(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] } }
  const flushList = () => { if (list) { const tag = list.ordered ? 'ol' : 'ul'; html.push(`<${tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${tag}>`); list = null } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```/.exec(line)
    if (fence) {
      flushPara(); flushList()
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { flushPara(); flushList(); const n = Math.min(6, heading[1].length + 1); html.push(`<h${n}>${inline(heading[2].trim())}</h${n}>`); continue }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      flushPara()
      const ordered = item[2] !== undefined
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(item[3])
      continue
    }
    if (!line.trim()) { flushPara(); flushList(); continue }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue }
    flushList()
    para.push(line.trim())
  }
  flushPara(); flushList()
  return html.join('\n')
}
