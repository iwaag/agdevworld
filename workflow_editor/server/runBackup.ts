// Backup and recovery of retired runs (improve_wfrun p3, docs/storage.md *Backup
// and recovery*). A generation is a folder on another machine holding everything
// a retired run needs to be read and restored; `LATEST` names the newest one whose
// every file and retained ref was checked at the destination.
//
//   <path>/staging/<id>.partial        being written; never read
//   <path>/generations/<id>/           complete and verified
//   <path>/LATEST                      moved only after verification, by rename
//
// The consistency boundary is one retired run: its manifest and record are copied
// holding its lifecycle and record locks, its archive is immutable until its
// generation changes, a retention repository is copied holding the lock retirement
// fetches under, and each run is read again after every transfer. A run that changed
// fails the generation by name. Stores are consistent one by one (VACUUM INTO) and
// are context; a retired run's authority is its own record.
//
// This is not disaster recovery for the service: Gitea, workspaces and the trees of
// runs that are not retired are outside it, and the manifest says which runs those are.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { withLock } from './lock.ts'
import { workspaces } from './migrate.ts'
import { loadRegistry, recordedWorkspace } from './registry.ts'
import { ARCHIVE, CLEANUP_RECORD, FILES, lifecycleLock, readContents, restoreRun, retainedFile, retentionRepo, RETENTION_DIR, sha256File, verifyRetained, type RetainedRef } from './retention.ts'
import { recordFolderOf } from './runrecord.ts'
import { readRun, readRunFile, RUN_FILE } from './runs.ts'
import { copyByReceipt, copyDir, listCopies, readCopy, reserve, runSpace, usedRuns, type CopyManifest, type RunCopy } from './runspace.ts'
import { checkOutput, resolveRef, setShareArea } from './shares.ts'
import { ExecStore } from './exec.ts'
import { RequestError, Workspace } from './workspace.ts'
import { runFolder, runKey, RUNS_ROOT, type RunRecord, type RunRef } from '../shared/run.ts'

export const BACKUP_SCHEMA = 'ag.wfe-run-backup.v1'
export const BACKUP_CONFIG = 'run-backup.json'
export const RECOVERY_MARKER = 'recovery.json'
const STORES = ['exec', 'notify', 'intake', 'present', 'delegate', 'conversations']
// Copied as they are; none holds a secret. Token files and SSH keys are named in the manifest, never copied.
const SETTINGS = ['registry.json', 'workers.json', 'shares.json', 'system.json', 'gitea.json', 'zulip.json', 'present.json', 'node-catalog.json', 'attachments.json', 'challenges.json', 'conversations.json', BACKUP_CONFIG]
const CREDENTIALS = ['the Gitea token files gitea.json names', 'each worker\'s token (workers.json)', 'the SSH key this backup uses']
const RUN_LOCK_MS = 30_000
const RETENTION_LOCK_MS = 600_000

export interface BackupConfig { file: string | null; host: string | null; path: string; ssh: string[]; keep: number; checkouts: Record<string, string> }
export interface BackupRepo { path: string; key: string; url: string | null; head: string | null; branch: string | null; refs: RetainedRef[] }
export interface BackupRun {
  workspace: string; project: string; ref: string; generation: number; covered: boolean; reasons: string[]; captured: string; seq: number | null; receipt: string | null
  repositories: BackupRepo[]; archive: { sha256: string | null; bytes: number; files: number; contents: string } | null
  workerArchives: Record<string, { sha256: string; bytes: number }>; outputs: { id: string; ref: string; path: string; share: string; files: number }[]
}
export interface BackupManifest {
  schema: string; id: string; started: string; finished: string; by: string
  source: { host: string; release: { agdevworld?: string; tree?: string } | null; checkouts: Record<string, string | null>; node: string; git: string }
  settings: string[]; stores: { name: string; at: string; bytes: number }[]
  runs: BackupRun[]; identityOnly: { workspace: string; ref: string; state: string; receipt: string | null }[]; legacy: { workspace: string; ref: string }[]
  retention: { workspace: string; key: string; refs: number; bytes: number }[]
  files: number; bytes: number; hashes: string; degraded: string[]; credentials: string[]; restore: string
}
export interface BackupStatus {
  last: { id: string; at: string; covered: number; notCovered: string[]; bytes: number; files: number; destination: string } | null
  lastAttempt: { at: string; outcome: string; id: string | null; failures: string[] } | null
  history: { at: string; outcome: string; id: string | null; seconds: number }[]
}
export type Stage = 'staged' | 'transferred' | 'hashed' | 'verified'
export interface CreateOptions { by: string; hook?: (stage: Stage, c: { partial: string; dest: Dest }) => Promise<void> | void }

const now = () => new Date().toISOString()
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const statusFile = (area: string) => join(area, '.local', 'run-backup', 'status.json')
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

export async function loadBackupConfig(area: string): Promise<BackupConfig | null> {
  const file = join(area, BACKUP_CONFIG)
  const text = await readTextOrNull(file)
  if (text === null) return null
  const o = JSON.parse(text) as Partial<BackupConfig>
  if (typeof o.path !== 'string' || !o.path.startsWith('/')) throw new RequestError(409, `${file} needs {"path" (absolute on that host), "host"?, "ssh"?, "keep"?, "checkouts"?}`)
  return { file, host: o.host ?? null, path: o.path.replace(/\/+$/, ''), ssh: o.ssh ?? ['ssh'], keep: Math.max(1, o.keep ?? 7), checkouts: o.checkouts ?? {} }
}
const fromPath = (path: string): BackupConfig => ({ file: null, host: null, path: path.replace(/\/+$/, ''), ssh: [], keep: 7, checkouts: {} })

function run(cmd: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('error', e => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }))
    p.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    p.stdin.on('error', () => null)
    p.stdin.end(input)
  })
}

