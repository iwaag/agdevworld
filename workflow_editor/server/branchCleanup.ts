// Recoverable cleanup of run branches on remotes (improve_wfrun p3, docs/storage.md
// *Run branch cleanup*). A branch goes only when its run is finished and retired, its
// hosts are synchronized, the branch's exact tip is in retained storage and in a
// verified backup of the run's current generation. Age, a name prefix or reachability
// from main never decide anything: a cancelled, unintegrated run keeps its work in
// retention too. Execution consumes an explicit selection, rechecks all of it under
// the run's lifecycle lock, and deletes only the object it saw. The mapping is written
// first (`branch-cleanup.json` beside `copy.json`, in the backup), so a partial
// deletion is retried and a branch can be recreated at its object.
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKey, type RunRef } from '../shared/run.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { withLock } from './lock.ts'
import { CLEANUP_RECORD, lifecycleLock, readContents, recordReasons, retentionRepo } from './retention.ts'
import { coverageOf, Dest, loadBackupConfig, readManifest, type BackupManifest } from './runBackup.ts'
import { readRun } from './runs.ts'
import { copyDir, listCopies, ownerOf, readCopy, runBranch, type CopyManifest, type RunCopy } from './runspace.ts'
import type { ExecStore } from './exec.ts'
import type { Workspace } from './workspace.ts'

export const CLEANUP_SCHEMA = 'ag.wfe-branch-cleanup.v1'
const BRANCH = /^refs\/heads\/wfe\/([a-z0-9][a-z0-9_.-]{0,63})\/([a-z0-9][a-z0-9_.-]{0,63})\/(run-[a-z0-9][a-z0-9_.-]{0,59})$/
export const STORAGE_LIMITS = 'Deleting a branch frees no bytes by itself: the objects stay on the remote until its own maintenance collects them, and other refs, reflogs and hard links may keep them. Measure allocated bytes per location; zero is a valid result.'

export type EntryState = 'pending' | 'deleted' | 'failed' | 'changed' | 'recreated'
export interface CleanupEntry { repository: string; path: string; key: string | null; ref: string; oid: string; state: EntryState; generation: number; by: string; at: string; backup: string | null; detail?: string }
export interface CleanupRecord { schema: string; workspace: string; run: string; entries: CleanupEntry[] }
export interface RefRow { repository: string | null; path: string; ref: string; oid: string | null; state: 'present' | 'absent' | 'outside' | 'unknown'; eligible: boolean; why: string[] }
export interface RunPreview { workspace: string; ref: string; state: string; eligible: boolean; reasons: string[]; refs: RefRow[]; recorded: number }
export interface Selection { workspace: string; ref: string; refs: { repository: string; ref: string; oid: string }[] }
export interface DeleteResult { workspace: string; ref: string; outcome: 'done' | 'refused' | 'partial'; reasons: string[]; refs: { repository: string; ref: string; oid: string; result: 'deleted' | 'changed' | 'failed' | 'already-absent' | 'not-selected'; detail?: string }[] }

const now = () => new Date().toISOString()
const parse = (key: string): RunRef => { const [workflow, run] = key.split('/'); return { workflow, run } }
const recordFile = (ws: Workspace, ref: RunRef) => join(copyDir(ws.shared, ref), CLEANUP_RECORD)

export async function readCleanupRecord(ws: Workspace, ref: RunRef): Promise<CleanupRecord | null> {
  const t = await readTextOrNull(recordFile(ws, ref))
  return t ? JSON.parse(t) as CleanupRecord : null
}
const writeRecord = (ws: Workspace, ref: RunRef, r: CleanupRecord) => atomicWrite(recordFile(ws, ref), `${JSON.stringify(r, null, 1)}\n`)

interface Ctx { x: ExecStore; env: Record<string, string>; remote: Map<string, Map<string, string> | string>; backup: BackupManifest | null; backupProblem: string | null; caches: Map<string, string> }

