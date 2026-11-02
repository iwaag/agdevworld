// A run's durable record (improve_wfrun p2, docs/storage.md): the folder a run
// is recorded in lives beside its working copy, not inside it:
//
//   <copy folder>/record/devdocs/runs/<wf>/<run>/   the one writable record
//   <copy folder>/tree/devdocs/runs/<wf>/<run>      a relative link to it
//
// An agent reads and writes the documented run path as ever; there is one set
// of bytes, and the record lock (server/lock.ts, keyed by real path) is the
// same whichever spelling a writer holds. The record root has the
// project-relative layout, so a run without a tree is read through a Workspace
// rooted there. Its `.git` is an invalid gitfile: Git run there fails instead of
// discovering the person's workspace above it.
//
// Git does not see the link (.git/info/exclude) and leaves the run folder's
// index entries alone (skip-worktree). What a branch holds of the folder is an
// intentional snapshot, staged by `stageRecord` at a publication.
import { spawn } from 'node:child_process'
import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { runFolder, type RunRef } from '../shared/run.ts'
import { git, gitOk } from './git.ts'
import { readTextOrNull } from './files.ts'

export const RECORD = 'record'
export const RECORD_STAGING = 'record.staging'
const RECORD_OLD = 'record.old'

export const recordRootOf = (copyFolder: string) => join(copyFolder, RECORD)
export const recordFolderOf = (copyFolder: string, ref: RunRef) => join(copyFolder, RECORD, runFolder(ref))
// The repository that owns the run folder, and the folder's path inside it.
export const folderIn = (owner: string, ref: RunRef) => (owner === '.' ? runFolder(ref) : runFolder(ref).slice(owner.length + 1))

function gitInput(cwd: string, args: string[], input: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d }); p.stderr.on('data', d => { stderr += d })
    p.on('error', reject)
    p.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    p.stdin.end(input)
  })
}
async function must(cwd: string, args: string[], input: string, env: Record<string, string> = {}): Promise<string> {
  const r = await gitInput(cwd, args, input, env)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim()}`)
  return r.stdout
}

// The record root's guard against Git discovery.
export async function guardRecordRoot(root: string) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '.git'), 'not a repository: a run\'s durable record (docs/storage.md)\n')
}

async function excludePath(repo: string, pattern: string) {
  const file = (await gitOk(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  const abs = file.startsWith('/') ? file : join(repo, file)
  const text = (await readTextOrNull(abs)) ?? ''
  if (text.split('\n').includes(pattern)) return
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`)
}

// Marks what the index holds of the run folder as Git's to leave alone.
async function markEntries(repo: string, folder: string, env: Record<string, string> = {}) {
  const tracked = (await git(repo, ['ls-files', '-z', '--', `${folder}/`], { env })).stdout
  if (tracked) await must(repo, ['update-index', '-z', '--skip-worktree', '--stdin'], tracked, env)
}

// Makes the tree's run path a link to the durable folder. A real folder found
// there (a Git operation or an agent replaced the link) is folded into the
// record first: a file the record lacks or holds older moves in, and run.json
// is never taken from it. Returns what was taken.
export async function linkRecord(tree: string, ref: RunRef, owner: string): Promise<string[]> {
  const path = join(tree, runFolder(ref))
  const target = relative(dirname(path), join(dirname(tree), RECORD, runFolder(ref)))
  const st = await lstat(path).catch(() => null)
  if (st?.isSymbolicLink() && await readlink(path) === target) return []
  const taken: string[] = []
  if (st?.isDirectory()) {
    const fold = async (from: string, rel: string) => {
      for (const e of await readdir(from, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { await fold(join(from, e.name), r); continue }
        if (!e.isFile() || r === 'run.json') continue
        const to = join(recordFolderOf(dirname(tree), ref), r)
        const have = await stat(to).catch(() => null)
        if (have && have.mtimeMs >= (await stat(join(from, e.name))).mtimeMs) continue
        await mkdir(dirname(to), { recursive: true })
        await copyFile(join(from, e.name), to)
        taken.push(r)
      }
    }
    await fold(path, '')
    await rm(path, { recursive: true, force: true })
  } else if (st) await rm(path, { force: true })
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path)
  const repo = owner === '.' ? tree : join(tree, owner)
  const folder = folderIn(owner, ref)
  await excludePath(repo, `/${folder}`)
  await markEntries(repo, folder)
  return taken
}


interface Entry { path: string; mode: string; abs?: string; link?: string }
async function recordEntries(dir: string): Promise<Entry[]> {
  const out: Entry[] = []
  const go = async (d: string, rel: string) => {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (e.name !== '.git') await go(join(d, e.name), r); continue }
      if (e.isSymbolicLink()) out.push({ path: r, mode: '120000', link: await readlink(join(d, e.name)) })
      else if (e.isFile()) out.push({ path: r, mode: (await stat(join(d, e.name))).mode & 0o111 ? '100755' : '100644', abs: join(d, e.name) })
    }
  }
  await go(dir, '')
  return out
}