// The destination: another machine over SSH, or a folder on this one.
export class Dest {
  readonly c: BackupConfig
  constructor(c: BackupConfig) { this.c = c }
  get where() { return this.c.host ? `${this.c.host}:${this.c.path}` : this.c.path }
  sh(script: string) { return run(this.c.host ? [...this.c.ssh, this.c.host, 'sh -s'] : ['sh', '-s'], script) }
  private spec(rel: string) { const p = `${this.c.path}/${rel}`; return this.c.host ? `${this.c.host}:${p}` : p }
  private transport() { return this.c.host ? ['-e', this.c.ssh.join(' ')] : [] }
  async push(src: string, rel: string, link?: string) {
    const p = `${this.c.path}/${rel}`
    const prev = link ? `${this.c.path}/${link}` : ''
    const m = await this.sh(`umask 077; mkdir -p ${q(p)}${prev ? ` && if [ -d ${q(prev)} ]; then echo link; fi` : ''}`)
    if (m.code !== 0) throw new Error(`cannot create ${this.where}/${rel}: ${m.stderr.trim()}`)
    const r = await run(['rsync', '-a', ...(m.stdout.includes('link') ? [`--link-dest=${prev}`] : []), ...this.transport(), `${src.replace(/\/+$/, '')}/`, `${this.spec(rel)}/`])
    if (r.code !== 0) throw new Error(`rsync to ${this.where}/${rel} failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`)
  }
  async pull(rel: string, into: string) {
    await mkdir(into, { recursive: true })
    const r = await run(['rsync', '-a', ...this.transport(), `${this.spec(rel).replace(/\/+$/, '')}/`, `${into}/`])
    if (r.code !== 0) throw new Error(`rsync from ${this.where}/${rel} failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`)
  }
  async read(rel: string): Promise<string | null> {
    const r = await this.sh(`cat ${q(`${this.c.path}/${rel}`)}`)
    return r.code === 0 ? r.stdout : null
  }
  async write(rel: string, text: string) {
    const r = await this.sh(`cat > ${q(`${this.c.path}/${rel}`)} <<'WFE_BACKUP_EOF'\n${text}${text.endsWith('\n') ? '' : '\n'}WFE_BACKUP_EOF\n`)
    if (r.code !== 0) throw new Error(`cannot write ${this.where}/${rel}: ${r.stderr.trim()}`)
  }
  async generations(): Promise<string[]> {
    const r = await this.sh(`ls -1 ${q(`${this.c.path}/generations`)} 2>/dev/null || true`)
    return r.stdout.split('\n').filter(Boolean).sort()
  }
  async latest(): Promise<string | null> { return (await this.read('LATEST'))?.trim() || null }
}

// ---- hashes -------------------------------------------------------------------------------

type Hashes = Map<string, string>

function assertListable(rel: string) { if (/[\n\\]/.test(rel)) throw new Error(`${rel}: a path with a newline or a backslash cannot be listed for verification`) }

async function hashTree(dir: string, prefix: string, into: Hashes, skip?: (rel: string) => boolean): Promise<number> {
  let bytes = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = join(dir, e.name), rel = `${prefix}/${e.name}`
    if (skip?.(rel)) continue
    if (e.isDirectory()) bytes += await hashTree(abs, rel, into, skip)
    else if (e.isFile()) { assertListable(rel); into.set(rel, await sha256File(abs)); bytes += (await stat(abs)).size }
  }
  return bytes
}

const failedLines = (out: string) => out.split('\n').map(l => /^(.*): FAILED/.exec(l)?.[1]).filter((x): x is string => !!x)

// Every listed file, then every retained ref with Git, in one folder wherever it is.
async function checkFolder(sh: (s: string) => Promise<{ code: number; stdout: string; stderr: string }>, root: string, m: Pick<BackupManifest, 'runs'>): Promise<string[]> {
  const bad: string[] = []
  const sums = await sh(`cd ${q(root)} && if command -v sha256sum >/dev/null 2>&1; then sha256sum --quiet -c hashes.sha256; else shasum -a 256 --quiet -c hashes.sha256; fi 2>&1`)
  if (sums.code !== 0) {
    const f = failedLines(sums.stdout)
    bad.push(...(f.length ? f : [`hashes.sha256: ${(sums.stdout + sums.stderr).trim().split('\n')[0]}`]))
  }
  const lines: string[] = []
  const seen = new Set<string>()
  for (const r of m.runs) for (const p of r.repositories) {
    const repo = `retention/${r.workspace}/${p.key}.git`
    for (const x of p.refs) {
      if (seen.has(`${repo} ${x.oid}`)) continue
      seen.add(`${repo} ${x.oid}`)
      const test = x.type === 'commit' ? `git -C ${q(repo)} rev-list --objects --quiet ${x.oid}` : `git -C ${q(repo)} cat-file -e ${x.oid}`
      lines.push(`${test} >/dev/null 2>&1 || echo ${q(`${repo}: retained ${x.oid.slice(0, 12)} is not complete`)}`)
    }
  }
  const refs = await sh(`cd ${q(root)} || exit 1\n${lines.join('\n')}\n`)
  if (refs.code !== 0) bad.push(`retained refs could not be checked: ${refs.stderr.trim()}`)
  bad.push(...refs.stdout.split('\n').filter(Boolean))
  return bad
}

// Which runs a failed path belongs to: a shared retention repository affects all of its runs.
export function affectedRuns(m: BackupManifest, paths: string[]): string[] {
  const out = new Set<string>()
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, '')
    const parts = p.split('/')
    if (parts[0] === 'runs') out.add(`${parts[1]}:${parts[2]}/${parts[3]}`)
    else if (parts[0] === 'retention') { for (const r of m.runs) if (r.workspace === parts[1] && r.repositories.some(x => `${x.key}.git` === parts[2])) out.add(`${r.workspace}:${r.ref}`) }
    else if (parts[0] === 'outputs') { for (const r of m.runs) if (r.outputs.some(o => p.startsWith(`outputs/${o.share}/${o.path}`))) out.add(`${r.workspace}:${r.ref}`) }
    else for (const r of m.runs) out.add(`${r.workspace}:${r.ref}`)
  }
  return [...out].sort()
}

// ---- capture ------------------------------------------------------------------------------