export async function cleanupContext(x: ExecStore): Promise<Ctx> {
  const cfg = await loadBackupConfig(x.ctx.area)
  let backup: BackupManifest | null = null, backupProblem: string | null = null
  if (!cfg) backupProblem = 'no backup destination is configured'
  else {
    const dest = new Dest(cfg)
    backup = await readManifest(dest).catch(e => { backupProblem = `the backup cannot be read: ${(e as Error).message}`; return null })
    if (!backup && !backupProblem) backupProblem = 'no verified backup generation exists'
  }
  return { x, env: x.ctx.gitea ? await x.ctx.gitea.gitEnv() : {}, remote: new Map(), backup, backupProblem, caches: new Map() }
}

const managed = (c: Ctx, url: string) => !c.x.ctx.gitea || url.startsWith(`${c.x.ctx.gitea.url}/`)

async function lsRemote(c: Ctx, url: string, fresh = false): Promise<Map<string, string> | string> {
  if (!fresh && c.remote.has(url)) return c.remote.get(url)!
  const r = await git(tmpdir(), ['ls-remote', '--heads', '--', url], { env: c.env, timeoutMs: 60_000 })
  const out: Map<string, string> | string = r.code !== 0 ? `its remote cannot be read: ${r.stderr.trim().split('\n')[0]}` : new Map(r.stdout.split('\n').filter(Boolean).map(l => { const [oid, ref] = l.split('\t'); return [ref, oid] as const }))
  c.remote.set(url, out)
  return out
}

// A bare repository of one remote, here only to answer reachability questions.
async function cacheOf(c: Ctx, url: string, spec: string[]): Promise<string | null> {
  const dir = join(c.x.ctx.area, '.local', 'branch-cleanup', 'cache', `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.git`)
  const seen = `${url} ${spec.join(' ')}`
  if (c.caches.has(seen)) return dir
  if (!await stat(join(dir, 'HEAD')).catch(() => null)) { await mkdir(dir, { recursive: true }); await git(dir, ['init', '-q', '--bare']) }
  const f = await git(dir, ['fetch', '-q', '--no-tags', '--prune', '--no-write-fetch-head', url, ...spec], { env: c.env, config: { 'protocol.file.allow': 'always' }, timeoutMs: 600_000 })
  if (f.code !== 0) return null
  c.caches.set(seen, dir)
  return dir
}

// A commit the parent's default branch pins must stay reachable after these refs go, or
// a later collection on the remote would break cloning the project.
async function pinProblem(c: Ctx, m: CopyManifest, path: string, url: string, leaving: Set<string>): Promise<string | null> {
  const paths = m.repositories.map(r => r.path).filter(p => p !== '.')
  const owner = ownerOf(path, paths)
  const parent = m.repositories.find(r => r.path === owner)
  if (!parent?.url || !parent.target) return `its parent repository's default branch is not known, so a pin cannot be checked`
  const rel = owner === '.' ? path : path.slice(owner.length + 1)
  const pdir = await cacheOf(c, parent.url, [`+refs/heads/${parent.target}:refs/heads/${parent.target}`])
  if (!pdir) return `the parent's ${parent.target} cannot be read, so a pin cannot be checked`
  const tree = await git(pdir, ['ls-tree', `refs/heads/${parent.target}`, '--', rel])
  const pin = /^160000 commit ([0-9a-f]+)/.exec(tree.stdout)?.[1]
  if (!pin) return null // this project no longer pins that repository on its default branch
  const dir = await cacheOf(c, url, ['+refs/heads/*:refs/heads/*'])
  if (!dir) return 'its remote cannot be fetched, so a pin cannot be checked'
  const holders = await git(dir, ['for-each-ref', '--contains', pin, '--format=%(refname)', 'refs/heads/'])
  if (holders.code !== 0) return null // the pinned commit is not on this remote at all; nothing here changes that
  const others = holders.stdout.split('\n').filter(Boolean).filter(r => !leaving.has(r))
  return others.length ? null : `${parent.target} of its parent pins ${pin.slice(0, 12)}, reachable only through the refs being deleted`
}

// The run's ownership of refs: its manifest, and what its archive says a repository held.
function repositoriesOf(m: CopyManifest, contents: { repositories: { path: string; url: string | null; key: string }[] } | null) {
  const out = new Map<string, { path: string; url: string | null; key: string | null }>()
  for (const r of m.repositories) if (r.initialized || r.branch) out.set(r.path, { path: r.path, url: r.url, key: null })
  for (const r of contents?.repositories ?? []) out.set(r.path, { path: r.path, url: r.url, key: r.key })
  return [...out.values()]
}

