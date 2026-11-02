// Moving existing runs' folders into durable storage (improve_wfrun p2,
// docs/storage.md *Relocation*): explicit, once, restartable from a journal,
// and separate from any deletion. Writers are quiesced first: the executor and
// the service are stopped, because the lock's key changes with the folder's real
// path; each run is then moved under its lock anyway. Lock order: the run's lock,
// then the manifest's. Nothing is queued, announced or recorded in the run: a
// storage change is not an execution event.
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runFolder, runKey, type RunRef } from '../shared/run.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { withLock } from './lock.ts'
import { backup, inventory, workspaces } from './migrate.ts'
import { relocateFolder } from './runrecord.ts'
import { listCopies, readCopy, recordOwner, updateManifest } from './runspace.ts'
import type { ExecStore } from './exec.ts'

export interface RelocationRun { workspace: string; ref: string; action: 'relocate' | 'relocated' | 'blocked'; why: string }
export interface RelocationPlan { at: string; executor: string; runs: RelocationRun[] }
interface Journal { started: string; backup: string; runs: Record<string, { done: boolean; error?: string }> }

const now = () => new Date().toISOString()

async function openAttempt(tree: string, ref: RunRef): Promise<string | null> {
  const text = await readTextOrNull(join(tree, runFolder(ref), 'run.json')).catch(() => null)
  try { return (text ? (JSON.parse(text) as { control?: { attempt?: { id?: string } | null } }).control?.attempt?.id : null) ?? null } catch { return null }
}

export async function relocationPlan(x: ExecStore, only?: string): Promise<RelocationPlan> {
  const plan: RelocationPlan = { at: now(), executor: x.executorState().state, runs: [] }
  for (const ws of (await workspaces(x)).filter(w => !only || w.reg.id === only)) {
    for (const c of await listCopies(ws)) {
      const base = { workspace: ws.reg.id, ref: runKey(c.ref) }
      if (c.manifest?.record === 'durable') { plan.runs.push({ ...base, action: 'relocated', why: 'its folder is in durable storage' }); continue }
      if (c.problem || !c.manifest) { plan.runs.push({ ...base, action: 'blocked', why: c.problem ?? 'no manifest' }); continue }
      const attempt = await openAttempt(c.tree, c.ref)
      plan.runs.push(attempt ? { ...base, action: 'blocked', why: `attempt ${attempt} is open` } : { ...base, action: 'relocate', why: 'its folder is in the tree' })
    }
  }
  return plan
}

export interface RelocationResult { plan: RelocationPlan; backup: string; moved: string[]; already: number; blocked: string[]; problems: string[] }

export async function relocate(x: ExecStore, o: { workspace?: string; allowLive?: boolean; by: string }): Promise<RelocationResult> {
  const plan = await relocationPlan(x, o.workspace)
  if (!o.allowLive && plan.executor === 'available') throw new Error('the executor reported within the last 45 s; stop it and the service before relocating records')
  const dir = join(x.ctx.area, '.local', 'migrations')
  await mkdir(dir, { recursive: true })
  const journalFile = join(dir, 'p2-records.json')
  const journal: Journal = JSON.parse(await readTextOrNull(journalFile) ?? 'null') ?? { started: now(), backup: join(x.ctx.area, '.local', 'backups', `p2-records-${now().replace(/[:.]/g, '-')}`), runs: {} }
  const save = () => atomicWrite(journalFile, `${JSON.stringify({ ...journal, by: o.by }, null, 2)}\n`)
  await backup(x, journal.backup, await inventory(x, o.workspace))
  await save()
  const res: RelocationResult = { plan, backup: journal.backup, moved: [], already: 0, blocked: [], problems: [] }
  const byWs = new Map((await workspaces(x)).map(w => [w.reg.id, w]))
  for (const r of plan.runs) {
    const key = `${r.workspace}/${r.ref}`
    if (r.action === 'relocated') { res.already++; continue }
    if (r.action === 'blocked') { res.blocked.push(`${key}: ${r.why}`); continue }
    const ws = byWs.get(r.workspace)!
    const [workflow, run] = r.ref.split('/')
    const ref: RunRef = { workflow, run }
    const j = journal.runs[key] ??= { done: false }
    try {
      const c = (await readCopy(ws, ref))!
      // The manifest as it was, once, beside the stores.
      const keep = join(journal.backup, 'manifests', r.workspace, workflow, `${run}.json`)
      if (!(await stat(keep).catch(() => null))) { await mkdir(join(keep, '..'), { recursive: true }); await copyFile(join(c.dir, 'copy.json'), keep) }
      await withLock(join(c.tree, runFolder(ref), 'run.json'), async () => {
        await relocateFolder(c.dir, ref, recordOwner(c.manifest!))
        await updateManifest(ws, ref, m => { m.record = 'durable' })
      }, { what: `run ${r.ref}`, timeoutMs: 120_000 })
      j.done = true; j.error = undefined
      res.moved.push(key)
    } catch (e) {
      j.error = (e as Error).message
      res.problems.push(`${key}: ${j.error} (run the relocation again to continue)`)
    }
    await save()
  }
  return res
}
