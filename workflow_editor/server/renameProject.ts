// Renaming a managed project (rename/warden): the registry, the run copies and
// records, and every store that names it. Explicit, previewed and restartable
// from a journal; a repeated step changes nothing. Writers are stopped first.
//
// What a project's name means is split here. A run's creation identity (its uid,
// branch, creation hash and frozen definition) stays as it was created; the run's
// current project moves through a recorded run.rename-project. Stores follow the
// current project, except the columns that record what happened (receipts, sent
// content, message text, hashed snapshots). `formerly` in the registry resolves
// what existing records stored; nothing new is routed through it.
//
// The repository and the chat channels are renamed before this runs, by their
// numeric ids, so that retained ids and history are not this module's to invent.
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ID_PATTERN } from '../shared/model.ts'
import { RUN_ID, RUNS_ROOT, runFolder, runKey, type RunRef } from '../shared/run.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { COPIES_DIR, listCopies, updateManifest } from './runspace.ts'
import { readRun, runOp } from './runs.ts'
import { Workspace, RequestError } from './workspace.ts'
import type { Registration } from './registry.ts'
import type { ExecStore } from './exec.ts'

export interface RenameOptions {
  from: string; to: string
  repository: string // the repository's new name on Gitea
  by: string
  sessions?: string // Claude Code's project folders; defaults to the home folder's
  allowLive?: boolean
}
export interface StoreChange { store: string; change: string; rows: number }
export interface RenamePreview {
  at: string; from: string; to: string; executor: string
  problems: string[]
  workspace: { from: string; to: string; moved: boolean }
  runs: { total: number; toRename: number; renamed: number; retired: number; open: string[] }
  stores: StoreChange[]
  sessions: number
  contexts: boolean
}
interface Journal { started: string; from: string; to: string; steps: Record<string, { at: string; detail?: unknown }>; problems: string[] }

const now = () => new Date().toISOString()
const exists = async (p: string) => !!(await lstat(p).catch(() => null))
const journalFile = (area: string, from: string, to: string) => join(area, '.local', 'migrations', `rename-${from}-${to}.json`)
const prefix = (col: string, value: string) => `instr(${col}, '${value}') = 1`

// One statement per operational column. `n` counts it in the preview; applying it
// twice changes nothing because each one selects by the old value.
interface Change { store: string; table: string; describe: string; where: string; set: string }

