// `wfe challenge` (challenge p1, p3; docs/challenges.md): durable shared
// records of problems found during project work and of the work done on them,
// one directory each in one Git repository. Thin over server/challenges.ts,
// the store the service uses; with --service (or WFE_SERVICE) every command
// goes through that WFE service instead — on an execution node it always does
// (cli/remote.ts), so files are read and written on the node itself.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { RequestError } from '../server/workspace.ts'
import { ChallengeStore, MAX_FILE, MAX_FILES, MAX_WRITE, SUMMARY, WEDO, type AddFile, type Challenge, type MaterialFile, type Operation, type Source, type Trial } from '../server/challenges.ts'

const mib = (n: number) => `${n / 1024 / 1024} MiB`

export const CHALLENGE_HELP = `wfe challenge <subcommand> …   (durable shared records of problems and the work on them; docs/challenges.md)

A challenge is a problem found during work that is worth keeping after that
work is done — to solve later, in any project, possibly together. Each one
is a directory, challenges/<id>/, in the shared challenge repository:

  challenges/ch-0001/
    summary.md            the statement: frontmatter id, title, state, projects
                          and a free-form Markdown body (optional, standard)
    voice.wav, …          source material that explains it (any names, any folders)
    wedo/<trial>/…        one directory per trial: whatever you tried, learned or
                          made — an idea, a failed experiment, a partial or a
                          better solution. Name it and fill it as you like; a
                          summary.md there is optional and shown when present.

Who wrote what, when, from which run and source is the repository's history;
you never type it into a file. Recording or reading starts no work; a
finished run resolves nothing and a new trial changes no state. The state is
the summary's: open | resolved | withdrawn are the standard ones; another
value is kept as written, and none means unspecified. Resolved and withdrawn
challenges still take trials.

A trial's summary.md is yours to shape. What was tried, what was learned,
which files show it and what is still open often help the next reader; none of
it is required. Link files with relative paths (![](out.png), [take 2](take2.wav),
[the input](../../voice.wav)).

Reading
list [--text <words>] [--project <id>] [--state <s>] [--limit <n>]
                              every project's challenges, newest change first. Text matches
                              ids, titles, summaries and trial names/summaries (not files);
                              --state: open|resolved|withdrawn|custom|unspecified|all, or a
                              state as written
show <id> [--at <commit>]     the summary, its files and trials, and the revision (the commit
                              to edit on, or to pin); --at reads a commit exactly as it was
files <id> [--trial <name>] [--at <commit>]
                              every file, by its name in the challenge's directory
file <id> <name> [--trial <name>] [--at <commit>] [--out <file>]
                              one file's bytes (stdout, or --out on this machine)
history <id> [--trial <name>] every revision: who, when, the request, run, source and paths

Writing (WRITER below)
publish <id> [--trial <name>] <path>[=<name>]... [--base <commit>] [--drop <name>]... [--note <t>]
                              files into a trial's directory (wedo/<name>/), or with no
                              --trial into the challenge's own; one commit. A directory
                              brings its whole tree (=<name> puts it under that folder; .git
                              is skipped; a symbolic link pointing outside it is refused).
                              New files need no --base; replacing or dropping files does
create --title <t> (--body <text> | --file <f|->) [--project <id>]... [--state <s>]
       [--add <path>[=<name>]]... [--source-message <conv>:<id>] [--note <t>]
                              a new challenge (its id is allocated); --add puts source
                              material beside its summary
edit <id> --base <commit> [--title <t>] [--body <text> | --file <f|->] [--project <id>]...
       [--state <s>] [--add <path>[=<name>]]... [--drop <name>]... [--trial <name>] [--note <t>]
                              changes only what you name: the summary's other fields, its
                              hand-written frontmatter and (unless --body) its body stay
resolve|withdraw|reopen <id> --base <commit> [--note <why>]
                              a state change is an ordinary edit; --note is its commit message
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
again is the same write (default: derived from the command, its files' bytes
and the attempt, so a repeated command is one write).

--base is the revision you read (show prints it). A write conflicts only where
it writes: if a file it changes (the summary, a file it replaces or drops)
changed since --base, it is refused with the current revision and nothing is
written — read again and apply your change. Others' new trials or files are no
conflict. A write answers with its publication: published (in the repository,
with its commit), unsynced (accepted but not yet durable; retried), conflict
(the files changed on the remote first; your draft is kept in ops) or refused.

Limits: a file is at most ${mib(MAX_FILE)}; one write adds at most ${mib(MAX_WRITE)} and
${MAX_FILES} files (publish larger sets in several writes). The repository has no
large-file storage: keep bigger artifacts in a durable store of their own and
link them from a summary — such a link is only as durable as that store, not
part of the repository's backup.

Attaching a challenge to work: wfe conversation post … --challenge
<id>[@<commit>], wfe request … --challenge <id>[@<commit>]. A run that was
given one finds its summary as it was in its input (run.json
input.attachments, attachments/<id>@<commit>.md in its folder); its files and
trials at that commit: wfe challenge show <id> --at <commit>.

--service <url> / WFE_SERVICE: go through the WFE service at <url>. On an
execution node every command goes to the coordinator this way: the files you
name are read here, and --out writes here.`

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
  const r = await fetch(new URL(path, base), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(600_000) })
  if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) {
    const bytes = Buffer.from(await r.arrayBuffer())
    if (!r.ok) throw Object.assign(new Error(`${base}: ${r.status} ${bytes.toString('utf8').slice(0, 300)}`), { status: r.status })
    return { status: r.status, data: null, bytes }
  }
  const data = await r.json() as { error?: string; detail?: unknown }
  if (!r.ok) throw Object.assign(new Error(`${base}: ${r.status} ${data?.error ?? JSON.stringify(data)}`), { status: r.status, detail: data?.detail })
  return { status: r.status, data }
}

