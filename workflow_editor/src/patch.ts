// Brings a persistent element in line with a freshly built one (p7/ex2):
// unchanged nodes are not written at all, changed text is updated in its own
// text node, and children carrying data-key keep their element identity —
// inserted, removed or moved, never rebuilt — so a reader's place, a text
// selection or a scroll anchor in them survives. Built content carries no
// listeners of its own (actions are delegated through data-action), so
// reusing an element never keeps a stale handler. Interactive controls are
// never patched: they live outside the patched blocks.
const keyOf = (n: Node): string | null => (n instanceof HTMLElement ? n.dataset.key ?? null : null)

// Attributes the person owns on a persistent element.
const OWNED = new Set(['open'])

function patchAttributes(cur: Element, next: Element) {
  for (const { name, value } of [...next.attributes]) if (!OWNED.has(name) && cur.getAttribute(name) !== value) cur.setAttribute(name, value)
  for (const { name } of [...cur.attributes]) if (!OWNED.has(name) && !next.hasAttribute(name)) cur.removeAttribute(name)
}

function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false
  if (a instanceof Element) return a.tagName === (b as Element).tagName && keyOf(a) === keyOf(b)
  return true
}

function patchNode(cur: Node, next: Node) {
  if (cur instanceof Element) { patchAttributes(cur, next as Element); patchChildren(cur, [...next.childNodes]) }
  else if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue
}

// The children of `cur` become `next` (nodes taken from a fresh build).
export function patchChildren(cur: Element, next: Node[]) {
  const keyed = new Map<string, Node>()
  for (const c of cur.childNodes) { const k = keyOf(c); if (k !== null) keyed.set(k, c) }
  let at: ChildNode | null = cur.firstChild
  for (const n of next) {
    const k = keyOf(n)
    const match = k !== null ? keyed.get(k) : at && keyOf(at) === null && same(at, n) ? at : undefined
    if (match && same(match, n)) {
      if (k !== null) keyed.delete(k)
      if (match === at) at = at.nextSibling
      else cur.insertBefore(match, at)
      patchNode(match, n)
    } else {
      cur.insertBefore(n, at)
    }
  }
  while (at) { const nx: ChildNode | null = at.nextSibling; at.remove(); at = nx }
}

// `cur` takes the attributes and children of `next`; `cur` itself stays.
export function patch(cur: Element, next: Element) {
  patchAttributes(cur, next)
  patchChildren(cur, [...next.childNodes])
}

// Children only, from a list of built nodes or strings.
export function patchContent(cur: Element, ...next: (Node | string | null | undefined | false)[]) {
  patchChildren(cur, next.filter((x): x is Node | string => !!x).map(x => (typeof x === 'string' ? document.createTextNode(x) : x)))
}
