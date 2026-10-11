// Observes a workspace while a browser is connected and pushes changes over
// Server-Sent Events. Two polls, both only while a client is connected:
//
// - Definitions (project.yaml, .gitmodules, devdocs/workflows/*.yaml) every
//   `intervalMs` (1 s). A file is re-read only when its stat (size, mtime,
//   inode) changed, so an idle poll is a directory listing and a few stats.
//   Polling handles atomic-rename saves and every editor alike.
// - Git state every `gitIntervalMs` (3 s): one `git status --porcelain=v2
//   --branch` in the root (HEAD, index, dirty files, dirty submodules), one
//   more status per submodule that is already dirty, and, per submodule,
//   whether it is checked out and its HEAD and reflog (file reads). Git runs
//   with GIT_OPTIONAL_LOCKS=0, so it never takes the index lock.
//
// Runs (docs/runs.md) are observed with the definitions: each
// devdocs/runs/<workflow>/<run>/run.json like a definition file, and each run
// folder's top-level listing by stat only, so report bodies are never read.
//
// The registry file is watched with the definitions (and alone by the
// workspace-less stream of the home page). A new stream takes its first
// snapshot before it says hello, and every hello means "re-read everything":
// changes made while no stream was connected are never lost.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeEvent } from '../shared/api.ts'
import { inside, readTextOrNull, textHash } from './files.ts'
import { git } from './git.ts'
import { ID_PATTERN } from '../shared/model.ts'
import { RUN_ID } from '../shared/run.ts'
import { WORKFLOW_FILE, WORKFLOWS_DIR, type Workspace } from './workspace.ts'

const MAX_FILES = 200
const MAX_RUNS = 500
const REGISTRY = '\0registry'
const RUN = '\0run:' // + <workflow>/<run>: run.json
const RUN_FILES = '\0runfiles:' // + <workflow>/<run>: the folder's listing, by stat

type Snapshot = Map<string, { sig: string; hash: string | null }>

interface Entry {
  key: string
  ws?: Workspace
  clients: Set<ServerResponse>
  snapshot: Snapshot | null
  git: string | null
  timer?: NodeJS.Timeout
  gitTimer?: NodeJS.Timeout
  busy: boolean
  gitBusy: boolean
  ready: Promise<void>
}

const sigOf = async (path: string) => {
  const s = await stat(path).catch(() => null)
  return s ? `${s.size}:${s.mtimeMs}:${s.ino}` : null
}

export class Watcher {
  readonly intervalMs: number
  readonly gitIntervalMs: number
  readonly registryFile?: string
  private entries = new Map<string, Entry>()
  private ownWrites = new Map<string, string>() // `${ws}\0${path}` -> rev

  constructor(intervalMs = 1000, opts: { gitIntervalMs?: number; registryFile?: string } = {}) {
    this.intervalMs = intervalMs
    this.gitIntervalMs = opts.gitIntervalMs ?? 3000
    this.registryFile = opts.registryFile
  }

  noteOwnWrite(ws: Workspace, path: string, rev: string) {
    this.ownWrites.set(`${ws.reg.id}\0${path}`, rev)
  }

  // The current Git fingerprint of a watched workspace, or null when nobody
  // watches it (then nothing may be cached on its basis).
  gitKey(wsId: string): string | null {
    return this.entries.get(wsId)?.git ?? null
  }

  // ---- definitions ---------------------------------------------------------

  private async file(prev: Snapshot | null, next: Snapshot, key: string, path: string) {
    const sig = await sigOf(path)
    if (sig === null) return // absent: not in the snapshot
    const old = prev?.get(key)
    if (old && old.sig === sig) { next.set(key, old); return }
    const text = await readTextOrNull(path).catch(() => null)
    next.set(key, { sig, hash: text === null ? null : textHash(text) })
  }