// Local files for a write: a file by its name (or =<name>), a directory by
// its tree (under =<name> when given). Nothing outside a named directory is
// read through a symbolic link inside it; .git folders are skipped.
export function collectFiles(specs: string[], fail: (m: string) => Error): { files: AddFile[]; notes: string[] } {
  const files: AddFile[] = []
  const notes: string[] = []
  for (const spec of specs) {
    const i = spec.lastIndexOf('=')
    const [path, as] = i > 0 ? [spec.slice(0, i), spec.slice(i + 1)] : [spec, null]
    let st
    try { st = statSync(path) } catch { throw fail(`${path}: no such file or directory`) }
    if (!st.isDirectory()) { files.push({ name: as ?? basename(path), bytes: readFileSync(path) }); continue }
    const root = realpathSync(path)
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = join(dir, e.name)
        const name = rel ? `${rel}/${e.name}` : e.name
        if (e.name === '.git') { notes.push(`skipped ${join(path, name)} (a .git folder)`); continue }
        if (e.isSymbolicLink()) {
          let target: string
          try { target = realpathSync(abs) } catch { throw fail(`${join(path, name)} is a broken symbolic link`) }
          if (target !== root && !target.startsWith(`${root}${sep}`)) throw fail(`${join(path, name)} is a symbolic link to ${target}, outside ${path}: nothing outside the directory is published (copy the file in, or name it separately)`)
          if (lstatSync(target).isDirectory()) { notes.push(`skipped ${join(path, name)} (a symbolic link to a folder inside it)`); continue }
          files.push({ name: as ? `${as}/${name}` : name, bytes: readFileSync(target) })
        } else if (e.isDirectory()) walk(abs, name)
        else if (e.isFile()) files.push({ name: as ? `${as}/${name}` : name, bytes: readFileSync(abs) })
      }
    }
    walk(root, '')
  }
  return { files, notes }
}

const short = (c: string | null | undefined) => c ? c.slice(0, 12) : '—'
const stateText = (c: { state: string | null; stateKind?: string }) => c.state === null ? '(unspecified)' : c.stateKind === 'custom' ? `${c.state} (custom)` : c.state
const recordLine = (c: Challenge) => `${c.id}  ${stateText(c).padEnd(9)} ${c.title}${c.projects.length ? `  [${c.projects.join(', ')}]` : ''}${c.trials.length ? `  ${c.trials.length} trial(s)` : ''}  (rev ${short(c.commit)}, ${c.updated.by} ${c.updated.at.slice(0, 10)})`
const opLine = (o: Operation) => `op ${o.id} ${o.kind} ${o.challenge}${o.trial ? ` ${WEDO}/${o.trial}` : ''} by ${o.actor}: ${o.state}${o.commit ? ` ${short(o.commit)}` : ''}${o.error ? ` — ${o.error}` : ''}`
const fileLine = (f: MaterialFile, indent = '  ') => `${indent}${f.name}  ${f.size} bytes`
const trialLine = (t: Trial) => `  ${t.dir}/  ${t.files.length} file(s)${t.summary ? `, summary${t.summary.title ? `: ${t.summary.title}` : ''}` : ', no summary'} — ${t.updated.by} ${t.updated.at.slice(0, 10)} (rev ${short(t.commit)})`

