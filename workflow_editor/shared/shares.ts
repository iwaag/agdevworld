// Shared areas (project_migration p6, docs/shares.md): a logical name for a
// folder that several hosts mount, and the references, input sets and
// external outputs a run records about it. Pure: parsing, shapes and the
// digest body. Where a share is on a host is that host's configuration
// (<area>/shares.json, server/shares.ts); a tracked record holds only
// `shared://<share>/<path>`.
import { ID_PATTERN, normalizeRepoPath } from './model.ts'

export const SHARE_SCHEME = 'shared://'
export const INPUT_SET_KIND = 'ag.wfe-input-set.v1'
export const OUTPUT_KIND = 'ag.wfe-external-artifact.v1'
export const INPUT_ID = /^i[0-9]{1,6}$/
export const OUTPUT_ID = /^o[0-9]{1,6}$/
export const CANDIDATE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
// Where a run's published outputs go on a share: one folder per publication.
export const OUTPUTS_ROOT = 'runs'
// The manifest a publication writes inside its own folder on the share.
export const OUTPUT_MANIFEST = '.wfe-output.json'

// A reference: share id, a share-relative path ('' = the share's root) and
// whether it names a folder (trailing slash, or the root).
export interface ShareRef { ref: string; share: string; path: string; folder: boolean }

export function parseRef(text: string): ShareRef | null {
  if (!text.startsWith(SHARE_SCHEME)) return null
  const rest = text.slice(SHARE_SCHEME.length)
  const slash = rest.indexOf('/')
  const share = slash < 0 ? rest : rest.slice(0, slash)
  if (!ID_PATTERN.test(share)) return null
  const raw = slash < 0 ? '' : rest.slice(slash + 1)
  const folder = raw === '' || raw.endsWith('/')
  const trimmed = raw.replace(/\/+$/, '')
  if (trimmed === '') return { ref: `${SHARE_SCHEME}${share}/`, share, path: '', folder: true }
  const path = normalizeRepoPath(trimmed)
  if (!path || path === '.' || path !== trimmed) return null
  return { ref: `${SHARE_SCHEME}${share}/${path}${folder ? '/' : ''}`, share, path, folder }
}

export const formatRef = (share: string, path: string, folder = false) =>
  `${SHARE_SCHEME}${share}/${path}${folder && path ? '/' : ''}`

// Every reference written in a text, in order of first appearance, once.
// A reference ends at whitespace or at a closing quote/bracket/backtick;
// trailing sentence punctuation is not part of it.
export function refsIn(text: string): ShareRef[] {
  const out: ShareRef[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/shared:\/\/[^\s`'"<>()[\]{}]+/g)) {
    const r = parseRef(m[0].replace(/[.,;:!?]+$/, ''))
    if (r && !seen.has(r.ref)) { seen.add(r.ref); out.push(r) }
  }
  return out
}

// A file of an input set or an output, relative to the folder it was read from.
export interface SetFile { path: string; bytes: number; sha256: string }

// How a run holds an input set: `copy` — staged into the copy's .local/
// and verified there; `in-place` — read where it is on the share, verified
// against the manifest whenever it is used.
export type Staging = 'copy' | 'in-place'
export const STAGINGS: readonly Staging[] = ['copy', 'in-place']

// The facts an input set's or output's last check found on this host.
export const SET_OBSERVATIONS = ['verified', 'changed', 'missing'] as const
export type SetObservation = typeof SET_OBSERVATIONS[number]
export interface SetCheck { at: string; by: string; status: SetObservation; detail: string }

export interface InputSet {
  id: string
  ref: string // the folder (or file) reference it realizes
  node: string // the node that selected it
  file: string // project-relative: devdocs/runs/<wf>/<run>/inputs/<id>.json
  digest: string // sha256:<hex> of the canonical body
  count: number
  bytes: number
  staging: Staging
  selected: { at: string; by: string; attempt: string | null }
  last: SetCheck | null
}

export interface ExternalOutput {
  id: string
  ref: string // the publication's folder on the share
  node: string
  title: string
  candidate: string // the name of the approach or variant; a later output of the same candidate supersedes an earlier one
  file: string // project-relative: devdocs/runs/<wf>/<run>/outputs/<id>.json
  digest: string
  count: number
  bytes: number
  inputs: string[] // input-set digests the output was made from
  published: { at: string; by: string; attempt: string | null }
  last: SetCheck | null
}

// What the digest of an input set or output covers: kind, reference and
// every file by path, size and hash. Same construction as a presentation
// revision (sha256 of the canonical JSON), computed by the file layer.
export const inputBody = (ref: string, files: SetFile[]) => ({ kind: INPUT_SET_KIND, ref, files: sortFiles(files) })
export const outputBody = (ref: string, candidate: string, inputs: string[], files: SetFile[]) => ({ kind: OUTPUT_KIND, ref, candidate, inputs: [...inputs].sort(), files: sortFiles(files) })
export const sortFiles = (files: SetFile[]) => [...files].map(f => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

export const outputFolderPath = (project: string, workflow: string, run: string, id: string) => `${OUTPUTS_ROOT}/${project}/${workflow}/${run}/${id}`
export const outputNumber = (id: string) => Number(id.slice(1))
export const totalBytes = (files: { bytes: number }[]) => files.reduce((n, f) => n + f.bytes, 0)
export const humanBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`
