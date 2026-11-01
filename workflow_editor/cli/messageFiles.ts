// `wfe conversation attachments|fetch|uploads|export|restore|backup`
// (workflow_editor p19, docs/message-files.md): the files people's messages
// carried. `attachments` and `fetch` work on any host: with the
// conversation store here, or through the coordinator's routes (`--service`,
// WFE_SERVICE; what an execution node does). `fetch` reads the share where
// this host mounts it, else downloads, and checks the hash before the file
// is moved into place on this host.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { FileAttachmentRef } from '../shared/intake.ts'
import type { ConversationStore } from '../server/conversations.ts'
import type { FileView } from '../server/messageFiles.ts'

export const FILES_HELP = `Files people's messages carried (docs/message-files.md):
attachments <id> [--message <n>] [--check-bytes]
                              the files of one message (or, without --message, of every message):
                              name, type, size, sha256 and id; the listing reads no bytes.
                              --check-bytes reads each file and checks its hash (verified,
                              missing, altered, unavailable)
fetch <id> --message <n> --attachment <f-…> [--out <path>]
                              the original bytes, written on this host (an execution node too):
                              read from the share where this host mounts it, else downloaded from
                              the coordinator; the sha256 is checked before the file is put in
                              place. Default --out: .local/attachments/<id>/m<n>/<position>-<name>
uploads <id>                  upload operations (submit tokens with files): reserved, published,
                              accepted or failed, with their bundle and events — what a client's
                              retry continues; a published bundle no message accepted is not sent
export <id> --out <dir>       a self-contained recovery package: transcript, bundle manifests, every
                              original file, package.json with each hash (checked while packaging).
                              Pinned challenges are referenced, not embedded
restore <dir> --into <dir>    unpack a package into a new folder, checking every hash, and list which
                              message each file belongs to; writes no store and starts nothing
backup [--status] [--restore <bundle> --conversation <id> --into <dir>]
                              copy accepted bundles to the backup destination (attachments.json
                              "backup") and read every hash back from there (the executor's
                              reconcile does this too); --status: each bundle's backup state;
                              --restore: bring one bundle back from the backup and verify it

post <id> … --attach <path>…  (with post) send files with the message; the text may then be empty`

export interface FilesCli {
  sub: string; args: string[]
  opt: (k: string) => string | undefined
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
}
const kb = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`
const line = (f: FileAttachmentRef & { preview?: string | null }) => `  #${f.message}.${f.ordinal} ${f.id}  ${f.name}  ${f.mime}, ${kb(f.bytes)}, sha256 ${f.sha256.slice(0, 16)}…${f.preview ? ` (${f.preview})` : ''}`
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const safe = (name: string) => name.replace(/[/\\\0]/g, '_')

// Through the coordinator's routes (an execution node, or --service).
async function remote(service: string, path: string): Promise<{ status: number; json?: Record<string, unknown>; bytes?: Buffer }> {
  const base = service.endsWith('/') ? service : `${service}/`
  const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(600_000) })
  if ((r.headers.get('content-type') ?? '').startsWith('application/json')) {
    const json = await r.json() as Record<string, unknown>
    if (!r.ok) throw Object.assign(new Error(`${base}${path}: ${r.status} ${String(json.error ?? JSON.stringify(json))}`), { detail: json.detail })
    return { status: r.status, json }
  }
  if (!r.ok) throw new Error(`${base}${path}: ${r.status}`)
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }
}