function showRecord(c: Challenge, o: { latest?: { commit: string } | null; pinned?: boolean } = {}): string {
  const at = o.pinned ? ` --at ${short(c.commit)}` : ''
  return [
    `${c.id}: ${c.title}${c.summary ? '' : ` (no ${SUMMARY})`}`,
    `state ${stateText(c)}; projects ${c.projects.join(', ') || '(none)'}`,
    `revision ${c.commit}${o.pinned ? ` (pinned${o.latest && o.latest.commit !== c.commit ? `; the latest is ${short(o.latest.commit)}` : '; the latest'})` : ''} — edit on it with --base ${short(c.commit)}`,
    `recorded by ${c.created.by} ${c.created.at}; last changed by ${c.updated.by} ${c.updated.at}`,
    ...(c.layout === 'legacy' ? [`(the layout before challenge p3 at this commit: ${c.path} and evidence/${c.id}/)`] : []),
    ...(c.problem ? [`note: ${c.problem}`] : []),
    ...(c.files.length ? [`files (wfe challenge file ${c.id} <name>${at}):`, ...c.files.map(f => fileLine(f))] : []),
    ...(c.trials.length ? [`trials (${c.trials.length}; wfe challenge files ${c.id} --trial <name>${at}):`, ...c.trials.map(trialLine)] : ['trials: none yet']),
    '', c.body || `(no ${c.summary ? 'body' : SUMMARY})`,
  ].join('\n')
}

function publicationLine(r: { operation: Operation; duplicate: boolean; publication: { state: string; commit: string | null; error: string | null } }): string {
  const p = r.publication
  const o = r.operation
  const what = `${o.kind === 'create' ? 'Recorded' : o.trial ? `Published ${WEDO}/${o.trial} of` : Object.keys(o.fields).length ? 'Edited' : 'Published files of'} ${o.challenge}${r.duplicate ? ' (the same request as before: nothing new written)' : ''}`
  if (p.state === 'published') return `${what}: published as ${p.commit} (operation ${o.id}; ${o.files.length} file(s) added${o.drop.length ? `, ${o.drop.length} dropped` : ''}).`
  if (p.state === 'unsynced') return `${what}: accepted but NOT yet in the repository (unsynced: ${p.error}). The content is kept and retried (wfe challenge retry ${o.id}, or the executor's reconcile); do not report it as recorded yet.`
  if (p.state === 'conflict') return `${what}: conflict — the files it writes changed in the repository first (${p.error}). Your draft is kept in operation ${o.id} (wfe challenge ops); read the challenge again and write your change on it.`
  return `${what}: ${p.state}${p.error ? ` — ${p.error}` : ''} (operation ${o.id}).`
}

