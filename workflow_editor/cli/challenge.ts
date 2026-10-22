// `wfe challenge` (challenge p1, docs/challenges.md): durable shared records
// of problems found during project work, in one Git repository. Thin over
// server/challenges.ts, the store the service uses; with --service (or
// WFE_SERVICE) every command goes through that WFE service instead.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { RequestError } from '../server/workspace.ts'
import { CHALLENGE_STATES, ChallengeStore, type Challenge, type ChallengeState, type Operation, type Source } from '../server/challenges.ts'

export const CHALLENGE_HELP = `wfe challenge <subcommand> …   (durable shared records of problems; docs/challenges.md)

A challenge is a problem found during work that is worth keeping after that
work is done — to solve later, in any project, possibly together. One record
is challenges/<id>.md in the shared challenge repository: id, title, state
(open | resolved | withdrawn) and projects in its frontmatter, and a
free-form Markdown body (no template; write enough that it stays useful if
the conversation or run it came from is gone). Essential evidence files are
evidence/<id>/<name> beside it. Who wrote what, when, from which run and
source is the repository's history; you never type it into the record.
Recording or reading one starts no work, and a finished run resolves none.

list [--text <words>] [--project <id>] [--state open|resolved|withdrawn|all] [--limit <n>]
                              every project's records, newest change first (default: all states)
show <id> [--at <commit>]     the record with its revision (the commit to edit on, or to pin);
                              --at reads the revision a message or run was given
history <id>                  every revision: who, when, the request, run and source
evidence <id> [<name>] [--at <commit>] [--out <file>]
                              the evidence files, or one file's bytes
create --title <t> (--body <text> | --file <f|->) [--project <id>]... [--state <s>]
       [--evidence <file>[=<name>]]... [--source-message <conv>:<id>] [--note <t>] WRITER
edit <id> --base <commit> [--title <t>] [--body <text> | --file <f|->] [--project <id>]...
       [--state <s>] [--evidence <file>[=<name>]]... [--drop-evidence <name>]... [--note <t>] WRITER
resolve|withdraw|reopen <id> --base <commit> [--note <why>] WRITER
                              a state change is an ordinary edit; --note is its commit message.
                              Say what resolved it in the body when that helps the next reader
ops [--all]                   the journal: writes not yet published (unsynced, conflict, …)
retry [<op>]                  publish what is not yet published, and catch up backup mirrors
                              (also every executor reconcile)
discard <op> --reason <t> --by <name>
                              drop a write that is not published (its draft stays in ops --all)
status                        the repository, the head the index read, the last fetch, mirrors
reindex                       rebuild the index from the repository

WRITER is --by <name> (who writes: yourself — an agent writes as its agent,
even for the Developer; say whom with --for <person>) [--request <id>]
[--run <workspace>/<workflow>/<run>]. From an executing attempt (WFE_ATTEMPT)
the attempt is recorded. --request names the write's identity: the same one
again is the same write (default: derived from the command and the attempt,
so a repeated command is one write).

--base is the revision you read (show prints it). If the record changed since,
the edit is refused with the current revision and nothing is written: read
it again and apply your change to it. A write answers with its publication:
published (in the repository, with its commit), unsynced (not yet durable;
retried), conflict (the record changed on the remote first; your draft is kept
in ops) or refused.

Attaching a challenge to work: wfe conversation post|discussion post …
--challenge <id>[@<commit>], wfe request … --challenge <id>[@<commit>]. A run
that was given one finds it in its input (run.json input.attachments, the
file attachments/<id>@<commit>.md in its folder); a later edit never changes
what it was given.

--service <url> / WFE_SERVICE: go through the WFE service at <url>.`

export interface ChallengeCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
  area: () => string
  env: () => Promise<Record<string, string>>
  isUsage: (e: unknown) => boolean
}