// Stages the durable folder as the repository's snapshot of it, in the index
// `env` names (the repository's own by default). The project's ignore rules
// apply as they did to a folder in the tree: Git refuses paths beyond a link,
// so they are asked of a sibling name; what is already tracked stays tracked.
export async function stageRecord(repo: string, folder: string, recordFolder: string, env: Record<string, string> = {}): Promise<void> {
  const entries = await recordEntries(recordFolder)
  const tracked = new Set((await git(repo, ['ls-files', '-z', '--', `${folder}/`], { env })).stdout.split('\0').filter(Boolean))
  const probe = `${dirname(folder)}/.wfe-record-probe`
  const asked = entries.filter(e => !tracked.has(`${folder}/${e.path}`)).map(e => `${probe}/${e.path}`)
  const ignored = new Set<string>()
  if (asked.length) {
    const r = await gitInput(repo, ['check-ignore', '-z', '--no-index', '--stdin'], `${asked.join('\0')}\0`, env)
    if (r.code > 1) throw new Error(`git check-ignore failed: ${r.stderr.trim()}`)
    for (const p of r.stdout.split('\0').filter(Boolean)) ignored.add(p.slice(probe.length + 1))
  }
  const kept = entries.filter(e => !ignored.has(e.path))
  const files = kept.filter(e => e.abs)
  const hashes = files.length ? (await must(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], `${files.map(e => e.abs).join('\n')}\n`, env)).trim().split('\n') : []
  const lines: string[] = []
  files.forEach((e, i) => lines.push(`${e.mode} ${hashes[i]}\t${folder}/${e.path}`))
  for (const e of kept.filter(x => x.link !== undefined)) lines.push(`120000 ${(await must(repo, ['hash-object', '-w', '--no-filters', '--stdin'], e.link!, env)).trim()}\t${folder}/${e.path}`)
  const present = new Set(kept.map(e => `${folder}/${e.path}`))
  for (const t of tracked) if (!present.has(t)) lines.push(`0 ${'0'.repeat(40)}\t${t}`)
  if (lines.length) await must(repo, ['update-index', '-z', '--index-info'], `${lines.join('\0')}\0`, env)
  await markEntries(repo, folder, env)
}

// Runs `f` (a Git operation that moves the repository between commits, whose
// snapshots of the folder differ) with the link and its index entries out of
// the way, then puts them back. The durable folder is not touched: what Git
// writes at the run path is the commit's snapshot, and it is removed.
export async function withoutLink<T>(tree: string, ref: RunRef, owner: string, f: () => Promise<T>): Promise<T> {
  const repo = owner === '.' ? tree : join(tree, owner)
  const folder = folderIn(owner, ref)
  const path = join(tree, runFolder(ref))
  await rm(path, { recursive: true, force: true })
  await git(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', folder])
  try { return await f() } finally {
    await rm(path, { recursive: true, force: true })
    await linkRecord(tree, ref, owner)
  }
}

// ---- moving an existing folder (relocation) -----------------------------------------------

const hashedFiles = async (dir: string) => {
  const { createHash } = await import('node:crypto')
  const out: Record<string, string> = {}
  for (const e of await recordEntries(dir)) out[e.path] = e.abs ? `${e.mode} ${createHash('sha256').update(await readFile(e.abs)).digest('hex')}` : `link ${e.link}`
  return out
}

// Moves a run folder from the tree into durable storage; every step checks
// what is already done, so a call after a crash continues. The caller holds
// the run's lock and has quiesced writers.
export async function relocateFolder(copyFolder: string, ref: RunRef, owner: string): Promise<'moved' | 'continued'> {
  const tree = join(copyFolder, 'tree')
  const path = join(tree, runFolder(ref))
  const staging = join(copyFolder, RECORD_STAGING), root = recordRootOf(copyFolder), old = join(copyFolder, RECORD_OLD)
  const st = await lstat(path).catch(() => null)
  const continued = st?.isSymbolicLink() || !!(await stat(root).catch(() => null))
  if (!st?.isSymbolicLink()) {
    if (!(await stat(root).catch(() => null))) {
      await rm(staging, { recursive: true, force: true })
      await mkdir(dirname(join(staging, runFolder(ref))), { recursive: true })
      if (st?.isDirectory()) await cp(path, join(staging, runFolder(ref)), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
      else await mkdir(join(staging, runFolder(ref)), { recursive: true })
      if (st?.isDirectory()) {
        const a = await hashedFiles(path), b = await hashedFiles(join(staging, runFolder(ref)))
        const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k])
        if (differ.length) throw new Error(`the staged record differs from the run folder: ${differ.slice(0, 5).join(', ')}`)
      }
      await guardRecordRoot(staging)
      await rename(staging, root)
    }
    if (st?.isDirectory()) await rename(path, old)
  }
  await linkRecord(tree, ref, owner)
  await rm(old, { recursive: true, force: true })
  return continued ? 'continued' : 'moved'
}
