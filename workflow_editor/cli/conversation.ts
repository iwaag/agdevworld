// `wfe conversation` (challenge p2, docs/conversations.md): every
// conversation — a person with one project, several projects together, or a
// room a conductor leads — through one service (server/conversationService.ts)
// and one archive writer (server/conversationArchive.ts). `wfe discussion` is
// the same command under its former name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { attachRequests, CONVERSATION_ID, ConversationStore, parseRunName, RELATIONS, runName, viewBaseOf, type MessageKind, type Relation } from '../server/conversations.ts'
import { ConversationArchive } from '../server/conversationArchive.ts'
import { ConversationService, type Requester, type TitleSkip } from '../server/conversationService.ts'
import { ConversationWorkflows, type WorkflowRef, type WorkflowRelation, type WorkflowRole } from '../server/conversationWorkflows.ts'
import type { ExecStore } from '../server/exec.ts'
import { adviseRun, readRun } from '../server/runs.ts'
import { stretchesOf } from '../shared/stretches.ts'
import type { Boundary } from '../shared/reminders.ts'
import type { RunRecord } from '../shared/run.ts'
import { RequestError } from '../server/workspace.ts'

// Why --if-untitled left the display title alone (challenge p4).
const skippedWords = (k: TitleSkip | null) => !k ? '' : `Display title left as it is: ${k.by ? `${k.by} titled it${k.at ? ` at ${k.at}` : ''} (${k.value === null ? 'the original title' : `"${k.value}"`})` : `it already reads "${k.value}"`}.`

export const CONVERSATION_HELP = `wfe conversation <subcommand> …   (conversations; docs/conversations.md)

A conversation is a person talking with project agents, each speaking
through runs of its own project's workflows with its own guide and context:
one project (a one-to-one room), several, or a room the conductor (ponderer)
leads. One kind of record whatever its shape: members and their history,
every message (the person's words verbatim; each agent message with the
participant, run and request it came from), response requests, an optional
default addressee, an optional facilitation, the conductor's activities.

A response request is the only thing that starts or continues a run here.
The person's message reaches, in this order: the participants it names
(--to); else the runs it names (--run: an instruction to work under way);
else the questions it replies to (--re naming an open run's question: that
run gets the answer); else the conductor while the room is facilitated (its
one run gets the words, waking it if it rests; only a room without a
conductor gets a new run); else the default addressee. With none of these it is refused: name whom it is for. Each
request records the workflow chosen for it: a project's converse workflow
when it is the only project and nobody leads, its discuss workflow
otherwise, the conductor's for the conductor. A contribution never starts
anything.

A question is your run's question (\`wfe run ask <run> <node> --to <whom>
--question …\`): WFE posts every open question of a run that speaks for a
conversation there, and the person's reply naming it comes back to that run
as its answer. There is no other way to ask.

Speaking (from your executing attempt):
reply | contribute [<id>] (--text <t> | --file <f|->) --re <msg>… [--kind reply|progress|result|synthesis]
           [--key <k>] [--completing <node>] [--workflow <record>]…
                              your message: your run's, its participant's and its request's. Name
                              what you answer (--re): a reply is never attributed by recency.
                              reply/result/synthesis answer your request; progress does not.
                              synthesis is the conductor's project's or the archive project's.
                              --completing <node>: that node completes with the message (a turn
                              that spoke and left its node running is held interrupted).
                              A result, synthesis or --completing post may first get WFE's
                              reminders (work not presented, a page left serving, work done
                              outside nodes, and what a delegated child's result left out —
                              wfe delegate show); nothing is posted then, and the refusal says
                              how to continue (--yes: as it is, for this post only).
                              --workflow <record>: your turn's workflow records this is about
link [<id>] <msg> --run <workspace>/<workflow>/<run> --as <relation> --note <why>
                              what a message is to a run: ${RELATIONS.filter(r => r !== 'turn').join(', ')}.
                              A later reading supersedes an earlier one; the message never changes

The conductor's run is an ordinary graph whose nodes carry an activity
(announce | ask | ponder | talk), each performed with its command from the
conductor's executing attempt. It is one standing run for the room's life
(docs/runs.md *Standing runs*): when its nodes are done it rests (Idle) and
holds nothing; the room's next words wake it with a new ponder node.

announce [<id>] --node <n> (--text <t> | --file <f|->) --re <msg>… [--conclude [--close]]
                              speak to the room (agenda, context, interim synthesis, conclusion);
                              waits for nobody; the node completes with the message. --conclude
                              records what is still owed and who receives it later; --close then
                              closes the conversation (it cancels nothing). When this run
                              delegated, what a child's result left out may first come back
                              as reminders (wfe delegate show); nothing is posted then (--yes:
                              as it is, for this message only)
ask [<id>] <participant>… --node <n> --question <q> --re <msg>…
ask [<id>] --node <n> --run <workspace>/<workflow>/<run> --question <what> [--re <msg>…]
                              ask participants with one question, or await the result of a run
                              already working; the node waits and your attempt can end. When every
                              request is resolved WFE completes the node with the outcomes and
                              continues your run with one instruction
settle [<id>] --node <n> --reason <why>
                              move on before an ask is resolved; later outcomes are told as late
ponder [<id>] --node <n> --decision <text> --source <msg>… [--next <activity>:<node>[:<name>]]…
       [--definition <file>] [--topic <label>]
                              your decision, citing its sources; the node completes with it.
                              --topic labels the stretch of the conversation this decision opens or
                              continues (readers navigate by it; it is never a new run).
                              --next adds a chain of activity nodes; --definition any revision.
                              --next review:<node> adds a human review node beside the chain
                              (what follows does not wait for the person; wfe review help prepare)
talk                          (no command) a talk node's question is wfe run ask on that node,
                              --to the requester (state names them)
state [<id>] [--all]          what the conductor works from: facilitation, conductor (its standing
                              and wakes) and requester, members, the graph — the current stretch and
                              open work in full, earlier completed stretches in one line each (--all:
                              every node) —, recent activities, open requests, questions, obligations
                              (held continuations and held events included)
invite [<id>] <participant> --question <q> [--re <msg>]… [--token <t>] [--author <person>]
                              ask a participant: from the conductor's run it is awaited (wait with
                              wfe run wait … --external conversation:<id> and end your attempt).
                              Outside an attempt it is the person's (--author). A participant's
                              run cannot ask others: say whom you would ask
await [<id>] --run <workspace>/<workflow>/<run> --note <what> [--re <msg>]…   (with --node: ask --run)
                              from the conductor's run: await the result of a run already working;
                              resolved by its next result or synthesis here, or when it ends

The person, and anyone outside a run:
participants                  the projects that can take part (with their converse and discuss
                              workflows) and the facilitator, and whether each can take a request
list [--category conversation|check] [--state open|closed|all] [--with <participant>]
     [--mode direct|group|facilitated]
                              conversations, newest first
show [<id>] [--since <msg>]   members and history, facilitation, every message (who spoke, for
                              which run and request, what it answers, whom the person addressed),
                              the requests (role, workflow, state, run, receipt), linked runs as
                              their records say now, questions waiting, held continuations, the
                              archive. Without <id>: the conversation of this attempt's run.
                              Messages after your request's horizon are marked
create <id> --title <t> [--author <person>] [--member <project>]… [--default <project>|--no-default]
       [--category conversation|check]
                              a new conversation with the person and the projects; one project is
                              its default addressee unless said otherwise. From the conductor's
                              attempt the run leads it (facilitated from creation), and the
                              requester is whoever requested that run
post <id> (--text <t> | --file <f>) --author <person> [--with <project>] [--to <participant>]…
     [--run <run>]… [--re <msg>]… [--token <t>] [--via <way>] [--challenge <id>[@<commit>]]…
                              the person's message, verbatim, routed as above (refused from an
                              executing attempt). --with: whom a new id is with (creates a
                              one-to-one conversation). --challenge attaches a challenge pinned to
                              its current revision (or the commit named)
start <id> (--text <t> | --file <f>) --author <person> [--token <t>] [--re <msg>]… [--challenge …]
                              ask the conductor to lead: an explicit start with a brief (the
                              person's words to the conductor) from the current history. The
                              conversation, its members, questions, runs and attachments stay
end <id> [--note <why>] [--author <who>]
                              end facilitation: later messages go to the default addressee (or
                              must name one). Nothing is stopped; work asked stays its asker's
default <id> (<participant> | --none) [--note <why>] [--author <who>]
                              the default addressee (recorded like metadata)
join <id> <participant> [--note <n>] [--author <who>]    a member joins; nothing starts
leave <id> <participant> [--note <n>] [--author <who>]   a member leaves; its speech stays
withdraw <id> <request> --reason <why> [--author <person>]
                              withdraw a request not started yet
retry <id> <request>          try a failed request again, at the same recipient
close <id> [--author <who>]   end automatic dispatch: requests not started are withdrawn; started
                              runs finish and are recorded; nothing is cancelled; a continuation
                              that comes due is held
reopen <id> [--author <who>]  continue it with the same conductor; nothing withdrawn, completed or held
                              is replayed
resume <id> [<request>] [--author <who>]
                              run held continuations once (what a conductor awaited, resolved
                              while the room was closed or no longer facilitated) and release what
                              the conductor's standing held
conductor <id> [--replace --reason <why> [--author <person>]]
                              the conductor: its run, standing (open, suspended, closed), status,
                              wakes and held events. --replace: a new conductor for a cancelled one,
                              named as its replacement (never done by itself; refused while the
                              conductor is not cancelled)
meta <id> [--category conversation|check] [--title <display title> [--if-untitled] | --no-title] --note <why> [--author <who>]
                              correct how it is listed; recorded with who and why; sends nothing
overview [<id>] --purpose <t> [--outcome <t>] [--unresolved <t>]… [--through <msg>] [--title <t> [--if-untitled]]
         --note <what changed> [--author <who>]    (or --file <json|->; without either: show it)
                              the readers' overview: purpose, outcome, unresolved, each part citing
                              [#n]; an interpretation with sources, a new revision each time. From a
                              run: the conductor's or the archive project's
  --if-untitled               give the display title only to a conversation nobody has titled: it is
                              written when the conversation has no display title and no display-title
                              record (a person's edit, or their reset to the original, wins); checked
                              and written at once. Skipped, it says who titled it and changes nothing
                              else: the overview is still published. Without it, --title sets the
                              display title whatever it was
annotate <id> --kind intervention|recovery|evaluation|correction|note (--text <t> | --file <f>)
         --author <who> [--re <msg>]… [--run <run>]
                              a record by someone outside the speech; never speech, starts nothing
workflow attach|link|list|show|repair …
                              the workflows of the conversation, beside the speech (see below)
dispatch                      start requests not started yet, settle those whose run ended, tell
                              waiting conductors (also done by the executor's reconcile)
archive [<id>…] [--status]    publish the archive (the archive project's discussions/<id>/ for
                              conversations that began as discussions, conversations/<id>/ for
                              every other) or say what is published

workflow attach [<id>] --project <p> (--workflow <wf> [--commit <c>] | --run <wf>/<run> [--revision rN])
         [--as referenced|created|edited|executed] [--node <n>]… [--re <msg>]… [--note <n>]
         [--from <what it was copied from>] [--role subject|progression]
                              declare a workflow version as material of this conversation (WFE
                              keeps its bytes; it proves retrieval, not comprehension). Saving,
                              creating, revising, requesting and delegating from a turn are
                              recorded by those commands themselves
workflow link [<id>] <record> --message <msg> [--note <n>] [--author <who>]
workflow list [<id>]
workflow show [<id>] <record> [--current]
workflow repair [<id>] [--all]

Carrying the person's words into a run: wfe run instruct|answer … --source-message <id>:<msg>.`