async function copyRunSnapshot(c: RunCopy, into: string) {
  await mkdir(into, { recursive: true })
  await cp(join(c.dir, 'copy.json'), join(into, 'copy.json'), { preserveTimestamps: true })
  if (await stat(join(c.dir, 'record')).catch(() => null)) await cp(join(c.dir, 'record'), join(into, 'record'), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  if (await stat(join(c.dir, CLEANUP_RECORD)).catch(() => null)) await cp(join(c.dir, CLEANUP_RECORD), join(into, CLEANUP_RECORD), { preserveTimestamps: true })
}

const fingerprint = (m: CopyManifest) => JSON.stringify({ state: m.state, generation: m.generation ?? 0, archive: m.lifecycle?.archive ? { s: m.lifecycle.archive.sha256, c: m.lifecycle.archive.contents } : null })
const retainedRefsOf = async (ws: Workspace, ref: RunRef, key: string) => (await git(retentionRepo(ws, key), ['for-each-ref', '--format=%(objectname) %(refname)', `refs/retained/${ref.workflow}/${ref.run}/`])).stdout

interface Captured { ws: Workspace; c: RunCopy & { manifest: CopyManifest }; run: BackupRun; fingerprint: string; refs: Record<string, string> }

// One retired run's control data and the checks that do not need its bytes moved.
async function captureRetired(ws: Workspace, c: RunCopy & { manifest: CopyManifest }, staging: string): Promise<Captured> {
  const key = runKey(c.ref)
  const m = c.manifest
  const out: BackupRun = { workspace: ws.reg.id, project: m.project, ref: key, generation: m.generation ?? 0, covered: true, reasons: [], captured: now(), seq: null, receipt: m.receipt ?? null, repositories: [], archive: null, workerArchives: {}, outputs: [] }
  const into = join(staging, 'runs', ws.reg.id, c.ref.workflow, c.ref.run)
  const recordFile = join(recordFolderOf(c.dir, c.ref), RUN_FILE)
  const fresh = await withLock(lifecycleLock(c.dir), () => withLock(recordFile, async () => {
    const again = await readCopy(ws, c.ref)
    if (again?.manifest?.state !== 'retired') throw new Error(`run ${key} is no longer retired (${again?.manifest?.state ?? 'no copy'}); it changed during capture`)
    await copyRunSnapshot(again, into)
    return again as Captured['c']
  }, { what: `run ${key}`, timeoutMs: RUN_LOCK_MS }), { what: `the lifecycle of run ${key}`, timeoutMs: RUN_LOCK_MS })
  const refs: Record<string, string> = {}
  try {
    const contents = await readContents(fresh)
    out.repositories = contents.repositories.map(r => ({ path: r.path, key: r.key, url: r.url, head: r.head, branch: r.branch, refs: r.refs }))
    for (const b of await verifyRetained(ws, c.ref, contents.repositories)) { out.covered = false; out.reasons.push(b) }
    for (const r of new Set(contents.repositories.map(x => x.key))) refs[r] = await retainedRefsOf(ws, c.ref, r)
    const a = fresh.manifest.lifecycle?.archive
    if (a) out.archive = { sha256: a.sha256, bytes: a.bytes, files: a.files, contents: a.contents }
  } catch (e) { out.covered = false; out.reasons.push((e as Error).message) }
  for (const [host, h] of Object.entries(fresh.manifest.lifecycle?.hosts ?? {})) {
    if (!h.archive) continue
    const file = join(c.dir, 'worker-archive', host, FILES)
    if (await sha256File(file).catch(() => null) === h.archive.sha256) out.workerArchives[host] = h.archive
    else { out.covered = false; out.reasons.push(`worker ${host}'s archive is missing or does not match its recorded checksum`) }
  }
  const reading = await readRun(ws, c.ref).catch(e => ({ record: null, problem: { message: (e as Error).message } }))
  const record = reading.record as RunRecord | null
  if (!record) { out.covered = false; out.reasons.push(`its record cannot be read: ${reading.problem?.message ?? 'unknown'}`) }
  else {
    out.seq = record.seq ?? null
    const space = await runSpace(ws, c.ref)
    for (const o of Object.values(record.outputs ?? {})) {
      const check = await checkOutput(space, record, o.id).catch(e => ({ status: 'unavailable', detail: (e as Error).message }))
      if (check.status !== 'verified') { out.covered = false; out.reasons.push(`output ${o.id}: ${check.status} (${check.detail})`); continue }
      const r = await resolveRef(o.ref)
      const files = JSON.parse(await readFile(join(recordFolderOf(c.dir, c.ref), 'outputs', `${o.id}.json`), 'utf8')).files as { path: string }[]
      out.outputs.push({ id: o.id, ref: o.ref, share: r.share, path: r.path, files: files.length })
    }
  }
  return { ws, c: fresh, run: out, fingerprint: fingerprint(fresh.manifest), refs }
}

export async function createBackup(x: ExecStore, o: CreateOptions): Promise<{ outcome: 'published' | 'degraded' | 'failed'; id: string | null; failures: string[]; manifest?: BackupManifest }> {
  const started = Date.now()
  const area = x.ctx.area
  const cfg = await loadBackupConfig(area)
  if (!cfg) throw new RequestError(409, `no backup destination is configured (${join(area, BACKUP_CONFIG)})`)
  const dest = new Dest(cfg)
  const id = `${now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(2).toString('hex')}`
  const work = join(area, '.local', 'run-backup')
  await mkdir(work, { recursive: true })
  const staging = join(work, 'staging', id)
  return withLock(join(work, 'create'), async () => {
    const finish = async (outcome: 'published' | 'degraded' | 'failed', failures: string[], manifest?: BackupManifest) => {
      await rm(staging, { recursive: true, force: true })
      const s = await readStatus(area)
      s.lastAttempt = { at: now(), outcome, id: outcome === 'failed' ? null : id, failures }
      s.history = [...s.history, { at: now(), outcome, id: outcome === 'failed' ? null : id, seconds: Math.round((Date.now() - started) / 1000) }].slice(-30)
      if (outcome === 'published' && manifest) s.last = { id, at: manifest.finished, covered: manifest.runs.filter(r => r.covered).length, notCovered: manifest.runs.filter(r => !r.covered).map(r => `${r.workspace}:${r.ref}`), bytes: manifest.bytes, files: manifest.files, destination: dest.where }
      await mkdir(dirname(statusFile(area)), { recursive: true })
      await atomicWrite(statusFile(area), `${JSON.stringify(s, null, 1)}\n`)
      return { outcome, id: outcome === 'failed' ? null : id, failures, manifest }
    }
    const partialRel = `staging/${id}.partial`
    const partial = `${cfg.path}/${partialRel}`
    try {
      await rm(join(work, 'staging'), { recursive: true, force: true })
      const ready = await dest.sh(`umask 077; mkdir -p ${q(cfg.path)} ${q(`${cfg.path}/generations`)} && chmod 700 ${q(cfg.path)} && rm -rf ${q(`${cfg.path}/staging`)} && mkdir -p ${q(partial)}`)
      if (ready.code !== 0) throw new Error(`the destination ${dest.where} is not usable: ${ready.stderr.trim()}`)
      const prev = await dest.latest()
      const link = (rel: string) => (prev ? `generations/${prev}/${rel}` : undefined)
      await mkdir(staging, { recursive: true })
      const hashes: Hashes = new Map()
      const failures: string[] = []

      // Settings and stores, each consistent on its own.
      const settings: string[] = []
      for (const f of SETTINGS) if (await stat(join(area, f)).catch(() => null)) { await mkdir(join(staging, 'settings'), { recursive: true }); await cp(join(area, f), join(staging, 'settings', f), { preserveTimestamps: true }); settings.push(f) }
      const stores: BackupManifest['stores'] = []
      for (const s of STORES) {
        const file = join(area, '.local', s, `${s}.sqlite`)
        if (!(await stat(file).catch(() => null))) continue
        await mkdir(join(staging, 'stores', s), { recursive: true })
        const to = join(staging, 'stores', s, `${s}.sqlite`)
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(file, { readOnly: true })
        try { db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`) } finally { db.close() }
        stores.push({ name: s, at: now(), bytes: (await stat(to)).size })
      }

      // Runs: retired runs in full, every other run for its identity.
      const captured: Captured[] = []
      const identityOnly: BackupManifest['identityOnly'] = []
      const legacy: BackupManifest['legacy'] = []
      const all = await workspaces(x)
      for (const ws of all) {
        for (const c of await listCopies(ws)) {
          if (c.manifest?.state === 'retired') { captured.push(await captureRetired(ws, c as Captured['c'], staging)); continue }
          identityOnly.push({ workspace: ws.reg.id, ref: runKey(c.ref), state: c.manifest?.state ?? 'damaged', receipt: c.manifest?.receipt ?? null })
          if (!c.manifest) continue
          const record = join(recordFolderOf(c.dir, c.ref), RUN_FILE)
          await withLock(record, () => copyRunSnapshot(c, join(staging, 'runs', ws.reg.id, c.ref.workflow, c.ref.run)), { what: `run ${runKey(c.ref)}`, timeoutMs: RUN_LOCK_MS })
            .catch(e => failures.push(`${ws.reg.id}:${runKey(c.ref)}: identity snapshot: ${(e as Error).message}`))
        }
        for (const wf of await readdir(join(ws.root, RUNS_ROOT), { withFileTypes: true }).catch(() => [])) {
          if (!wf.isDirectory()) continue
          for (const r of await readdir(join(ws.root, RUNS_ROOT, wf.name), { withFileTypes: true }).catch(() => [])) if (r.isDirectory() && !(await stat(copyDir(ws, { workflow: wf.name, run: r.name })).catch(() => null))) legacy.push({ workspace: ws.reg.id, ref: `${wf.name}/${r.name}` })
        }
      }
      if (failures.length) throw new Error(failures.join('; '))
      let bytes = await hashTree(staging, '.', hashes)
      await o.hook?.('staged', { partial, dest })
      await dest.push(staging, partialRel, prev ? `generations/${prev}` : undefined)

      // Archives, against what their manifests recorded.
      for (const k of captured) {
        const rel = `runs/${k.ws.reg.id}/${k.c.ref.workflow}/${k.c.ref.run}`
        if (await stat(join(k.c.dir, ARCHIVE)).catch(() => null)) {
          await dest.push(join(k.c.dir, ARCHIVE), `${partialRel}/${rel}/${ARCHIVE}`, link(`${rel}/${ARCHIVE}`))
          bytes += await hashTree(join(k.c.dir, ARCHIVE), `./${rel}/${ARCHIVE}`, hashes, p => p.endsWith(`/${FILES}`))
          if (k.run.archive?.sha256) { hashes.set(`./${rel}/${ARCHIVE}/${FILES}`, k.run.archive.sha256); bytes += k.run.archive.bytes }
        }
        for (const [host, a] of Object.entries(k.run.workerArchives)) {
          const w = `${rel}/worker-archive/${host}`
          await dest.push(join(k.c.dir, 'worker-archive', host), `${partialRel}/${w}`, link(w))
          hashes.set(`./${w}/${FILES}`, a.sha256)
          bytes += a.bytes
        }
      }

      // Retention repositories, whole, under the lock retirement fetches under.
      const retention: BackupManifest['retention'] = []
      for (const ws of all) {
        const dir = join(ws.shared.root, RETENTION_DIR)
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory() || !e.name.endsWith('.git')) continue
          const bare = join(dir, e.name), key = e.name.slice(0, -'.git'.length), rel = `retention/${ws.reg.id}/${e.name}`
          await withLock(`${bare}.lock`, async () => {
            const n = await hashTree(bare, `./${rel}`, hashes)
            await dest.push(bare, `${partialRel}/${rel}`, link(rel))
            bytes += n
            retention.push({ workspace: ws.reg.id, key, refs: (await git(bare, ['for-each-ref'])).stdout.split('\n').filter(Boolean).length, bytes: n })
          }, { what: `the retention repository ${key}`, timeoutMs: RETENTION_LOCK_MS })
        }
      }

      // Outputs the archives count on: the live share is no backup of itself.
      const pushed = new Set<string>()
      for (const k of captured) for (const out of k.run.outputs) {
        const rel = `outputs/${out.share}/${out.path.replace(/\/+$/, '')}`
        const files = JSON.parse(await readFile(join(recordFolderOf(k.c.dir, k.c.ref), 'outputs', `${out.id}.json`), 'utf8')).files as { path: string; sha256: string; size?: number }[]
        for (const f of files) { assertListable(`${rel}/${f.path}`); hashes.set(`./${rel}/${f.path}`, f.sha256) }
        if (pushed.has(rel)) continue
        pushed.add(rel)
        const r = await resolveRef(out.ref)
        await dest.push(r.abs!, `${partialRel}/${rel}`, link(rel))
        bytes += files.reduce((n, f) => n + (f.size ?? 0), 0)
      }
      await o.hook?.('transferred', { partial, dest })

      // What was read at the start must still be so: a change means this generation mixes two states.
      const changed: string[] = []
      for (const k of captured) {
        const again = await readCopy(k.ws, k.c.ref)
        if (!again?.manifest || fingerprint(again.manifest) !== k.fingerprint) { changed.push(`${k.run.workspace}:${k.run.ref}: its storage state changed during capture`); continue }
        for (const [key, refs] of Object.entries(k.refs)) if (await retainedRefsOf(k.ws, k.c.ref, key) !== refs) changed.push(`${k.run.workspace}:${k.run.ref}: its retained refs changed during capture`)
      }
      if (changed.length) throw new Error(changed.join('; '))

      const list = `${[...hashes].map(([p, h]) => `${h}  ${p}`).sort().join('\n')}\n`
      await dest.write(`${partialRel}/hashes.sha256`, list)
      await o.hook?.('hashed', { partial, dest })
      const runs = captured.map(k => k.run)
      const bad = await checkFolder(s => dest.sh(s), partial, { runs })
      if (bad.length) throw new Error(`the staged generation does not verify (nothing was published): ${bad.slice(0, 8).join('; ')}${bad.length > 8 ? `; and ${bad.length - 8} more` : ''}`)
      await o.hook?.('verified', { partial, dest })

      // A generation that lost a run the last one covered does not replace it. A run nothing
      // has covered yet stays reported as not covered without holding the others back.
      const degraded: string[] = []
      if (prev) {
        const last = JSON.parse(await dest.read(`generations/${prev}/manifest.json`) ?? 'null') as BackupManifest | null
        for (const r of runs) if (!r.covered && last?.runs.some(l => l.covered && l.workspace === r.workspace && l.ref === r.ref)) degraded.push(`${r.workspace}:${r.ref}: covered by ${prev}, not now: ${r.reasons[0]}`)
      }
      const release = JSON.parse(await readTextOrNull(join(area, 'service', 'current', 'RELEASE.json')) ?? 'null') as BackupManifest['source']['release']
      const checkouts: Record<string, string | null> = {}
      for (const [name, path] of Object.entries(cfg.checkouts)) checkouts[name] = (await git(path, ['rev-parse', 'HEAD'])).stdout.trim() || null
      const manifest: BackupManifest = {
        schema: BACKUP_SCHEMA, id, started: new Date(started).toISOString(), finished: now(), by: o.by,
        source: { host: hostname(), release, checkouts, node: process.version, git: (await git(area, ['--version'])).stdout.trim() },
        settings, stores, runs, identityOnly, legacy, retention, files: hashes.size, bytes, hashes: sha(list), degraded, credentials: CREDENTIALS,
        restore: 'wfe backup restore --from <this folder\'s parent> --generation <id> --into <empty folder>; then wfe backup rehearse --into <that folder>. docs/storage.md, Backup and recovery.',
      }
      const text = `${JSON.stringify(manifest, null, 1)}\n`
      await dest.write(`${partialRel}/manifest.json`, text)
      await dest.write(`${partialRel}/manifest.sha256`, sha(text))
      const pub = await dest.sh(`mv ${q(partial)} ${q(`${cfg.path}/generations/${id}`)}${degraded.length ? '' : ` && printf '%s\\n' ${q(id)} > ${q(`${cfg.path}/LATEST.new`)} && mv ${q(`${cfg.path}/LATEST.new`)} ${q(`${cfg.path}/LATEST`)}`}`)
      if (pub.code !== 0) throw new Error(`publication failed: ${pub.stderr.trim()}`)
      if (degraded.length) return await finish('degraded', degraded, manifest)
      await expire(dest, cfg.keep)
      return await finish('published', [], manifest)
    } catch (e) {
      return finish('failed', [(e as Error).message])
    }
  }, { what: 'a backup', timeoutMs: 2_000 })
}

// Older generations go only after a newer one verified; LATEST always stays.
export async function expire(dest: Dest, keep: number): Promise<string[]> {
  const latest = await dest.latest()
  const all = await dest.generations()
  const gone = all.slice(0, Math.max(0, all.length - keep)).filter(g => g !== latest)
  if (gone.length) await dest.sh(gone.map(g => `rm -rf ${q(`${dest.c.path}/generations/${g}`)}`).join('\n'))
  return gone
}

// ---- reading what exists ------------------------------------------------------------------

export async function readStatus(area: string): Promise<BackupStatus> {
  return JSON.parse(await readTextOrNull(statusFile(area)) ?? 'null') ?? { last: null, lastAttempt: null, history: [] }
}

export async function readManifest(dest: Dest, id?: string | null): Promise<BackupManifest | null> {
  const g = id ?? await dest.latest()
  if (!g) return null
  const text = await dest.read(`generations/${g}/manifest.json`)
  if (!text) return null
  const m = JSON.parse(text) as BackupManifest
  return m.schema === BACKUP_SCHEMA ? m : null
}

export interface VerifyResult { id: string | null; ok: boolean; failures: string[]; affected: string[] }

export async function verifyGeneration(dest: Dest, id?: string | null): Promise<VerifyResult> {
  const g = id ?? await dest.latest()
  if (!g) return { id: null, ok: false, failures: ['no verified generation exists'], affected: [] }
  const text = await dest.read(`generations/${g}/manifest.json`)
  const sum = (await dest.read(`generations/${g}/manifest.sha256`))?.trim()
  if (!text) return { id: g, ok: false, failures: ['its manifest cannot be read'], affected: [] }
  if (sum !== sha(text)) return { id: g, ok: false, failures: ['its manifest does not match its checksum'], affected: [] }
  const m = JSON.parse(text) as BackupManifest
  if (sha(await dest.read(`generations/${g}/hashes.sha256`) ?? '') !== m.hashes) return { id: g, ok: false, failures: ['its file list does not match the manifest'], affected: m.runs.map(r => `${r.workspace}:${r.ref}`) }
  const bad = await checkFolder(s => dest.sh(s), `${dest.c.path}/generations/${g}`, m)
  return { id: g, ok: bad.length === 0, failures: bad, affected: affectedRuns(m, bad) }
}

// What a consumer can rely on now: a run is covered when the latest generation
// holds it, complete, at the generation it has now.
export function coverageOf(m: BackupManifest | null, workspace: string, ref: string, generation: number): { covered: boolean; run: BackupRun | null; why: string | null } {
  if (!m) return { covered: false, run: null, why: 'no verified backup generation exists' }
  const r = m.runs.find(x => x.workspace === workspace && x.ref === ref)
  if (!r) return { covered: false, run: null, why: `backup ${m.id} does not hold it in full` }
  if (!r.covered) return { covered: false, run: r, why: `backup ${m.id} could not cover it: ${r.reasons[0]}` }
  if (r.generation !== generation) return { covered: false, run: r, why: `backup ${m.id} holds its generation ${r.generation}; it is at ${generation} now` }
  return { covered: true, run: r, why: null }
}

export async function backupOverview(x: ExecStore): Promise<Record<string, unknown>> {
  const area = x.ctx.area
  const cfg = await loadBackupConfig(area)
  const s = await readStatus(area)
  const retired: { workspace: string; ref: string; generation: number }[] = []
  for (const ws of await workspaces(x)) for (const c of await listCopies(ws)) if (c.manifest?.state === 'retired') retired.push({ workspace: ws.reg.id, ref: runKey(c.ref), generation: c.manifest.generation ?? 0 })
  const dest = cfg ? new Dest(cfg) : null
  const reach = dest ? await dest.latest().catch(() => null) : null
  const m = dest ? await readManifest(dest).catch(() => null) : null
  const uncovered = retired.filter(r => !coverageOf(m, r.workspace, r.ref, r.generation).covered).map(r => `${r.workspace}:${r.ref}`)
  return {
    configured: !!cfg, destination: dest?.where ?? null, latest: reach, status: s, ageSeconds: s.last ? Math.round((Date.now() - Date.parse(s.last.at)) / 1000) : null,
    generations: dest ? await dest.generations().catch(() => []) : [], retired: retired.length, uncovered,
    outside: m ? { identityOnly: m.identityOnly.length, legacy: m.legacy.length } : null, keep: cfg?.keep ?? null,
  }
}

// ---- restoring into an isolated area ------------------------------------------------------

export interface RestoreOutcome { id: string; into: string; area: string; files: number; bytes: number; seconds: number; failures: string[]; affected: string[] }

export async function restoreGeneration(cfg: BackupConfig, o: { generation?: string; into: string }): Promise<RestoreOutcome> {
  const t0 = Date.now()
  const dest = new Dest(cfg)
  const id = o.generation ?? await dest.latest()
  if (!id) throw new RequestError(409, `${dest.where} has no verified generation`)
  const have = await readdir(o.into).catch(() => [])
  if (have.length) throw new RequestError(409, `${o.into} is not empty; restore into a new folder`)
  const generation = join(o.into, 'generation')
  await dest.pull(`generations/${id}`, generation)
  const text = await readFile(join(generation, 'manifest.json'), 'utf8').catch(() => null)
  if (text === null) throw new RequestError(409, `generation ${id} has no manifest; it cannot be used`)
  const m = JSON.parse(text) as BackupManifest
  const local = new Dest(fromPath(generation))
  const bad = await checkFolder(s => local.sh(s), generation, m)
  const failures = [...bad]
  if ((await readFile(join(generation, 'manifest.sha256'), 'utf8').catch(() => '')).trim() !== sha(text)) failures.push('manifest.json: does not match its checksum')
  const out: RestoreOutcome = { id, into: o.into, area: join(o.into, 'area'), files: m.files, bytes: m.bytes, seconds: 0, failures, affected: affectedRuns(m, bad) }
  if (!failures.length) await materialize(o.into, generation, m)
  out.seconds = Math.round((Date.now() - t0) / 1000)
  return out
}

// A working area out of the generation, with host paths remapped and logical identities
// as they were. No Gitea, Zulip, Slack, presentation or worker setting is carried over,
// so nothing here can reach live systems; the marker refuses the operating commands too.
async function materialize(into: string, generation: string, m: BackupManifest) {
  const area = join(into, 'area')
  await mkdir(area, { recursive: true })
  const reg = JSON.parse(await readFile(join(generation, 'settings', 'registry.json'), 'utf8')) as { workspaces: { id: string; path: string }[] }
  const roots = new Map<string, string>()
  for (const w of reg.workspaces) { w.path = join(area, w.id); roots.set(w.id, w.path); await mkdir(w.path, { recursive: true }) }
  await writeFile(join(area, 'registry.json'), `${JSON.stringify(reg, null, 1)}\n`)
  const shares = JSON.parse(await readTextOrNull(join(generation, 'settings', 'shares.json')) ?? '{"shares":{}}') as { shares: Record<string, { root: string }> }
  for (const [name, s] of Object.entries(shares.shares)) {
    s.root = join(into, 'shares', name)
    await mkdir(s.root, { recursive: true })
    await writeFile(join(s.root, '.wfe-share.json'), `${JSON.stringify({ share: name })}\n`)
  }
  await writeFile(join(area, 'shares.json'), `${JSON.stringify(shares, null, 1)}\n`)
  for (const s of await readdir(join(generation, 'stores')).catch(() => [])) {
    await mkdir(join(area, '.local', s), { recursive: true })
    await cp(join(generation, 'stores', s), join(area, '.local', s), { recursive: true })
  }
  for (const ws of await readdir(join(generation, 'runs')).catch(() => [])) {
    if (!roots.has(ws)) continue
    const to = join(roots.get(ws)!, '.local', 'wfe', 'runs')
    await mkdir(dirname(to), { recursive: true })
    await cp(join(generation, 'runs', ws), to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  }
  for (const ws of await readdir(join(generation, 'retention')).catch(() => [])) {
    if (!roots.has(ws)) continue
    await mkdir(join(roots.get(ws)!, RETENTION_DIR), { recursive: true })
    await cp(join(generation, 'retention', ws), join(roots.get(ws)!, RETENTION_DIR), { recursive: true, preserveTimestamps: true })
  }
  for (const s of await readdir(join(generation, 'outputs')).catch(() => [])) await cp(join(generation, 'outputs', s), join(into, 'shares', s), { recursive: true, preserveTimestamps: true })
  // Run numbers of runs recorded only in a project tree stay taken.
  for (const l of m.legacy) if (roots.has(l.workspace)) await mkdir(join(roots.get(l.workspace)!, RUNS_ROOT, l.ref), { recursive: true })
  await writeFile(join(area, RECOVERY_MARKER), `${JSON.stringify({ schema: 'ag.wfe-recovery.v1', generation: m.id, restored: now(), source: m.source.release ?? null, isolated: true }, null, 1)}\n`)
}

export const isRecoveryArea = async (area: string) => !!(await stat(join(area, RECOVERY_MARKER)).catch(() => null))

// ---- rehearsal ----------------------------------------------------------------------------

export interface Check { check: string; run?: string; ok: boolean; detail: string; seconds?: number }
export interface Rehearsal { schema: 'ag.wfe-recovery-rehearsal.v1'; generation: string | null; at: string; host: string; ok: boolean; seconds: number; checks: Check[]; restored: { runs: number; bytes: number }; compared: number; external: string[] }

const treeBytes = async (dir: string): Promise<number> => {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) n += await treeBytes(abs)
    else if (e.isFile()) n += (await lstat(abs)).size
  }
  return n
}

// Everything the plan asks of a recovery, in the isolated area, on disposable copies.
// The process's Git may only use local files, and its locks are its own.
export async function rehearse(o: { into: string; by: string; failureCases?: boolean; only?: string[] }): Promise<Rehearsal> {
  const t0 = Date.now()
  const area = join(o.into, 'area')
  if (!await isRecoveryArea(area)) throw new RequestError(409, `${area} is not a recovery area: wfe backup restore makes one`)
  process.env.WFE_LOCK_DIR = join(o.into, 'locks')
  process.env.GIT_ALLOW_PROTOCOL = 'file'
  process.env.GIT_TERMINAL_PROMPT = '0'
  process.env.GIT_CEILING_DIRECTORIES = o.into
  setShareArea(area)
  const registryFile = join(area, 'registry.json')
  const m = JSON.parse(await readFile(join(o.into, 'generation', 'manifest.json'), 'utf8')) as BackupManifest
  const checks: Check[] = []
  const add = (check: string, ok: boolean, detail: string, run?: string) => { checks.push({ check, ok, detail, ...(run ? { run } : {}) }) }
  const x = new ExecStore({ registryFile, area })
  let compared = 0, restoredBytes = 0, restoredRuns = 0
  const wsOf = async (id: string) => new Workspace(recordedWorkspace((await loadRegistry(registryFile)).workspaces, id)!)
  const parse = (ref: string): RunRef => { const [workflow, run] = ref.split('/'); return { workflow, run } }
  const selected = m.runs.filter(r => r.covered && (!o.only?.length || o.only.includes(`${r.workspace}:${r.ref}`)))
  const jobsBefore = x.countsForRehearsal().jobs
  const attemptsBefore = x.countsForRehearsal().attempts
  try {
    for (const r of selected) {
      const label = `${r.workspace}:${r.ref}`
      const ws = await wsOf(r.workspace), ref = parse(r.ref)
      // 1. Records, reports and evidence, with no tree.
      const reading = await readRun(ws, ref)
      add('record read and replayed', !!reading.record && !reading.problem && (r.seq === null || reading.record!.seq === r.seq), reading.record ? `sequence ${reading.record.seq} (${reading.record.execution.state})` : reading.problem?.message ?? 'no record', label)
      const space = await runSpace(ws, ref)
      const names = (await readdir(join(recordFolderOf(copyDir(ws, ref), ref))).catch(() => [])).filter(n => n.endsWith('.md'))
      let readable = 0
      for (const n of names) if ((await readRunFile(space, ref, n).catch(() => null))?.text !== undefined) readable++
      add('reports read', readable === names.length, `${readable} of ${names.length} documents`, label)
      const artifacts = (reading.record?.artifacts ?? []).filter(a => !a.path.startsWith(`${runFolder(ref)}/`))
      let found = 0
      for (const a of artifacts) if (await retainedFile(ws, ref, a.path).catch(() => null)) found++
      add('evidence links resolve', true, `${found} of ${artifacts.length} artifacts outside the run folder come from retained storage; an artifact made in another copy may legitimately be elsewhere`, label)
      // 4. Output bytes against the original hashes, on the remapped share.
      for (const out of r.outputs) {
        const c = reading.record ? await checkOutput(space, reading.record, out.id).catch(e => ({ status: 'unavailable', detail: (e as Error).message })) : { status: 'unavailable', detail: 'no record' }
        compared += out.files
        add('output bytes', c.status === 'verified', `${out.id}: ${c.status}, ${out.files} files (${c.detail})`, label)
      }
      // 5. Identity: the receipt finds this run, nothing is allocated or queued.
      if (r.receipt) {
        const again = await reserve(ws, { project: r.project, workflow: ref.workflow, receipt: r.receipt })
        add('receipt replay', again.existing && runKey(again.ref) === r.ref, `${r.receipt.slice(0, 32)} finds ${runKey(again.ref)}`, label)
      } else add('receipt replay', true, 'this run has no receipt', label)
      const used = await usedRuns(ws, r.project, ref.workflow)
      add('run number stays taken', used.has(ref.run), `${used.size} numbers taken in ${ref.workflow}`, label)
      // Refs deleted from a remote can be recreated from what was restored here.
      const cleaned = JSON.parse(await readTextOrNull(join(copyDir(ws, ref), CLEANUP_RECORD)) ?? 'null') as { entries: { ref: string; oid: string; key: string | null; state: string }[] } | null
      for (const e of cleaned?.entries.filter(z => z.state === 'deleted') ?? []) {
        const present = e.key ? (await git(retentionRepo(ws, e.key), ['rev-list', '--objects', '--quiet', e.oid])).code === 0 : false
        compared++
        add('deleted branch recoverable', present, `${e.ref} at ${e.oid.slice(0, 12)}`, label)
      }
    }
    // Numbers of the runs that are not in the backup in full stay taken, and their receipts answer.
    let identities = 0, identityBad = 0
    for (const i of m.identityOnly) {
      const ws = await wsOf(i.workspace), ref = parse(i.ref)
      identities++
      if (!(await usedRuns(ws, '-', ref.workflow)).has(ref.run)) identityBad++
      else if (i.receipt && !await copyByReceipt(ws, i.receipt)) identityBad++
    }
    add('identity of runs outside the guarantee', identityBad === 0, `${identities - identityBad} of ${identities} keep their number and receipt; their trees are not in the backup`)

    if (o.failureCases !== false) await failureCases(x, m, selected, wsOf, parse, add)

    // 2 and 3. Restoration; a worker's archive and its bundles.
    for (const r of selected) {
      const label = `${r.workspace}:${r.ref}`
      const ws = await wsOf(r.workspace), ref = parse(r.ref)
      const t = Date.now()
      const res = await restoreRun(x, ws, ref, { by: o.by })
      const copy = await readCopy(ws, ref)
      let detail = `${res.outcome}${res.reasons.length ? `: ${res.reasons.slice(0, 3).join('; ')}` : ''}`
      let ok = res.outcome === 'restored'
      if (ok && copy) {
        for (const p of r.repositories) {
          const d = p.path === '.' ? copy.tree : join(copy.tree, p.path)
          const head = (await git(d, ['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim() || null
          if (head !== p.head) { ok = false; detail += `; ${p.path} at ${head?.slice(0, 12)}, saved ${p.head?.slice(0, 12)}` }
          for (const v of p.refs.filter(e => e.ref.startsWith('refs/heads/'))) {
            const got = (await git(d, ['rev-parse', '-q', '--verify', v.ref])).stdout.trim()
            compared++
            if (got !== v.oid) { ok = false; detail += `; ${p.path} ${v.ref} at ${got.slice(0, 12)}, saved ${v.oid.slice(0, 12)}` }
          }
        }
        const contents = (await readContents(copy as Parameters<typeof readContents>[0]).catch(() => null))?.entries ?? []
        compared += contents.length
        detail += `; ${r.repositories.length} repositories at their saved commits, ${contents.length} listed files compared`
        const b = await treeBytes(copy.tree)
        restoredBytes += b
        restoredRuns++
        detail += `, ${(b / 2 ** 20).toFixed(1)} MiB`
      }
      checks.push({ check: 'restoration', run: label, ok, detail, seconds: Math.round((Date.now() - t) / 1000) })
      for (const [host, a] of Object.entries(r.workerArchives)) {
        const dir = join(copyDir(ws, ref), 'worker-archive', host)
        const scratch = await mkdtemp(join(o.into, 'worker-'))
        const sum = await sha256File(join(dir, FILES)).catch(() => null)
        compared++
        const unpack = await run(['tar', '-xzpf', join(dir, FILES), '-C', scratch])
        const bundles = await findBundles(scratch)
        const verified: string[] = []
        for (const b of bundles) {
          const inTree = copy ? copy.tree : scratch
          const v = await git(inTree, ['bundle', 'verify', b])
          const heads = (await git(inTree, ['bundle', 'list-heads', b])).stdout.split('\n').filter(Boolean).length
          verified.push(`${relative(scratch, b)}: ${v.code === 0 ? `readable, ${heads} refs` : `NOT verified: ${v.stderr.trim().split('\n')[0]}`}`)
        }
        add('worker archive', sum === a.sha256 && unpack.code === 0 && verified.every(v => !v.includes('NOT verified')), `${host}: checksum ${sum === a.sha256 ? 'matches' : 'differs'}, ${(a.bytes / 2 ** 20).toFixed(1)} MiB, ${bundles.length} bundles${verified.length ? ` (${verified.join('; ')})` : ''}. Bundles come back as files, not refs.`, label)
        await rm(scratch, { recursive: true, force: true })
      }
    }
    const jobsAfter = x.countsForRehearsal().jobs
    const attemptsAfter = x.countsForRehearsal().attempts
    add('nothing dispatched', jobsAfter === jobsBefore && attemptsAfter === attemptsBefore, `jobs ${jobsBefore} → ${jobsAfter}, attempts ${attemptsBefore} → ${attemptsAfter}`)
  } finally { x.close() }
  const result: Rehearsal = {
    schema: 'ag.wfe-recovery-rehearsal.v1', generation: m.id, at: now(), host: hostname(), ok: checks.every(c => c.ok), seconds: Math.round((Date.now() - t0) / 1000), checks,
    restored: { runs: restoredRuns, bytes: restoredBytes }, compared, external: ['the software at the manifest\'s revisions', 'to publish again: Gitea and its tokens (a restored copy names its original remote)'],
  }
  await writeFile(join(o.into, 'rehearsal.json'), `${JSON.stringify(result, null, 1)}\n`)
  return result
}

async function findBundles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...await findBundles(abs))
    else if (e.name.endsWith('.bundle')) out.push(abs)
  }
  return out
}

// On the disposable copies: a damaged archive and a lost retention repository are
// reported as failures of the runs they affect, then put back.
async function failureCases(x: ExecStore, m: BackupManifest, selected: BackupRun[], wsOf: (id: string) => Promise<Workspace>, parse: (ref: string) => RunRef, add: (c: string, ok: boolean, d: string, r?: string) => void) {
  const withTgz = selected.find(r => r.archive?.sha256)
  if (withTgz) {
    const ws = await wsOf(withTgz.workspace), ref = parse(withTgz.ref)
    const f = join(copyDir(ws, ref), ARCHIVE, FILES)
    await rename(f, `${f}.kept`)
    await writeFile(f, 'damaged')
    const r = await restoreRun(x, ws, ref, { by: 'rehearsal', dryRun: true })
    const wet = await restoreRun(x, ws, ref, { by: 'rehearsal' })
    await rm(f)
    await rename(`${f}.kept`, f)
    add('damaged archive is refused', r.reasons.some(t => /checksum/.test(t)) && wet.outcome === 'failed', `${withTgz.workspace}:${withTgz.ref}: dry run "${r.reasons[0] ?? ''}"; restoration ${wet.outcome}`)
  }
  const target = selected[0]
  if (target) {
    const ws = await wsOf(target.workspace)
    const key = target.repositories[0].key
    const bare = retentionRepo(ws, key)
    await rename(bare, `${bare}.kept`)
    const hit: string[] = []
    for (const r of m.runs.filter(z => z.workspace === target.workspace && z.repositories.some(p => p.key === key))) {
      const d = await restoreRun(x, ws, parse(r.ref), { by: 'rehearsal', dryRun: true })
      if (d.reasons.some(t => /unavailable|not fully retained/.test(t))) hit.push(`${r.workspace}:${r.ref}`)
    }
    await rename(`${bare}.kept`, bare)
    add('lost retention repository names its runs', hit.length > 0, `${key}: ${hit.join(', ')}`)
  }
}

// ---- putting lost pieces back -------------------------------------------------------------

export interface ReinstateItem { item: string; action: 'present' | 'copied' | 'would-copy' | 'moved-aside-and-copied' | 'would-replace-damaged' | 'kept-newer'; detail?: string }

// Current-release recovery after losing pieces of live storage: what is missing or
// damaged comes back from a generation. Nothing that exists and is intact is
// overwritten, so a backup older than newer events cannot erase them; those newer
// events and any retained refs absent from the generation are reported.
export async function reinstate(x: ExecStore, cfg: BackupConfig, o: { generation?: string; workspace?: string; dryRun?: boolean; by: string }): Promise<{ generation: string; items: ReinstateItem[]; losses: string[] }> {
  const dest = new Dest(cfg)
  const id = o.generation ?? await dest.latest()
  const m = await readManifest(dest, id)
  if (!id || !m) throw new RequestError(409, `${dest.where} has no usable generation${id ? ` ${id}` : ''}`)
  const items: ReinstateItem[] = [], losses: string[] = []
  const stamp = now().replace(/[:.]/g, '-')
  for (const ws of (await workspaces(x)).filter(w => !o.workspace || w.reg.id === o.workspace)) {
    const here = m.runs.filter(r => r.workspace === ws.reg.id || ws.reg.formerly?.includes(r.workspace))
    for (const key of new Set(here.flatMap(r => r.repositories.map(p => p.key)))) {
      const bare = retentionRepo(ws, key), label = `retention ${ws.reg.id}/${key}`
      const runs = here.filter(r => r.repositories.some(p => p.key === key))
      const missing = !(await stat(join(bare, 'HEAD')).catch(() => null))
      let damaged = false
      if (!missing) for (const r of runs) for (const p of r.repositories.filter(z => z.key === key)) for (const v of p.refs) if ((await git(bare, v.type === 'commit' ? ['rev-list', '--objects', '--quiet', v.oid] : ['cat-file', '-e', v.oid], { timeoutMs: 3_600_000 })).code !== 0) damaged = true
      if (!missing && !damaged) { items.push({ item: label, action: 'present' }); continue }
      if (o.dryRun) { items.push({ item: label, action: missing ? 'would-copy' : 'would-replace-damaged' }); continue }
      await withLock(`${bare}.lock`, async () => {
        if (damaged) {
          const old = (await git(bare, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.split('\n').filter(Boolean)
          await rename(bare, `${bare}.damaged-${stamp}`)
          await dest.pull(`generations/${id}/retention/${ws.reg.id}/${key}.git`, bare)
          const kept = new Set((await git(bare, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.split('\n'))
          for (const l of old) if (!kept.has(l)) losses.push(`${label}: ${l} is newer than generation ${id}; it remains only in the damaged copy`)
        } else await dest.pull(`generations/${id}/retention/${ws.reg.id}/${key}.git`, bare)
      }, { what: `the retention repository ${key}`, timeoutMs: RETENTION_LOCK_MS })
      items.push({ item: label, action: damaged ? 'moved-aside-and-copied' : 'copied' })
    }
    for (const r of here) {
      const ref: RunRef = { workflow: r.ref.split('/')[0], run: r.ref.split('/')[1] }
      const dir = copyDir(ws, ref), rel = `generations/${id}/runs/${r.workspace}/${r.ref}`, label = `${r.workspace}:${r.ref}`
      const pullIfMissing = async (name: string, file?: boolean) => {
        const present = !!(await stat(join(dir, name)).catch(() => null))
        if (present) return false
        if (o.dryRun) { items.push({ item: `${label} ${name}`, action: 'would-copy' }); return false }
        if (file) { const t = await dest.read(`${rel}/${name}`); if (t !== null) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, name), t) } } else await dest.pull(`${rel}/${name}`, join(dir, name))
        items.push({ item: `${label} ${name}`, action: 'copied' })
        return true
      }
      await pullIfMissing('copy.json', true)
      await pullIfMissing('record')
      const c = await readCopy(ws, ref)
      if (c?.manifest && (c.manifest.generation ?? 0) !== r.generation) { items.push({ item: label, action: 'kept-newer', detail: `the run is at generation ${c.manifest.generation}, the backup holds ${r.generation}: its archive is not replaced` }); continue }
      await pullIfMissing(CLEANUP_RECORD, true).catch(() => null)
      if (r.archive) {
        const tgz = join(dir, ARCHIVE, FILES)
        const bad = r.archive.sha256 && await stat(tgz).catch(() => null) && await sha256File(tgz) !== r.archive.sha256
        if (bad) {
          if (o.dryRun) items.push({ item: `${label} archive`, action: 'would-replace-damaged' })
          else { await rename(join(dir, ARCHIVE), join(dir, `${ARCHIVE}.damaged-${stamp}`)); await dest.pull(`${rel}/${ARCHIVE}`, join(dir, ARCHIVE)); items.push({ item: `${label} archive`, action: 'moved-aside-and-copied' }) }
        } else if (!await pullIfMissing(ARCHIVE)) { if (!o.dryRun || await stat(join(dir, ARCHIVE)).catch(() => null)) items.push({ item: `${label} archive`, action: 'present' }) }
      }
      for (const host of Object.keys(r.workerArchives)) await pullIfMissing(`worker-archive/${host}`)
      const live = await readRun(ws, ref).catch(() => null)
      if (r.seq !== null && live?.record && live.record.seq !== r.seq) items.push({ item: `${label} record`, action: 'kept-newer', detail: `sequence ${live.record.seq} here, ${r.seq} in the backup; the live record stays` })
    }
  }
  return { generation: id, items, losses }
}
