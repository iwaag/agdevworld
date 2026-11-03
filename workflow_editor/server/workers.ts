// Execution nodes (project_migration p7, docs/workers.md): the workers that
// perform runs for this area's coordinator. One worker shares the
// coordinator's files (`local`): its agents work in the record copy itself
// and it reaches the store through the CLI. Every other worker works in a copy
// of its own on its own disk and reaches the coordinator over HTTP
// (server/workerApi.ts); its `wfe` forwards (cli/remote.ts).
//
// <area>/workers.json:
//   { "default": "<id>",
//     "coordination": { "worker": "<id>", "lane": "coordination", "workspace": "warden", "workflow": "coordinate" },
//     "workers": { "<id>": { "local": true, "label": "…", "lanes": ["conversation", "coordination"] }, "<id>": { "tokenFile": "…" } } }
// No file: one local worker, `local`, which is also the default, and no
// coordination (every ordinary job is admitted as it is queued).
//
// Lanes (project_migration p8, improve_wfrun p4): a lane names which claim
// loop of a worker's executor serves a run (`execution.lane`); it is a label,
// not a slot count. Since improve_wfrun p4 no lane has a capacity: ordinary
// work (every lane but the coordination lane) starts when warden's
// coordination decided it should (docs/coordination.md), however many
// attempts the worker already holds, and the coordination lane carries that
// coordination itself, one coordination run at a time, admitted by nothing
// but its own queue. A legacy object form `{ "conversation": 1 }` is read as
// the lane names; the numbers are ignored.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { DEFAULT_LANE, LANE_PATTERN, NODE_PATTERN, type Project, type Workflow } from '../shared/model.ts'
import type { RunRef } from '../shared/run.ts'
import { readFile } from 'node:fs/promises'
import { atomicWrite } from './files.ts'
import { git } from './git.ts'
import { withLock } from './lock.ts'
import type { RepoStep } from './publish.ts'
import { RUN_FILE, runDir } from './runs.ts'
import { withoutLink } from './runrecord.ts'
import { treeSpace } from './runspace.ts'
import { RequestError, type Workspace } from './workspace.ts'

export const WORKERS_FILE = 'workers.json'

// `lanes`: the extra lane names the worker's executor serves beside `default`.
export interface WorkerSetting { id: string; local: boolean; label: string; tokenFile: string | null; lanes: string[] }
// Where coordination runs (improve_wfrun p4): the worker and lane that carry
// them, and the project workspace and workflow WFE creates them from.
export interface CoordinationSetting { worker: string; lane: string; workspace: string; workflow: string }
export interface WorkersConfig { file: string | null; default: string; local: string; workers: Record<string, WorkerSetting>; coordination: CoordinationSetting | null }

const cache = new Map<string, { mtime: number; config: WorkersConfig }>()