async function remote(url: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown; bytes?: Buffer }> {
  const base = url.endsWith('/') ? url : `${url}/`
  const r = await fetch(new URL(path, base), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) })
  if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) {
    const bytes = Buffer.from(await r.arrayBuffer())
    if (!r.ok) throw Object.assign(new Error(`${base}: ${r.status} ${bytes.toString('utf8').slice(0, 300)}`), { status: r.status })
    return { status: r.status, data: null, bytes }
  }
  const data = await r.json() as { error?: string; detail?: unknown }
  if (!r.ok) throw Object.assign(new Error(`${base}: ${r.status} ${data?.error ?? JSON.stringify(data)}`), { status: r.status, detail: data?.detail })
  return { status: r.status, data }
}

const short = (c: string | null | undefined) => c ? c.slice(0, 12) : '—'
const recordLine = (c: Challenge) => `${c.id}  ${c.state.padEnd(9)} ${c.title}${c.projects.length ? `  [${c.projects.join(', ')}]` : ''}  (rev ${short(c.commit)}, ${c.updated.by} ${c.updated.at.slice(0, 10)})`
const opLine = (o: Operation) => `op ${o.id} ${o.kind} ${o.challenge} by ${o.actor}: ${o.state}${o.commit ? ` ${short(o.commit)}` : ''}${o.error ? ` — ${o.error}` : ''}`

function showRecord(c: Challenge, o: { latest?: { commit: string } | null; pinned?: boolean } = {}): string {
  return [
    `${c.id}: ${c.title}`,
    `state ${c.state}; projects ${c.projects.join(', ') || '(none)'}`,
    `revision ${c.commit}${o.pinned ? ` (pinned${o.latest && o.latest.commit !== c.commit ? `; the latest is ${short(o.latest.commit)}` : '; the latest'})` : ''} — edit on it with --base ${short(c.commit)}`,
    `recorded by ${c.created.by} ${c.created.at}; last changed by ${c.updated.by} ${c.updated.at}`,
    ...(c.evidence.length ? [`evidence: ${c.evidence.map(e => `${e.name} (${e.size} bytes)`).join(', ')} — wfe challenge evidence ${c.id} <name>${o.pinned ? ` --at ${short(c.commit)}` : ''}`] : []),
    ...(c.problem ? [`problem: ${c.problem}`] : []),
    '', c.body || '(no body)',
  ].join('\n')
}

function publicationLine(r: { operation: Operation; duplicate: boolean; publication: { state: string; commit: string | null; error: string | null } }): string {
  const p = r.publication
  const what = `${r.operation.kind === 'create' ? 'Recorded' : 'Edited'} ${r.operation.challenge}${r.duplicate ? ' (the same request as before: nothing new written)' : ''}`
  if (p.state === 'published') return `${what}: published as ${p.commit} (operation ${r.operation.id}).`
  if (p.state === 'unsynced') return `${what}: accepted but NOT yet in the repository (unsynced: ${p.error}). The content is kept and retried (wfe challenge retry ${r.operation.id}, or the executor's reconcile); do not report it as recorded yet.`
  if (p.state === 'conflict') return `${what}: conflict — the record changed in the repository first (${p.error}). Your draft is kept in operation ${r.operation.id} (wfe challenge ops); read the record again and save your change on it.`
  return `${what}: ${p.state}${p.error ? ` — ${p.error}` : ''} (operation ${r.operation.id}).`
}