// The one eligibility answer for the CLI and the service.
export async function assess(c: Ctx, ws: Workspace, ref: RunRef, o: { leaving?: Set<string>; only?: boolean } = {}): Promise<RunPreview> {
  ws = ws.shared
  const key = runKey(ref)
  const copy = await readCopy(ws, ref)
  const base = { workspace: ws.reg.id, ref: key }
  if (!copy?.manifest) return { ...base, state: copy ? 'damaged' : 'none', eligible: false, reasons: [copy?.problem ?? 'no managed copy: unknown ownership'], refs: [], recorded: 0 }
  const m = copy.manifest
  const reasons: string[] = []
  if (m.state !== 'retired') reasons.push(`its working copy is ${m.state}, not retired`)
  if (m.state === 'retired' && m.lifecycle?.phase !== 'released') reasons.push(`its retirement stopped at ${m.lifecycle?.phase ?? 'unknown'}`)
  if (m.lifecycle?.failure) reasons.push(`its last storage operation failed: ${m.lifecycle.failure.message}`)
  for (const [h, s] of Object.entries(m.lifecycle?.hosts ?? {})) if (!['removed', 'absent'].includes(s.state)) reasons.push(`worker ${h} is at ${s.state}: its copy is not settled`)
  const reading = await readRun(ws, ref).catch(e => ({ record: null, problem: { message: (e as Error).message } }))
  if (!reading.record) reasons.push(`its record cannot be read: ${reading.problem?.message ?? 'unknown'}`)
  else reasons.push(...recordReasons(reading.record))
  reasons.push(...c.x.storageBlockers(ws.reg.id, ref))
  const contents = m.state === 'retired' ? await readContents(copy as RunCopy & { manifest: CopyManifest }).catch(e => { reasons.push((e as Error).message); return null }) : null
  const cov = coverageOf(c.backup, ws.reg.id, key, m.generation ?? 0)
  if (m.state === 'retired' && !cov.covered) reasons.push(cov.run || !c.backupProblem ? cov.why! : c.backupProblem!)
  const name = `refs/heads/${runBranch(m.project, ref)}`
  const prior = await readCleanupRecord(ws, ref)
  const repos = repositoriesOf(m, contents)
  const rows: RefRow[] = []
  const leaving = o.leaving ?? new Set<string>()
  for (const r of repos) {
    const row: RefRow = { repository: r.url, path: r.path, ref: name, oid: null, state: 'unknown', eligible: false, why: [] }
    rows.push(row)
    if (!r.url) { row.why.push('it names no remote'); continue }
    if (!managed(c, r.url)) { row.state = 'outside'; row.why.push('this remote is not the configured Gitea; cleanup does not touch it'); continue }
    const listed = await lsRemote(c, r.url)
    if (typeof listed === 'string') { row.why.push(listed); continue }
    const oid = listed.get(name) ?? null
    row.oid = oid
    row.state = oid ? 'present' : 'absent'
    if (!oid || m.state !== 'retired' || !r.key) { if (oid && m.state === 'retired') row.why.push('the archive names no retention repository for it'); continue }
    // Reachable in this run's own retained refs, and those refs are in the backup.
    const bare = retentionRepo(ws, r.key)
    const full = await git(bare, ['rev-list', '--objects', '--quiet', oid], { timeoutMs: 3_600_000 })
    if (full.code !== 0) { row.why.push(`its tip ${oid.slice(0, 12)} is not in retained storage`); continue }
    const holders = await git(bare, ['for-each-ref', '--contains', oid, '--format=%(objectname)', `refs/retained/${ref.workflow}/${ref.run}/`])
    const tips = new Set(holders.stdout.split('\n').filter(Boolean))
    if (!tips.size) { row.why.push(`its tip ${oid.slice(0, 12)} is reachable only through other runs' retained refs`); continue }
    const inBackup = new Set(cov.run?.repositories.filter(p => p.path === r.path).flatMap(p => p.refs.map(v => v.oid)) ?? [])
    if (![...tips].some(t => inBackup.has(t))) row.why.push(`its tip ${oid.slice(0, 12)} is not reached by what the backup holds of this run`)
    if (r.path !== '.' && !(o.only === true)) {
      const pin = await pinProblem(c, m, r.path, r.url, new Set([name, ...leaving])).catch(e => `a pin cannot be checked: ${(e as Error).message}`)
      if (pin) row.why.push(pin)
    }
    row.eligible = row.why.length === 0 && reasons.length === 0
  }
  const present = rows.filter(r => r.state === 'present')
  if (m.state === 'retired' && reasons.length === 0 && !present.some(r => r.eligible)) reasons.push(present.length ? `no branch can go: ${[...new Set(present.flatMap(r => r.why))].join('; ')}` : 'no branch of it is on a remote')
  return { ...base, state: m.state, eligible: reasons.length === 0, reasons, refs: rows, recorded: prior?.entries.filter(e => e.state === 'deleted').length ?? 0 }
}

