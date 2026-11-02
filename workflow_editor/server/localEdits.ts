// Workflow edits still only in a person's checkout (workflow_editor p20,
// docs/drafts.md): the inventory of what the old flow left, and importing one
// as a draft with its actual provenance. Reading changes nothing in the checkout.
//
// A checkout that differs from the published definition only because it is
// behind is not an edit: its file equals a revision the project already had.
// A real edit is uncommitted, in local commits Gitea does not have, or untracked;
// its base is what that checkout's history last shared with the project.
import { join } from 'node:path'
import { git } from './git.ts'
import type { AccessContext } from './access.ts'
import { digestOf, publishedDescriptor, publishedWorkspace } from './published.ts'
import { observe, type Registration } from './registry.ts'
import type { DraftRecord, LocalEdit, LocalEditsView } from '../shared/drafts.ts'
import { draftMeta, DRAFT_SCHEMA, type DraftStore } from './drafts.ts'
import { RequestError, Workspace, WORKFLOWS_DIR } from './workspace.ts'
import { parseWorkflow } from './yamlDoc.ts'
import { randomBytes } from 'node:crypto'

interface Found extends Omit<LocalEdit, 'draft'> { text: string; baseText: string | null }

async function inventory(ctx: AccessContext, reg: Registration): Promise<{ found: Found[]; unread: string[] }> {
  const ws = new Workspace(reg)
  const pub = await publishedWorkspace(ctx, reg, { discovery: true })
  const info = await ws.devdocs()
  const owner = info.mode === 'submodule' ? join(ws.root, 'devdocs') : ws.root
  const inner = info.mode === 'submodule' ? WORKFLOWS_DIR.replace(/^devdocs\//, '') : WORKFLOWS_DIR
  const cache = pub.located.defs?.dir ?? pub.located.rootDir
  const head = (await git(owner, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).stdout.trim() || null
  const knownToProject = async (c: string) => (await git(cache, ['cat-file', '-e', `${c}^{commit}`])).code === 0
  // The newest commit of this checkout's history the project also has.
  let shared: string | null = null, ahead: number | null = null
  if (head) {
    const log = (await git(owner, ['rev-list', '--max-count=500', head])).stdout.split('\n').filter(Boolean)
    for (let i = 0; i < log.length; i++) if (await knownToProject(log[i]!)) { shared = log[i]!; ahead = i; break }
  }
  const at = async (commit: string | null, file: string) => {
    if (!commit) return null
    const r = await git(owner, ['show', `${commit}:${inner}/${file}`])
    return r.code === 0 ? r.stdout : null
  }
  const found: Found[] = [], unread: string[] = []
  for (const file of await ws.workflowFiles()) {
    try {
      const { text } = await ws.readWorkflowFile(file)
      if (text === null) continue
      const published = (await pub.readWorkflowFile(file)).text
      if (text === published) continue
      const headText = await at(head, file)
      const sharedText = await at(shared, file)
      const committedHere = headText !== null && text === headText
      // Same as a revision the project had: only behind (or the published side changed).
      if (committedHere && (ahead === 0 || sharedText === text)) continue
      const untracked = headText === null && sharedText === null
      if (untracked && (await git(owner, ['log', '-1', '--format=%H', shared ?? head ?? 'HEAD', '--', `${inner}/${file}`])).stdout.trim()) continue
      const parsed = parseWorkflow(text)
      found.push({
        file, workflow: parsed.ok ? parsed.model.id : null, name: parsed.ok ? parsed.model.name : null,
        edit: committedHere ? 'local-commits' : untracked ? 'untracked' : 'uncommitted',
        sha256: digestOf(text), head, ahead, baseCommit: shared, baseSha256: sharedText === null ? null : digestOf(sharedText),
        publishedSha256: published === null ? null : digestOf(published), text, baseText: sharedText,
      })
    } catch (e) { unread.push(`${file}: ${(e as Error).message}`) }
  }
  return { found, unread }
}

export async function localEdits(ctx: AccessContext, store: DraftStore, reg: Registration): Promise<LocalEditsView> {
  const obs = await observe(reg)
  if (!obs.available) return { workspace: reg.id, available: false, reason: obs.reason, edits: [], unread: [] }
  const { found, unread } = await inventory(ctx, reg)
  const drafts = await store.list({ project: reg.project!, states: ['open', 'applied', 'discarded'] })
  return {
    workspace: reg.id, available: true, unread,
    edits: found.map(({ text: _t, baseText: _b, ...f }) => {
      const same = drafts.find(d => d.file === f.file && (d.revisions[0]?.sha256 === f.sha256 || d.sha256 === f.sha256))
      return { ...f, draft: same ? draftMeta(same) : null }
    }),
  }
}

// An edit becomes a draft with what it really was based on. The checkout stays
// exactly as it is, and nothing is published.
export async function importEdit(ctx: AccessContext, store: DraftStore, reg: Registration, o: { file: string; sha256: string; by: string }): Promise<DraftRecord> {
  if (!o.by?.trim()) throw new RequestError(400, 'by is required: the name of who imports')
  const { found } = await inventory(ctx, reg)
  const f = found.find(x => x.file === o.file)
  if (!f) throw new RequestError(404, `${o.file} has no edit in this checkout any more`, { code: 'no-edit' })
  if (f.sha256 !== o.sha256) throw new RequestError(409, `${o.file} changed in the checkout since it was shown; look at it again`, { code: 'definition-conflict', sha256: f.sha256 })
  const pub = await publishedWorkspace(ctx, reg, { discovery: true })
  const at = new Date().toISOString(), by = o.by.trim()
  return store.create({
    schema: DRAFT_SCHEMA, id: `d-${randomBytes(6).toString('hex')}`, project: reg.project!, workspace: reg.id, workflow: f.workflow, file: f.file,
    author: by, created: at, updated: at, updatedBy: by, state: 'open', revision: 1, text: f.text, sha256: f.sha256,
    base: { text: f.baseText, sha256: f.baseSha256, source: f.baseCommit ? { ...publishedDescriptor(pub.source, f.file, f.workflow, f.baseText), definition: { repository: pub.source.definitions?.repository ?? pub.source.repository, path: `${WORKFLOWS_DIR}/${f.file}`, revision: f.baseCommit }, root: null } : null },
    provenance: { kind: 'import', workspace: reg.id, edit: f.edit, head: f.head, baseCommit: f.baseCommit, at },
    revisions: [{ revision: 1, sha256: f.sha256, text: f.text, at, by }], apply: null,
  })
}