function changesOf(f: string, t: string): Change[] {
  const swap = (col: string, a: string, b: string) => `${col} = '${b}' || substr(${col}, ${a.length + 1})`
  const c = (store: string, table: string, describe: string, where: string, set: string): Change => ({ store, table, describe, where, set })
  const eq = (store: string, table: string, col: string) => c(store, table, col, `${col} = '${f}'`, `${col} = '${t}'`)
  return [
    ...['jobs', 'attempts', 'checkpoints', 'integrations'].map(x => eq('exec', x, 'workspace')),
    c('intake', 'requests', 'project, workspace', `project = '${f}' OR workspace = '${f}'`, `project = CASE project WHEN '${f}' THEN '${t}' ELSE project END, workspace = CASE workspace WHEN '${f}' THEN '${t}' ELSE workspace END`),
    // Dependent rows first: they select by the keys the later statements change.
    c('notify', 'delivery_events', 'event', prefix('event', `${f}/`), swap('event', `${f}/`, `${t}/`)),
    c('notify', 'deliveries', 'run_key', prefix('run_key', `${f}/`), swap('run_key', `${f}/`, `${t}/`)),
    c('notify', 'deliveries', 'events', `instr(events, '"${f}/') > 0`, `events = replace(events, '"${f}/', '"${t}/')`),
    c('notify', 'io_attempts', 'run_key', prefix('run_key', `${f}/`), swap('run_key', `${f}/`, `${t}/`)),
    c('notify', 'relocations', 'run_key', prefix('run_key', `${f}/`), swap('run_key', `${f}/`, `${t}/`)),
    c('notify', 'outbox', 'event id', `json_extract(event, '$.id') LIKE '${f}/%'`, `event = json_set(event, '$.id', '${t}/' || substr(json_extract(event, '$.id'), ${f.length + 2}))`),
    c('notify', 'outbox', 'id', prefix('id', `${f}/`), swap('id', `${f}/`, `${t}/`)),
    c('notify', 'outbox', 'run_key', prefix('run_key', `${f}/`), swap('run_key', `${f}/`, `${t}/`)),
    c('notify', 'runs', 'key, project, workspace, channel', `project = '${f}'`, `key = '${t}/' || substr(key, ${f.length + 2}), project = '${t}', workspace = CASE workspace WHEN '${f}' THEN '${t}' ELSE workspace END, channel = replace(channel, 'wf-${f}', 'wf-${t}')`),
    c('notify', 'runs', 'workspace of other projects\' rows', `workspace = '${f}'`, `workspace = '${t}'`),
    c('notify', 'targets', 'key, project, name, description', `project = '${f}'`, `key = replace(key, ':${f}', ':${t}'), project = '${t}', name = replace(name, 'wf-${f}', 'wf-${t}'), description = replace(replace(description, 'project ${f}', 'project ${t}'), '${f}/', '${t}/')`),
    eq('delegate', 'delegations', 'parent_ws'),
    eq('delegate', 'delegations', 'target_project'),
    eq('delegate', 'delegations', 'target_ws'),
    eq('conversations', 'invitations', 'participant'),
    eq('conversations', 'invitations', 'workspace'),
    c('conversations', 'invitations', 'run', prefix('run', `${f}/`), swap('run', `${f}/`, `${t}/`)),
    eq('conversations', 'workflow_refs', 'project'),
    c('conversations', 'workflow_refs', 'run', prefix('run', `${f}/`), swap('run', `${f}/`, `${t}/`)),
    c('conversations', 'workflow_refs', 'target', `instr(target, '"run":"${f}/') > 0`, `target = replace(target, '"run":"${f}/', '"run":"${t}/')`),
    c('conversations', 'activities', 'awaits', prefix('awaits', `${f}/`), swap('awaits', `${f}/`, `${t}/`)),
    eq('present', 'instances', 'workspace'),
    eq('present', 'usages', 'workspace'),
  ]
}

const storeFile = (area: string, store: string) => join(area, '.local', store, `${store}.sqlite`)

function countChanges(area: string, list: Change[]): StoreChange[] {
  const out: StoreChange[] = []
  const stores = new Map<string, DatabaseSync>()
  try {
    for (const c of list) {
      const db = stores.get(c.store) ?? new DatabaseSync(storeFile(area, c.store), { readOnly: true })
      stores.set(c.store, db)
      const row = db.prepare(`SELECT count(*) AS n FROM ${c.table} WHERE ${c.where}`).get() as { n: number }
      out.push({ store: c.store, change: `${c.table}: ${c.describe}`, rows: Number(row.n) })
    }
  } finally { for (const db of stores.values()) db.close() }
  return out
}