// ---- reading ------------------------------------------------------------------------------

export interface Inventory { workspace: string; project: string; runs: { ref: string; state: string; refs: { path: string; repository: string; oid: string }[] }[]; unknown: { repository: string; ref: string; oid: string }[]; outside: number; totals: { refs: number; byRepository: Record<string, number> }; unread: string[] }

// Exact repository/ref/object tuples and who owns them. Reads only.
export async function inventory(c: Ctx, ws: Workspace): Promise<Inventory> {
  ws = ws.shared
  const copies = await listCopies(ws)
  const out: Inventory = { workspace: ws.reg.id, project: ws.reg.project ?? ws.reg.id, runs: [], unknown: [], outside: 0, totals: { refs: 0, byRepository: {} }, unread: [] }
  const urls = new Set<string>()
  const owned = new Set<string>()
  for (const copy of copies) {
    const m = copy.manifest
    if (!m) continue
    out.project = m.project
    const name = `refs/heads/${runBranch(m.project, copy.ref)}`
    const refs: Inventory['runs'][number]['refs'] = []
    const contents = m.state === 'retired' ? await readContents(copy as RunCopy & { manifest: CopyManifest }).catch(() => null) : null
    for (const r of repositoriesOf(m, contents)) {
      if (!r.url) continue
      if (!managed(c, r.url)) { out.outside++; continue }
      urls.add(r.url)
      const listed = await lsRemote(c, r.url)
      if (typeof listed === 'string') { if (!out.unread.includes(r.url)) out.unread.push(r.url); continue }
      const oid = listed.get(name)
      owned.add(`${r.url} ${name}`)
      if (oid) refs.push({ path: r.path, repository: r.url, oid })
    }
    out.runs.push({ ref: runKey(copy.ref), state: m.state, refs })
  }
  // Run branches of this project with no copy here: never assumed to be anybody's.
  for (const url of urls) {
    const listed = await lsRemote(c, url)
    if (typeof listed === 'string') continue
    for (const [ref, oid] of listed) {
      const b = BRANCH.exec(ref)
      if (!b || b[1] !== out.project) continue
      out.totals.refs++
      out.totals.byRepository[url] = (out.totals.byRepository[url] ?? 0) + 1
      if (!owned.has(`${url} ${ref}`)) out.unknown.push({ repository: url, ref, oid })
    }
  }
  return out
}

export async function previewWorkspace(c: Ctx, ws: Workspace, runs?: string[]): Promise<{ workspace: string; runs: RunPreview[]; expected: { refs: number; byRepository: Record<string, number> }; limits: string }> {
  const out: RunPreview[] = []
  const wanted = runs?.length ? runs : (await listCopies(ws.shared)).filter(c0 => c0.manifest?.state === 'retired').map(c0 => runKey(c0.ref))
  for (const key of wanted) out.push(await assess(c, ws, parse(key)))
  const byRepository: Record<string, number> = {}
  let refs = 0
  for (const p of out) if (p.eligible) for (const r of p.refs.filter(x => x.eligible)) { refs++; byRepository[r.repository!] = (byRepository[r.repository!] ?? 0) + 1 }
  return { workspace: ws.reg.id, runs: out, expected: { refs, byRepository }, limits: STORAGE_LIMITS }
}

export const selectionFrom = (previews: RunPreview[]): Selection[] => previews.filter(p => p.eligible).map(p => ({ workspace: p.workspace, ref: p.ref, refs: p.refs.filter(r => r.eligible).map(r => ({ repository: r.repository!, ref: r.ref, oid: r.oid! })) }))

