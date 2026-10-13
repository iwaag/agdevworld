// The p9 migration (docs/storage.md *Migration*): runs recorded in a project
// workspace before p9 move into working copies of their own, without
// changing what they mean. Explicit and restartable:
//
// - `inventory` reads and changes nothing: every run with its execution
//   state, hold, open attempt, queued jobs, unpublished checkpoints, open
//   presentations and the action the migration would take; each
//   repository's head and the uncommitted files of the project workspace.
// - `migrate` takes the host-local recovery copies first (stores, settings,
//   each workspace's refs and status), then moves each non-terminal run the
//   execution host performs: its copy is reserved under the run's own id and
//   made from the committed project, the run's folder as it is in the
//   project workspace is placed there, and `run.relocate` records its
//   storage. Nodes, questions, holds, decisions, receipts and jobs stay as
//   they are; nothing is queued, resumed or announced. Checkpoints keep
//   the mode they were made with: an old one still publishes the project
//   workspace's branches, never the run branch.
// - Terminal runs stay where they are (read through the common resolver), and
//   so do runs an IDE agent performs. Uncommitted files of the project
//   workspace outside run folders are reported with their paths, never
//   moved or attributed by guess.
// - A journal in the area (`.local/migrations/p9.json`) records each run's
//   steps; running it again continues an interrupted migration and changes
//   nothing that is done.
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostOf, runFolder, type RunRef } from '../shared/run.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { loadRegistry, observe } from './registry.ts'
import { listRuns, readRun, runOp } from './runs.ts'
import { materialize, readCopy, reserve, storageOf } from './runspace.ts'
import { Workspace } from './workspace.ts'
import type { ExecStore } from './exec.ts'

export type MigrationAction = 'migrate' | 'migrated' | 'keep-terminal' | 'keep-ide' | 'blocked'
export interface InventoryRun {
  workspace: string; ref: string; execution: string; executor: string; host: string
  hold: string | null; attempt: string | null; jobs: number; checkpoints: { id: number; state: string; kind: string }[]
  presentations: string[]; action: MigrationAction; why: string
}
export interface InventoryRepo { workspace: string; path: string; head: string | null; branch: string | null; dirty: string[] }
export interface Inventory { at: string; runs: InventoryRun[]; repositories: InventoryRepo[]; unattributed: { workspace: string; paths: string[] }[]; executor: string }

const now = () => new Date().toISOString()
const lines = (s: string) => s.split('\n').map(x => x.trimEnd()).filter(Boolean)

// The run's record as the project tree has it (bypassing its copy).
async function readSharedRecord(ws: Workspace, ref: RunRef) {
  const text = await readTextOrNull(join(ws.shared.root, runFolder(ref), 'run.json'))
  try { return text ? JSON.parse(text) as import('../shared/run.ts').RunRecord : null } catch { return null }
}

async function workspaces(x: ExecStore): Promise<Workspace[]> {
  const out: Workspace[] = []
  for (const w of (await loadRegistry(x.ctx.registryFile)).workspaces) if ((await observe(w)).available) out.push(new Workspace(w))
  return out
}

