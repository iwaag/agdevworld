// Where devdocs lives and which Git repository owns it (p4). A project
// declares `devdocs: directory | submodule` in project.yaml; the working tree
// path is `devdocs/...` either way. History reads and publication go through
// this one resolver, which names the owning repository and the path inside it.
//
// - directory: the project root repository owns it, at `devdocs/...`.
// - submodule: the devdocs repository owns it, at its own root.
//
// A declaration that disagrees with the Git structure is reported, never
// converted. Historical content is read from an identified repository and
// commit only; nothing falls back to current files.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Diagnostic } from '../shared/api.ts'
import { DEVDOCS_MODES, type DevdocsMode } from '../shared/model.ts'
import { git } from './git.ts'

export type DevdocsOwner = 'root' | 'devdocs'

export interface DevdocsInfo {
  declared: DevdocsMode | null // from project.yaml; null when absent or not a mode
  observed: 'directory' | 'submodule' | 'missing' // what the root's Git structure says
  mode: DevdocsMode | null // usable only when the declaration agrees with Git
  owner: DevdocsOwner
  ownerDir: string // absolute work tree of the owning repository
  prefix: '' | 'devdocs/' // devdocs' path inside the owning repository
  problem?: Diagnostic
}

// A commit of the owning repository, as a history view shows it.
export interface DevdocsRev {
  owner: DevdocsOwner
  commit: string
  subject: string
  date: string
  root?: string // the root commit the gitlink was read from (submodule mode, root:<commit>)
}

export class RevError extends Error {}

const exists = (p: string) => stat(p).then(() => true, () => false)

export async function devdocsInfo(root: string, declaredText: string | undefined, submodulePaths: string[]): Promise<DevdocsInfo> {
  const declared = (DEVDOCS_MODES as readonly string[]).includes(declaredText ?? '') ? declaredText as DevdocsMode : null
  const inModules = submodulePaths.some(p => p.replace(/\/$/, '') === 'devdocs')
  const observed = inModules ? 'submodule' : await exists(join(root, 'devdocs')) ? 'directory' : 'missing'
  const asSubmodule = declared === 'submodule' || (declared === null && inModules)
  const info: DevdocsInfo = {
    declared, observed, mode: null,
    owner: asSubmodule ? 'devdocs' : 'root',
    ownerDir: asSubmodule ? join(root, 'devdocs') : root,
    prefix: asSubmodule ? '' : 'devdocs/',
  }
  if (!declared) {
    info.problem = { severity: 'error', code: 'devdocs-mode-undeclared', message: `project.yaml does not declare the devdocs storage mode${declaredText ? ` ("${declaredText}" is not one)` : ''}; Git shows ${observed === 'missing' ? 'no devdocs' : `devdocs as a ${observed}`}`, fix: `Add "devdocs: ${observed === 'submodule' ? 'submodule' : 'directory'}" to project.yaml.` }
  } else if (declared === 'directory' && observed === 'submodule') {
    info.problem = { severity: 'error', code: 'devdocs-mode-mismatch', message: 'project.yaml declares devdocs as a directory, but .gitmodules lists devdocs as a submodule', fix: 'Correct project.yaml or the Git structure by hand; the storage mode is not converted.' }
  } else if (declared === 'submodule' && observed !== 'submodule') {
    info.problem = { severity: 'error', code: 'devdocs-mode-mismatch', message: `project.yaml declares devdocs as a submodule, but .gitmodules has no devdocs entry${observed === 'directory' ? ' (devdocs is a plain directory)' : ''}`, fix: 'Correct project.yaml or add the devdocs submodule (wfe add-repo devdocs <location>); the storage mode is not converted.' }
  } else {
    info.mode = declared
  }
  return info
}

// Resolves a history reference to a commit of the owning repository:
//   <commit>       a commit of the repository that owns devdocs
//   root:<commit>  a commit of the project root; in submodule mode its
//                  recorded devdocs gitlink is used (and named as such)
export async function resolveRev(root: string, info: DevdocsInfo, ref: string): Promise<DevdocsRev> {
  const m = /^root:(.+)$/.exec(ref.trim())
  let commit = (m ? m[1] : ref).trim()
  if (!/^[0-9A-Za-z_./~^-]+$/.test(commit) || commit.startsWith('-')) throw new RevError(`"${ref}" is not a revision`)
  let viaRoot: string | undefined
  if (m) {
    const r = await git(root, ['rev-parse', '--verify', '-q', `${commit}^{commit}`])
    if (r.code !== 0) throw new RevError(`"${commit}" is not a commit of the project root`)
    viaRoot = r.stdout.trim()
    if (info.owner === 'devdocs') {
      const tree = await git(root, ['ls-tree', viaRoot, '--', 'devdocs'])
      const link = /^160000 commit ([0-9a-f]+)\t/.exec(tree.stdout)
      if (!link) throw new RevError(`root commit ${viaRoot.slice(0, 10)} records no devdocs gitlink`)
      commit = link[1]
    } else commit = viaRoot
  }
  const info2 = await git(info.ownerDir, ['log', '-1', '--format=%H%x00%s%x00%cI', `${commit}^{commit}`, '--'])
  if (info2.code !== 0 || !info2.stdout.trim()) {
    throw new RevError(viaRoot && info.owner === 'devdocs'
      ? `root commit ${viaRoot.slice(0, 10)} records devdocs ${commit.slice(0, 10)}, which this devdocs repository does not have (fetch it)`
      : `"${commit}" is not a commit of the ${info.owner === 'root' ? 'project root' : 'devdocs repository'}`)
  }
  const [full, subject, date] = info2.stdout.trim().split('\0')
  return { owner: info.owner, commit: full, subject, date, ...(viaRoot && info.owner === 'devdocs' ? { root: viaRoot } : {}) }
}

// A devdocs-relative path (`runs/...`, `workflows/...`) as a path in the owning repository.
export const ownerPath = (info: DevdocsInfo, devdocsRel: string) => `${info.prefix}${devdocsRel}`

export async function showAt(info: DevdocsInfo, rev: DevdocsRev, devdocsRel: string): Promise<string | null> {
  const r = await git(info.ownerDir, ['show', `${rev.commit}:${ownerPath(info, devdocsRel)}`])
  return r.code === 0 ? r.stdout : null
}

export async function blobSizeAt(info: DevdocsInfo, rev: DevdocsRev, devdocsRel: string): Promise<number | null> {
  const object = `${rev.commit}:${ownerPath(info, devdocsRel)}`
  const type = await git(info.ownerDir, ['cat-file', '-t', object])
  if (type.code !== 0 || type.stdout.trim() !== 'blob') return null
  const size = await git(info.ownerDir, ['cat-file', '-s', object])
  return size.code === 0 ? Number(size.stdout.trim()) : null
}

export async function listAt(info: DevdocsInfo, rev: DevdocsRev, devdocsDir: string): Promise<{ name: string; size: number }[]> {
  const r = await git(info.ownerDir, ['ls-tree', '-l', rev.commit, '--', `${ownerPath(info, devdocsDir)}/`])
  return r.stdout.split('\n').filter(l => /^\d+ blob /.test(l)).map(l => {
    const [meta, path] = l.split('\t')
    return { name: path.split('/').pop()!, size: Number(meta.trim().split(/\s+/)[3]) }
  })
}
