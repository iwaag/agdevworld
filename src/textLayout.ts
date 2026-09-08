// Grapheme-safe wrapping and pagination for Phaser text.
//
// Phaser's own `wordWrap` splits an over-long "word" character by character
// with `split('')`, which is per UTF-16 code unit: a Japanese sentence is one
// word to it (no spaces), and an emoji is two units, so a reply in the Front
// Desk voice — Japanese, with emoji every few characters — is exactly the text
// it breaks in half. The wrap is done here instead, with `Intl.Segmenter`:
// words where the language has them, graphemes when a word is wider than the
// line, and never inside a grapheme. The result is handed to Phaser as
// explicit lines, with word wrap off.

export interface Measure {
  (text: string): number
}

const words = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : undefined
const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

export function graphemesOf(text: string): string[] {
  if (graphemes) return Array.from(graphemes.segment(text), (s) => s.segment)
  return Array.from(text)
}

function wordsOf(text: string): string[] {
  if (words) return Array.from(words.segment(text), (s) => s.segment)
  return text.split(/(\s+)/).filter((s) => s !== '')
}

// Characters a line should not start with (Japanese kinsoku, the common few).
const NO_LINE_START = new Set('、。，．）」』】〕〉》〗〙〟｝］’”!?！？:;：；…ー〜～'.split(''))

// Wrap one paragraph (no newlines) into lines no wider than `maxWidth`.
function wrapParagraph(paragraph: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = []
  let line = ''
  const push = (piece: string) => {
    if (piece === '') return
    const candidate = line + piece
    if (line === '' || measure(candidate) <= maxWidth) {
      line = candidate
      return
    }
    // A break is owed. Whitespace at a break is dropped rather than carried.
    if (/^\s+$/.test(piece)) { lines.push(line); line = ''; return }
    if (NO_LINE_START.has(piece) && line !== '') {
      // Pull the last grapheme of the line down with it so the punctuation
      // never starts a line — unless the line is that one grapheme.
      const parts = graphemesOf(line)
      if (parts.length > 1) {
        const last = parts.pop()!
        lines.push(parts.join(''))
        line = last + piece
        return
      }
    }
    lines.push(line)
    line = piece
  }
  for (const word of wordsOf(paragraph)) {
    if (measure(word) <= maxWidth) {
      push(word)
      continue
    }
    // Wider than a whole line on its own: place it grapheme by grapheme.
    for (const grapheme of graphemesOf(word)) push(grapheme)
  }
  if (line !== '' || lines.length === 0) lines.push(line.replace(/\s+$/, ''))
  return lines
}

export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    out.push(...wrapParagraph(paragraph, Math.max(1, maxWidth), measure))
  }
  return out
}

export function paginate(lines: string[], linesPerPage: number): string[][] {
  const per = Math.max(1, Math.floor(linesPerPage))
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per))
  return pages.length > 0 ? pages : [[]]
}

// Every http(s) URL in a post, in order, with a markdown link's own label
// when it has one. The chips under the dialogue are made from these.
export interface FoundLink {
  label: string
  url: string
}

export function linksIn(text: string): FoundLink[] {
  const found: FoundLink[] = []
  const seen = new Set<string>()
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let match: RegExpExecArray | null
  while ((match = markdown.exec(text)) !== null) {
    if (seen.has(match[2])) continue
    seen.add(match[2])
    found.push({ label: match[1], url: match[2] })
  }
  const bare = /https?:\/\/[^\s<>()\]`'"]+/g
  while ((match = bare.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?。、」』）]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    let label: string
    try {
      const parsed = new URL(url)
      label = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
    } catch {
      label = url
    }
    if (label.length > 48) label = `${label.slice(0, 45)}…`
    found.push({ label, url })
  }
  return found
}