function applyChanges(area: string, list: Change[]): StoreChange[] {
  const out: StoreChange[] = []
  for (const store of new Set(list.map(c => c.store))) {
    const db = new DatabaseSync(storeFile(area, store))
    try {
      db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
      try {
        for (const c of list.filter(x => x.store === store)) {
          const r = db.prepare(`UPDATE ${c.table} SET ${c.set} WHERE ${c.where}`).run()
          out.push({ store, change: `${c.table}: ${c.describe}`, rows: Number(r.changes) })
        }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    } finally { db.close() }
  }
  return out
}

// Claude Code keeps a working directory's sessions in a folder named after it, so a held
// run could not resume its conversation from a moved copy unless the folder moves too.
const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')
async function sessionFolders(root: string, oldDir: string): Promise<string[]> {
  const head = slug(oldDir)
  return (await readdir(root).catch(() => [])).filter(d => d === head || d.startsWith(`${head}-`))
}

async function presentConfigs(area: string, oldDir: string): Promise<string[]> {
  const root = join(area, '.local', 'present', 'instances')
  const out: string[] = []
  for (const d of await readdir(root).catch(() => [])) {
    const file = join(root, d, 'config.json')
    if ((await readTextOrNull(file).catch(() => null))?.includes(`${oldDir}/`)) out.push(file)
  }
  return out
}

interface Places { reg: Registration; rawRegistry: Record<string, unknown>; oldDir: string; newDir: string; moved: boolean }

async function placesOf(x: ExecStore, o: RenameOptions): Promise<Places> {
  const rawRegistry = JSON.parse(await readFile(x.ctx.registryFile, 'utf8')) as { workspaces: Registration[] }
  const reg = rawRegistry.workspaces.find(w => w.id === o.from) ?? rawRegistry.workspaces.find(w => w.id === o.to)
  if (!reg) throw new RequestError(404, `no workspace ${o.from} or ${o.to} is registered`)
  const moved = reg.id === o.to
  const dir = reg.path
  const newDir = moved ? dir : join(dirname(dir), `pj-${o.to}`)
  const oldDir = moved ? join(dirname(dir), `pj-${o.from}`) : dir
  return { reg, rawRegistry, oldDir, newDir, moved }
}

const liveRoot = async (p: Places) => (await exists(p.newDir)) && !(await exists(p.oldDir)) ? p.newDir : p.oldDir

async function runsOf(root: string, reg: Registration): Promise<{ ws: Workspace; refs: RunRef[]; treeOnly: RunRef[] }> {
  const ws = new Workspace({ ...reg, path: root })
  const refs: RunRef[] = []
  for (const wf of await readdir(join(root, COPIES_DIR)).catch(() => [])) {
    for (const run of await readdir(join(root, COPIES_DIR, wf)).catch(() => [])) if (RUN_ID.test(run)) refs.push({ workflow: wf, run })
  }
  // A run recorded in the project tree without a copy of its own (hand-operated fixtures) is
  // a run of this project too; its changed record is the workspace's to commit and publish.
  const treeOnly: RunRef[] = []
  for (const wf of await readdir(join(root, RUNS_ROOT)).catch(() => [])) {
    for (const run of await readdir(join(root, RUNS_ROOT, wf)).catch(() => [])) {
      if (RUN_ID.test(run) && !refs.some(r => r.workflow === wf && r.run === run) && await exists(join(root, RUNS_ROOT, wf, run, 'run.json'))) treeOnly.push({ workflow: wf, run })
    }
  }
  return { ws, refs: [...refs, ...treeOnly].sort((a, b) => runKey(a).localeCompare(runKey(b))), treeOnly }
}

export async function renamePreview(x: ExecStore, o: RenameOptions): Promise<RenamePreview> {
  for (const id of [o.from, o.to]) if (!ID_PATTERN.test(id)) throw new RequestError(400, `"${id}" is not a project id`)
  const area = x.ctx.area
  const p = await placesOf(x, o)
  const problems: string[] = []
  const reg = p.rawRegistry as { workspaces: Registration[]; projects: { id: string }[] }
  if (!p.moved && reg.workspaces.some(w => w.id === o.to || w.project === o.to)) problems.push(`workspace or project ${o.to} is already registered`)
  if (!p.moved && reg.projects.some(e => e.id === o.to)) problems.push(`project ${o.to} is already registered`)
  if ((await exists(p.newDir)) && (await exists(p.oldDir))) problems.push(`both ${p.oldDir} and ${p.newDir} exist`)
  const executor = x.executorState().state
  if (executor === 'available' && !o.allowLive) problems.push('the executor reports; stop it, the service, Observer and its watchdog first')
  const root = await liveRoot(p)
  const { ws, refs } = await runsOf(root, p.reg)
  const runs = { total: refs.length, toRename: 0, renamed: 0, retired: 0, open: [] as string[] }
  for (const c of await listCopies(ws)) if (c.manifest?.state === 'retired') runs.retired++
  for (const ref of refs) {
    const r = (await readRun(ws, ref).catch(e => ({ record: null, problem: { message: (e as Error).message } })))
    if (!r.record) { problems.push(`${runKey(ref)}: ${r.problem?.message}`); continue }
    if (r.record.project === o.from) runs.toRename++
    else if (r.record.project === o.to && r.record.createdAs === o.from) runs.renamed++
    else if (r.record.project === o.to) continue
    else problems.push(`${runKey(ref)}: its project is ${r.record.project}`)
    if (r.record.control.attempt) { runs.open.push(runKey(ref)); problems.push(`${runKey(ref)}: attempt ${r.record.control.attempt.id} is open`) }
  }
  return {
    at: now(), from: o.from, to: o.to, executor, problems,
    workspace: { from: p.oldDir, to: p.newDir, moved: root === p.newDir },
    runs, stores: countChanges(area, changesOf(o.from, o.to)),
    sessions: (await sessionFolders(o.sessions ?? join(homedir(), '.claude', 'projects'), p.oldDir)).length,
    contexts: await exists(join(area, '.local', 'contexts', 'projects', o.from)),
  }
}

async function readJournal(file: string, o: RenameOptions): Promise<Journal> {
  const text = await readTextOrNull(file)
  return text ? JSON.parse(text) as Journal : { started: now(), from: o.from, to: o.to, steps: {}, problems: [] }
}

export async function renameProject(x: ExecStore, o: RenameOptions): Promise<{ journal: string; steps: Journal['steps']; problems: string[] }> {
  const preview = await renamePreview(x, o)
  if (preview.problems.length) throw new RequestError(409, `refused; nothing was changed by this call:\n  ${preview.problems.join('\n  ')}`)
  const area = x.ctx.area
  const file = journalFile(area, o.from, o.to)
  await mkdir(dirname(file), { recursive: true })
  const j = await readJournal(file, o)
  const step = async (name: string, f: () => Promise<unknown>) => {
    if (j.steps[name]) return
    const detail = await f()
    j.steps[name] = { at: now(), detail }
    await atomicWrite(file, `${JSON.stringify(j, null, 1)}\n`)
  }
  await atomicWrite(file, `${JSON.stringify(j, null, 1)}\n`)
  const p = await placesOf(x, o)
  const url = async (dir: string) => (await git(dir, ['remote', 'get-url', 'origin'])).stdout.trim()
  const renamedUrl = (u: string) => u.replace(new RegExp(`/${basename(p.oldDir)}(\\.git)?$`), `/${o.repository}$1`)

  await step('workspace', async () => {
    if (!(await exists(p.newDir))) await rename(p.oldDir, p.newDir)
    const before = await url(p.newDir)
    const after = renamedUrl(before)
    if (after !== before) await git(p.newDir, ['remote', 'set-url', 'origin', after])
    // The workspace follows the published definition, or the next notification scan
    // would read the old project.yaml and provision the old channels again.
    const env = x.ctx.gitea ? await x.ctx.gitea.gitEnv() : {}
    const fetched = await git(p.newDir, ['fetch', 'origin'], { env })
    if (fetched.code !== 0) throw new RequestError(409, `the workspace cannot fetch ${after}: ${fetched.stderr.trim()}`)
    const merged = await git(p.newDir, ['merge', '--ff-only', 'origin/HEAD'])
    if (merged.code !== 0) throw new RequestError(409, `the workspace cannot follow its published branch: ${merged.stderr.trim()}`)
    const id = /^id:\s*(\S+)/m.exec(await readFile(join(p.newDir, 'project.yaml'), 'utf8'))?.[1]
    if (id !== o.to) throw new RequestError(409, `the published project.yaml has id ${id}, not ${o.to}; publish the renamed definition first`)
    return { dir: p.newDir, origin: after, head: (await git(p.newDir, ['rev-parse', 'HEAD'])).stdout.trim() }
  })

  await step('registry', async () => {
    const raw = JSON.parse(await readFile(x.ctx.registryFile, 'utf8')) as { workspaces: (Registration)[]; projects: { id: string; root: string }[]; repositories: { key?: string; gitea: { id: number; owner: string; name: string }; description?: string }[] }
    const w = raw.workspaces.find(e => e.id === o.from)
    if (w) Object.assign(w, { id: o.to, label: o.to, path: p.newDir, project: o.to, formerly: [...new Set([...(w.formerly ?? []), o.from])] })
    const proj = raw.projects.find(e => e.id === o.from)
    if (proj) {
      proj.id = o.to
      const id = Number(proj.root.split(':')[1])
      const repo = raw.repositories.find(r => r.gitea.id === id)
      if (repo) { repo.gitea.name = o.repository; if (repo.description) repo.description = repo.description.replace(new RegExp(`^${o.from}\\b`), o.to) }
    }
    await atomicWrite(x.ctx.registryFile, `${JSON.stringify(raw, null, 1)}\n`)
  })

  const reg = (JSON.parse(await readFile(x.ctx.registryFile, 'utf8')) as { workspaces: Registration[] }).workspaces.find(w => w.id === o.to)!
  const { ws, refs, treeOnly } = await runsOf(p.newDir, reg)

  await step('copies', async () => {
    let manifests = 0, remotes = 0
    for (const c of await listCopies(ws)) {
      if (!c.manifest) { j.problems.push(`${runKey(c.ref)}: ${c.problem}`); continue }
      if (c.manifest.project === o.from || c.manifest.workspace === o.from || c.manifest.repositories.some(r => r.url && renamedUrl(r.url) !== r.url)) {
        await updateManifest(ws, c.ref, m => { m.project = o.to; m.workspace = o.to; for (const r of m.repositories) if (r.url) r.url = renamedUrl(r.url) })
        manifests++
      }
      if (await stat(join(c.tree, '.git')).catch(() => null)) {
        const was = await url(c.tree)
        if (renamedUrl(was) !== was) { await git(c.tree, ['remote', 'set-url', 'origin', renamedUrl(was)]); remotes++ }
      }
    }
    return { manifests, remotes }
  })

  await step('records', async () => {
    let renamed = 0, already = 0
    for (const ref of refs) {
      const r = await readRun(ws, ref)
      if (r.record?.project !== o.from) { already++; continue }
      await runOp(ws, ref, { op: 'run.rename-project', from: o.from, to: o.to, note: `the project ${o.from} was renamed ${o.to}; this run's uid, branch and definition stay as created` }, { by: o.by, via: 'wfe rename-project' })
      renamed++
    }
    return { renamed, already, committedRecords: treeOnly.map(r => `${runFolder(r)}/run.json`) }
  })

  await step('stores', async () => applyChanges(area, changesOf(o.from, o.to)))

  await step('settings', async () => {
    const file = join(area, 'zulip.json')
    const text = await readTextOrNull(file)
    if (!text) return { zulip: false }
    const raw = JSON.parse(text) as { intake?: { agents?: { workflows?: string[] }[]; projects?: Record<string, { workspace?: string }> } }
    let changed = 0
    for (const a of raw.intake?.agents ?? []) a.workflows = a.workflows?.map(w => { if (w.startsWith(`${o.from}/`)) { changed++; return `${o.to}/${w.slice(o.from.length + 1)}` } return w })
    const projects = raw.intake?.projects
    if (projects?.[o.from]) { projects[o.to] = { ...projects[o.from], workspace: o.to }; delete projects[o.from]; changed++ }
    if (changed) await atomicWrite(file, `${JSON.stringify(raw, null, 1)}\n`)
    return { zulip: changed }
  })

  await step('contexts', async () => {
    const a = join(area, '.local', 'contexts', 'projects', o.from), b = join(area, '.local', 'contexts', 'projects', o.to)
    if ((await exists(a)) && !(await exists(b))) { await rename(a, b); return { moved: true } }
    return { moved: false }
  })

  await step('presentations', async () => {
    const files = await presentConfigs(area, p.oldDir)
    for (const f of files) await writeFile(f, (await readFile(f, 'utf8')).replaceAll(`${p.oldDir}/`, `${p.newDir}/`))
    return { configs: files.length }
  })

  await step('sessions', async () => {
    const root = o.sessions ?? join(homedir(), '.claude', 'projects')
    let moved = 0
    for (const d of await sessionFolders(root, p.oldDir)) {
      const to = slug(p.newDir) + d.slice(slug(p.oldDir).length)
      if (!(await exists(join(root, to)))) { await rename(join(root, d), join(root, to)); moved++ }
    }
    return { moved }
  })

  return { journal: file, steps: j.steps, problems: j.problems }
}