export async function inventory(x: ExecStore, only?: string): Promise<Inventory> {
  const inv: Inventory = { at: now(), runs: [], repositories: [], unattributed: [], executor: x.executorState().state }
  for (const ws of (await workspaces(x)).filter(w => !only || w.reg.id === only)) {
    const repos = await ws.repositories()
    for (const r of repos.filter(r => r.kind !== 'directory' && r.initialized)) {
      const dir = r.path === '.' ? ws.root : join(ws.root, r.path)
      const status = await git(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=dirty'])
      inv.repositories.push({ workspace: ws.reg.id, path: r.path, head: r.head ?? null, branch: r.branch ?? null, dirty: lines(status.stdout).map(l => l.slice(3)) })
    }
    const runFolders: string[] = []
    for (const s of await listRuns(ws)) {
      const ref = { workflow: s.workflow, run: s.run }
      runFolders.push(runFolder(ref))
      const copy = await readCopy(ws, ref)
      const key = `${ws.reg.id}/${s.ref}`
      // A copy made by this migration whose record does not say so yet is an
      // interrupted migration: it continues. Otherwise a copy means moved.
      const inCopy = copy && !copy.problem ? (await readRun(ws, ref).catch(() => null))?.record ?? null : null
      const resuming = !!copy && copy.manifest?.receipt === `migrate:${key}` && !inCopy?.storage
      const rec = copy && !resuming ? inCopy : (await readRun(ws.shared, ref).catch(() => null))?.record ?? (await readSharedRecord(ws, ref))
      const view = await x.runView(ws.reg.id, ref)
      const base = {
        workspace: ws.reg.id, ref: s.ref, execution: s.execution ?? 'unreadable', executor: s.executor ?? '?', host: s.executorHost ?? '?',
        hold: rec?.control.hold?.kind ?? null, attempt: rec?.control.attempt?.id ?? view.attempts.find(a => a.state !== 'ended')?.id ?? null,
        jobs: view.jobs.filter(j => j.state === 'queued' || j.state === 'claimed').length,
        checkpoints: view.checkpoints.filter(c => c.state === 'failed' || c.state === 'attention' || c.state === 'pending').map(c => ({ id: c.id, state: c.state, kind: c.kind })),
        presentations: Object.values(rec?.presentations ?? {}).filter(p => p.state === 'available' || p.state === 'stop-failed').map(p => p.id),
      }
      const decide = (): [MigrationAction, string] => {
        if (resuming) return ['migrate', `an interrupted migration: continues (${copy!.problem ?? 'its record does not name its copy yet'})`]
        if (copy) return inCopy?.storage ? ['migrated', `in its copy (${copy.manifest?.branch})`] : ['blocked', copy.problem ?? 'it has a copy whose record names no storage']
        if (!rec) return ['blocked', `the record cannot be read: ${s.problem?.message ?? 'unknown'}`]
        if (rec.execution.state === 'completed' || rec.cancelled) return ['keep-terminal', 'completed or cancelled: stays in the project tree, read as before']
        if (hostOf(rec.executor) !== x.executor || !rec.executor.host) return ['keep-ide', `performed by ${rec.executor.name} (not the execution host): stays in the project workspace`]
        if (base.attempt) return ['blocked', `attempt ${base.attempt} is open; end it first`]
        return ['migrate', `${rec.execution.state}${rec.control.hold ? `, held (${rec.control.hold.kind})` : ''}: moves into a copy of its own`]
      }
      const [action, why] = decide()
      inv.runs.push({ ...base, action, why })
    }
    // Uncommitted files of the project workspace outside every run folder: not moved, not attributed.
    const root = inv.repositories.find(r => r.workspace === ws.reg.id && r.path === '.')
    const paths = (root?.dirty ?? []).filter(p => !runFolders.some(f => p === f || p.startsWith(`${f}/`)) && !p.startsWith('.local/'))
    for (const r of inv.repositories.filter(r => r.workspace === ws.reg.id && r.path !== '.')) paths.push(...r.dirty.map(p => `${r.path}/${p}`).filter(p => !runFolders.some(f => p.startsWith(`${f}/`))))
    if (paths.length) inv.unattributed.push({ workspace: ws.reg.id, paths })
  }
  return inv
}

interface Journal { started: string; backup: string; runs: Record<string, { steps: string[]; done: boolean; error?: string }> }

// Host-local recovery copies, taken once per migration (a resumed one keeps
// the first set): the stores (consistent copies), the area's settings, and
// each workspace's refs and status.
async function backup(x: ExecStore, dir: string, inv: Inventory) {
  await mkdir(dir, { recursive: true })
  for (const store of ['exec', 'notify', 'intake', 'present']) {
    const file = join(x.ctx.area, '.local', store, `${store}.sqlite`)
    if (!(await stat(file).catch(() => null))) continue
    const out = join(dir, `${store}.sqlite`)
    if (await stat(out).catch(() => null)) continue
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`) } finally { db.close() }
  }
  for (const f of ['registry.json', 'zulip.json', 'present.json', 'node-catalog.json', 'system.json']) {
    const src = join(x.ctx.area, f)
    if (await stat(src).catch(() => null)) await copyFile(src, join(dir, f))
  }
  for (const ws of await workspaces(x)) {
    const refs: string[] = []
    for (const r of inv.repositories.filter(r => r.workspace === ws.reg.id)) {
      const d = r.path === '.' ? ws.root : join(ws.root, r.path)
      refs.push(`# ${r.path}`, ...(lines((await git(d, ['show-ref'])).stdout)), `HEAD ${r.head ?? '?'} ${r.branch ?? '(detached)'}`, ...r.dirty.map(p => `dirty ${p}`))
    }
    await writeFile(join(dir, `refs-${ws.reg.id}.txt`), `${refs.join('\n')}\n`)
  }
  await writeFile(join(dir, 'inventory.json'), `${JSON.stringify(inv, null, 2)}\n`)
}