export async function challengeCommand(c: ChallengeCli): Promise<number> {
  const [sub, id, ...names] = c.positional
  if (!sub || sub === 'help') { c.out(CHALLENGE_HELP, { help: CHALLENGE_HELP }); return 0 }
  const service = c.opt('service') ?? process.env.WFE_SERVICE ?? undefined
  let store: ChallengeStore | undefined
  const local = () => store ??= new ChallengeStore({ area: c.area(), env: c.env })
  const needId = () => { if (!id) throw c.usage(`${sub} <id>`); return id }
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')
  const bodyText = () => {
    const f = c.opt('file'), t = c.opt('body')
    if (f !== undefined && t !== undefined) throw c.usage('--body or --file, not both')
    if (f !== undefined) return readFileSync(f === '-' ? 0 : f, 'utf8')
    return t
  }
  const collect = (specs: string[]) => { const r = collectFiles(specs, m => c.refused(m)); for (const n of r.notes) process.stderr.write(`wfe challenge: ${n}\n`); return r.files }
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
  const hashes = (files: AddFile[]) => files.map(e => [e.name, createHash('sha256').update(e.bytes).digest('hex')])
  const wire = (files: AddFile[]) => files.map(e => ({ name: e.name, base64: e.bytes.toString('base64') }))
  const fail = (e: unknown): never => { throw c.refused((e as Error).message, (e as { detail?: unknown }).detail) }
  const report = (r: { operation: Operation; duplicate: boolean; record: Challenge | null; publication: { state: string; commit: string | null; error: string | null } }) => {
    c.out(publicationLine(r), r)
    return r.publication.state === 'published' ? 0 : 1
  }
  const read = async (at: string | undefined) => service
    ? (await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}${at ? `?at=${encodeURIComponent(at)}` : ''}`)).data as { challenge: Challenge | null; latest: { commit: string } | null; pinned: boolean; operations: Operation[] }
    : await (async () => { const s = local(); await s.sync(); const latest = s.current(needId()); const challenge = at ? await s.at(needId(), at) : latest; return { challenge, latest: latest && { commit: latest.commit, title: latest.title, state: latest.state, updated: latest.updated }, pinned: !!at, operations: s.operations({ challenge: needId() }) } })()

  try {
    switch (sub) {
      case 'list': {
        const q = { text: c.opt('text'), project: c.opt('project'), state: c.opt('state') ?? 'all', limit: c.opt('limit') ? Number(c.opt('limit')) : undefined }
        const r = service
          ? (await remote(service, 'GET', `api/challenges?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`)).data as ReturnType<ChallengeStore['list']> & { operations: Operation[] }
          : (await local().sync(), { ...local().list(q), operations: local().operations({ open: true }) })
        const n = r.counts
        const lines = [`${r.total} challenge(s)${q.state !== 'all' ? ` ${q.state}` : ''}${q.text ? ` matching "${q.text}"` : ''}${q.project ? ` of ${q.project}` : ''} (open ${n.open}, resolved ${n.resolved}, withdrawn ${n.withdrawn}, custom ${n.custom}${r.custom.length ? ` [${r.custom.map(x => `${x.state} ${x.count}`).join(', ')}]` : ''}, unspecified ${n.unspecified}):`,
          ...r.challenges.flatMap(x => [`  ${recordLine(x)}`, ...((x as { matches?: { trial: string; excerpt: string | null }[] }).matches ?? []).map(m => `      matched in ${WEDO}/${m.trial}${m.excerpt ? `: ${m.excerpt}` : ''}`)])]
        if (r.operations.length) lines.push('Not yet published:', ...r.operations.map(o => `  ${opLine(o)}`))
        c.out(lines.join('\n'), r)
        return 0
      }
      case 'show': {
        const r = await read(c.opt('at'))
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
        const trial = c.opt('trial')
        const h = service ? ((await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}/history${trial ? `?trial=${encodeURIComponent(trial)}` : ''}`)).data as { history: Awaited<ReturnType<ChallengeStore['log']>> }).history : await local().log(needId(), { trial })
        c.out(h.length ? h.map(e => `${short(e.commit)} ${e.at} ${e.actor}${e.onBehalfOf ? ` for ${e.onBehalfOf}` : ''}: ${e.subject}${e.run ? `; run ${e.run}` : ''}${e.source ? `; from ${e.source}` : ''}${e.state ? ` [${e.state}]` : ''}`).join('\n') : `${needId()}${trial ? ` ${WEDO}/${trial}` : ''} has no published revision`, { id: needId(), trial: trial ?? null, history: h })
        return 0
      }
      case 'files': case 'file': {
        const at = c.opt('at')
        const trial = c.opt('trial')
        const prefix = trial ? `${WEDO}/${trial}/` : ''
        const name = names[0]
        if (sub === 'files' || !name) {
          const r = (await read(at)).challenge
          if (!r) throw c.refused(`no challenge ${needId()}`)
          const t = trial ? r.trials.find(x => x.name === trial) : null
          if (trial && !t) throw c.refused(`${r.id} has no trial ${trial} at ${short(r.commit)} (trials: ${r.trials.map(x => x.name).join(', ') || 'none'})`)
          const lines = t ? [`${r.id} ${t.dir}/ at ${short(r.commit)}:`, ...t.files.map(f => fileLine(f))]
            : [`${r.id} at ${short(r.commit)}:`, ...(r.summary ? [fileLine({ name: SUMMARY, path: r.path, size: 0 }).replace(/ {2}0 bytes$/, '  (the summary)')] : []), ...r.files.map(f => fileLine(f)), ...r.trials.flatMap(x => x.files.map(f => fileLine(f)))]
          c.out(lines.join('\n'), { id: r.id, commit: r.commit, layout: r.layout, files: t ? t.files : r.files, trials: t ? [t] : r.trials })
          return 0
        }
        const full = prefix + name.replace(/^\.\/+/, '')
        const bytes = service ? (await remote(service, 'GET', `api/challenges/${encodeURIComponent(needId())}/files/${enc(full)}${at ? `?at=${encodeURIComponent(at)}` : ''}`)).bytes! : (await (async () => { if (!at) await local().sync(); return local().file(needId(), { name: full }, at) })()).bytes
        const outFile = c.opt('out')
        if (outFile) { await mkdir(dirname(resolve(outFile)), { recursive: true }); await writeFile(outFile, bytes); c.out(`Wrote ${bytes.length} bytes to ${outFile}.`, { id: needId(), name: full, bytes: bytes.length, out: resolve(outFile) }) }
        else process.stdout.write(bytes)
        return 0
      }
      case 'create': {
        const title = c.opt('title')
        if (!title) throw c.usage('create --title <t> (--body <text> | --file <f|->)')
        const fields = { title, body: bodyText() ?? '', projects: c.opts('project'), state: c.opt('state'), source: source(), note: c.opt('note') }
        const files = collect(c.opts('add'))
        const w = writer({ ...fields, files: hashes(files) })
        if (service) return report((await remote(service, 'POST', 'api/challenges', { ...fields, request: w.request, author: w.by, onBehalfOf: w.onBehalfOf, run: w.run, attempt: w.attempt, via: 'cli', files: wire(files) })).data as Parameters<typeof report>[0])
        return report(await local().create({ ...w, ...fields, files }))
      }
      case 'publish': case 'edit': case 'resolve': case 'withdraw': case 'reopen': {
        const base = c.opt('base')
        if (sub !== 'publish' && !base) throw c.usage(`${sub} <id> --base <commit>: the revision you read (wfe challenge show prints it)`)
        const state = sub === 'edit' ? c.opt('state') : sub === 'publish' ? undefined : ({ resolve: 'resolved', withdraw: 'withdrawn', reopen: 'open' } as const)[sub]
        const projects = c.opts('project')
        const editing = sub === 'edit'
        const specs = sub === 'publish' ? names : editing ? c.opts('add') : []
        if (sub === 'publish' && !specs.length && !c.opts('drop').length) throw c.usage('publish <id> [--trial <name>] <path>[=<name>]...: the files or directories to publish')
        const files = collect(specs)
        const fields = { base: base ?? null, title: editing ? c.opt('title') : undefined, body: editing ? bodyText() : undefined, projects: editing && projects.length ? projects : undefined, state, trial: c.opt('trial'), drop: sub === 'publish' || editing ? c.opts('drop') : [], source: source(), note: c.opt('note') }
        const w = writer({ ...fields, files: hashes(files) })
        if (service) return report((await remote(service, 'POST', `api/challenges/${encodeURIComponent(needId())}`, { ...fields, request: w.request, author: w.by, onBehalfOf: w.onBehalfOf, run: w.run, attempt: w.attempt, via: 'cli', files: wire(files) })).data as Parameters<typeof report>[0])
        return report(await local().edit(needId(), { ...w, ...fields, files }))
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
          `limits: a file ${mib(s.limits.file)}, a write ${mib(s.limits.write)} and ${s.limits.files} files`,
        ].join('\n'), s)
        return s.disabled ? 1 : 0
      }
      case 'reindex': {
        if (service) throw c.usage('reindex runs where the area is')
        await local().sync({ force: true })
        const s = await local().status()
        c.out(`Index rebuilt at ${short(s.head)}: ${local().list({ limit: 1 }).total} challenge(s).`, s)
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