// ---- deleting -----------------------------------------------------------------------------

export async function deleteSelection(c: Ctx, wsOf: (id: string) => Promise<Workspace>, selection: Selection[], o: { by: string; dryRun?: boolean; after?: (s: Selection, ref: string) => Promise<void> | void }): Promise<DeleteResult[]> {
  const results: DeleteResult[] = []
  const leavingOf = new Map<string, Set<string>>()
  for (const s of selection) for (const r of s.refs) { if (!leavingOf.has(r.repository)) leavingOf.set(r.repository, new Set()); leavingOf.get(r.repository)!.add(r.ref) }
  for (const s of selection) {
    const ws = (await wsOf(s.workspace)).shared
    const ref = parse(s.ref)
    results.push(await withLock(lifecycleLock(copyDir(ws, ref)), async () => {
      c.remote.clear()
      const leaving = new Set(s.refs.flatMap(r => [...(leavingOf.get(r.repository) ?? [])]))
      const p = await assess(c, ws, ref, { leaving })
      const res: DeleteResult = { workspace: s.workspace, ref: s.ref, outcome: 'done', reasons: [], refs: [] }
      const record: CleanupRecord = await readCleanupRecord(ws, ref) ?? { schema: CLEANUP_SCHEMA, workspace: s.workspace, run: s.ref, entries: [] }
      const copy = await readCopy(ws, ref)
      const generation = copy?.manifest?.generation ?? 0
      const open = (r: { repository: string; ref: string; oid: string }) => record.entries.find(e => e.repository === r.repository && e.ref === r.ref && e.oid === r.oid && (e.state === 'pending' || e.state === 'failed') && e.generation === generation)
      for (const sel of s.refs) {
        const row = p.refs.find(r => r.repository === sel.repository && r.ref === sel.ref)
        // A retry: the earlier attempt may have deleted it after all.
        if (row?.state === 'absent') {
          const e = open(sel)
          if (e && !o.dryRun) { e.state = 'deleted'; e.at = now(); e.detail = 'found gone on a retry' }
          res.refs.push({ ...sel, result: e ? 'deleted' : 'already-absent' })
          continue
        }
        if (!p.eligible) { res.refs.push({ ...sel, result: 'not-selected', detail: 'the run is no longer eligible' }); continue }
        if (!row || !row.eligible) { res.refs.push({ ...sel, result: 'not-selected', detail: row?.why.join('; ') || 'it is not this run\'s branch on this remote' }); continue }
        if (row.oid !== sel.oid) { res.refs.push({ ...sel, result: 'changed', detail: `the remote is at ${row.oid?.slice(0, 12)}, the selection saw ${sel.oid.slice(0, 12)}; left as it is` }); continue }
        if (o.dryRun) { res.refs.push({ ...sel, result: 'deleted', detail: 'dry run' }); continue }
        const entry: CleanupEntry = open(sel) ?? { repository: sel.repository, path: row.path, key: null, ref: sel.ref, oid: sel.oid, state: 'pending', generation, by: o.by, at: now(), backup: c.backup?.id ?? null }
        if (!record.entries.includes(entry)) record.entries.push(entry)
        entry.state = 'pending'
        entry.key = (await readContents(copy as RunCopy & { manifest: CopyManifest }).catch(() => null))?.repositories.find(r => r.path === row.path)?.key ?? null
        await writeRecord(ws, ref, record)
        await o.after?.(s, sel.ref)
        const cwd = entry.key ? retentionRepo(ws, entry.key) : tmpdir()
        const push = await git(cwd, ['push', '--porcelain', `--force-with-lease=${sel.ref}:${sel.oid}`, sel.repository, `:${sel.ref}`], { env: c.env, config: { 'protocol.file.allow': 'always' }, timeoutMs: 120_000 })
        entry.at = now()
        if (push.code === 0) { entry.state = 'deleted'; entry.detail = undefined; res.refs.push({ ...sel, result: 'deleted' }) }
        else if (/stale info|rejected|fetch first/i.test(push.stdout + push.stderr)) { entry.state = 'changed'; entry.detail = 'the remote moved under the deletion; left as it is'; res.refs.push({ ...sel, result: 'changed', detail: entry.detail }) }
        else { entry.state = 'failed'; entry.detail = (push.stderr.trim() || push.stdout.trim()).split('\n')[0]; res.refs.push({ ...sel, result: 'failed', detail: entry.detail }) }
        await writeRecord(ws, ref, record)
      }
      if (record.entries.length) await writeRecord(ws, ref, record)
      if (!p.eligible && !res.refs.some(r => r.result === 'deleted')) { res.outcome = 'refused'; res.reasons = p.reasons }
      else if (res.refs.some(r => r.result !== 'deleted' && r.result !== 'already-absent')) { res.outcome = 'partial'; res.reasons = p.reasons }
      return res
    }, { what: `the lifecycle of run ${s.workspace}:${s.ref}`, timeoutMs: 5_000 }))
  }
  return results
}

