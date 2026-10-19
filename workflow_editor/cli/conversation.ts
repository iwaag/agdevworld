// `wfe conversation` (project_migration p8, docs/conversations.md): the
// person's conversations with the entrance, read and answered by the
// entrance's runs. Thin over server/conversations.ts, the store the service
// uses.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ConversationStore, parseRunName, RELATIONS, runName, viewBaseOf, type MessageKind, type Relation } from '../server/conversations.ts'
import type { ExecStore } from '../server/exec.ts'
import { readRun } from '../server/runs.ts'
import { RequestError } from '../server/workspace.ts'

export const CONVERSATION_HELP = `wfe conversation <subcommand> …   (the entrance's conversations; docs/conversations.md)

A conversation is the person's continuing talk with the entrance (Front).
Every message of the person starts one run of the entrance workflow with
those words as its braindump (the "turn"); that run reads the conversation,
decides what the message is, and answers here. Run state stays in the runs'
own records: a conversation links to runs, it never copies them.

list                          the conversations, newest first
show [<conv>] [--since <id>]  every message (the person's words verbatim, each reply with the
                              run that wrote it and what it answers), what each message is
                              linked to, the linked runs as their records say now, and the
                              questions still waiting for the person. Without <conv>: the
                              conversation of this attempt's run (WFE_ATTEMPT)
reply [<conv>] (--text <t> | --file <f|->) [--re <id>]… [--kind reply|question|progress|result]
              [--question <q>] [--key <k>]
                              answer the person. From an executing attempt the reply is its
                              run's: it names the run, and the same text (or --key) retried is
                              one message. --re names the messages it answers — always name
                              them when several requests are open: a reply is never
                              attributed by recency. --kind question asks the person (name your
                              run's WFE question with --question when your run waits on it);
                              result is a delivered outcome; progress says where work stands
link [<conv>] <message> --run <workspace>/<workflow>/<run> --as <relation> --note <why>
                              record what a message is to a run: ${RELATIONS.filter(r => r !== 'turn').join(', ')}.
                              A different relation later supersedes it; the message itself is
                              never rewritten. 'turn' (the run started for a message) is
                              recorded by the store
post <conv> (--text <t> | --file <f>) --author <person> [--token <t>] [--re <id>]… [--via <way>]
                              a person's message from the command line (the Front Desk posts
                              the same way); starts its turn. --via names how the words came
                              (e.g. slack) when not the Front Desk
dispatch                      start the turns of messages whose run could not be requested yet
                              (also done by the executor's reconcile)

Carrying the person's words into a run: wfe run instruct|answer … --source-message <conv>:<id>
records where they were said (the message stays the original; the run gets the reference).`

export interface ConversationCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
  exec: () => Promise<ExecStore>
  area: () => string
}

