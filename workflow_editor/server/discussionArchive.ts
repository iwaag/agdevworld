// The discussion archive (workflow_editor p16, docs/discussions.md
// "Archive"): reproducible copies of discussions in the archive project's
// repository (conversations.json "discussions".archive; pj-ponderer since
// argue p4 ex1), written by one owner — this module, in the
// coordinator's reconcile and `wfe discussion archive` — in a clone nobody
// else uses (<area>/.local/discussions/archive), under a file lock.
//
//   discussions/<id>/manifest.json     identity, members and their history,
//                                      invitations, the published horizon,
//                                      provenance (runs), exports
//   discussions/<id>/transcript.jsonl  append-only: message | membership |
//                                      invitation | link | activity (argue p4:
//                                      the conductor's activities, conductor and
//                                      requester changes) | annotation | meta
//                                      (argue p4 ex2: category and display
//                                      title changes) | overview records
//
// The repository is the truth about what is published: an export reads the
// pushed manifest's horizon and appends only records beyond it, so a crash
// after a push and before the bookkeeping below is recorded publishes nothing
// twice; the next export finds the horizon already there and records the
// commit it observes. A push that fails leaves the live discussion untouched
// and the archive `failed` with the reason, retried at the next reconcile.
// Interpretation (summary.md and the like) is written by the archive
// project's own runs and integrated like any run's work; this writer never
// touches it.
//
// The destination (argue p4 ex1): each row records the repository its
// commit and horizon were verified in. When the configured archive project
// changes, a row of another destination is `unverified` — its commit names
// another repository — and due: the next export reads the new destination's
// own manifest, appends only beyond that horizon, and records the commit it
// finds there. The writer's clone of another origin is rebuilt, not
// re-pointed.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DiscussionStore, Horizon } from './discussions.ts'
import { DiscussionWorkflows } from './discussionWorkflows.ts'
import { git, gitOk } from './git.ts'
import { withLock } from './lock.ts'

export const ARCHIVE_FORMAT = 'ag.argue.discussion.v1'
const IDENTITY = { 'user.name': 'WFE discussion archive', 'user.email': 'wfe-discussion-archive@agdev.invalid' }

export interface ArchiveRow { conv: string; state: 'current' | 'failed' | 'publishing'; commit_id: string | null; horizon: string | null; published_at: string | null; error: string | null; tries: number; attempted_at: string | null; destination: string | null }
export interface ArchiveStatus {
  state: 'current' | 'behind' | 'unverified' | 'failed' | 'never' | 'disabled'
  live: Horizon
  // destination: the repository the commit was verified in (null: before v8)
  published: { commit: string; horizon: Horizon; at: string | null; url: string | null; destination: string | null } | null
  error: string | null; tries: number; attempted: string | null
  repository: string | null
}
const ZERO: Horizon = { message: 0, link: 0, membership: 0, event: 0, activity: 0, annotation: 0, meta: 0, overview: 0, workflow: 0, workflowEvent: 0 }
// A manifest written before argue p4 has no activity or annotation horizon,
// one before argue p4 ex2 no meta or overview horizon, one before argue p4
// ex3 no workflow horizon: 0.
const OPTIONAL = ['activity', 'annotation', 'meta', 'overview', 'workflow', 'workflowEvent'] as const
const covers = (a: Horizon, b: Horizon) => a.message >= b.message && a.link >= b.link && a.membership >= b.membership && a.event >= b.event && OPTIONAL.every(k => (a[k] ?? 0) >= (b[k] ?? 0))
const now = () => new Date().toISOString()
// A repository's identity: its URL without credentials, `.git` or a final
// slash (a local path as given, resolved).
export const destinationOf = (url: string) => url.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '').replace(/\.git$/, '')
const webOf = (destination: string) => /^https?:\/\//.test(destination) ? destination : null

export class DiscussionArchive {
  readonly ds: DiscussionStore
  readonly dir: string
  constructor(ds: DiscussionStore, o: { dir?: string } = {}) {
    this.ds = ds
    this.dir = o.dir ?? join(ds.area, '.local', 'discussions', 'archive')
  }
  private row(conv: string): ArchiveRow | undefined { return this.ds.db.prepare('SELECT * FROM archives WHERE conv = ?').get(conv) as ArchiveRow | undefined }
  private record(conv: string, o: Partial<ArchiveRow>) {
    const cur = this.row(conv) ?? { conv, state: 'failed', commit_id: null, horizon: null, published_at: null, error: null, tries: 0, attempted_at: null, destination: null }
    const n = { ...cur, ...o }
    this.ds.db.prepare('INSERT INTO archives (conv, state, commit_id, horizon, published_at, error, tries, attempted_at, destination) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conv) DO UPDATE SET state = excluded.state, commit_id = excluded.commit_id, horizon = excluded.horizon, published_at = excluded.published_at, error = excluded.error, tries = excluded.tries, attempted_at = excluded.attempted_at, destination = excluded.destination')
      .run(conv, n.state, n.commit_id, n.horizon, n.published_at, n.error, n.tries, n.attempted_at, n.destination)
  }