export async function challengeCommand(c: ChallengeCli): Promise<number> {
  const [sub, id, name] = c.positional
  if (!sub || sub === 'help') { c.out(CHALLENGE_HELP, { help: CHALLENGE_HELP }); return 0 }
  const service = c.opt('service') ?? process.env.WFE_SERVICE ?? undefined
  let store: ChallengeStore | undefined
  const local = () => store ??= new ChallengeStore({ area: c.area(), env: c.env })
  const needId = () => { if (!id) throw c.usage(`${sub} <id>`); return id }
  const states = (s: string | undefined): ChallengeState | undefined => {
    if (s === undefined) return undefined
    if (!(CHALLENGE_STATES as readonly string[]).includes(s)) throw c.usage(`--state is one of ${CHALLENGE_STATES.join(', ')}`)
    return s as ChallengeState
  }
  const bodyText = () => {
    const f = c.opt('file'), t = c.opt('body')
    if (f !== undefined && t !== undefined) throw c.usage('--body or --file, not both')
    if (f !== undefined) return readFileSync(f === '-' ? 0 : f, 'utf8')
    return t
  }
  const evidence = () => c.opts('evidence').map(spec => {
    const i = spec.lastIndexOf('=')
    const [file, n] = i > 0 ? [spec.slice(0, i), spec.slice(i + 1)] : [spec, basename(spec)]
    return { name: n, bytes: readFileSync(file) }
  })
  const source = (): Source | null => {
    const s = c.opt('source-message')
    if (!s) return null
    const m = /^([a-z0-9][a-z0-9-]{0,47}):#?(\d+)$/.exec(s)
    if (!m) throw c.usage('--source-message is <conversation>:<message id>')
    return { kind: 'conversation', conversation: m[1], message: Number(m[2]) }
  }
  const writer = (content: unknown) => {
    const by = c.opt('by')
    if (!by?.trim()) throw c.usage('--by <name> is required: who writes (an agent writes as itself; --for names the person it writes for)')
    const attempt = process.env.WFE_ATTEMPT || null
    const request = c.opt('request') ?? `cli:${createHash('sha256').update(JSON.stringify({ sub, id: id ?? null, content, by, attempt })).digest('hex').slice(0, 32)}`
    return { by: by.trim(), onBehalfOf: c.opt('for') ?? null, run: c.opt('run') ?? null, attempt, via: 'cli', request }
  }
  const fail = (e: unknown): never => { throw c.refused((e as Error).message, (e as { detail?: unknown }).detail) }
  const report = (r: { operation: Operation; duplicate: boolean; record: Challenge | null; publication: { state: string; commit: string | null; error: string | null } }) => {
    c.out(publicationLine(r), r)
    return r.publication.state === 'published' ? 0 : 1
  }

  try {
    switch (sub) {
      case 'list': {
        const q = { text: c.opt('text'), project: c.opt('project'), state: states(c.opt('state')) ?? 'all' as const, limit: c.opt('limit') ? Number(c.opt('limit')) : undefined }
        const r = service
          ? (await remote(service, 'GET', `api/challenges?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`)).data as ReturnType<ChallengeStore['list']> & { operations: Operation[] }
          : (await local().sync(), { ...local().list(q), operations: local().operations({ open: true }) })
        const lines = [`${r.total} challenge(s)${q.state !== 'all' ? ` ${q.state}` : ''}${q.text ? ` matching "${q.text}"` : ''}${q.project ? ` of ${q.project}` : ''} (open ${r.counts.open}, resolved ${r.counts.resolved}, withdrawn ${r.counts.withdrawn}):`, ...r.challenges.map(x => `  ${recordLine(x)}`)]
        if (r.operations.length) lines.push('Not yet published:', ...r.operations.map(o => `  ${opLine(o)}`))
        c.out(lines.join('\n'), r)
        return 0
      }
      case 'show': {
        const at = c.opt('at')
        const r = service
          ? (await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}${at ? `?at=${encodeURIComponent(at)}` : ''}`)).data as { challenge: Challenge | null; latest: { commit: string } | null; pinned: boolean; operations: Operation[] }
          : await (async () => { const s = local(); await s.sync(); const latest = s.current(needId()); const challenge = at ? await s.at(needId(), at) : latest; return { challenge, latest: latest && { commit: latest.commit, title: latest.title, state: latest.state, updated: latest.updated }, pinned: !!at, operations: s.operations({ challenge: needId() }) } })()
        if (!r.challenge) {
          if (!r.operations.length) throw c.refused(`no challenge ${needId()}`)
          c.out([`${needId()} is not published yet:`, ...r.operations.map(o => `  ${opLine(o)}`)].join('\n'), r)
          return 1
        }
        const open = r.operations.filter(o => ['pending', 'unsynced', 'conflict'].includes(o.state))
        c.out([showRecord(r.challenge, r), ...(open.length ? ['', 'Not yet published:', ...open.map(o => `  ${opLine(o)}`)] : [])].join('\n'), r)
        return 0
      }
      case 'history': {
        const h = service ? ((await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}/history`)).data as { history: Awaited<ReturnType<ChallengeStore['log']>> }).history : await local().log(needId())
        c.out(h.length ? h.map(e => `${short(e.commit)} ${e.at} ${e.actor}${e.onBehalfOf ? ` for ${e.onBehalfOf}` : ''}: ${e.subject}${e.run ? `; run ${e.run}` : ''}${e.source ? `; from ${e.source}` : ''}${e.state ? ` [${e.state}]` : ''}`).join('\n') : `${needId()} has no published revision`, { id: needId(), history: h })
        return 0
      }
      case 'evidence': {
        const at = c.opt('at')
        if (!name) {
          const r = service ? ((await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}${at ? `?at=${at}` : ''}`)).data as { challenge: Challenge }).challenge : at ? await local().at(needId(), at) : (await local().sync(), local().current(needId()))
          if (!r) throw c.refused(`no challenge ${needId()}`)
          c.out(r.evidence.length ? r.evidence.map(e => `${e.name}  ${e.size} bytes  (${e.path} at ${short(r.commit)})`).join('\n') : `${r.id} has no evidence at ${short(r.commit)}`, { id: r.id, commit: r.commit, evidence: r.evidence })
          return 0
        }
        const bytes = service ? (await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}/evidence/${encodeURIComponent(name)}${at ? `?at=${at}` : ''}`)).bytes! : (await (async () => { if (!at) await local().sync(); return local().evidence(needId(), name, at) })()).bytes
        const outFile = c.opt('out')
        if (outFile) { await writeFile(outFile, bytes); c.out(`Wrote ${bytes.length} bytes to ${outFile}.`, { id: needId(), name, bytes: bytes.length, out: outFile }) }
        else process.stdout.write(bytes)
        return 0
      }
      case 'create': {
        const title = c.opt('title')
        if (!title) throw c.usage('create --title <t> (--body <text> | --file <f|->)')
        const fields = { title, body: bodyText() ?? '', projects: c.opts('project'), state: states(c.opt('state')), source: source(), note: c.opt('note') }
        const ev = evidence()
        const w = writer({ ...fields, evidence: ev.map(e => [e.name, createHash('sha256').update(e.bytes).digest('hex')]) })
        if (service) return report((await remote(service, 'POST', 'api/challenges', { ...fields, request: w.request, author: w.by, via: 'cli', evidence: ev.map(e => ({ name: e.name, base64: e.bytes.toString('base64') })) })).data as Parameters<typeof report>[0])
        return report(await local().create({ ...w, ...fields, evidence: ev }))
      }
      case 'edit': case 'resolve': case 'withdraw': case 'reopen': {
        const base = c.opt('base')
        if (!base) throw c.usage(`${sub} <id> --base <commit>: the revision you read (wfe challenge show prints it)`)
        const state = sub === 'edit' ? states(c.opt('state')) : ({ resolve: 'resolved', withdraw: 'withdrawn', reopen: 'open' } as const)[sub]
        const projects = c.opts('project')
        const fields = { base, title: sub === 'edit' ? c.opt('title') : undefined, body: sub === 'edit' ? bodyText() : undefined, projects: sub === 'edit' && projects.length ? projects : undefined, state, drop: c.opts('drop-evidence'), source: source(), note: c.opt('note') }
        const ev = sub === 'edit' ? evidence() : []
        const w = writer({ ...fields, evidence: ev.map(e => [e.name, createHash('sha256').update(e.bytes).digest('hex')]) })
        if (service) return report((await remote(service, 'POST', `api/challenges/${encodeURIComponent(needId())}`, { ...fields, request: w.request, author: w.by, via: 'cli', evidence: ev.map(e => ({ name: e.name, base64: e.bytes.toString('base64') })) })).data as Parameters<typeof report>[0])
        return report(await local().edit(needId(), { ...w, ...fields, evidence: ev }))
      }
      case 'ops': {
        const ops = service ? ((await remote(service, 'GET', 'api/challenges')).data as { operations: Operation[] }).operations : local().operations({ open: !c.flag('all') })
        c.out(ops.length ? ops.map(opLine).join('\n') : 'Nothing is waiting to be published.', { operations: ops })
        return 0
      }
      case 'retry': {
        if (service) {
          if (!id) throw c.usage('retry <op> with --service')
          const r = (await remote(service, 'POST', `api/challenges/operations/${encodeURIComponent(id)}/retry`, {})).data as { operation: Operation }
          c.out(opLine(r.operation), r); return r.operation.state === 'published' ? 0 : 1
        }
        if (id) { const op = await local().retry(Number(id)); c.out(opLine(op), { operation: op }); return op.state === 'published' ? 0 : 1 }
        const r = await local().publish()
        await local().sync({ force: true })
        const mirrors = await local().mirror()
        c.out([`published ${r.published.length}, unsynced ${r.failed.length}, conflicts ${r.conflicts.length}, refused ${r.refused.length}${r.failed.length ? ` — ${r.failed[0]!.error}` : ''}`, ...mirrors].join('\n'), { ...r, mirrors })
        return r.failed.length ? 1 : 0
      }
      case 'discard': {
        const by = c.opt('by'), reason = c.opt('reason')
        if (!id || !by || !reason) throw c.usage('discard <op> --reason <t> --by <name>')
        const op = service ? ((await remote(service, 'POST', `api/challenges/operations/${encodeURIComponent(id)}/discard`, { author: by, reason, via: 'cli' })).data as { operation: Operation }).operation : local().discard(Number(id), { by, reason })
        c.out(opLine(op), { operation: op }); return 0
      }
      case 'status': {
        const s = service ? ((await remote(service, 'GET', 'api/challenges?limit=1')).data as { status: Awaited<ReturnType<ChallengeStore['status']>> }).status : (await local().sync({ force: true }), await local().status())
        c.out(s.disabled ? `Challenges are not configured here: ${s.disabled}` : [
          `repository ${s.repository!.web ?? s.repository!.url} (branch ${s.repository!.branch}); index at ${short(s.head)} (${s.indexed ?? 'never'}); last fetch ${s.fetched ?? 'never'}${s.problem ? ` — problem: ${s.problem}` : ''}`,
          `operations: ${Object.entries(s.operations).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
          ...s.mirrors.map(m => `mirror ${m.url}: ${m.error ? `failing — ${m.error}` : m.commit ? `at ${short(m.commit)} (${m.at})` : 'never pushed'}`),
        ].join('\n'), s)
        return s.disabled ? 1 : 0
      }
      case 'reindex': {
        if (service) throw c.usage('reindex runs where the area is')
        await local().sync({ force: true })
        const s = await local().status()
        c.out(`Index rebuilt at ${short(s.head)}: ${local().list({ limit: 1 }).total} record(s).`, s)
        return 0
      }
      default: throw c.usage(`unknown subcommand ${sub} (wfe challenge help)`)
    }
  } catch (e) {
    // A refusal of the store keeps its detail (the current record of a
    // conflict); a usage error is the caller's; anything else is reported.
    if (e instanceof RequestError || c.isUsage(e)) throw e
    return fail(e)
  } finally { store?.close() }
}