// The commands that need only reads, on any host.
export async function filesRead(c: FilesCli, o: { service?: string; store?: () => ConversationStore }): Promise<number> {
  const [id] = c.args
  if (!id) throw c.usage(`${c.sub} needs <conversation id>`)
  const mf = await import('../server/messageFiles.ts')
  const n = c.opt('message') !== undefined ? Number(String(c.opt('message')).replace(/^#/, '')) : undefined
  if (n !== undefined && (!Number.isInteger(n) || n <= 0)) throw c.usage('--message takes a message id')
  const enc = encodeURIComponent
  const list = async (): Promise<(FileAttachmentRef & { preview?: string | null })[]> => {
    if (o.service) {
      if (n !== undefined) return ((await remote(o.service, `api/conversations/${enc(id)}/messages/${n}/attachments`)).json!.attachments as { kind: string }[]).filter(a => a.kind === 'file') as FileView[]
      const v = (await remote(o.service, `api/conversations/${enc(id)}`)).json as { messages: { attachments?: { kind: string }[] }[] }
      return v.messages.flatMap(m => (m.attachments ?? []).filter(a => a.kind === 'file')) as FileView[]
    }
    const cs = o.store!()
    if (!cs.conversation(id)) throw c.refused(`no conversation ${id}`)
    return cs.fileRows({ conv: id }).filter(r => n === undefined || r.message === n).map(r => mf.fileView(r))
  }
  if (c.sub === 'attachments') {
    const files = await list()
    const verify = c.flag('check-bytes')
    const states: { id: string; state: string; detail: string }[] = []
    if (verify) {
      if (o.service) {
        const v = (await remote(o.service, `api/conversations/${enc(id)}/attachments/verify${n ? `?message=${n}` : ''}`)).json as { files: { attachment: string; state: string; detail: string }[] }
        for (const f of v.files) states.push({ id: f.attachment, state: f.state, detail: f.detail })
      } else for (const f of files) { const r = await mf.checkFile(f); states.push({ id: f.id, state: r.state, detail: r.detail }) }
    }
    const lines = files.length ? files.map(f => { const s = states.find(x => x.id === f.id); return `${line(f)}${s ? `  — ${s.state}${s.state === 'verified' ? '' : `: ${s.detail}`}` : ''}` }) : [`  (no files${n ? ` in #${n}` : ''})`]
    c.out([`Files of ${id}${n ? ` #${n}` : ''} (fetch one: wfe conversation fetch ${id} --message <n> --attachment <id>):`, ...lines].join('\n'), { conversation: id, message: n ?? null, files, ...(verify ? { integrity: states } : {}) })
    return verify && states.some(s => s.state !== 'verified') ? 1 : 0
  }
  // fetch
  const att = c.opt('attachment')
  if (n === undefined || !att) throw c.usage('fetch needs --message <n> --attachment <f-…>')
  const f = (await list()).find(x => x.id === att && x.message === n)
  if (!f) throw c.refused(`message #${n} of ${id} has no attachment ${att}`, { code: 'attachment-not-found' })
  const out = resolve(c.opt('out') ?? join('.local', 'attachments', id, `m${n}`, `${f.ordinal}-${safe(f.name)}`))
  let bytes: Buffer | null = null
  let how = ''
  const here = await mf.locateFile(f.ref).catch(() => ({ state: 'unavailable' as const, detail: 'no share configuration here' }))
  if (here.state === 'ok') { bytes = await readFile((here as { abs: string }).abs); how = `read from the share on this host (${f.ref})` }
  else if (o.service) { bytes = (await remote(o.service, `api/conversations/${enc(id)}/messages/${n}/attachments/${enc(att)}?download=1`)).bytes ?? null; how = `downloaded from the coordinator (the share is ${here.state} here)` }
  else throw c.refused(`${f.ref} cannot be read here (${here.state}: ${here.detail}); on another host use the coordinator: --service <WFE URL>`, { code: here.state === 'missing' ? 'attachment-missing' : 'storage-unavailable' })
  if (!bytes || bytes.length !== f.bytes || sha(bytes) !== f.sha256) throw c.refused(`the bytes of ${att} are not the recorded ones (${bytes ? `${bytes.length} bytes, sha256 ${sha(bytes).slice(0, 12)}…` : 'none'}; recorded ${f.bytes} bytes, ${f.sha256.slice(0, 12)}…); nothing was written`, { code: 'attachment-integrity' })
  await mkdir(dirname(out), { recursive: true })
  const tmp = `${out}.wfe-fetch-${process.pid}`
  try { await writeFile(tmp, bytes); await rename(tmp, out) } finally { await rm(tmp, { force: true }) }
  c.out(`Wrote ${f.name} (${kb(f.bytes)}, sha256 verified) to ${out}; ${how}.`, { ok: true, out, attachment: f, how })
  return 0
}

// The commands of the coordinator's store.
export async function filesAdmin(c: FilesCli, cs: ConversationStore, ds: import('../server/conversationService.ts').ConversationService): Promise<number> {
  const mf = await import('../server/messageFiles.ts')
  if (c.sub === 'uploads') {
    const id = c.args[0]; if (!id) throw c.usage('uploads needs <conversation id>')
    const ops = ds.uploads(id)
    const lines = ops.length ? ops.flatMap(u => [`  ${u.id} ${u.token} by ${u.author}: ${u.state}${u.message ? ` → #${u.message}` : ''}; bundle ${u.bundle} (${(JSON.parse(u.files) as unknown[]).length} file(s))${u.error ? ` — ${u.error}` : ''}`, ...ds.uploadEvents(u.id).map(e => `      ${e.at} ${e.state}: ${e.note}`)]) : ['  (none)']
    c.out([`Upload operations of ${id}:`, ...lines].join('\n'), { conversation: id, uploads: ops.map(u => ({ ...u, files: JSON.parse(u.files), pins: JSON.parse(u.pins), events: ds.uploadEvents(u.id) })) })
    return 0
  }
  if (c.sub === 'export') {
    const id = c.args[0]; const out = c.opt('out')
    if (!id || !out) throw c.usage('export <id> --out <new folder>')
    const { ConversationArchive } = await import('../server/conversationArchive.ts')
    const pkg = await new ConversationArchive(ds).exportPackage(id, resolve(out), c.opt('author') ?? 'wfe conversation export')
    c.out(`Exported ${id} through #${pkg.horizon} to ${resolve(out)}: transcript, ${pkg.manifests.length} bundle manifest(s), ${pkg.files.length} file(s) (every hash checked)${pkg.challenges.length ? `; ${pkg.challenges.length} pinned challenge(s) referenced, not embedded` : ''}.`, { ok: true, out: resolve(out), package: pkg })
    return 0
  }
  if (c.sub === 'restore') {
    const from = c.args[0]; const into = c.opt('into')
    if (!from || !into) throw c.usage('restore <package folder> --into <new folder>')
    const r = await mf.restorePackage(resolve(from), resolve(into))
    c.out([`Restored ${r.conversation} into ${r.into}: ${r.verified} file(s) hash-verified; nothing was started or replayed.`, ...r.messages.map(m => `  #${m.message}: ${m.files.map(f => `${f.ordinal}. ${f.name} (${f.attachment}) ${f.path}`).join('; ')}`), ...(r.problems.length ? ['Problems:', ...r.problems.map(p => `  ${p}`)] : [])].join('\n'), { ok: !r.problems.length, ...r })
    return r.problems.length ? 1 : 0
  }
  // backup
  const cfg = mf.loadFilesConfig(cs.area)
  if ('disabled' in cfg) throw c.refused(cfg.disabled)
  const { FileBackups } = await import('../server/fileBackups.ts')
  const fb = new FileBackups(ds, cfg)
  const restoreBundle = c.opt('restore')
  if (restoreBundle) {
    const conv = c.opt('conversation'), into = c.opt('into')
    if (!conv || !into) throw c.usage('backup --restore <bundle> --conversation <id> --into <new folder>')
    const r = await mf.restoreFromBackup(cfg, conv, restoreBundle, resolve(into))
    c.out(`Restored bundle ${restoreBundle} of ${conv} from ${cfg.backup?.host}:${cfg.backup?.path} into ${resolve(into)}: manifest digest and ${r.files} file(s) verified.`, { ok: true, into: resolve(into), ...r })
    return 0
  }
  if (!c.flag('status')) {
    const notes = await fb.run()
    for (const n of notes) process.stderr.write(`${n}\n`)
  }
  const st = fb.status()
  c.out([`Backup of message files to ${cfg.backup ? `${cfg.backup.host}:${cfg.backup.path}` : '(none configured)'}: ${st.filter(b => b.state === 'verified').length}/${st.length} bundle(s) verified there.`, ...st.map(b => `  ${b.conv} ${b.bundle}: ${b.state}${b.at ? ` ${b.at}` : ''}${b.error ? ` — ${b.error}` : ''}`)].join('\n'), { destination: cfg.backup, bundles: st })
  return st.some(b => b.state !== 'verified') ? 1 : 0
}
