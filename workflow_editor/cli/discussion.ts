// `wfe discussion` (workflow_editor p16, docs/discussions.md): discussions of
// a person, a facilitator and project agents, each speaking through its own
// runs. Thin over server/discussions.ts and server/discussionArchive.ts, the
// store and archive writer the service uses.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONVERSATION_ID, ConversationStore, parseRunName, RELATIONS, runName, viewBaseOf, type MessageKind, type Relation } from '../server/conversations.ts'
import { DiscussionArchive } from '../server/discussionArchive.ts'
import { DiscussionStore } from '../server/discussions.ts'
import type { ExecStore } from '../server/exec.ts'
import { readRun } from '../server/runs.ts'
import { RequestError } from '../server/workspace.ts'

export const DISCUSSION_HELP = `wfe discussion <subcommand> …   (discussions; docs/discussions.md)

A discussion is a shared conversation of a person, a facilitator (argue)
and project agents, each speaking through runs of its own project's
workflow with its own guide and context. Its members and their history,
every message (the person's words verbatim; each agent message with the
participant, run and invitation it came from) and its invitations are
kept by WFE. An invitation is the only thing that starts a run here: the
person's message invites the participants it addresses, or the facilitator
when it addresses nobody; the facilitator invites from its run and is told,
in one instruction, when everything it awaits is resolved. A contribution
never starts anything by itself.

participants                  the facilitator and the projects that can be invited, and whether
                              each can take an invitation now
list                          the discussions, newest first, with members and open invitations
show [<id>] [--since <msg>]   members and their history, every message (who spoke, for which
                              run and invitation, what it answers, whom the person addressed),
                              the invitations (state, run, horizon, outcome), linked runs as their
                              records say now, questions waiting for the person, the archive.
                              Without <id>: the discussion of this attempt's run. Messages after
                              your invitation's horizon are marked: they are readable, and newer
                              than what you were invited with
create <id> --title <t> --author <person> [--member <project>]…
                              a new discussion with the person, the facilitator and the projects
post <id> (--text <t> | --file <f>) --author <person> [--to <participant>]… [--re <msg>]…
     [--token <t>] [--via <way>]
                              the person's message, verbatim. --to invites those participants with
                              it; without --to (or --to <facilitator>) the facilitator is invited
contribute [<id>] (--text <t> | --file <f|->) --re <msg>… [--kind reply|question|progress|result|synthesis]
           [--question <q>] [--key <k>]
                              speak from an executing attempt: the message is your run's, its
                              participant's and its invitation's. Name what you answer (--re): a
                              reply is never attributed by recency. reply/result/synthesis answer
                              your invitation; progress and question do not. synthesis is the
                              facilitator's (shown apart from original speech)
invite [<id>] <participant> --question <q> [--re <msg>]… [--token <t>] [--author <person>]
                              ask a participant: from the facilitator's run the invitation is
                              awaited (your run is told when all it awaits are resolved; make your
                              node wait with wfe run wait … --external discussion:<id> and end your
                              attempt to free the slot). Outside an attempt it is the person's
                              (--author). A participant's run cannot invite: say whom you would ask
withdraw <id> <invitation> --reason <why> [--author <person>]
                              withdraw an invitation not started yet
join <id> <participant> [--note <n>] [--author <who>]    a member joins (recorded in the history)
leave <id> <participant> [--note <n>] [--author <who>]   a member leaves; its speech stays
link [<id>] <msg> --run <workspace>/<workflow>/<run> --as <relation> --note <why>
                              what a message is to a run: ${RELATIONS.filter(r => r !== 'turn').join(', ')}.
                              handoff: work an outcome was handed to in another project
close <id> [--author <who>]   end automatic dispatch: invitations not started are withdrawn;
                              started ones finish and are recorded; no facilitator is continued;
                              nothing downstream is cancelled
reopen <id> [--author <who>]  continue it; nothing withdrawn or completed is replayed
dispatch                      start invitations not started yet, mark those whose run ended
                              without a contribution unanswered, tell waiting facilitators
                              (also done by the executor's reconcile every minute)
archive [<id>…] [--status]    publish the archive (pj-argue discussions/<id>/manifest.json and
                              transcript.jsonl) for the named or every due discussion, or say
                              what is published: commit, horizon, and what is still behind

Carrying the person's words into a run: wfe run instruct|answer … --source-message <id>:<msg>.`

export interface DiscussionCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
  exec: () => Promise<ExecStore>
  area: () => string
}

