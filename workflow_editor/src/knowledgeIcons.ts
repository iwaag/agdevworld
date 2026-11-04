// The artwork of categories and findings (improve_workflow p3, docs/knowledge.md
// *Icons*): agy's family, bundled with the release and mapped by category key or
// qualified finding id. Display only. A node stores no artwork, so changing a
// file here cannot change which finding a node references; what has none gets a
// generic icon and its actual name.
import { ICONS } from './icons.ts'

const files = import.meta.glob('./knowledge-icons/**/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const manifests = import.meta.glob('./knowledge-icons/manifest.json', { import: 'default', eager: true }) as Record<string, IconManifest>
export interface IconEntry { file: string; label: string; depicts?: string }
export interface IconManifest { categories: Record<string, IconEntry>; findings: Record<string, IconEntry>; fallbacks: { category: string; finding: string } }
const manifest: IconManifest | undefined = Object.values(manifests)[0]
const art = (file?: string) => (file ? files[`./knowledge-icons/${file}`] : undefined)

function framed(kind: 'category' | 'finding', svg: string | undefined, label: string, known: boolean): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = `k-icon k-icon-${kind}${known ? '' : ' k-icon-generic'}`
  span.setAttribute('aria-hidden', 'true')
  span.dataset.art = svg ? 'family' : 'builtin'
  // Bundled in this repository and read before integration, never from a document.
  span.innerHTML = svg ?? ICONS[kind === 'category' ? 'list' : 'doc']
  if (label) span.dataset.label = label
  return span
}
export const categoryIcon = (key?: string) => {
  const e = key ? manifest?.categories[key] : undefined
  return framed('category', art(e?.file) ?? art(manifest?.fallbacks.category), e?.label ?? '', !!e)
}
export const findingIcon = (qid: string) => {
  const e = manifest?.findings[qid]
  return framed('finding', art(e?.file) ?? art(manifest?.fallbacks.finding), e?.label ?? '', !!e)
}
export const findingLabel = (qid: string) => manifest?.findings[qid]?.label