// Copies the run's folder as it is in the project workspace (its committed
// and uncommitted records alike) into its copy; the copy's own entries are
// replaced only while the relocation is not recorded there yet.
async function placeFolder(src: string, dest: string) {
  await mkdir(dest, { recursive: true })
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (e.isDirectory()) await placeFolder(join(src, e.name), join(dest, e.name))
    else if (e.isFile()) await copyFile(join(src, e.name), join(dest, e.name))
  }
}

export interface MigrateResult { inventory: Inventory; backup: string; migrated: string[]; already: string[]; kept: string[]; blocked: string[]; problems: string[] }

export async function migrate(x: ExecStore, o: { workspace?: string; allowLive?: boolean; by: string; env?: Record<string, string> }): Promise<MigrateResult> {
  const inv = await inventory(x, o.workspace)
  if (!o.allowLive && inv.executor === 'available') throw new Error('the executor reported within the last 45 s; stop it (and keep intake and claims paused) before migrating')
  const journalFile = join(x.ctx.area, '.local', 'migrations', 'p9.json')
  await mkdir(join(x.ctx.area, '.local', 'migrations'), { recursive: true })
  const journal: Journal = JSON.parse(await readTextOrNull(journalFile) ?? 'null') ?? { started: now(), backup: join(x.ctx.area, '.local', 'backups', `p9-migrate-${now().replace(/[:.]/g, '-')}`), runs: {} }
  const save = () => atomicWrite(journalFile, `${JSON.stringify(journal, null, 2)}\n`)
  await backup(x, journal.backup, inv)
  await save()
  const res: MigrateResult = { inventory: inv, backup: journal.backup, migrated: [], already: [], kept: [], blocked: [], problems: [] }
  const byWs = new Map((await workspaces(x)).map(w => [w.reg.id, w]))
  for (const r of inv.runs) {
    const key = `${r.workspace}/${r.ref}`
    if (r.action === 'migrated') { res.already.push(key); continue }
    if (r.action === 'keep-terminal' || r.action === 'keep-ide') { res.kept.push(`${key}: ${r.why}`); continue }
    if (r.action === 'blocked' && !journal.runs[key]) { res.blocked.push(`${key}: ${r.why}`); continue }
    const ws = byWs.get(r.workspace)!
    const [workflow, run] = r.ref.split('/')
    const ref: RunRef = { workflow, run }
    const j = journal.runs[key] ??= { steps: [], done: false }
    const step = async (name: string, f: () => Promise<void>) => { if (j.steps.includes(name)) return; await f(); j.steps.push(name); await save() }
    try {
      const project = (await ws.readProject()).project?.id
      if (!project) throw new Error('project.yaml cannot be read')
      await step('reserved', async () => { await reserve(ws, { project, workflow, name: run, receipt: `migrate:${key}`, adopt: true }, o.env ?? {}) })
      await step('made', async () => { await materialize(ws, ref, o.env ?? {}) })
      const copy = (await readCopy(ws, ref))!
      await step('placed', async () => { await placeFolder(join(ws.root, runFolder(ref)), join(copy.tree, runFolder(ref))) })
      await step('recorded', async () => {
        const have = (await readRun(ws, ref)).record // through the copy now
        if (!have) throw new Error('the record cannot be read in its copy')
        if (!have.storage) await runOp(ws, ref, { op: 'run.relocate', storage: storageOf(copy.manifest!), note: `moved from the project workspace by the p9 migration; what it published before (on ${copy.manifest!.repositories.find(x => x.path === '.')?.target ?? 'the shared branch'}) stays published`, receipt: `relocate:${key}` }, { by: o.by, via: 'migration' })
      })
      j.done = true; j.error = undefined
      await save()
      res.migrated.push(key)
    } catch (e) {
      j.error = (e as Error).message
      await save()
      res.problems.push(`${key}: ${j.error} (run the migration again to continue)`)
    }
  }
  for (const u of inv.unattributed) res.problems.push(`${u.workspace}: uncommitted files outside run folders, not moved (their owner is not recorded): ${u.paths.join(', ')}`)
  await writeFile(join(journal.backup, 'result.json'), `${JSON.stringify({ ...res, inventory: undefined, at: now() }, null, 2)}\n`)
  return res
}