export async function discussionCommand(c: DiscussionCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') { c.out(DISCUSSION_HELP, { help: DISCUSSION_HELP }); return 0 }
  const x = await c.exec()
  const cs = new ConversationStore({ area: c.area(), exec: x })
  const ds = new DiscussionStore(cs)
  try {
    const attempt = process.env.WFE_ATTEMPT || undefined
    // The executing attempt's run: the speaker, and its discussion and invitation.
    const own = async () => {
      if (!attempt) return null
      const row = x.attemptRow(attempt)
      if (!row || row.state === 'ended') return null
      const rec = (await readRun(await x.workspace(row.workspace), { workflow: row.workflow, run: row.run })).record
      if (!rec) return null
      const run = runName(row.workspace, { workflow: row.workflow, run: row.run })
      const src = rec.input.source?.kind === 'conversation' ? rec.input.source : null
      return { run, attempt, agent: rec.executor.name, discussion: src && ds.discussion(src.conversation) ? src.conversation : null, invitation: src?.invitation ?? null }
    }
    const disc = async (given?: string) => {
      if (given && !CONVERSATION_ID.test(given)) throw c.usage(`"${given.length > 40 ? `${given.slice(0, 40)}…` : given}" is not a discussion id; text goes in --text <text> (or --file <file|->)`)
      if (given) return given
      const o = await own()
      if (o?.discussion) return o.discussion
      throw c.usage('name the discussion: this process is not an attempt of a run invited to one')
    }
    const text = () => {
      const t = c.opt('text'), f = c.opt('file')
      if (!!t === !!f) throw c.usage('give exactly one of --text <text> or --file <file|->')
      return t ?? readFileSync(f === '-' ? 0 : resolve(f!), 'utf8')
    }
    const ids = (k: string) => c.opts(k).map(v => { const n = Number(v.replace(/^#/, '')); if (!Number.isInteger(n)) throw c.usage(`--${k} takes message ids`); return n })
    const isNum = (v: string | undefined) => v !== undefined && /^#?\d+$/.test(v)
    const who = async () => { const o = await own(); return o?.agent ?? c.opt('author') ?? c.opt('by') }
    switch (sub) {
      case 'participants': {
        const rows = await ds.participants()
        const cfg = ds.config()
        c.out(rows.length ? rows.map(p => `${p.participant.padEnd(12)} ${p.kind.padEnd(11)} ${p.target.padEnd(22)} ${p.state.padEnd(11)} ${p.agent ?? ''}${p.problem ? ` — ${p.problem}` : ''}`).join('\n') : 'disabled' in cfg ? cfg.disabled : 'No participants configured.', rows)
        return 0
      }
      case 'list': {
        const rows = ds.list()
        c.out(rows.length ? rows.map(r => `${r.id.padEnd(24)} ${r.state.padEnd(6)} ${String(r.count).padStart(4)} msgs  ${String(r.open).padStart(2)} open  [${r.members.join(', ')}]  ${r.title}`).join('\n') : 'No discussions.', rows)
        return 0
      }
      case 'show': {
        const id = await disc(args[0])
        const o = await own()
        const v = await ds.view(id, { viewBase: viewBaseOf(c.area()), since: Number(c.opt('since') ?? 0) || 0 })
        const archive = await new DiscussionArchive(ds).status(id)
        const mine = o?.invitation ? v.invitations.find(i => i.id === o.invitation) : undefined
        const lines = [`Discussion ${id} (${v.discussion.state}): ${v.discussion.title}`, `Facilitator: ${v.discussion.facilitator}. Members: ${v.members.map(m => `${m.participant} (${m.kind}${m.workspace ? ` ${m.workspace}/${m.workflow}` : ''})`).join(', ')}`]
        if (mine) lines.push(`You are ${mine.participant}, invited (invitation ${mine.id}) by ${mine.by}${mine.byRun ? ` (${mine.byRun})` : ''} about ${mine.source.map(n => `#${n}`).join(', ')}; horizon #${mine.horizon}.`)
        const history = v.membership.filter(r => r.action === 'leave' || r.note !== 'created the discussion')
        if (history.length) lines.push('Membership:', ...history.map(r => `  ${r.at} ${r.participant} ${r.action} (by ${r.by}${r.note ? `: ${r.note}` : ''})`))
        for (const m of v.messages) {
          const after = mine && m.id > mine.horizon ? ' (after your invitation)' : ''
          const head = m.role === 'person'
            ? `${m.author} (person)${m.via ? ` via ${m.via}` : ''}${m.addressed.length ? ` to ${m.addressed.join(', ')}` : ''}`
            : `${m.participant ?? m.author} (${m.author}${m.run ? ` for ${m.run}` : ''}${m.invitation ? `, invitation ${m.invitation}` : ''})`
          lines.push('', `#${m.id} ${m.at} ${head}${m.kind !== 'message' ? ` [${m.kind}${m.question ? ` ${m.question}` : ''}]` : ''}${m.re.length ? ` re ${m.re.map(n => `#${n}`).join(', ')}` : ''}${after}`)
          lines.push(...m.text.split('\n').map(l => `    ${l}`))
          for (const l of v.links.filter(l => l.message === m.id && !v.links.some(y => y.supersedes === l.id))) lines.push(`    → ${l.relation} ${l.run} by ${l.by}: ${l.note}`)
        }
        lines.push('', 'Invitations:', ...v.invitations.map(i => `  ${i.id} → ${i.participant} (${i.target}) by ${i.by}${i.byRun ? ` ${i.byRun}` : ''}${i.awaitedBy ? ', awaited' : ''}: ${i.state}${i.late ? ' (late)' : ''}${i.run ? ` ${i.run}` : ''}${i.answeredBy ? ` answered by #${i.answeredBy}` : ''}${i.error ? ` — ${i.error}` : ''}; about ${i.source.map(n => `#${n}`).join(', ')}; "${i.question.split('\n')[0].slice(0, 100)}"`))
        if (!v.invitations.length) lines.push('  (none)')
        lines.push('', 'Runs (run view; files: append a path in the run folder):', ...v.runs.map(r => `  ${r.key} — ${r.status?.text ?? r.situation} (${r.situation}, ${r.execution}); ${r.relation}${r.url ? `; ${r.url}` : ''}${r.files ? `; files ${r.files}` : ''}${r.presentations.map(p => `; review ${p.id} ${p.url}`).join('')}${r.problem ? `; ${r.problem}` : ''}`))
        lines.push(`Waiting for the person: ${v.asking.length ? v.asking.map(n => `#${n}`).join(', ') : 'nothing'}`)
        lines.push(`Archive: ${archive.state}${archive.published ? ` — ${archive.published.commit.slice(0, 12)} through #${archive.published.horizon.message}${archive.published.url ? ` ${archive.published.url}` : ''}` : ''}${archive.error ? ` (${archive.error})` : ''}`)
        c.out(lines.join('\n'), { ...v, archive })
        return 0
      }
      case 'create': {
        const id = args[0]; if (!id) throw c.usage('create needs <id>')
        const title = c.opt('title'); if (!title) throw c.usage('--title <title> is required')
        const author = c.opt('author'); if (!author) throw c.usage('--author <person> is required: who opens it')
        const r = ds.create(id, { title, by: author, members: c.opts('member') })
        c.out(`${r.duplicate ? 'Already exists' : 'Created'}: discussion ${id} with ${ds.members(id).map(m => m.participant).join(', ')}.`, { ok: true, ...r, members: ds.members(id) })
        return 0
      }
      case 'post': {
        const id = args[0]; if (!id) throw c.usage('post needs <id>')
        const author = c.opt('author'); if (!author) throw c.usage('--author <person> is required: whose words these are')
        const r = await ds.post(id, { text: text(), author, token: c.opt('token') ?? `cli-${Date.now()}-${process.pid}`, re: ids('re'), to: c.opts('to'), via: c.opt('via') })
        c.out(`${r.duplicate ? 'Already posted (same token)' : 'Posted'}: #${r.message.id} in ${id}${r.reopened ? ' (reopened)' : ''}; ${r.invitations.map(i => `invitation ${i.id} → ${i.participant}: ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}`).join('; ')}.`, { ok: true, ...r })
        return 0
      }
      case 'contribute': {
        const id = await disc(isNum(args[0]) ? undefined : args[0])
        const o = await own()
        if (!o) throw c.usage('contribute speaks for an executing attempt\'s run (WFE_ATTEMPT); the person posts with: wfe discussion post')
        const re = ids('re')
        if (!re.length) throw c.usage('--re <msg> is required: the messages you answer')
        const r = await ds.contribute(id, { text: text(), author: o.agent, run: o.run, attempt: o.attempt, invitation: o.discussion === id ? o.invitation : null, re, kind: (c.opt('kind') ?? 'reply') as MessageKind, question: c.opt('question') ?? null, key: c.opt('key') })
        c.out(`${r.duplicate ? 'Already posted (same key); nothing changed' : 'Posted'}: #${r.message.id} in ${id} as ${r.message.participant} for ${o.run}${r.invitation ? `; invitation ${r.invitation.id} ${r.invitation.state}${r.invitation.late ? ' (late)' : ''}` : ''}.`, { ok: true, ...r })
        return 0
      }
      case 'invite': {
        const named = args.length >= 2 ? args : [undefined, args[0]]
        const id = await disc(named[0])
        const participant = named[1]; if (!participant) throw c.usage('invite needs <participant>')
        const question = c.opt('question'); if (!question) throw c.usage('--question <text> is required: what the participant is asked')
        const o = await own()
        const by = o?.agent ?? c.opt('author'); if (!by) throw c.usage('--author <person> is required outside an executing attempt')
        const r = await ds.invite(id, { participant, question, re: ids('re'), by, byRun: o?.run ?? null, token: c.opt('token') })
        const i = r.invitation
        c.out(`${r.duplicate ? 'Already invited (same invitation)' : 'Invited'}: invitation ${i.id} → ${i.participant}: ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}${i.awaited_by ? `; awaited by ${i.awaited_by}` : ''}.`, { ok: true, ...r })
        return 0
      }
      case 'withdraw': {
        const [id, n] = args; if (!id || !isNum(n)) throw c.usage('withdraw needs <id> <invitation>')
        const reason = c.opt('reason'); if (!reason) throw c.usage('--reason <why> is required')
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        const i = ds.withdrawInvitation(id, Number(n.replace(/^#/, '')), { by, reason })
        c.out(`Withdrawn: invitation ${i.id} → ${i.participant}.`, { ok: true, invitation: i })
        return 0
      }
      case 'join':
      case 'leave': {
        const [id, participant] = args; if (!id || !participant) throw c.usage(`${sub} needs <id> <participant>`)
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        if (sub === 'join') { const r = ds.join(id, participant, { by, note: c.opt('note'), person: c.flag('person') }); c.out(`${r.duplicate ? 'Already a member' : 'Joined'}: ${participant} in ${id}.`, { ok: true, ...r }) }
        else { const r = ds.leave(id, participant, { by, note: c.opt('note') }); c.out(r.left ? `Left: ${participant} from ${id}.` : `${participant} is not a member of ${id}; nothing changed.`, { ok: true, ...r }) }
        return 0
      }
      case 'link': {
        const given = isNum(args[0]) ? undefined : args[0]
        const id = await disc(given)
        const msg = Number((given ? args[1] : args[0])?.replace(/^#/, ''))
        if (!Number.isInteger(msg)) throw c.usage('link needs <msg>')
        const run = c.opt('run'); if (!run) throw c.usage('--run <workspace>/<workflow>/<run> is required')
        parseRunName(run)
        const relation = c.opt('as') as Relation | undefined; if (!relation) throw c.usage(`--as <relation> is required (${RELATIONS.filter(r => r !== 'turn').join(', ')})`)
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        ds.discussion(id) ?? (() => { throw c.refused(`no discussion ${id}`) })()
        const r = cs.link(id, { message: msg, run, relation, note: c.opt('note') ?? '', by, attempt: (await own())?.attempt ?? null })
        c.out(`${r.duplicate ? 'Already linked' : 'Linked'}: #${msg} is ${relation} of ${run}.`, { ok: true, ...r })
        return 0
      }
      case 'close': {
        const id = args[0]; if (!id) throw c.usage('close needs <id>')
        const by = await who() ?? 'person'
        const r = ds.close(id, { by })
        c.out(`Closed ${id}${r.withdrawn.length ? `; withdrawn invitations ${r.withdrawn.join(', ')}` : ''}. Started runs finish and are recorded.`, { ok: true, ...r })
        return 0
      }
      case 'reopen': {
        const id = args[0]; if (!id) throw c.usage('reopen needs <id>')
        const r = ds.reopen(id, { by: await who() ?? 'person' })
        c.out(`Reopened ${id}.`, { ok: true, discussion: r })
        return 0
      }
      case 'dispatch': {
        const notes = await ds.reconcile()
        c.out(notes.join('\n') || 'Nothing to start, mark or tell.', { ok: true, notes })
        return 0
      }
      case 'archive': {
        const a = new DiscussionArchive(ds)
        if (c.flag('status')) {
          const targets = args.length ? args : ds.list().map(d => d.id)
          const rows = await Promise.all(targets.map(async id => ({ id, ...await a.status(id) })))
          c.out(rows.map(r => `${r.id.padEnd(24)} ${r.state.padEnd(8)} ${r.published ? `${r.published.commit.slice(0, 12)} through #${r.published.horizon.message} (live #${r.live.message})` : `live #${r.live.message}`}${r.error ? ` — ${r.error}` : ''}`).join('\n') || 'No discussions.', rows)
          return 0
        }
        const r = await a.publish(args.length ? args : undefined)
        c.out([...r.published.map(p => `published ${p.conv}: ${p.records} records, ${p.commit.slice(0, 12)}`), ...r.unchanged.map(u => `unchanged ${u}`), ...r.failed.map(f => `FAILED ${f.conv}: ${f.error}`)].join('\n') || 'Nothing due.', { ok: !r.failed.length, ...r })
        return r.failed.length ? 1 : 0
      }
    }
    throw c.usage(`no discussion subcommand "${sub}" (see: wfe discussion help)`)
  } catch (e) {
    if (e instanceof RequestError) throw c.refused(e.message, e.detail)
    throw e
  } finally { cs.close() }
}