export async function conversationCommand(c: ConversationCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') { c.out(CONVERSATION_HELP, { help: CONVERSATION_HELP }); return 0 }
  const x = await c.exec()
  const store = new ConversationStore({ area: c.area(), exec: x })
  try {
    // The executing attempt's run, when there is one: the replier and the default conversation.
    const attempt = process.env.WFE_ATTEMPT || undefined
    const own = async () => {
      if (!attempt) return null
      const row = x.attemptRow(attempt)
      if (!row || row.state === 'ended') return null
      const rec = (await readRun(await x.workspace(row.workspace), { workflow: row.workflow, run: row.run })).record
      if (!rec) return null
      const run = runName(row.workspace, { workflow: row.workflow, run: row.run })
      const src = rec.input.source?.kind === 'conversation' ? rec.input.source.conversation : null
      return { run, attempt, agent: rec.executor.name, conversation: src ?? store.conversationsOfRun(run)[0] ?? null }
    }
    const conv = async (given?: string) => {
      if (given) return given
      const o = await own()
      if (o?.conversation) return o.conversation
      throw c.usage('name the conversation: this process is not an attempt of a run linked to one')
    }
    const text = () => {
      const t = c.opt('text'), f = c.opt('file')
      if (!!t === !!f) throw c.usage('give exactly one of --text <text> or --file <file|->')
      return t ?? readFileSync(f === '-' ? 0 : resolve(f!), 'utf8')
    }
    const ids = (k: string) => c.opts(k).map(v => { const n = Number(v.replace(/^#/, '')); if (!Number.isInteger(n)) throw c.usage(`--${k} takes message ids`); return n })
    const isNum = (v: string | undefined) => v !== undefined && /^#?\d+$/.test(v)
    switch (sub) {
      case 'list': {
        const rows = store.list()
        c.out(rows.length ? rows.map(r => `${r.id.padEnd(22)} ${r.state.padEnd(6)} ${String(r.count).padStart(4)} msgs  updated ${r.updated}  ${r.title}`).join('\n') : 'No conversations.', rows)
        return 0
      }
      case 'show': {
        const id = await conv(args[0])
        const v = await store.view(id, { viewBase: viewBaseOf(c.area()), since: Number(c.opt('since') ?? 0) || 0 })
        const lines = [`Conversation ${id} (${v.conversation.state}): ${v.conversation.title}`]
        for (const m of v.messages) {
          const links = v.links.filter(l => l.message === m.id && !v.links.some(x => x.supersedes === l.id))
          lines.push('', `#${m.id} ${m.at} ${m.role === 'person' ? `${m.author} (the person)${m.via ? ` via ${m.via}` : ''}` : `${m.author}${m.run ? ` for ${m.run}` : ''}`}${m.kind !== 'message' ? ` [${m.kind}${m.question ? ` ${m.question}` : ''}]` : ''}${m.re.length ? ` re ${m.re.map(n => `#${n}`).join(', ')}` : ''}`)
          lines.push(...m.text.split('\n').map(l => `    ${l}`))
          for (const l of links) lines.push(`    → ${l.relation} ${l.run}${l.relation === 'turn' ? '' : ` by ${l.by}: ${l.note}`}`)
          if (m.dispatch && m.dispatch.state !== 'started') lines.push(`    ! turn not started (${m.dispatch.state}${m.dispatch.error ? `: ${m.dispatch.error}` : ''})`)
        }
        lines.push('', 'Runs:', ...v.runs.map(r => `  ${r.key} — ${r.status?.text ?? r.situation} (${r.situation}, ${r.execution})${r.waiting.length ? `, waiting at ${r.waiting.join(', ')}` : ''}; linked as ${r.relation}${r.url ? `; ${r.url}` : ''}${r.problem ? `; ${r.problem}` : ''}`))
        lines.push(`Waiting for the person: ${v.asking.length ? v.asking.map(n => `#${n}`).join(', ') : 'nothing'}`)
        c.out(lines.join('\n'), v)
        return 0
      }
      case 'reply': {
        const id = await conv(isNum(args[0]) ? undefined : args[0])
        const o = await own()
        const author = o?.agent ?? c.opt('by')
        if (!author) throw c.usage('--by <name> is required outside an executing attempt: who replies')
        const kind = (c.opt('kind') ?? 'reply') as MessageKind
        const r = store.reply(id, { text: text(), author, run: o?.run ?? null, attempt: o?.attempt ?? null, re: ids('re'), kind, question: c.opt('question') ?? null, key: c.opt('key') })
        c.out(`${r.duplicate ? 'Already posted (same key); nothing changed' : 'Posted'}: #${r.message.id} in ${id} as ${author}${o ? ` for ${o.run}` : ''}.`, { ok: true, duplicate: r.duplicate, message: r.message })
        return 0
      }
      case 'link': {
        const given = isNum(args[0]) ? undefined : args[0]
        const id = await conv(given)
        const msg = Number((given ? args[1] : args[0])?.replace(/^#/, ''))
        if (!Number.isInteger(msg)) throw c.usage('link needs <message>')
        const run = c.opt('run'); if (!run) throw c.usage('--run <workspace>/<workflow>/<run> is required')
        parseRunName(run)
        const relation = c.opt('as') as Relation | undefined; if (!relation) throw c.usage(`--as <relation> is required (${RELATIONS.filter(r => r !== 'turn').join(', ')})`)
        const o = await own()
        const by = o?.agent ?? c.opt('by'); if (!by) throw c.usage('--by <name> is required outside an executing attempt')
        const r = store.link(id, { message: msg, run, relation, note: c.opt('note') ?? '', by, attempt: o?.attempt ?? null })
        c.out(`${r.duplicate ? 'Already linked' : 'Linked'}: #${msg} is ${relation} of ${run}${r.link.supersedes ? ` (supersedes link ${r.link.supersedes})` : ''}.`, { ok: true, ...r })
        return 0
      }
      case 'post': {
        const id = args[0]; if (!id) throw c.usage('post needs <conv>')
        const author = c.opt('author'); if (!author) throw c.usage('--author <person> is required: whose words these are')
        const r = await store.post(id, { text: text(), author, token: c.opt('token') ?? `cli-${Date.now()}-${process.pid}`, re: ids('re'), via: c.opt('via') })
        c.out(`${r.duplicate ? 'Already posted (same token)' : 'Posted'}: #${r.message.id} in ${id}; turn ${r.message.dispatch_state}${r.message.dispatch_run ? ` (${r.message.dispatch_run})` : ''}${r.message.dispatch_error ? ` — ${r.message.dispatch_error}` : ''}.`, { ok: true, ...r })
        return 0
      }
      case 'dispatch': {
        const notes = await store.dispatchDue()
        c.out(notes.join('\n') || 'Every message has its turn.', { ok: true, notes })
        return 0
      }
    }
    throw c.usage(`no conversation subcommand "${sub}" (see: wfe conversation help)`)
  } catch (e) {
    if (e instanceof RequestError) throw c.refused(e.message, e.detail)
    throw e
  } finally { store.close() }
}