export interface ConversationCli {
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

export async function conversationCommand(c: ConversationCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') { c.out(CONVERSATION_HELP, { help: CONVERSATION_HELP }); return 0 }
  const x = await c.exec()
  const cs = new ConversationStore({ area: c.area(), exec: x })
  const ds = new ConversationService(cs)
  try {
    const attempt = process.env.WFE_ATTEMPT || undefined
    // The executing attempt's run: the speaker, and its conversation and request.
    const own = async () => {
      if (!attempt) return null
      const row = x.attemptRow(attempt)
      if (!row || row.state === 'ended') return null
      const rec = (await readRun(await x.workspace(row.workspace), { workflow: row.workflow, run: row.run })).record
      if (!rec) return null
      const run = runName(row.workspace, { workflow: row.workflow, run: row.run })
      const src = rec.input.source?.kind === 'conversation' ? rec.input.source : null
      return { run, attempt, agent: rec.executor.name, rec, discussion: src && ds.conversation(src.conversation) ? src.conversation : ds.conductedBy(run)[0] ?? cs.conversationsOfRun(run)[0] ?? null, invitation: src && ds.conversation(src.conversation) ? src.invitation ?? null : null }
    }
    // A positional that cannot be a conversation id is usually the text
    // given without --text (archsage converse/run-001 believed such a reply
    // was posted, p15).
    const disc = async (given?: string) => {
      if (given && !CONVERSATION_ID.test(given)) throw c.usage(`"${given.length > 40 ? `${given.slice(0, 40)}…` : given}" is not a conversation id; text goes in --text <text> (or --file <file|->)`)
      if (given) return given
      const o = await own()
      if (o?.discussion) return o.discussion
      throw c.usage('name the conversation: this process is not an attempt of a run asked in one')
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
        c.out(rows.length ? rows.map(p => `${p.participant.padEnd(12)} ${p.kind.padEnd(11)} ${(p.kind === 'facilitator' ? p.target : [p.converse && `converse ${p.converse}`, p.discuss && `discuss ${p.discuss}`].filter(Boolean).join(', ')).padEnd(34)} ${p.state.padEnd(11)} ${p.agent ?? ''}${p.problem ? ` — ${p.problem}` : ''}`).join('\n') : 'disabled' in cfg ? cfg.disabled : 'No participants configured.', rows)
        return 0
      }
      case 'list': {
        const l = await ds.listing({ category: c.opt('category'), state: c.opt('state'), with: c.opt('with'), mode: c.opt('mode') })
        const rows = l.conversations
        const cov = (r: typeof rows[number]) => !r.overview ? 'no overview' : r.overview.after ? `overview +${r.overview.after}` : 'overview'
        c.out(rows.length ? rows.map(r => `${r.id.padEnd(24)} ${r.category.padEnd(10)} ${r.state.padEnd(6)} ${String(r.count).padStart(4)} msgs  ${String(r.open).padStart(2)} open  ${r.mode.padEnd(11)} ${cov(r).padEnd(12)} [${r.members.join(', ')}]  ${r.displayTitle ?? r.title}`).join('\n') : 'No conversations.', l)
        return 0
      }
      case 'show': {
        const id = await disc(args[0])
        const o = await own()
        const v = await ds.view(id, { viewBase: viewBaseOf(c.area()), since: Number(c.opt('since') ?? 0) || 0 })
        const archive = await new ConversationArchive(ds).status(id)
        const mine = o?.invitation ? v.requests.find(i => i.id === o.invitation) : undefined
        const d = v.conversation
        const req = d.requester
        const ov = v.overview
        const f = d.facilitation
        const lines = [`Conversation ${id} (${d.state}, ${d.category}, ${d.mode}): ${d.title}${d.displayTitle ? ` — shown as "${d.displayTitle}"` : ''}`,
          ov ? `Overview by ${ov.author}${ov.run ? ` (${ov.run})` : ''} ${ov.at}, through #${ov.through}${ov.after ? ` (${ov.after} newer message${ov.after === 1 ? '' : 's'})` : ''}: purpose ${ov.purpose.split('\n')[0].slice(0, 160)}${ov.outcome ? ` | outcome ${ov.outcome.split('\n')[0].slice(0, 160)}` : ''}${ov.unresolved.length ? ` | ${ov.unresolved.length} unresolved` : ''}` : 'Overview: none (wfe conversation overview)',
          `${f ? `Facilitated by ${f.workspace}/${f.workflow} since ${f.at} (by ${f.by}${f.brief ? `, brief #${f.brief}` : ''}, from #${f.horizon})` : 'Not facilitated'}${d.conductor ? `; conductor ${d.conductor}` : ''}${req ? `; requester ${req.kind === 'person' ? req.id : req.run}` : ''}. Default addressee: ${d.defaultTo ?? 'none'}. Members: ${v.members.map(m => `${m.participant} (${m.kind})`).join(', ')}`]
        if (mine) lines.push(`You are ${mine.participant}, asked (request ${mine.id}, ${mine.role ?? 'request'} ${mine.target}) by ${mine.by}${mine.byRun ? ` (${mine.byRun})` : ''} about ${mine.source.map(n => `#${n}`).join(', ')}; horizon #${mine.horizon}.`)
        const history = v.membership.filter(r => r.action === 'leave' || !/^(created the (discussion|conversation)|a member from its creation)$/.test(r.note))
        if (history.length) lines.push('Membership:', ...history.map(r => `  ${r.at} ${r.participant} ${r.action} (by ${r.by}${r.note ? `: ${r.note}` : ''})`))
        for (const m of v.messages) {
          const after = mine && m.id > mine.horizon ? ' (after your request)' : ''
          const head = m.role === 'person'
            ? `${m.author} (person)${m.via ? ` via ${m.via}` : ''}${m.addressed.length ? ` to ${m.addressed.join(', ')}` : ''}`
            : `${m.participant ?? m.author} (${m.author}${m.run ? ` for ${m.run}` : ''}${m.invitation ? `, request ${m.invitation}` : ''})`
          lines.push('', `#${m.id} ${m.at} ${head}${m.kind !== 'message' ? ` [${m.kind}${m.question ? ` ${m.question}` : ''}${m.node ? ` node ${m.node}` : ''}]` : ''}${m.re.length ? ` re ${m.re.map(n => `#${n}`).join(', ')}` : ''}${after}`)
          lines.push(...m.text.split('\n').map(l => `    ${l}`))
          for (const l of v.links.filter(l => l.message === m.id && !v.links.some(y => y.supersedes === l.id))) lines.push(`    → ${l.relation} ${l.run} by ${l.by}: ${l.note}`)
        }
        lines.push('', 'Requests:', ...v.requests.map(i => `  ${i.id} → ${i.participant} (${i.role ?? '?'} ${i.target}) by ${i.by}${i.byRun ? ` ${i.byRun}` : ''}${i.awaits ? ', awaited result' : i.awaitedBy ? ', awaited' : ''}${i.instruct ? ', instruction' : ''}: ${i.state}${i.late ? ' (late)' : ''}${i.run ? ` ${i.run}` : ''}${i.answeredBy ? ` answered by #${i.answeredBy}` : ''}${i.error ? ` — ${i.error}` : ''}${i.held ? ` [continuation held: ${i.held}]` : ''}; about ${i.source.map(n => `#${n}`).join(', ')}; "${i.question.split('\n')[0].slice(0, 100)}"`))
        if (!v.requests.length) lines.push('  (none)')
        lines.push('', 'Runs (run view; files: append a path in the run folder):', ...v.runs.map(r => `  ${r.key} — ${r.status?.text ?? r.situation} (${r.situation}, ${r.execution}); ${r.relation}${r.url ? `; ${r.url}` : ''}${r.files ? `; files ${r.files}` : ''}${r.presentations.map(p => `; review ${p.id} ${p.url}`).join('')}${r.problem ? `; ${r.problem}` : ''}`))
        lines.push(`Waiting for the person: ${v.asking.length ? v.asking.map(n => `#${n}`).join(', ') : 'nothing'}`)
        if (v.status.continuations.length) lines.push(`Held continuations: ${v.status.continuations.map(h => `requests ${h.requests.join(', ')} for ${h.awaitedBy} (${h.why})`).join('; ')} — wfe conversation resume ${id}`)
        if (v.activities.length) lines.push(`Activities: ${v.activities.length} (wfe conversation state ${id})`)
        if (v.annotations.length) lines.push('Annotations (outside the speech):', ...v.annotations.map(a => `  ${a.kind} by ${a.author} ${a.at}${a.re.length ? ` re ${a.re.map(n => `#${n}`).join(', ')}` : ''}: ${a.text.split('\n')[0].slice(0, 160)}`))
        lines.push(`Archive: ${archive.state}${archive.published ? ` — ${archive.published.commit.slice(0, 12)} through #${archive.published.horizon.message}${archive.published.url ? ` ${archive.published.url}` : ''}` : ''}${archive.error ? ` (${archive.error})` : ''}`)
        c.out(lines.join('\n'), { ...v, archive })
        return 0
      }
      case 'create': {
        const id = args[0]; if (!id) throw c.usage('create needs <id>')
        const title = c.opt('title'); if (!title) throw c.usage('--title <title> is required')
        const o = await own()
        const cfg = ds.config()
        // From the facilitator's attempt (argue p4): this run conducts, and
        // whoever requested it is the requester.
        const conducting = o && !('disabled' in cfg) && o.run.startsWith(`${cfg.facilitator.workspace}/${cfg.facilitator.workflow}/`) ? o : null
        let requester: Requester | undefined
        let author = c.opt('author')
        if (conducting) {
          const inp = conducting.rec.input
          const e = inp.entrustedBy
          if (e?.kind === 'delegation') requester = { kind: 'run', run: `${e.parent.project}/${e.parent.workflow}/${e.parent.run}`, agent: inp.requester ?? null }
          else if (e?.kind === 'run') requester = { kind: 'run', run: `${e.project ?? parseRunName(conducting.run).workspace}/${e.workflow}/${e.run}`, agent: inp.requester ?? null }
          else requester = { kind: 'person', id: inp.onBehalfOf ?? inp.author ?? author ?? (('person' in cfg) ? cfg.person : 'person') }
          author = author ?? (requester.kind === 'person' ? requester.id : conducting.agent)
        }
        if (!author) throw c.usage('--author <person> is required: who opens it')
        const r = ds.create(id, { title, by: author, members: c.opts('member'), category: c.opt('category'), ...(c.flag('no-default') ? { defaultTo: null } : c.opt('default') ? { defaultTo: c.opt('default')! } : {}), ...(conducting ? { conductor: conducting.run, requester } : {}) })
        // p18: the run that created it conducts it for its whole life.
        if (conducting) await ds.syncStanding(id)
        c.out(`${r.duplicate ? 'Already exists' : 'Created'}: ${r.conversation.category === 'check' ? 'check' : 'conversation'} ${id} with ${ds.members(id).map(m => m.participant).join(', ')}${r.conversation.default_to ? `; default addressee ${r.conversation.default_to}` : ''}${ds.facilitation(id) ? `; led by ${conducting?.run}` : ''}.`, { ok: true, ...r, members: ds.members(id) })
        return 0
      }
      case 'post': {
        const id = args[0]; if (!id) throw c.usage('post needs <id>')
        const author = c.opt('author'); if (!author) throw c.usage('--author <person> is required: whose words these are')
        // The person's route (argue p4 step 5: ponderer/conduct/run-004 posted
        // the requester's brief as a person named front-agent): an executing
        // attempt speaks as its own run.
        const o = await own()
        if (o) throw c.refused(`post is the person's route; ${o.run} speaks as itself: wfe conversation reply, or announce from the conductor (quote the request and name whose it is)`, { code: 'not-person' })
        const r = await ds.post(id, { text: text(), author, token: c.opt('token') ?? `cli-${Date.now()}-${process.pid}`, re: ids('re'), to: c.opts('to'), runs: c.opts('run'), via: c.opt('via'), with: c.opt('with'), title: c.opt('title'), challenges: attachRequests(c.opts('challenge')) })
        c.out(`${r.duplicate ? 'Already posted (same token)' : 'Posted'}: #${r.message.id} in ${id}${r.created ? ' (created)' : ''}${r.reopened ? ' (reopened)' : ''}; ${r.invitations.map(i => `request ${i.id} → ${i.participant} (${i.role}): ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}`).join('; ')}.`, { ok: true, ...r })
        return 0
      }
      case 'start': {
        const id = args[0]; if (!id) throw c.usage('start needs <id>')
        const author = c.opt('author'); if (!author) throw c.usage('--author <person> is required: who asks the conductor to lead')
        if (await own()) throw c.refused('starting facilitation is the person\'s act (the conductor creating a conversation from its attempt leads it from creation: wfe conversation create)', { code: 'not-person' })
        const r = await ds.startFacilitation(id, { text: text(), author, token: c.opt('token') ?? `cli-${Date.now()}-${process.pid}`, re: ids('re'), via: c.opt('via'), challenges: attachRequests(c.opts('challenge')) })
        c.out(`${r.duplicate ? 'Already started (same token)' : 'Facilitation started'}: ${r.facilitation.workspace}/${r.facilitation.workflow} leads ${id} from #${r.facilitation.horizon}; brief #${r.posted.message.id}; ${r.posted.invitations.map(i => `request ${i.id} (${i.role}): ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}`).join('; ')}.`, { ok: true, ...r })
        return 0
      }
      case 'end': {
        const id = args[0]; if (!id) throw c.usage('end needs <id>')
        const o = await own()
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        const r = await ds.endFacilitation(id, { by, run: o?.run ?? null, note: c.opt('note') })
        c.out(r.ended ? `Facilitation of ${id} ended. Later messages go to ${ds.conversation(id)?.default_to ?? 'whom they name (no default addressee)'}; nothing was stopped.` : `${id} is not facilitated; nothing changed.`, { ok: true, ...r })
        return 0
      }
      case 'default': {
        const id = args[0]; if (!id) throw c.usage('default needs <id> (<participant> | --none)')
        const p = c.flag('none') ? null : args[1]
        if (p === undefined) throw c.usage('name the default addressee, or --none')
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        const r = ds.setDefault(id, p, { by, run: (await own())?.run ?? null, note: c.opt('note') })
        c.out(`Default addressee of ${id}: ${r.default_to ?? 'none'}.`, { ok: true, defaultTo: r.default_to ?? null })
        return 0
      }
      case 'retry': {
        const [id, n] = args; if (!id || !isNum(n)) throw c.usage('retry needs <id> <request>')
        const i = await ds.retry(id, Number(n.replace(/^#/, '')))
        c.out(`Request ${i.id} → ${i.participant}: ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}.`, { ok: i.state !== 'failed', request: i })
        return i.state === 'failed' ? 1 : 0
      }
      case 'resume': {
        const [id, n] = args; if (!id) throw c.usage('resume needs <id> [<request>]')
        const r = await ds.resume(id, { by: await who() ?? 'person', request: n === undefined ? undefined : Number(n.replace(/^#/, '')) })
        c.out(r.resumed.length ? `Resumed requests ${r.resumed.join(', ')}:\n${r.notes.join('\n') || '(nothing further to tell)'}` : `Nothing is held in ${id}.`, { ok: true, ...r })
        return 0
      }
      case 'reply':
      case 'contribute': {
        const id = await disc(isNum(args[0]) ? undefined : args[0])
        const o = await own()
        if (!o) throw c.usage(`${sub} speaks for an executing attempt's run (WFE_ATTEMPT); the person posts with: wfe conversation post`)
        const re = ids('re')
        if (!re.length) throw c.usage('--re <msg> is required: the messages you answer')
        const complete = c.opt('completing')
        // One way to ask (workflow_editor fix3): WFE posts the run's question.
        if (c.opt('kind') === 'question' || c.opt('question')) throw c.refused('a question is your run\'s question: wfe run ask <run> <node> --to <whom> --question <q>. WFE posts it in this conversation and the reply comes back to your run as its answer', { code: 'question-is-run-ask' })
        // Reminders before a post that reports a result or completes its node
        // (workflow_editor fix5); a retransmission (same key) posts nothing new.
        const kind = c.opt('kind') ?? 'reply'
        const bounds: Boundary[] = [...(kind === 'result' || kind === 'synthesis' ? [{ kind: 'report' as const, messageKind: kind }] : []), ...(complete ? [{ kind: 'complete' as const, node: complete }] : [])]
        const said = text()
        if (bounds.length && !ds.posted(id, o.run, said, c.opt('key'))) {
          const { workspace, ref } = parseRunName(o.run)
          // fix6: the delegated results it reports are assessed too, in the same response.
          const assess = async (rec: RunRecord) => { const { delegatedReminders } = await import('../server/delegate.ts'); return delegatedReminders(x.delegate, rec) }
          try { await adviseRun(await x.workspace(workspace), ref, bounds, c.flag('yes') ? { yes: true } : { what: `posting this ${kind}${complete ? ` and completing ${complete}` : ''}`, assess }) } catch (e) { if (e instanceof RequestError) throw c.refused(e.message, e.detail); throw e }
        }
        const r = await ds.contribute(id, { text: said, author: o.agent, run: o.run, attempt: o.attempt, invitation: o.discussion === id ? o.invitation : null, re, kind: kind as MessageKind, key: c.opt('key'), node: complete ?? null, complete: !!complete })
        const wfs = new ConversationWorkflows(ds)
        const linked = c.opts('workflow').map(v => wfs.link(id, Number(v.replace(/^#/, '')), { message: r.message.id, by: o.agent, run: o.run }).ref.id)
        c.out(`${r.duplicate ? 'Already posted (same key); nothing changed' : 'Posted'}: #${r.message.id} in ${id} as ${r.message.participant} for ${o.run}${r.invitation ? `; request ${r.invitation.id} ${r.invitation.state}${r.invitation.late ? ' (late)' : ''}` : ''}${r.completed ? `; node ${r.completed} completed` : ''}${linked.length ? `; workflow record${linked.length === 1 ? '' : 's'} ${linked.join(', ')} shown with it` : ''}.`, { ok: true, ...r, workflows: linked })
        return 0
      }
      case 'workflow': return await workflowCommand(c, ds, args, { own, disc, ids, isNum, who })
      case 'invite': {
        const named = args.length >= 2 ? args : [undefined, args[0]]
        const id = await disc(named[0])
        const participant = named[1]; if (!participant) throw c.usage('invite needs <participant>')
        const question = c.opt('question'); if (!question) throw c.usage('--question <text> is required: what the participant is asked')
        const o = await own()
        const by = o?.agent ?? c.opt('author'); if (!by) throw c.usage('--author <person> is required outside an executing attempt')
        const r = await ds.invite(id, { participant, question, re: ids('re'), by, byRun: o?.run ?? null, token: c.opt('token') })
        const i = r.invitation
        c.out(`${r.duplicate ? 'Already asked (same request)' : 'Asked'}: request ${i.id} → ${i.participant} (${i.role}): ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}${i.awaited_by ? `; awaited by ${i.awaited_by}` : ''}.`, { ok: true, ...r })
        return 0
      }
      case 'await': {
        if (c.opt('node')) return conversationCommand({ ...c, positional: ['ask', ...args], opt: k => k === 'question' ? c.opt('question') ?? c.opt('note') : c.opt(k) })
        const id = await disc(args[0])
        const o = await own()
        if (!o) throw c.usage('await is the conductor\'s, from its executing attempt (WFE_ATTEMPT)')
        const run = c.opt('run'); if (!run) throw c.usage('--run <workspace>/<workflow>/<run> is required: whose result is awaited')
        parseRunName(run)
        const note = c.opt('note'); if (!note) throw c.usage('--note <what> is required: the result awaited')
        const r = await ds.awaitResult(id, { run, note, re: ids('re'), by: o.agent, byRun: o.run })
        const i = r.invitation
        c.out(`${r.duplicate ? 'Already awaited' : 'Awaiting'}: the result of ${run} (request ${i.id}): ${i.state}${i.answered_by ? ` by #${i.answered_by}` : ''}; awaited by ${i.awaited_by}.`, { ok: true, ...r })
        return 0
      }
      case 'announce':
      case 'ask':
      case 'settle':
      case 'ponder': {
        const o = await own()
        if (!o) throw c.usage(`${sub} is the conductor's, from its executing attempt (WFE_ATTEMPT)`)
        const given = sub === 'ask' ? (args[0] && ds.conversation(args[0]) ? args[0] : undefined) : args[0]
        const id = await disc(given)
        const node = c.opt('node'); if (!node) throw c.usage(`--node <node> is required: the ${sub === 'settle' ? 'ask' : sub} node of your run`)
        const base = { run: o.run, attempt: o.attempt, author: o.agent, node }
        if (sub === 'announce') {
          // The opening of a discussion the conductor created has nothing to name.
          const re = ids('re'); if (!re.length && ds.horizon(id).message) throw c.usage('--re <msg> is required: what the announcement is about')
          // fix6: an announcement reports to the person; the delegated results
          // of this run are assessed first (fix6 trial A, ponderer/conduct/run-037
          // reported misc/freework/run-007's result with announce).
          if (!ds.posted(id, o.run, text(), undefined)) {
            const { workspace, ref } = parseRunName(o.run)
            const assess = async (rec: RunRecord) => { const { delegatedReminders } = await import('../server/delegate.ts'); return delegatedReminders(x.delegate, rec) }
            try { await adviseRun(await x.workspace(workspace), ref, [{ kind: 'report', messageKind: 'announcement' }], c.flag('yes') ? { yes: true } : { what: 'announcing this', assess, delegatedOnly: true }) } catch (e) { if (e instanceof RequestError) throw c.refused(e.message, e.detail); throw e }
          }
          const r = await ds.announce(id, { ...base, text: text(), re, invitation: o.discussion === id ? o.invitation : null, conclude: c.flag('conclude'), close: c.flag('close') })
          const ob = r.activity.obligations
          c.out(`${r.duplicate ? 'Already announced' : 'Announced'}: #${r.message.id}; node ${node} completed${ob ? `; ${ob.length ? `outstanding:\n${ob.map(b => `  ${b.ref}: ${b.owes} — owner ${b.owner}; later to ${b.receiver}`).join('\n')}` : 'nothing outstanding'}` : ''}${r.closed ? `\nClosed ${id}.` : ''}`, { ok: true, ...r })
          return 0
        }
        if (sub === 'ask') {
          const question = c.opt('question'); if (!question) throw c.usage('--question <text> is required')
          const run = c.opt('run'); if (run) parseRunName(run)
          const who = (given ? args.slice(1) : args)
          const r = await ds.ask(id, { ...base, participants: who, question, re: ids('re'), awaitRun: run })
          c.out(`${r.duplicate ? 'Already asked' : 'Asked'} (activity ${r.activity.id}): ${r.invitations.map(i => `request ${i.id} → ${i.participant}: ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}`).join('; ')}. Node ${node} waits; end your attempt when nothing else is to be done: WFE completes ${node} with the outcomes and continues this run.`, { ok: true, ...r })
          return 0
        }
        if (sub === 'settle') {
          const reason = c.opt('reason'); if (!reason) throw c.usage('--reason <why> is required')
          const r = await ds.settle(id, { ...base, reason })
          c.out(`${r.duplicate ? 'Already' : 'Settled'}: node ${node} completed (${r.activity.outcome?.split('\n')[0]}).`, { ok: true, ...r })
          return 0
        }
        if (sub === 'ponder') {
          const decision = c.opt('decision') ?? (c.opt('file') ? text() : undefined); if (!decision) throw c.usage('--decision <text> is required: what you decided and why')
          const next = c.opts('next').map(v => { const [activity, n, ...name] = v.split(':'); if (!activity || !n) throw c.usage(`--next ${v}: write <activity>:<node>[:<name>]`); return { activity, node: n, ...(name.length ? { name: name.join(':') } : {}) } })
          const def = c.opt('definition')
          const r = await ds.ponder(id, { ...base, decision, sources: ids('source'), next, ...(def ? { definition: readFileSync(def === '-' ? 0 : resolve(def), 'utf8') } : {}), ...(c.opt('topic') ? { topic: c.opt('topic')! } : {}) })
          c.out(`${r.duplicate ? 'Already decided' : 'Decided'} (activity ${r.activity.id}): node ${node} completed${r.revision ? `; revision ${r.revision}${next.length ? ` adds ${next.map(x => `${x.activity}:${x.node}`).join(' → ')}` : ''}` : ''}.`, { ok: true, ...r })
          return 0
        }
        return 0
      }
      case 'talk': throw c.refused('there is no talk command: ask the requester with wfe run ask <run> <talk node> --to <requester> --question <q> (wfe conversation state names the requester). WFE posts it here as the talk activity', { code: 'question-is-run-ask' })
      case 'state': {
        const id = await disc(args[0])
        const v = await ds.view(id, { viewBase: viewBaseOf(c.area()) })
        const d = v.conversation
        const lines = [`Conversation ${id} (${d.state}, ${d.mode}): ${d.title}`, `Facilitation: ${d.facilitation ? `active since ${d.facilitation.at} (by ${d.facilitation.by}, from #${d.facilitation.horizon})` : 'none (ended or never started)'}. Conductor: ${d.conductor ?? 'none'}${d.conductor ? ` — ${v.runs.find(r => r.key === d.conductor)?.status?.text ?? ''}` : ''}. Requester: ${d.requester ? d.requester.kind === 'person' ? `${d.requester.id} (person)` : `${d.requester.run} (${d.requester.agent ?? 'agent'})` : 'unknown'}.`,
          `Members: ${v.members.map(m => m.participant).join(', ')}. Newest message #${v.horizon.message}.`]
        if (d.conductor) {
          try {
            const { workspace, ref } = parseRunName(d.conductor)
            const read = await readRun(await x.workspace(workspace), ref)
            const rec = read.record
            const node = (n: string) => { const s = rec!.nodes[n]; const a = v.activities.find(y => y.run === d.conductor && y.node === n); return `  ${n}: ${s.state}${a ? ` — ${a.kind} (activity ${a.id}, ${a.state})${a.topic ? ` [${a.topic}]` : ''}${a.kind === 'ponder' ? `: ${a.text.split('\n')[0].slice(0, 120)}` : ''}` : ''}${s.wait ? ` — waits: ${s.wait.reason}` : ''}` }
            if (rec?.standing) {
              // p18: one standing run for the room's life; the current stretch
              // and open work in full, earlier completed stretches folded.
              const st = rec.standing
              lines.push(`Standing: ${st.state} since ${st.since} (${st.reason})${st.replaces ? `; replaces ${st.replaces}` : ''}; ${st.wakes.length} wake${st.wakes.length === 1 ? '' : 's'}${st.held.length ? `; held until the person resumes: ${st.held.join(', ')}` : ''}.`)
              const all = stretchesOf(rec)
              lines.push('Conductor graph, by stretch:')
              for (const x of all) {
                const head = x.n === 0 ? 'opening' : `w${x.n} (${x.wake!.events.join(', ')}, ${x.at})`
                const topic = v.activities.find(a => a.run === d.conductor && a.topic && x.nodes.includes(a.node))?.topic
                if (c.flag('all') || x.open || x === all.at(-1)) lines.push(` ${head}${topic ? ` — ${topic}` : ''}:`, ...x.nodes.map(node))
                else lines.push(` ${head}${topic ? ` — ${topic}` : ''}: ${x.nodes.length} node${x.nodes.length === 1 ? '' : 's'} completed (--all to list)`)
              }
            } else if (rec) lines.push('Conductor graph:', ...Object.keys(rec.nodes).map(node))
          } catch (e) { lines.push(`Conductor graph: unreadable (${(e as Error).message})`) }
        }
        const recent = c.flag('all') ? v.activities : v.activities.filter(a => a.state === 'waiting' || v.activities.indexOf(a) >= v.activities.length - 12)
        if (recent.length < v.activities.length) lines.push(`Activities (${v.activities.length - recent.length} earlier completed ones not listed; --all):`)
        lines.push(...(recent.length < v.activities.length ? [] : ['Activities:']), ...(recent.length ? recent.map(a => `  ${a.id} ${a.kind.padEnd(8)} ${a.state.padEnd(9)} ${a.run}#${a.node}${a.message ? ` #${a.message}` : ''}${a.invitations.length ? ` invitations ${a.invitations.join(', ')}` : ''}${a.question ? ` ${a.question}` : ''}${a.text ? ` — ${a.text.split('\n')[0].slice(0, 100)}` : ''}`) : ['  (none)']))
        const open = v.requests.filter(i => i.state === 'pending' || i.state === 'started')
        lines.push('Open requests:', ...(open.length ? open.map(i => `  ${i.id} → ${i.participant}${i.run ? ` ${i.run}` : ''} (${i.state}${i.awaits ? ', awaited result' : ''}${i.activity ? `, activity ${i.activity}` : ''})`) : ['  (none)']))
        lines.push(`Waiting for the person: ${v.asking.length ? v.asking.map(n => `#${n}`).join(', ') : 'nothing'}`)
        lines.push('Obligations:', ...(v.obligations.length ? v.obligations.map(b => `  ${b.ref}: ${b.owes} — owner ${b.owner}; later to ${b.receiver}`) : ['  (none)']))
        if (v.annotations.length) lines.push('Annotations:', ...v.annotations.map(a => `  ${a.id} ${a.kind} by ${a.author}${a.re.length ? ` re ${a.re.map(n => `#${n}`).join(', ')}` : ''}: ${a.text.split('\n')[0].slice(0, 120)}`))
        c.out(lines.join('\n'), v)
        return 0
      }
      case 'annotate': {
        const id = args[0]; if (!id) throw c.usage('annotate needs <id>')
        const kind = c.opt('kind'); if (!kind) throw c.usage('--kind intervention|recovery|evaluation|correction|note is required')
        const author = await who(); if (!author) throw c.usage('--author <who> is required')
        const r = ds.annotate(id, { kind, author, text: text(), re: ids('re'), run: c.opt('run') ?? null, token: c.opt('token') })
        c.out(`${r.duplicate ? 'Already recorded' : 'Recorded'}: annotation ${r.annotation.id} (${kind}) in ${id}.`, { ok: true, ...r })
        return 0
      }
      case 'meta': {
        const id = args[0]; if (!id) throw c.usage('meta needs <id>')
        const note = c.opt('note'); if (!note) throw c.usage('--note <why> is required: the reason is part of the record')
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        const title = c.flag('no-title') ? null : c.opt('title')
        const r = ds.setMeta(id, { category: c.opt('category'), displayTitle: title, ifUntitled: c.flag('if-untitled'), by, run: (await own())?.run ?? null, note })
        c.out([r.changed.length ? `Recorded for ${id}: ${r.changed.map(m => `${m.field} = ${m.value ?? '(none)'}`).join('; ')}.` : r.skipped ? '' : `Nothing changed for ${id}: it already reads so.`, skippedWords(r.skipped)].filter(Boolean).join(' '), { ok: true, ...r })
        return 0
      }
      case 'overview': {
        const id = await disc(args[0])
        if (!c.opt('purpose') && !c.opt('file')) {
          const o = ds.overview(id)
          const b = ds.brief(id)
          c.out(o ? [`Overview of ${id} by ${o.author}${o.run ? ` (${o.run})` : ''}, ${o.at}; covers through #${o.through}${o.after ? `, ${o.after} newer message${o.after === 1 ? '' : 's'}` : ' (current)'}; cites ${o.sources.map(n => `#${n}`).join(' ')}`, `Purpose: ${o.purpose}`, `Outcome: ${o.outcome ?? '(none stated)'}`, ...o.unresolved.map(u => `Unresolved: ${u}`), o.note ? `Note: ${o.note}` : ''].filter(Boolean).join('\n')
            : `No overview of ${id}.${b ? ` Readers see the brief (#${b.message}, ${b.author}), labelled as such.` : ''}`, { overview: o, brief: b })
          return 0
        }
        const o = await own()
        const author = o?.agent ?? c.opt('author'); if (!author) throw c.usage('--author <who> is required outside an executing attempt')
        const f = c.opt('file')
        const given = f ? JSON.parse(readFileSync(f === '-' ? 0 : resolve(f), 'utf8')) as { purpose?: string; outcome?: string; unresolved?: string[]; through?: number; title?: string; ifUntitled?: boolean; note?: string } : null
        const purpose = given?.purpose ?? c.opt('purpose'); if (!purpose) throw c.usage('--purpose <text> is required (or --file)')
        const note = given?.note ?? c.opt('note'); if (!note) throw c.usage('--note <what changed> is required: why this revision')
        const through = given?.through ?? (c.opt('through') ? Number(c.opt('through')!.replace(/^#/, '')) : undefined)
        const r = ds.publishOverview(id, { purpose, outcome: given?.outcome ?? c.opt('outcome') ?? null, unresolved: given?.unresolved ?? c.opts('unresolved'), through, title: given?.title ?? c.opt('title'), ifUntitled: given?.ifUntitled ?? c.flag('if-untitled'), note, author, run: o?.run ?? null })
        c.out(`${r.duplicate ? 'Already recorded (same overview)' : 'Recorded'}: overview ${r.overview.id} of ${id}, through #${r.overview.through}, citing ${r.overview.sources.map(n => `#${n}`).join(' ')}${r.changed.length ? `; display title "${r.changed[0].value}"` : ''}. Nothing was sent or started.${r.skipped ? ` ${skippedWords(r.skipped)}` : ''}`, { ok: true, ...r })
        return 0
      }
      case 'withdraw': {
        const [id, n] = args; if (!id || !isNum(n)) throw c.usage('withdraw needs <id> <request>')
        const reason = c.opt('reason'); if (!reason) throw c.usage('--reason <why> is required')
        const by = await who(); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
        const i = ds.withdrawInvitation(id, Number(n.replace(/^#/, '')), { by, reason })
        c.out(`Withdrawn: request ${i.id} → ${i.participant}.`, { ok: true, request: i })
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
        ds.conversation(id) ?? (() => { throw c.refused(`no conversation ${id}`) })()
        const r = cs.link(id, { message: msg, run, relation, note: c.opt('note') ?? '', by, attempt: (await own())?.attempt ?? null })
        c.out(`${r.duplicate ? 'Already linked' : 'Linked'}: #${msg} is ${relation} of ${run}.`, { ok: true, ...r })
        return 0
      }
      case 'conductor': {
        const id = args[0]; if (!id) throw c.usage('conductor needs <id>')
        if (c.flag('replace')) {
          const reason = c.opt('reason'); if (!reason) throw c.usage('--reason <why> is required: why a new conductor replaces the cancelled one')
          const by = await who(); if (!by) throw c.usage('--author <person> is required')
          if (await own()) throw c.refused('replacing the conductor is the person\'s act', { code: 'not-person' })
          const r = await ds.replaceConductor(id, { by, reason, token: c.opt('token') })
          c.out(`Replacing ${r.replaces}: request ${r.invitation.id} (${r.invitation.state}${r.invitation.run ? ` ${r.invitation.run}` : ''}${r.invitation.error ? ` — ${r.invitation.error}` : ''}).`, { ok: r.invitation.state !== 'failed', ...r })
          return r.invitation.state === 'failed' ? 1 : 0
        }
        const cur = await ds.conductorRecord(id)
        if (!cur) { c.out(`${id} has no conductor.`, { conductor: null }); return 0 }
        const rec = cur.record
        const st = rec?.standing
        const { runStatus } = await import('../shared/status.ts')
        const lines = [`Conductor of ${id}: ${cur.run}${rec ? ` — ${runStatus(rec).text}` : ' (unreadable here)'}`,
          st ? `Standing: ${st.state} since ${st.since} (${st.reason}; by ${st.by})${st.replaces ? `; replaces ${st.replaces}` : ''}` : rec ? 'Standing: none (a run from before p18, or not established yet)' : '',
          ...(st?.wakes.length ? [`Wakes (${st.wakes.length}):`, ...st.wakes.slice(-10).map(w => `  w${w.n} ${w.at} ${w.node} for ${w.events.join(', ')}`)] : []),
          ...(st?.held.length ? [`Held until the person resumes: ${st.held.join(', ')} (wfe conversation resume ${id})`] : [])].filter(Boolean)
        c.out(lines.join('\n'), { conductor: cur.run, standing: st ?? null, status: rec ? runStatus(rec) : null })
        return 0
      }
      case 'close': {
        const id = args[0]; if (!id) throw c.usage('close needs <id>')
        const by = await who() ?? 'person'
        const r = await ds.close(id, { by })
        c.out(`Closed ${id}${r.withdrawn.length ? `; withdrawn requests ${r.withdrawn.join(', ')}` : ''}. Started runs finish and are recorded.`, { ok: true, ...r })
        return 0
      }
      case 'reopen': {
        const id = args[0]; if (!id) throw c.usage('reopen needs <id>')
        const r = await ds.reopen(id, { by: await who() ?? 'person' })
        c.out(`Reopened ${id}.${ds.invitations(id).some(i => i.held) ? ` Held continuations stay held: wfe conversation resume ${id}.` : ''}`, { ok: true, conversation: r })
        return 0
      }
      case 'dispatch': {
        const notes = await ds.reconcile()
        c.out(notes.join('\n') || 'Nothing to start, mark or tell.', { ok: true, notes })
        return 0
      }
      case 'archive': {
        const a = new ConversationArchive(ds)
        if (c.flag('status')) {
          const targets = args.length ? args : ds.list().map(d => d.id)
          const rows = await Promise.all(targets.map(async id => ({ id, ...await a.status(id) })))
          const repo = rows[0]?.repository ?? (await a.origin() as { web?: string | null; url?: string }).web ?? null
          c.out([...(repo ? [`Archive repository: ${repo}`] : []), ...rows.map(r => `${r.id.padEnd(24)} ${r.state.padEnd(10)} ${r.path.padEnd(40)} ${r.published ? `${r.published.commit.slice(0, 12)} through #${r.published.horizon.message} (live #${r.live.message})` : `live #${r.live.message}`}${r.error ? ` — ${r.error}` : ''}`)].join('\n') || 'No conversations.', rows)
          return 0
        }
        const r = await a.publish(args.length ? args : undefined)
        c.out([...r.published.map(p => `published ${p.conv}: ${p.records} records, ${p.commit.slice(0, 12)}`), ...r.unchanged.map(u => `unchanged ${u}`), ...r.failed.map(f => `FAILED ${f.conv}: ${f.error}`)].join('\n') || 'Nothing due.', { ok: !r.failed.length, ...r })
        return r.failed.length ? 1 : 0
      }
    }
    throw c.usage(`no conversation subcommand "${sub}" (see: wfe conversation help)`)
  } catch (e) {
    if (e instanceof RequestError) throw c.refused(e.message, e.detail)
    throw e
  } finally { cs.close() }
}

const RELATION_WORDS: Record<string, string> = { referenced: 'referenced', created: 'created', edited: 'edited', executed: 'executed' }
const versionLine = (v: WorkflowRef['after']) => !v ? 'no version recorded' : v.kind === 'revision' ? `${v.run} ${v.revision} (sha256 ${v.sha256.slice(0, 12)}, seq ${v.seq ?? '?'})` : `${v.kind}${v.commit ? ` at ${v.commit.slice(0, 12)}` : ''} ${v.path ?? ''} (sha256 ${v.sha256.slice(0, 12)})`
const refLine = (r: WorkflowRef) => `${String(r.id).padStart(3)} ${RELATION_WORDS[r.relation].padEnd(10)} ${r.role.padEnd(11)} ${r.project}/${r.workflow}${r.target.kind === 'run' ? ` run ${r.target.run}` : ' definition'} — ${versionLine(r.after)}${r.before ? ` (before: ${versionLine(r.before)})` : ''}\n      turn ${r.run ?? r.actor}${r.attempt ? ` attempt ${r.attempt}` : ''}${r.invitation ? ` invitation ${r.invitation}` : ''}${r.origin ? ` for ${r.origin}` : ''}${r.activity ? ` activity ${r.activity}` : ''}; ${r.messages.length ? `messages ${r.messages.map(n => `#${n}`).join(', ')}` : 'no message'}; ${r.evidence} (${r.operation})${r.state !== 'recorded' ? ` [${r.state}]` : ''}${r.nodes.length ? `; nodes ${r.nodes.join(', ')}` : ''}${r.note ? `\n      ${r.note.split('\n')[0].slice(0, 200)}` : ''}`

async function workflowCommand(c: ConversationCli, ds: ConversationService, args: string[], h: {
  own: () => Promise<{ run: string; attempt: string; agent: string; discussion: string | null; invitation: number | null } | null>
  disc: (given?: string) => Promise<string>
  ids: (k: string) => number[]
  isNum: (v: string | undefined) => boolean
  who: () => Promise<string | undefined>
}): Promise<number> {
  const [op, ...rest] = args
  const wfs = new ConversationWorkflows(ds)
  const given = rest[0] && !h.isNum(rest[0]) ? rest[0] : undefined
  const id = op === 'repair' && !given ? undefined : await h.disc(given)
  const after = given ? rest.slice(1) : rest
  switch (op) {
    case 'attach': {
      const project = c.opt('project'); if (!project) throw c.usage('--project <project workspace> is required')
      const workflow = c.opt('workflow'), run = c.opt('run')
      if (!!workflow === !!run) throw c.usage('give exactly one of --workflow <workflow> (a definition) or --run <workflow>/<run> (a run\'s revision)')
      if (c.opt('commit') && !workflow) throw c.usage('--commit goes with --workflow')
      if (c.opt('revision') && !run) throw c.usage('--revision goes with --run')
      const o = await h.own()
      const turn = o ? await wfs.turnOf(o.attempt) : null
      const author = o?.agent ?? c.opt('author'); if (!author) throw c.usage('--author <who> is required outside an executing attempt')
      const r = await wfs.attach(id!, { project, workflow, run, revision: c.opt('revision'), commit: c.opt('commit'), relation: c.opt('as') as WorkflowRelation | undefined, role: c.opt('role') as WorkflowRole | undefined, nodes: c.opts('node'), note: c.opt('note'), messages: h.ids('re'), from: c.opt('from'), turn: turn && turn.conv === id ? turn : o ? { conv: id!, run: o.run, attempt: o.attempt, actor: o.agent, invitation: null, origin: null } : null, author })
      c.out(`${r.duplicate ? 'Already recorded (same version, same messages)' : 'Recorded'}: workflow record ${r.ref.id} in ${id}.\n${refLine(r.ref)}`, { ok: true, ...r })
      return 0
    }
    case 'link': {
      const n = Number(after[0]?.replace(/^#/, '')); if (!Number.isInteger(n)) throw c.usage('workflow link needs <record>')
      const msg = Number(c.opt('message')?.replace(/^#/, '')); if (!Number.isInteger(msg)) throw c.usage('--message <msg> is required')
      const o = await h.own()
      const by = o?.agent ?? c.opt('author'); if (!by) throw c.usage('--author <who> is required outside an executing attempt')
      if (!o && !c.opt('note')) throw c.usage('--note <why> is required outside an executing attempt: the reason is part of the record')
      const r = wfs.link(id!, n, { message: msg, by, run: o?.run ?? null, note: c.opt('note') })
      c.out(`${r.duplicate ? 'Already associated' : 'Associated'}: workflow record ${n} with #${msg}.`, { ok: true, ...r })
      return 0
    }
    case 'list': {
      const rows = wfs.rows(id!).map(r => wfs.view(r))
      c.out(rows.length ? rows.map(refLine).join('\n') : `No workflow is recorded in ${id}.`, { ok: true, workflows: rows })
      return 0
    }
    case 'show': {
      const n = Number(after[0]?.replace(/^#/, '')); if (!Number.isInteger(n)) throw c.usage('workflow show needs <record>')
      if (c.flag('current')) {
        const r = await wfs.current(id!, n)
        const cur = r.current as { available: boolean; unavailable?: string; version?: WorkflowRef['after']; workflow?: { nodes: Record<string, { name: string }> }; same?: boolean; state?: { nodes?: Record<string, string>; unavailable?: string } }
        c.out(cur.available ? [`CURRENT (not the recorded version): ${versionLine(cur.version!)}${cur.same ? ' — the same bytes as recorded' : ' — differs from the recorded version'}`, ...Object.entries(cur.workflow!.nodes).map(([k, v]) => `  ${k}: ${v.name}${cur.state?.nodes?.[k] ? ` [${cur.state.nodes[k]} now]` : ''}`)].join('\n') : `The current target is unavailable: ${cur.unavailable}`, r)
        return 0
      }
      const g = await wfs.graph(id!, n)
      const lines = [refLine(g.ref)]
      const side = (label: string, s: typeof g.after | null) => {
        if (!s) return
        if (!s.available) { lines.push(`${label}: unavailable — ${(s as { unavailable: string }).unavailable}`); return }
        lines.push(`${label}: ${Object.keys(s.workflow!.nodes).length} nodes, ${s.workflow!.edges.length} edges`, ...Object.entries(s.workflow!.nodes).map(([k, v]) => `  ${k} (${v.type}${v.activity ? ` ${v.activity}` : ''}): ${v.name}`))
      }
      side(g.before ? 'After' : 'Version', g.after)
      side('Before', g.before)
      const ch = g.changes
      if (ch) lines.push(`Change (${ch.behavioural ? 'behavioural' : 'layout or style only'}):`, ...ch.added.map(x => `  + node ${x.id} "${x.name}"`), ...ch.removed.map(x => `  - node ${x.id} "${x.name}"`), ...ch.changed.map(x => `  ~ node ${x.id}: ${x.props.map(p => p.prop).join(', ')}`), ...ch.restyled.map(x => `  · node ${x.id}: ${[...x.style, ...(x.moved ? ['position'] : [])].join(', ')}`), ...ch.edgesAdded.map(([a, b]) => `  + edge ${a} → ${b}`), ...ch.edgesRemoved.map(([a, b]) => `  - edge ${a} → ${b}`), ...ch.fields.map(f => `  ~ ${f.field}`))
      const st = g.state as { unavailable?: string; seq?: number; at?: string; nodes?: Record<string, string> }
      lines.push(st.unavailable ? `State: unavailable — ${st.unavailable}` : `State at seq ${st.seq} (${st.at}): ${Object.entries(st.nodes!).map(([k, v]) => `${k}=${v}`).join(', ')}`)
      c.out(lines.join('\n'), g)
      return 0
    }
    case 'repair': {
      const notes = await wfs.repair({ conv: id, all: c.flag('all') })
      c.out(notes.join('\n') || 'Nothing to repair or record.', { ok: true, notes })
      return 0
    }
  }
  throw c.usage('workflow needs attach, link, list, show or repair (see: wfe conversation help)')
}
