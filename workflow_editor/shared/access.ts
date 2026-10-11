// Access declarations as path scopes (p4). A workflow's repository bindings
// declare `readonly` or `editable` for a project-relative path; the most
// specific binding containing a path governs it (`.` contains everything).
// Writing the run's own records (its folder under devdocs/runs/) is a
// reporting capability every run has, even under `root: readonly`; it does
// not extend to source code, other runs or workflow definitions. These are
// declarations the executor checks itself, not OS-enforced permissions.
import { normalizeRepoPath, type RepositoryBinding } from './model.ts'

export interface AccessAnswer {
  path: string
  access: 'editable' | 'readonly' | 'report' | 'undeclared'
  binding?: string // the governing binding key
  scope?: string // the governing binding's path
  reason: string
}

const contains = (scope: string, path: string) => scope === '.' || path === scope || path.startsWith(`${scope}/`)

export function accessAt(bindings: Record<string, RepositoryBinding>, rawPath: string, runDir?: string): AccessAnswer {
  const path = normalizeRepoPath(rawPath)
  if (!path) return { path: rawPath, access: 'undeclared', reason: 'not a project-relative path inside the project' }
  if (runDir && contains(runDir, path)) return { path, access: 'report', reason: `the run's own record folder (${runDir}); every run may write its records there` }
  let best: { key: string; scope: string; access: string } | null = null
  for (const [key, b] of Object.entries(bindings)) {
    const scope = normalizeRepoPath(b.path)
    if (!scope || !contains(scope, path)) continue
    const depth = (x: string) => (x === '.' ? 0 : x.split('/').length)
    if (!best || depth(scope) > depth(best.scope)) best = { key, scope, access: b.access }
  }
  if (!best) return { path, access: 'undeclared', reason: 'no binding of this workflow covers it; treat it as not yours to change' }
  const access = best.access === 'editable' ? 'editable' : 'readonly'
  return { path, access, binding: best.key, scope: best.scope, reason: `binding "${best.key}" (${best.scope}) declares it ${best.access}` }
}