  // The archive project's repository: its workspace's origin.
  async origin(): Promise<{ url: string; web: string | null; destination: string } | { disabled: string }> {
    const cfg = this.ds.config()
    if ('disabled' in cfg) return cfg
    if (!cfg.archive) return { disabled: 'conversations.json "discussions" names no archive' }
    if (!this.ds.exec) return { disabled: 'execution is not configured here' }
    try {
      const ws = await this.ds.exec.workspace(cfg.archive.workspace)
      let url = (await gitOk(ws.root, ['remote', 'get-url', 'origin'])).trim()
      if (!/^[a-z+]+:\/\//.test(url) && !isAbsolute(url) && !/^[^/]+@[^:]+:/.test(url)) url = resolve(ws.root, url)
      const destination = destinationOf(url)
      return { url, web: webOf(destination), destination }
    } catch (e) { return { disabled: `the archive workspace ${cfg.archive.workspace} has no readable origin: ${(e as Error).message}` } }
  }

  async status(conv: string): Promise<ArchiveStatus> {
    const live = this.ds.horizon(conv)
    const o = await this.origin()
    const r = this.row(conv)
    // A link names the repository the commit was verified in, never the
    // configured one by assumption.
    const web = r?.destination ? webOf(r.destination) : null
    const published = r?.commit_id && r.horizon ? { commit: r.commit_id, horizon: JSON.parse(r.horizon) as Horizon, at: r.published_at, url: web ? `${web}/src/commit/${r.commit_id}/discussions/${conv}` : null, destination: r.destination ?? null } : null
    // Closing or reopening is published too (the final catch-up on close).
    const sameState = !r?.horizon || (JSON.parse(r.horizon) as { state?: string }).state === this.ds.discussion(conv)?.state
    const elsewhere = !!published && 'destination' in o && published.destination !== o.destination
    const state: ArchiveStatus['state'] = 'disabled' in o ? 'disabled' : r?.state === 'failed' ? 'failed' : !published ? 'never' : elsewhere ? 'unverified' : covers(published.horizon, live) && sameState ? 'current' : 'behind'
    return { state, live, published, error: 'disabled' in o ? o.disabled : r?.state === 'failed' ? r.error : elsewhere ? `published in ${published!.destination ?? 'a repository not recorded (before store v8)'}; not yet verified in ${o.destination}` : null, tries: r?.tries ?? 0, attempted: r?.attempted_at ?? null, repository: 'disabled' in o ? null : o.web ?? o.url }
  }

  // Discussions whose live records go beyond what was last published, or
  // whose state (open/closed) differs from the published one, or that failed,
  // or whose publication was verified in another destination than `dest` (the
  // configured one; given by publish). A failed one waits 2^tries minutes (at
  // most an hour) before the next try.
  due(at = Date.now(), dest?: string): string[] {
    return this.ds.list().filter(d => {
      const r = this.row(d.id)
      if (r?.state === 'failed' && r.attempted_at && at - Date.parse(r.attempted_at) < Math.min(2 ** r.tries, 60) * 60_000) return false
      if (!r || r.state !== 'current' || !r.horizon) return true
      if (dest !== undefined && r.destination !== dest) return true
      const h = JSON.parse(r.horizon) as Horizon & { state?: string }
      return !covers(h, this.ds.horizon(d.id)) || h.state !== d.state
    }).map(d => d.id)
  }

  private async env(): Promise<Record<string, string>> { return this.ds.exec?.ctx.gitea ? await this.ds.exec.ctx.gitea.gitEnv() : {} }

  // Publishes the named discussions (default: every due one) in one push.
  // Retried on a rejected push by starting again from the new remote state.
  async publish(convs?: string[], o: { beforePush?: () => Promise<void>; afterPush?: () => Promise<void> } = {}): Promise<{ published: { conv: string; commit: string; records: number }[]; unchanged: string[]; failed: { conv: string; error: string }[] }> {
    const origin = await this.origin()
    if ('disabled' in origin) return { published: [], unchanged: [], failed: (convs ?? this.due()).map(conv => ({ conv, error: origin.disabled })) }
    const targets = convs ?? this.due(Date.now(), origin.destination)
    if (!targets.length) return { published: [], unchanged: [], failed: [] }
    mkdirSync(join(this.dir, '..'), { recursive: true })
    return withLock(join(this.dir, '..', 'archive.writer'), async () => {
      const env = await this.env()
      const g = (args: string[]) => gitOk(this.dir, args, { env, config: IDENTITY, timeoutMs: 120_000 })
      const at = now()
      for (const conv of targets) this.record(conv, { attempted_at: at })
      try {
        // The clone is disposable: one of another repository is rebuilt from
        // the destination's published truth, never re-pointed.
        if (existsSync(join(this.dir, '.git'))) {
          const was = await git(this.dir, ['remote', 'get-url', 'origin'], { env })
          if (was.code !== 0 || destinationOf(was.stdout.trim()) !== origin.destination) rmSync(this.dir, { recursive: true, force: true })
          else await g(['remote', 'set-url', 'origin', origin.url])
        }
        if (!existsSync(join(this.dir, '.git'))) await gitOk(join(this.dir, '..'), ['clone', '-q', '--', origin.url, this.dir], { env, timeoutMs: 180_000 })
        for (let round = 1; ; round++) {
          await g(['fetch', '-q', 'origin'])
          const branch = await this.branch(env)
          // The clone is this writer's own: what it holds beyond the remote is
          // an unpushed earlier attempt, rebuilt from the remote's truth now.
          if ((await git(this.dir, ['rev-parse', '--verify', '-q', 'HEAD'], { env })).code === 0) await g(['reset', '-q', '--hard'])
          if ((await git(this.dir, ['rev-parse', '--verify', '-q', `origin/${branch}`], { env })).code === 0) await g(['checkout', '-q', '-B', branch, `origin/${branch}`])
          else await g(['checkout', '-q', '--orphan', branch])
          await g(['clean', '-qfd'])
          const made: { conv: string; commit: string; records: number }[] = []
          const unchanged: string[] = []
          for (const conv of targets) {
            const r = this.write(conv)
            if (!r) { unchanged.push(conv); continue }
            await g(['add', '--', `discussions/${conv}`])
            await g(['commit', '-q', '-m', `Archive discussion ${conv} through #${r.horizon.message}`, '-m', `Discussion-Horizon: ${conv} m${r.horizon.message} l${r.horizon.link} j${r.horizon.membership} e${r.horizon.event} a${r.horizon.activity ?? 0} n${r.horizon.annotation ?? 0} t${r.horizon.meta ?? 0} o${r.horizon.overview ?? 0} w${r.horizon.workflow ?? 0} x${r.horizon.workflowEvent ?? 0}`])
            made.push({ conv, commit: (await g(['rev-parse', 'HEAD'])).trim(), records: r.records })
          }
          if (made.length) {
            await o.beforePush?.()
            const p = await git(this.dir, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { env, timeoutMs: 180_000 })
            if (p.code !== 0) {
              if (round < 3 && /non-fast-forward|fetch first|rejected/.test(p.stderr)) continue
              throw new Error(`push failed: ${p.stderr.trim() || p.stdout.trim()}`)
            }
            await o.afterPush?.()
          }
          // Recorded from the repository: the commit that last changed each
          // discussion's manifest on the published branch.
          for (const conv of [...made.map(m => m.conv), ...unchanged]) {
            const m = this.published(conv)
            if (!m) continue
            const commit = (await g(['log', '-1', '--format=%H', '--', `discussions/${conv}/manifest.json`])).trim()
            this.record(conv, { state: 'current', commit_id: commit, horizon: JSON.stringify({ ...m.horizon, state: m.state }), published_at: m.exports.at(-1)?.at ?? null, error: null, tries: 0, destination: origin.destination })
          }
          return { published: made, unchanged, failed: [] }
        }
      } catch (e) {
        const error = (e as Error).message
        for (const conv of targets) this.record(conv, { state: 'failed', error, tries: (this.row(conv)?.tries ?? 0) + 1 })
        return { published: [], unchanged: [], failed: targets.map(conv => ({ conv, error })) }
      }
    }, { timeoutMs: 120_000, what: 'the discussion archive' })
  }

  private async branch(env: Record<string, string>): Promise<string> {
    const h = await git(this.dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { env })
    return h.code === 0 && h.stdout.trim() ? h.stdout.trim().replace(/^origin\//, '') : 'main'
  }

  // The manifest as published (in the checked-out remote state).
  published(conv: string): Manifest | null {
    try { return JSON.parse(readFileSync(join(this.dir, 'discussions', conv, 'manifest.json'), 'utf8')) as Manifest } catch { return null }
  }

  // Appends the records beyond the published horizon and rewrites the
  // manifest. Null when nothing changed (no new record, same state).
  private write(conv: string): { horizon: Horizon; records: number } | null {
    const d = this.ds.discussion(conv)
    if (!d) return null
    const before = this.published(conv)
    const from = before?.horizon ?? ZERO
    const live = this.ds.horizon(conv)
    const lines: { at: string; order: number; rec: Record<string, unknown> }[] = []
    for (const r of this.ds.membership(conv)) if (r.id > from.membership) lines.push({ at: r.at, order: 0, rec: { type: 'membership', id: r.id, participant: r.participant, kind: r.kind, workspace: r.workspace, workflow: r.workflow, action: r.action, by: r.by, at: r.at, note: r.note } })
    const invs = new Map(this.ds.invitations(conv).map(i => [i.id, i]))
    for (const e of this.ds.events(conv, from.event)) {
      const i = invs.get(e.invitation)
      lines.push({ at: e.at, order: 2, rec: { type: 'invitation', id: e.id, invitation: e.invitation, state: e.state, at: e.at, run: e.run, message: e.message, note: e.note, ...((e.state === 'pending' || e.state === 'awaited') && i ? { participant: i.participant, target: `${i.workspace}/${i.workflow}`, question: i.question, source: JSON.parse(i.source), by: i.by, byRun: i.by_run, awaitedBy: i.awaited_by, ...(i.awaits ? { awaits: i.awaits } : {}) } : {}) } })
    }
    // A message's attachments (challenge p1) go with it: the challenge and the
    // revision it was sent with, which resolve in the challenge repository.
    for (const m of this.ds.messages(conv, from.message)) { const att = this.ds.cs.attachmentsOf([m.id]); lines.push({ at: m.at, order: 1, rec: { type: 'message', id: m.id, at: m.at, role: m.role, author: m.author, participant: m.participant, kind: m.kind, text: m.text, re: JSON.parse(m.re), via: m.via, addressed: m.addressed ? JSON.parse(m.addressed) : [], invitation: m.invitation, run: m.run, attempt: m.attempt, question: m.question, ...(att.length ? { attachments: att } : {}) } }) }
    for (const l of this.ds.cs.links(conv)) if (l.id > from.link) lines.push({ at: l.at, order: 3, rec: { type: 'link', id: l.id, at: l.at, message: l.message, run: l.run, relation: l.relation, note: l.note, by: l.by, attempt: l.attempt, supersedes: l.supersedes } })
    for (const e of this.ds.activityEvents(conv, from.activity ?? 0)) lines.push({ at: e.at, order: 4, rec: { type: 'activity', id: e.id, at: e.at, kind: e.kind, activity: e.activity, state: e.state, by: e.by, note: e.note, data: JSON.parse(e.data) } })
    for (const a of this.ds.annotations(conv, from.annotation ?? 0)) lines.push({ at: a.at, order: 5, rec: { type: 'annotation', id: a.id, at: a.at, kind: a.kind, author: a.author, text: a.text, re: JSON.parse(a.re), run: a.run } })
    for (const m of this.ds.metaRows(conv, from.meta ?? 0)) lines.push({ at: m.at, order: 6, rec: { type: 'meta', id: m.id, at: m.at, field: m.field, value: m.value, by: m.by, run: m.run, note: m.note } })
    for (const v of this.ds.overviewRows(conv, from.overview ?? 0)) lines.push({ at: v.at, order: 7, rec: { type: 'overview', id: v.id, at: v.at, author: v.author, run: v.run, purpose: v.purpose, outcome: v.outcome, unresolved: JSON.parse(v.unresolved), through: v.through, sources: JSON.parse(v.sources), note: v.note } })
    // Workflows of the discussion (argue p4 ex3): each record as recorded,
    // later message associations, and every version a record names, once,
    // as discussions/<id>/workflows/<sha256>.yaml (what a fresh reader
    // resolves a version from after its source moved or retired).
    const wfs = new DiscussionWorkflows(this.ds)
    const snapshots: string[] = []
    for (const w of wfs.rows(conv, from.workflow ?? 0)) {
      const r = wfs.view(w)
      lines.push({ at: w.at, order: 8, rec: { type: 'workflow', ...r } })
      for (const v of [r.after, r.before]) if (v && !snapshots.includes(v.sha256)) snapshots.push(v.sha256)
    }
    for (const e of wfs.events(conv, from.workflowEvent ?? 0)) lines.push({ at: e.at, order: 9, rec: { type: 'workflow-link', id: e.id, at: e.at, ref: e.ref, message: e.message, by: e.by, run: e.run, note: e.note } })
    if (!lines.length && before?.state === d.state) return null
    lines.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order)
    const dir = join(this.dir, 'discussions', conv)
    mkdirSync(dir, { recursive: true })
    if (lines.length) appendFileSync(join(dir, 'transcript.jsonl'), lines.map(l => `${JSON.stringify(l.rec)}\n`).join(''))
    for (const sha of snapshots) {
      const snap = wfs.snapshot(sha)
      const file = join(dir, 'workflows', `${sha}.yaml`)
      if (snap && !existsSync(file)) { mkdirSync(join(dir, 'workflows'), { recursive: true }); writeFileSync(file, snap.text) }
    }
    const horizon = { message: Math.max(from.message, live.message), link: Math.max(from.link, live.link), membership: Math.max(from.membership, live.membership), event: Math.max(from.event, live.event), activity: Math.max(from.activity ?? 0, live.activity ?? 0), annotation: Math.max(from.annotation ?? 0, live.annotation ?? 0), meta: Math.max(from.meta ?? 0, live.meta ?? 0), overview: Math.max(from.overview ?? 0, live.overview ?? 0), workflow: Math.max(from.workflow ?? 0, live.workflow ?? 0), workflowEvent: Math.max(from.workflowEvent ?? 0, live.workflowEvent ?? 0) }
    const runs = new Map<string, { run: string; workspace: string; workflow: string; author: string | null; participant: string }>()
    for (const i of invs.values()) if (i.run) runs.set(i.run, { run: i.run, workspace: i.workspace, workflow: i.workflow, author: null, participant: i.participant })
    for (const m of this.ds.messages(conv)) if (m.run) { const [ws, wf] = m.run.split('/'); runs.set(m.run, { run: m.run, workspace: ws, workflow: wf, author: m.author, participant: m.participant ?? ws }) }
    const manifest: Manifest = {
      format: ARCHIVE_FORMAT, id: conv, title: d.title, created: d.created, by: d.by, state: d.state, facilitator: `${d.workspace}/${d.workflow}`,
      conductor: d.conductor ?? null, requester: this.ds.requester(conv),
      category: d.category ?? 'discussion', displayTitle: d.display_title ?? null, overview: currentOverview(this.ds, conv),
      members: this.ds.members(conv), horizon,
      activities: this.ds.activityRows(conv).map(a => this.ds.activityView(a)),
      invitations: [...invs.values()].map(i => ({ id: i.id, participant: i.participant, target: `${i.workspace}/${i.workflow}`, by: i.by, byRun: i.by_run, awaitedBy: i.awaited_by, source: JSON.parse(i.source), horizon: i.horizon, state: i.state, late: !!i.late, run: i.run, answeredBy: i.answered_by, error: i.error, deliveredTo: i.delivery ? (JSON.parse(i.delivery) as { message: number }).message : null, ...(i.awaits ? { awaits: i.awaits } : {}) })),
      runs: [...runs.values()],
      exports: [...(before?.exports ?? []), { at: now(), from, through: horizon, records: lines.length, state: d.state }],
      workflows: wfs.rows(conv).map(w => { const r = wfs.view(w); const snap = (v: typeof r.after) => v && existsSync(join(dir, 'workflows', `${v.sha256}.yaml`)) ? `workflows/${v.sha256}.yaml` : null; return { id: r.id, relation: r.relation, role: r.role, project: r.project, workflow: r.workflow, target: r.target, after: r.after, before: r.before, messages: r.messages, run: r.run, attempt: r.attempt, invitation: r.invitation, evidence: r.evidence, state: r.state, snapshot: { after: snap(r.after), before: snap(r.before) } } }),
      transcript: 'transcript.jsonl', summary: 'summary.md',
    }
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return { horizon, records: lines.length }
  }
}

// The current overview as of the export, without its live `after` count
// (the horizon says what the export covers).
function currentOverview(ds: DiscussionStore, conv: string) {
  const o = ds.overview(conv)
  if (!o) return null
  const { after, ...rest } = o
  void after
  return rest
}

export interface Manifest {
  format: string; id: string; title: string; created: string; by: string; state: string; facilitator: string
  conductor?: string | null; requester?: unknown; activities?: unknown[]
  category?: string; displayTitle?: string | null; overview?: unknown
  members: unknown[]; horizon: Horizon; invitations: unknown[]; runs: unknown[]; workflows?: unknown[]
  exports: { at: string; from: Horizon; through: Horizon; records: number; state: string }[]
  transcript: string; summary: string
}
