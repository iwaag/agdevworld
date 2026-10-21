// `wfe dialogue` (argue p5, docs/dialogue.md): character dialogue, the short
// reading view of discussions. Thin over server/dialogue.ts, the store the
// service and its worker use.
import { ConversationStore } from '../server/conversations.ts'
import { DialogueStore, DialogueWorker } from '../server/dialogue.ts'
import { DiscussionStore } from '../server/discussions.ts'
import type { ExecStore } from '../server/exec.ts'

export const DIALOGUE_HELP = `wfe dialogue <subcommand> …   (character dialogue; docs/dialogue.md)

Character dialogue is presentation only: each agent message of a discussion
may be read as one short line in its speaker's character voice, rendered by
the client's renderer (conversations.json "dialogue".renderer: aghangout's
renderer/render.ts) from the original speech. The person's messages are
always shown as written. Lines are kept outside version control beside the
archive (<archive workspace>/.local/character-dialogue/); no discussion read,
archive, overview or run context includes them. The WFE service's worker
renders queued lines and follows new agent speech.

status                        configuration, storage folder, the renderer (version, model, character
                              export), jobs by state, results, recent failures
show <id> [--lang ja] [--queue] [--json]
                              every message's line state: ready (with the line), pending, running,
                              failed (with the reason), unrequested, or original (the person's).
                              --queue also queues the missing lines, as a reader's page does
history <id> <msg> [--lang ja]
                              every rendering of one message, newest first: its inputs (renderer,
                              model, character export, context messages and their hashes) and usage
retry <id> <msg> [--lang ja] [--author <who>]
                              queue a failed line again, or render a ready one again (the current line
                              stays until the new one is in); a queued or running line is left alone
work [--timeout <s>]          render every queued line in this process until none is left (when the
                              service is not running, or for a check); the service's worker does the same`

export interface DialogueCli {
  positional: string[]
  opt: (k: string) => string | undefined
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  exec: () => Promise<ExecStore>
  area: () => string
}

export async function dialogueCommand(c: DialogueCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') { c.out(DIALOGUE_HELP, { help: DIALOGUE_HELP }); return 0 }
  const x = await c.exec()
  const cs = new ConversationStore({ area: c.area(), exec: x })
  const dl = new DialogueStore(new DiscussionStore(cs))
  const lang = c.opt('lang') ?? 'ja'
  try {
    if (sub === 'status') {
      const s = await dl.status()
      const lines = !s.configured ? [`not configured: ${s.problem}`] : [
        s.problem ? `problem: ${s.problem}` : null,
        'storage' in s ? `storage: ${s.storage}` : null,
        'renderer' in s && s.renderer ? `renderer: ${s.renderer.version} (${s.renderer.model}), characters ${s.renderer.characters?.slice(0, 7) ?? '?'}, ${s.renderer.path}` : null,
        'languages' in s ? `languages: ${s.languages!.join(', ')}; following new speech in ${s.follow!.join(', ') || 'none'} after message #${s.followFrom ?? '(not started)'}; ${s.concurrency} at once` : null,
        'jobs' in s ? `jobs: ${Object.entries(s.jobs!).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; results: ${s.results}` : null,
        ...('failed' in s ? (s.failed as { conv: string; message: number; language: string; tries: number; error: string }[]).map(f => `  failed ${f.conv} #${f.message} ${f.language} after ${f.tries}: ${f.error}`) : []),
      ].filter((l): l is string => !!l)
      c.out(lines.join('\n'), s)
      return 0
    }
    if (sub === 'show') {
      const id = args[0] ?? (() => { throw c.usage('wfe dialogue show <id>') })()
      const r = await dl.read(id, lang, { queue: c.flag('queue') })
      const lines = [`${id} (${lang}): ${r.available ? `renderer ${r.renderer!.version} (${r.renderer!.model})` : `unavailable — ${r.problem}`}${r.queued ? `; queued ${r.queued}` : ''}`,
        ...r.items.map(i => `#${i.message} ${i.participant ?? ''} ${i.state}${i.stale ? ' (an earlier rendering is for other inputs)' : ''}${i.text ? `: ${i.text}` : ''}${i.error ? ` — ${i.error}` : ''}`)]
      c.out(lines.join('\n'), r)
      return 0
    }
    if (sub === 'history') {
      const [id, msg] = args
      if (!id || !msg || !Number.isInteger(Number(msg))) throw c.usage('wfe dialogue history <id> <msg>')
      const h = await dl.history(id, Number(msg), lang)
      c.out(h.map(r => `${r.created} ${r.renderer} ${r.model} characters ${r.characters?.slice(0, 7)} context ${r.context.map((x: { id: number }) => `#${x.id}`).join(' ')}\n  ${r.text}`).join('\n') || 'no rendering yet', h)
      return 0
    }
    if (sub === 'retry') {
      const [id, msg] = args
      if (!id || !msg || !Number.isInteger(Number(msg))) throw c.usage('wfe dialogue retry <id> <msg>')
      const cfg = dl.ds.config()
      const r = await dl.retry(id, Number(msg), lang, c.opt('author') ?? ('disabled' in cfg ? 'cli' : cfg.person))
      c.out(`${id} #${msg} ${lang}: ${r.reason}`, r)
      return 0
    }
    if (sub === 'work') {
      const w = new DialogueWorker(dl, s => process.stderr.write(`${s}\n`))
      await w.drain(Number(c.opt('timeout') ?? 600) * 1000)
      const s = await dl.status()
      c.out(`done: ${'jobs' in s ? Object.entries(s.jobs!).map(([k, n]) => `${k} ${n}`).join(', ') : ''}`, s)
      return 0
    }
    throw c.usage(`unknown subcommand ${sub} (wfe dialogue help)`)
  } finally { dl.close(); cs.close() }
}