export function loadWorkers(area: string): WorkersConfig {
  const file = join(area, WORKERS_FILE)
  if (!existsSync(file)) return { file: null, default: 'local', local: 'local', workers: { local: { id: 'local', local: true, label: 'this host', tokenFile: null, lanes: [] } }, coordination: null }
  const { mtimeMs } = statSync(file)
  const hit = cache.get(file)
  if (hit && hit.mtime === mtimeMs) return hit.config
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new RequestError(500, `${file} cannot be read: ${(e as Error).message}`) }
  const o = (raw ?? {}) as { default?: unknown; coordination?: unknown; workers?: Record<string, { local?: unknown; label?: unknown; tokenFile?: unknown; lanes?: unknown }> }
  const workers: Record<string, WorkerSetting> = {}
  for (const [id, w] of Object.entries(o.workers ?? {})) {
    if (!NODE_PATTERN.test(id)) throw new RequestError(500, `${file}: worker id "${id}" must match ${NODE_PATTERN.source}`)
    const tokenFile = typeof w?.tokenFile === 'string' && w.tokenFile ? (isAbsolute(w.tokenFile) ? w.tokenFile : resolve(dirname(file), w.tokenFile)) : null
    const lanes: string[] = []
    if (w?.lanes !== undefined && w.lanes !== null) {
      const names = Array.isArray(w.lanes) ? w.lanes : typeof w.lanes === 'object' ? Object.keys(w.lanes as Record<string, unknown>) : null
      if (!names) throw new RequestError(500, `${file}: worker "${id}": "lanes" lists lane names`)
      for (const lane of names) {
        if (typeof lane !== 'string' || !LANE_PATTERN.test(lane)) throw new RequestError(500, `${file}: worker "${id}": lane "${String(lane)}" must match ${LANE_PATTERN.source}`)
        // The default lane is every worker's; it is not declared.
        if (lane === DEFAULT_LANE) throw new RequestError(500, `${file}: worker "${id}": the "${DEFAULT_LANE}" lane is every worker's; declare only extra lanes`)
        if (!lanes.includes(lane)) lanes.push(lane)
      }
    }
    workers[id] = { id, local: w?.local === true, label: typeof w?.label === 'string' ? w.label : id, tokenFile, lanes }
  }
  const locals = Object.values(workers).filter(w => w.local)
  if (locals.length !== 1) throw new RequestError(500, `${file}: exactly one worker must be "local" (the one sharing the coordinator's files); found ${locals.length}`)
  const def = typeof o.default === 'string' ? o.default : locals[0].id
  if (!workers[def]) throw new RequestError(500, `${file}: the default worker "${def}" is not listed`)
  let coordination: CoordinationSetting | null = null
  if (o.coordination !== undefined && o.coordination !== null) {
    const c = o.coordination as Record<string, unknown>
    if (typeof c !== 'object' || Array.isArray(c)) throw new RequestError(500, `${file}: "coordination" names the worker, lane, workspace and workflow of coordination runs`)
    const worker = typeof c.worker === 'string' ? c.worker : def
    if (!workers[worker]) throw new RequestError(500, `${file}: coordination worker "${worker}" is not listed`)
    const lane = typeof c.lane === 'string' ? c.lane : 'coordination'
    if (!LANE_PATTERN.test(lane) || lane === DEFAULT_LANE) throw new RequestError(500, `${file}: coordination lane "${lane}" must be an extra lane name`)
    if (!workers[worker].lanes.includes(lane)) throw new RequestError(500, `${file}: worker "${worker}" does not declare the coordination lane "${lane}"`)
    if (typeof c.workspace !== 'string' || !c.workspace || typeof c.workflow !== 'string' || !c.workflow) throw new RequestError(500, `${file}: coordination needs "workspace" (the registered workspace of the coordinating project) and "workflow" (its coordination workflow)`)
    coordination = { worker, lane, workspace: c.workspace, workflow: c.workflow }
  }
  const config = { file, default: def, local: locals[0].id, workers, coordination }
  cache.set(file, { mtime: mtimeMs, config })
  return config
}


// The node a new run is performed on: the request's choice, the workflow's,
// the project's, the area's default — the first that is given. An unknown
// node is refused before anything is created.
export function chooseNode(cfg: WorkersConfig, o: { request?: string | null; workflow?: Workflow | null; project?: Project | null }): { node: string; from: 'request' | 'workflow' | 'project' | 'default' } {
  const pick = o.request ? { node: o.request, from: 'request' as const }
    : o.workflow?.execution.node ? { node: o.workflow.execution.node, from: 'workflow' as const }
      : o.project?.execution?.node ? { node: o.project.execution.node, from: 'project' as const }
        : { node: cfg.default, from: 'default' as const }
  if (!cfg.workers[pick.node]) throw new RequestError(400, `execution node "${pick.node}" (from the ${pick.from}) is not a worker of this area (${Object.keys(cfg.workers).sort().join(', ')})`, { code: 'node-unknown' })
  return pick
}

