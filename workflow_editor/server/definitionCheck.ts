// What an integration did to the project's workflows (improve_wfrun p2): the
// definitions a run added or changed, validated at the revision that reached the
// default branch and against the published peers, not the editing workspace.
// gimmickimg freework/run-018 added `partial-animation`, invalid, and finished
// without noticing. This reports; it refuses nothing, and it is never an approval.
//
// A definition's own error is `invalid`. A check that could not finish
// (the peers unreadable, the revision unavailable) is `incomplete`: unknown,
// never stated as valid or invalid.
import { posix } from 'node:path'
import type { DefinitionCheck, DefinitionFinding } from '../shared/run.ts'
import { git } from './git.ts'
import type { AccessContext } from './access.ts'
import type { Registration } from './registry.ts'

// The workflow files that differ between two commits of the repository that
// owns devdocs (`inner`: where the workflows folder is in it).
export async function changedDefinitions(dir: string, inner: string, from: string, to: string): Promise<{ file: string; status: string }[]> {
  const r = await git(dir, ['diff', '--name-status', '--no-renames', '-z', from, to, '--', `${inner}/`], { timeoutMs: 60_000 })
  if (r.code !== 0) throw new Error(`the changes cannot be read: ${r.stderr.trim()}`)
  const parts = r.stdout.split('\0').filter(Boolean)
  const out: { file: string; status: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) if (/\.ya?ml$/.test(parts[i + 1])) out.push({ status: parts[i], file: posix.basename(parts[i + 1]) })
  return out
}

export async function checkDefinitions(ctx: AccessContext | null, reg: Registration, rootCommit: string, changed: { file: string; status: string }[]): Promise<DefinitionCheck | null> {
  const files = changed.filter(c => c.status !== 'D')
  if (!files.length) return null
  if (!ctx) return { revision: rootCommit, state: 'incomplete', detail: 'no published source on this host: nothing to validate against', findings: files.map(f => ({ file: f.file, status: f.status, state: 'unchecked' })) }
  const { publishedWorkspace, publishedPeers } = await import('./published.ts')
  const findings: DefinitionFinding[] = []
  let peers = true, detail = ''
  try {
    const pub = await publishedWorkspace(ctx, reg, { rev: rootCommit })
    // A peer list that cannot be read makes a delegate target unknown, not wrong.
    await publishedPeers(ctx, reg.project).catch(e => { peers = false; detail = `published peers cannot be read: ${(e as Error).message}` })
    if (!peers) pub.peers = undefined
    for (const f of files) {
      const res = await pub.workflowResponse(f.file).catch(e => e as Error)
      if (res instanceof Error) { findings.push({ file: f.file, status: f.status, state: 'unchecked', issues: [res.message] }); continue }
      const errors = res.issues.filter(i => i.severity === 'error')
      const peerOnly = !peers && errors.length > 0 && errors.every(i => /delegate|project/i.test(i.code ?? ''))
      findings.push({
        file: f.file, status: f.status,
        state: !res.workflow ? 'invalid' : peerOnly ? 'unchecked' : errors.length ? 'invalid' : !peers ? 'unchecked' : 'valid',
        ...(errors.length ? { issues: errors.map(i => i.message) } : !res.workflow && res.problem ? { issues: [res.problem.message] } : {}),
      })
    }
  } catch (e) {
    return { revision: rootCommit, state: 'incomplete', detail: `the revision cannot be read: ${(e as Error).message}`, findings: files.map(f => ({ file: f.file, status: f.status, state: 'unchecked' })) }
  }
  const invalid = findings.some(f => f.state === 'invalid'), unchecked = findings.some(f => f.state === 'unchecked')
  return { revision: rootCommit, state: invalid ? 'invalid' : unchecked ? 'incomplete' : 'valid', ...(detail ? { detail } : {}), findings }
}