// ---- recreating ---------------------------------------------------------------------------

export interface RecreateResult { ref: string; workspace: string; refs: { repository: string; ref: string; oid: string; result: 'recreated' | 'would-recreate' | 'already-there' | 'conflict' | 'failed'; detail?: string }[] }

// A deleted branch back at its recorded object, from retained storage. A branch that
// is there at another object is reported, never overwritten.
export async function recreateBranches(c: Ctx, ws: Workspace, ref: RunRef, o: { by: string; dryRun?: boolean }): Promise<RecreateResult> {
  ws = ws.shared
  return withLock(lifecycleLock(copyDir(ws, ref)), async () => {
    const out: RecreateResult = { workspace: ws.reg.id, ref: runKey(ref), refs: [] }
    const record = await readCleanupRecord(ws, ref)
    if (!record) return out
    c.remote.clear()
    const latest = new Map<string, CleanupEntry>()
    for (const e of record.entries) latest.set(`${e.repository} ${e.ref}`, e)
    for (const e of latest.values()) {
      if (e.state !== 'deleted' && e.state !== 'pending' && e.state !== 'failed') continue
      const row = { repository: e.repository, ref: e.ref, oid: e.oid }
      const listed = await lsRemote(c, e.repository)
      if (typeof listed === 'string') { out.refs.push({ ...row, result: 'failed', detail: listed }); continue }
      const have = listed.get(e.ref)
      if (have === e.oid) { if (!o.dryRun) { e.state = 'recreated'; e.at = now(); e.detail = 'it was there at this object' } out.refs.push({ ...row, result: 'already-there' }); continue }
      if (have) { out.refs.push({ ...row, result: 'conflict', detail: `the remote has it at ${have.slice(0, 12)}; it was deleted at ${e.oid.slice(0, 12)}. Nothing was overwritten.` }); continue }
      if (!e.key) { out.refs.push({ ...row, result: 'failed', detail: 'the record names no retention repository' }); continue }
      const bare = retentionRepo(ws, e.key)
      if ((await git(bare, ['cat-file', '-e', `${e.oid}^{commit}`])).code !== 0) { out.refs.push({ ...row, result: 'failed', detail: `${e.oid.slice(0, 12)} is not in the retention repository ${e.key}` }); continue }
      if (o.dryRun) { out.refs.push({ ...row, result: 'would-recreate' }); continue }
      // The lease says the ref must not exist, and the push itself carries the objects.
      const push = await git(bare, ['push', '--porcelain', `--force-with-lease=${e.ref}:`, e.repository, `${e.oid}:${e.ref}`], { env: c.env, config: { 'protocol.file.allow': 'always' }, timeoutMs: 600_000 })
      if (push.code !== 0) { out.refs.push({ ...row, result: /stale info|rejected|fetch first/i.test(push.stdout + push.stderr) ? 'conflict' : 'failed', detail: (push.stderr.trim() || push.stdout.trim()).split('\n')[0] }); continue }
      e.state = 'recreated'
      e.at = now()
      e.detail = `recreated by ${o.by}`
      out.refs.push({ ...row, result: 'recreated' })
    }
    if (!o.dryRun) await writeRecord(ws, ref, record)
    return out
  }, { what: `the lifecycle of run ${ws.reg.id}:${runKey(ref)}`, timeoutMs: 5_000 })
}