// The lane a new run's attempts are claimed in (project_migration p8): the
// workflow's, the project's, else the default lane. Not checked against the
// worker: a lane the worker does not offer is served by its default lane
// (laneOn), so a run never waits for a lane nobody declared.
export function chooseLane(o: { workflow?: Workflow | null; project?: Project | null }): string {
  return o.workflow?.execution.lane || o.project?.execution?.lane || DEFAULT_LANE
}
// The lane a run is claimed in on a worker: the one its record names when the
// worker offers it, else `default`.
export function laneOn(w: WorkerSetting | undefined, lane: string | null | undefined): string {
  return lane && w?.lanes.includes(lane) ? lane : DEFAULT_LANE
}
// Whether a claim in this lane of this worker is the coordination path
// (improve_wfrun p4): served without a coordination decision, one run at a time.
export const isCoordinationLane = (cfg: WorkersConfig, worker: string, lane: string) => !!cfg.coordination && cfg.coordination.worker === worker && cfg.coordination.lane === lane
// Whether a run of this workflow is a coordination run.
export const isCoordinationRun = (cfg: WorkersConfig, workspace: string, workflow: string) => !!cfg.coordination && cfg.coordination.workspace === workspace && cfg.coordination.workflow === workflow

// The node that performs a run: the one its record names, else the area's
// default (records made before p7).
export const nodeOfRecord = (cfg: WorkersConfig, executor: { node?: string }) => executor.node ?? cfg.default
export const isLocalNode = (cfg: WorkersConfig, id: string) => cfg.workers[id]?.local === true

// Where a remote worker keeps a run's copy (p7): <root>/<workspace>/<workflow>/<run>/tree.
export const workerTree = (root: string, workspace: string, ref: RunRef) => posix.join(root, workspace, ref.workflow, ref.run, 'tree')

// After a remote worker published its copy (p7): the coordinator's record
// copy of the run follows the pushed commits, so its views, its own
// checkpoints and integration build on the worker's work. Under the run's
// lock; run.json — the authoritative record, which may be newer than the
// snapshot the worker committed — is kept as it is. Each repository moves
// only forward (its current commit must be an ancestor of the worker's);
// anything else is refused, never forced.
export async function alignRecordCopy(ws: Workspace, ref: RunRef, steps: RepoStep[], env: Record<string, string>): Promise<void> {
  const space = await treeSpace(ws.shared, ref)
  if (!space.copyOf) throw new Error(`run ${ref.workflow}/${ref.run} has no record copy here`)
  const record = join(space.copyOf!.recordRoot ?? space.root, runDir(ref), RUN_FILE)
  const moves = steps.filter(s => s.head).sort((a, b) => depth(a.repo) - depth(b.repo))
  await withLock(record, async () => {
    const keep = await readFile(record, 'utf8')
    try {
      for (const st of moves) {
        const dir = join(space.root, st.repo)
        const f = await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${st.branch}:refs/remotes/origin/${st.branch}`], { env, timeoutMs: 120_000 })
        if (f.code !== 0) throw new Error(`${st.repo}: git fetch failed: ${f.stderr.trim()}`)
        const branch = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
        if (branch !== st.branch) throw new Error(`${st.repo} has ${branch || 'a detached HEAD'} checked out, not ${st.branch}`)
        const cur = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
        if (cur === st.head) continue
        if ((await git(dir, ['merge-base', '--is-ancestor', cur, st.head!])).code !== 0) throw new Error(`${st.repo}: the record copy is at ${cur.slice(0, 12)}, which the worker's ${st.head!.slice(0, 12)} does not contain`)
        const c = space.copyOf!
        const move = () => git(dir, ['reset', '-q', '--hard', st.head!])
        const r = c.recordRoot && c.owner === st.repo ? await withoutLink(space.root, ref, st.repo, move) : await move()
        if (r.code !== 0) throw new Error(`${st.repo}: git reset failed: ${r.stderr.trim()}`)
      }
    } finally {
      await atomicWrite(record, keep)
    }
  }, { what: `run ${ref.workflow}/${ref.run}` })
}
const depth = (repo: string) => (repo === '.' ? 0 : repo.split('/').length)
