// Drafts as records and as the service answers about them (workflow_editor p20,
// docs/drafts.md).
import type { DefinitionDescriptor, PublishedSourceView, WorkflowResponse } from './api.ts'
import type { Issue } from './model.ts'

export type Provenance =
  | { kind: 'published' }
  | { kind: 'new'; template: string }
  | { kind: 'import'; workspace: string; edit: 'uncommitted' | 'local-commits' | 'untracked'; head: string | null; baseCommit: string | null; at: string }

export type ApplyOutcome = 'in-progress' | 'applied' | 'conflict' | 'invalid' | 'failed' | 'uncertain'
export interface ApplyJournal {
  key: string; revision: number; by: string; outcome: ApplyOutcome; phase: string; started: string; updated: string
  merged?: string // sha256 of the bytes being published
  // What was built, written before it can reach the remote.
  definition?: { repository: string; branch: string; path: string; parent: string; commit: string; pushed: boolean }
  root?: { repository: string; branch: string; parent: string; commit: string; pushed: boolean; pinFrom: string | null; pinTo: string }
  result?: DefinitionDescriptor
  noChange?: boolean // the published definition already was this
  superseded?: boolean // a later publication already changed the file again
  error?: string
}

export interface DraftRecord {
  schema: 'ag.wfe-draft.v1'
  id: string; project: string; workspace: string; workflow: string | null; file: string
  author: string; created: string; updated: string; updatedBy: string
  state: 'open' | 'applied' | 'discarded'
  revision: number; text: string; sha256: string
  base: { text: string | null; sha256: string | null; source: DefinitionDescriptor | null }
  provenance: Provenance
  revisions: { revision: number; sha256: string; text: string; at: string; by: string }[]
  apply: ApplyJournal | null
  discarded?: { by: string; at: string }
}
// What a list shows: everything but the texts.
export type DraftMeta = Omit<DraftRecord, 'text' | 'revisions' | 'base'> & { base: { sha256: string | null; source: DefinitionDescriptor | null } }

export type MergeSegment = string | { n: number; mine: string; base: string; latest: string }
export interface DraftConflict {
  kind: 'text' | 'deleted' | 'renamed' | 'exists'
  message: string
  latest: { text: string | null; sha256: string | null; source: DefinitionDescriptor } // what to resolve against
  segments?: MergeSegment[]
  renamedTo?: string
}
export type Comparison =
  | { state: 'same'; text: string } // the published definition already is the draft
  | { state: 'unchanged'; text: string } // nothing edited: the latest stands
  | { state: 'direct' | 'merged'; text: string } // what applying would publish
  | { state: 'conflict'; conflict: DraftConflict }
export interface CompareResponse { draft: DraftMeta; comparison: Comparison; check?: { problem?: string; issues: Issue[] } }

export interface DraftView {
  draft: DraftMeta
  descriptor: DefinitionDescriptor
  source: PublishedSourceView | null
  sourceProblem?: string
  // The published definition now, against what this draft began from.
  latest: { sha256: string | null; changed: boolean; deleted: boolean; renamedTo?: string } | null
  baseText: string | null
}
export type DraftResponse = WorkflowResponse & DraftView

export interface ApplyResult {
  ok: boolean; duplicate?: boolean; draft: DraftMeta; apply: ApplyJournal
  conflict?: DraftConflict; issues?: Issue[]; problem?: string
}

export interface LocalEdit {
  file: string; workflow: string | null; name: string | null
  edit: 'uncommitted' | 'local-commits' | 'untracked'
  sha256: string; head: string | null; ahead: number | null; baseCommit: string | null; baseSha256: string | null
  publishedSha256: string | null
  draft: DraftMeta | null // already imported, or a draft with the same bytes
}
export interface LocalEditsView { workspace: string; available: boolean; reason?: string; edits: LocalEdit[]; unread: string[] }
