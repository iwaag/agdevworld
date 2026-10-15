// The other registered projects' workflows (p10, docs/delegation.md): what a
// delegate node of this project may target, for validation (unknown target,
// no intake, recursion across projects) and for the editor's inspector. One
// registered, available, allowed workspace per project; a project with
// several is offered from the one zulip.json selects, else its first.
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import { loadRegistry, observe } from './registry.ts'
import { Workspace } from './workspace.ts'
import type { PeerProject } from '../shared/api.ts'

export async function registryPeers(registryFile: string, area: string, self?: string): Promise<PeerProject[]> {
  const reg = await loadRegistry(registryFile)
  const boundary = await loadBoundary(registryFile, area)
  const out: PeerProject[] = []
  const seen = new Set<string>()
  for (const w of reg.workspaces) {
    if (!w.project || w.project === self || seen.has(w.project)) continue
    try { await assertWorkspaceAllowed(boundary, w, 'Delegation') } catch { continue }
    if (!(await observe(w)).available) continue
    seen.add(w.project)
    const list = (await new Workspace(w).workflowSummaries().catch(() => ({ list: [] }))).list
    out.push({ project: w.project, workspace: w.id, label: w.label, workflows: list.filter(s => s.id).map(s => ({ id: s.id!, name: s.name, file: s.file, delegates: s.delegates, intake: !!s.intake })) })
  }
  return out.sort((a, b) => (a.project < b.project ? -1 : 1))
}