  async snapshot(entry: Pick<Entry, 'ws' | 'snapshot'>): Promise<Snapshot> {
    const prev = entry.snapshot
    const next: Snapshot = new Map()
    if (this.registryFile) await this.file(prev, next, REGISTRY, this.registryFile)
    const ws = entry.ws
    if (!ws) return next
    for (const rel of ['project.yaml', '.gitmodules']) await this.file(prev, next, rel, await inside(ws.root, rel))
    const dir = await inside(ws.root, WORKFLOWS_DIR)
    const files = (await readdir(dir).catch(() => [] as string[])).filter(f => WORKFLOW_FILE.test(f)).sort().slice(0, MAX_FILES)
    for (const f of files) await this.file(prev, next, `${WORKFLOWS_DIR}/${f}`, join(dir, f))
    await this.runs(prev, next, ws)
    return next
  }

  private async runs(prev: Snapshot | null, next: Snapshot, ws: Workspace) {
    const runsDir = await inside(ws.root, 'devdocs/runs')
    const tops = (await readdir(runsDir, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && ID_PATTERN.test(d.name)).map(d => d.name).sort()
    let count = 0
    for (const wf of tops) {
      const runs = (await readdir(join(runsDir, wf), { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && RUN_ID.test(d.name)).map(d => d.name).sort()
      for (const run of runs) {
        if (count++ >= MAX_RUNS) return
        const dir = join(runsDir, wf, run)
        await this.file(prev, next, `${RUN}${wf}/${run}`, join(dir, 'run.json'))
        const names = (await readdir(dir).catch(() => [] as string[])).sort().slice(0, MAX_FILES)
        const sigs = await Promise.all(names.map(async n => `${n} ${await sigOf(join(dir, n))}`))
        next.set(`${RUN_FILES}${wf}/${run}`, { sig: '', hash: textHash(sigs.join('\n')) })
      }
    }
  }

  diff(wsId: string, before: Snapshot, after: Snapshot): ChangeEvent[] {
    const events: ChangeEvent[] = []
    const keys = new Set([...before.keys(), ...after.keys()])
    let listChanged = false, runsChanged = false
    const runEvents = new Map<string, ChangeEvent>()
    for (const key of keys) {
      const a = before.get(key)?.hash ?? null, b = after.get(key)?.hash ?? null
      if (a === b && before.has(key) === after.has(key)) continue
      if (key.startsWith(RUN) || key.startsWith(RUN_FILES)) {
        const record = key.startsWith(RUN)
        const run = key.slice(record ? RUN.length : RUN_FILES.length)
        if (!record && (!before.has(key) || !after.has(key))) runsChanged = true
        // One event per run and tick; its rev is run.json's content hash.
        runEvents.set(run, { type: 'changed', workspace: wsId, kind: 'run', run, rev: after.get(`${RUN}${run}`)?.hash ?? null })
        continue
      }
      const byEditor = b !== null && this.ownWrites.get(`${wsId}\0${key}`) === b
      if (key === REGISTRY) events.push({ type: 'changed', workspace: wsId, kind: 'registry', rev: b })
      else if (key === 'project.yaml') events.push({ type: 'changed', workspace: wsId, kind: 'project', rev: b, byEditor })
      else if (key === '.gitmodules') events.push({ type: 'changed', workspace: wsId, kind: 'repositories', rev: b, byEditor })
      else {
        if (!before.has(key) || !after.has(key)) listChanged = true
        events.push({ type: 'changed', workspace: wsId, kind: 'workflow', file: key.slice(WORKFLOWS_DIR.length + 1), rev: b, byEditor })
      }
    }
    if (listChanged) events.push({ type: 'changed', workspace: wsId, kind: 'workflows', rev: null })
    events.push(...runEvents.values())
    if (runsChanged) events.push({ type: 'changed', workspace: wsId, kind: 'runs', rev: null })
    return events
  }

  // ---- Git state -------------------------------------------------------------

  async gitFingerprint(ws: Workspace): Promise<string> {
    const status = await git(ws.root, ['status', '--porcelain=v2', '--branch', '--ignore-submodules=none'], { env: { GIT_OPTIONAL_LOCKS: '0' } })
    const parts = [status.code === 0 ? status.stdout : `status failed ${status.code}`]
    // Root status only flags a submodule as modified (S.M.) or with untracked
    // files (S..U); a further change inside an already flagged one shows only
    // in its own status. Those few are inspected individually.
    for (const line of status.stdout.split('\n')) {
      const f = line.split(' ')
      if ((f[0] === '1' || f[0] === '2') && /^S.(M|.U)/.test(f[2] ?? '')) {
        const path = f.slice(f[0] === '1' ? 8 : 9).join(' ').split('\t')[0]
        const sub = await git(join(ws.root, path), ['status', '--porcelain=v1', '-uall'], { env: { GIT_OPTIONAL_LOCKS: '0' } })
        parts.push(`${path} ${textHash(sub.stdout)}`)
      }
    }
    for (const sm of await ws.submodulePaths()) {
      const dot = join(ws.root, sm.path, '.git')
      const gitfile = await readTextOrNull(dot).catch(() => null) // a gitfile; a directory reads as an error
      const dir = gitfile?.startsWith('gitdir: ') ? join(ws.root, sm.path, gitfile.slice(8).trim()) : (await sigOf(dot)) ? dot : null
      if (!dir) { parts.push(`${sm.path} -`); continue }
      const head = (await readTextOrNull(join(dir, 'HEAD')).catch(() => null))?.trim()
      parts.push(`${sm.path} ${head} ${await sigOf(join(dir, 'logs', 'HEAD'))}`)
    }
    return textHash(parts.join('\n'))
  }

  // ---- ticks and streams -----------------------------------------------------

  private send(entry: Entry, event: string, data: unknown) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of entry.clients) c.write(line)
  }

  private async tick(entry: Entry) {
    if (entry.busy) return
    entry.busy = true
    try {
      const next = await this.snapshot(entry)
      if (entry.snapshot) for (const event of this.diff(entry.key, entry.snapshot, next)) this.send(entry, 'change', event)
      entry.snapshot = next
    } catch (e) {
      this.send(entry, 'watch-error', { error: (e as Error).message })
    } finally {
      entry.busy = false
    }
  }

  private async gitTick(entry: Entry) {
    if (entry.gitBusy || !entry.ws) return
    entry.gitBusy = true
    try {
      const next = await this.gitFingerprint(entry.ws)
      if (entry.git !== null && next !== entry.git) this.send(entry, 'change', { type: 'changed', workspace: entry.key, kind: 'git', rev: next } satisfies ChangeEvent)
      entry.git = next
    } catch (e) {
      this.send(entry, 'watch-error', { error: (e as Error).message })
    } finally {
      entry.gitBusy = false
    }
  }

  // `ws` absent: the home page's stream (registry only).
  async stream(ws: Workspace | undefined, req: IncomingMessage, res: ServerResponse) {
    const key = ws?.reg.id ?? ''
    let entry = this.entries.get(key)
    if (!entry) {
      const e: Entry = { key, ws, clients: new Set(), snapshot: null, git: null, busy: false, gitBusy: false, ready: Promise.resolve() }
      e.ready = (async () => {
        await this.tick(e)
        if (ws) await this.gitTick(e)
      })()
      e.timer = setInterval(() => void this.tick(e), this.intervalMs)
      if (ws) e.gitTimer = setInterval(() => void this.gitTick(e), this.gitIntervalMs)
      this.entries.set(key, e)
      entry = e
    }
    const current = entry
    current.clients.add(res)
    let closed = false
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
    req.on('close', () => {
      closed = true
      clearInterval(heartbeat)
      current.clients.delete(res)
      if (current.clients.size === 0) {
        clearInterval(current.timer)
        clearInterval(current.gitTimer)
        if (this.entries.get(key) === current) this.entries.delete(key)
      }
    })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    await current.ready
    if (!closed) res.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ workspace: key, intervalMs: this.intervalMs, gitIntervalMs: this.gitIntervalMs })}\n\n`)
  }
}
