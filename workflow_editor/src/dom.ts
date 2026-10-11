// A small element builder: h('div.card#id', {attrs/props/on*}, ...children).
type Child = Node | string | number | null | undefined | false | Child[]
type Props = Record<string, unknown>

export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}` | `${K}#${string}`, props?: Props | Child, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [, tag, rest] = /^([a-z0-9]+)(.*)$/.exec(spec) ?? []
  const el = document.createElement(tag as K)
  for (const m of rest.matchAll(/([.#])([^.#]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]); else el.id = m[2]
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props as Child)
  } else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  append(el, children)
  return el
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.append(c instanceof Node ? c : String(c))
  }
}

export const short = (hash?: string | null) => (hash ? hash.slice(0, 7) : '—')

export function when(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString()
}
