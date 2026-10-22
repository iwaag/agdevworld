// `wfe discussion` (workflow_editor p16, docs/discussions.md): discussions of
// a person, a facilitator and project agents, each speaking through its own
// runs. Thin over server/discussions.ts and server/discussionArchive.ts, the
// store and archive writer the service uses.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONVERSATION_ID, ConversationStore, parseRunName, RELATIONS, runName, viewBaseOf, type MessageKind, type Relation } from '../server/conversations.ts'
import { DiscussionArchive } from '../server/discussionArchive.ts'
import { DiscussionStore, type Requester } from '../server/discussions.ts'
import { DiscussionWorkflows, type WorkflowRef, type WorkflowRelation, type WorkflowRole } from '../server/discussionWorkflows.ts'
import type { ExecStore } from '../server/exec.ts'
import { readRun } from '../server/runs.ts'
import { RequestError } from '../server/workspace.ts'

export const DISCUSSION_HELP = `wfe discussion <subcommand> …   (discussions; docs/discussions.md)

A discussion is a shared conversation of a person, a facilitator (the
ponderer, which conducts it) and project agents, each speaking through runs
of its own project's workflow with its own guide and context. Its members
and their history, every message (the person's words verbatim; each agent
message with the participant, run and invitation it came from), its
invitations and the conductor's activities are kept by WFE. An invitation
is the only thing that starts a run here: the person's message invites the
participants it addresses; addressing nobody, it goes to the conductor run
(the facilitator's open run that owns the discussion: as the answer to its
question, else as an instruction), or invites the facilitator when none is
open. A contribution never starts anything by itself.

A question is your run's question, from any run (\`wfe run ask <run> <node>
--to <whom> --question …\`): WFE posts every open question of a run that
speaks for a discussion there, and the person's reply naming it comes back
to that run as its answer. There is no other way to ask here.

The conductor's run is an ordinary graph whose nodes carry a discussion
activity (node field activity: announce | ask | ponder | talk). Each is
performed with its command, from the conductor's executing attempt:

announce [<id>] --node <n> (--text <t> | --file <f|->) --re <msg>… [--conclude [--close]]
                              (a discussion you created opens with an announcement that quotes the
                              request and names whose it is; it needs no --re)
                              speak to the discussion (agenda, context, interim synthesis, the
                              conclusion); waits for nobody; the node completes with the message.
                              --conclude records what is still owed and who receives it later;
                              --close then closes the discussion (it cancels nothing)
ask [<id>] <participant>… --node <n> --question <q> --re <msg>…
ask [<id>] --node <n> --run <workspace>/<workflow>/<run> --question <what> [--re <msg>…]
                              invite them with one question (parallel invitations), or await the
                              result of a run already working; the node waits and your attempt can
                              end. When every invitation is resolved (answered #m, unanswered,
                              failed, withdrawn) WFE completes the node with the outcomes and
                              continues your run with one instruction. Unavailable participants
                              fail at once and block nobody
settle [<id>] --node <n> --reason <why>
                              move on before an ask is resolved: its node completes now with what
                              came so far; later outcomes are told as late outcomes of that ask
ponder [<id>] --node <n> --decision <text> --source <msg>… [--next <activity>:<node>[:<name>]]…
       [--definition <file>]  your decision: what is settled, what is missing, what comes next and
                              why, citing the messages it rests on. The node completes with it.
                              --next adds a chain of new activity nodes after this one (in order);
                              --definition records any revision of the run's graph instead. Both
                              are one recorded run revision (wfe run revisions)
talk                          (no command) a talk node's question to the requester is wfe run ask
                              on that node, --to the requester (state names them); it is the talk
                              activity. An agent requester answers through its delegation (wfe
                              delegate answer) or request topic
state [<id>]                  what the conductor works from: conductor and requester, members,
                              activities and the conductor run's graph, open invitations, questions
                              waiting, obligations (what is owed, by whom, to whom), newest message
annotate <id> --kind intervention|recovery|evaluation|correction|note (--text <t> | --file <f>)
         --author <who> [--re <msg>]… [--run <run>]
                              a record by someone outside the speech (an Omni hint, a repair, an
                              evaluation, a correction of an earlier claim); never speech, starts
                              nothing; archived and shown apart

participants                  the facilitator and the projects that can be invited, and whether
                              each can take an invitation now
list [--category discussion|check] [--state open|closed]
                              the discussions, newest first, with category, members, open invitations
                              and whether an overview covers the newest message
show [<id>] [--since <msg>]   members and their history, every message (who spoke, for which
                              run and invitation, what it answers, whom the person addressed),
                              the invitations (state, run, horizon, outcome), linked runs as their
                              records say now, questions waiting for the person, the archive.
                              Without <id>: the discussion of this attempt's run. Messages after
                              your invitation's horizon are marked: they are readable, and newer
                              than what you were invited with
create <id> --title <t> [--author <person>] [--member <project>]… [--category discussion|check]
                              a new discussion with the person, the facilitator and the projects.
                              --category check: an operational check or fixture (listed apart from
                              ordinary discussions; default discussion).
                              From the facilitator's attempt the run is its conductor, and the
                              requester is whoever requested that run (a delegating run, an agent's
                              request, or the person it names)
post <id> (--text <t> | --file <f>) --author <person> [--to <participant>]… [--re <msg>]…
     [--token <t>] [--via <way>]
                              the person's message, verbatim (refused from an executing attempt:
                              a run speaks as itself with contribute or announce). --to invites those participants with
                              it; without --to (or --to <facilitator>) the facilitator is invited
contribute [<id>] (--text <t> | --file <f|->) --re <msg>… [--kind reply|progress|result|synthesis]
           [--key <k>] [--completing <node>] [--workflow <record>]…
                              speak from an executing attempt: the message is your run's, its
                              participant's and its invitation's. Name what you answer (--re): a
                              reply is never attributed by recency. reply/result/synthesis answer
                              your invitation; progress does not. A question is wfe run ask. synthesis is the
                              facilitator's project's or the archive project's (any of its
                              workflows), shown apart from original speech. --completing <node>: that node of your run completes with the
                              message in the same command (a turn that spoke and left its node
                              running is held interrupted; p3 rts-vs-bot/discuss/run-001).
                              --workflow <record>: the workflow records of your turn this message is
                              about (wfe discussion workflow list) are shown with it
invite [<id>] <participant> --question <q> [--re <msg>]… [--token <t>] [--author <person>]
                              ask a participant: from the facilitator's run the invitation is
                              awaited (your run is told when all it awaits are resolved; make your
                              node wait with wfe run wait … --external discussion:<id> and end your
                              attempt to free the slot). Outside an attempt it is the person's
                              (--author). A participant's run cannot invite: say whom you would ask
await [<id>] --run <workspace>/<workflow>/<run> --note <what> [--re <msg>]…   (with --node: ask --run)
                              from the facilitator's run: await the result of a run that is already
                              working (a participant's run waiting for the work it entrusted, a
                              synthesize run, any run). Nothing is started. It is resolved by that
                              run's next result or synthesis here, or when the run ends (answered by
                              its last message here since the await, else unanswered), and told with
                              your other awaited invitations. Wait as for invite
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
meta <id> [--category discussion|check] [--title <display title> | --no-title] --note <why> [--author <who>]
                              correct how the discussion is listed: its category, and a title for
                              readers (the original title and id stay). Recorded with who and why;
                              sends nothing, invites nobody, reopens nothing
overview [<id>] --purpose <t> [--outcome <t>] [--unresolved <t>]… [--through <msg>] [--title <t>]
         --note <what changed> [--author <who>]    (or --file <json|->; without either: show it)
                              the reader's overview, shown in the list and at the top of the room:
                              what the discussion is trying to establish, its current outcome and
                              what is unresolved, in the readers' language, each part citing the
                              messages it rests on as [#n] (WFE refuses a part without one). It
                              covers the speech through --through (default: the newest message);
                              later messages make it "stale" in readers' eyes, still readable. An
                              overview is your interpretation with sources: not speech, not proof
                              of agreement, not the discussion's status (WFE derives that). Keep
                              disagreement and open work in it. A new one is a new revision; the
                              earlier ones stay. From a run: the facilitator's or archive project's.
                              --title also records the display title. --file takes
                              {purpose, outcome?, unresolved?[], through?, title?, note?}
workflow attach [<id>] --project <p> (--workflow <wf> [--commit <c>] | --run <wf>/<run> [--revision rN])
         [--as referenced|created|edited|executed] [--node <n>]… [--re <msg>]… [--note <what it is to the discussion>]
         [--from <what it was copied from>] [--role subject|progression]
                              declare a workflow as material of this discussion: the definition as it
                              is now in the project's working tree (a draft unless it equals the
                              committed file), at a commit, or a run's revision. WFE reads it and keeps
                              its bytes, so readers see exactly that version beside the turn; --node
                              names the nodes you mean, --re the messages it belongs to. It records
                              that the version was retrieved, not that it was understood. Starts
                              nothing. (Saving or creating a definition, revising a run and requesting
                              or delegating work from a discussion turn are recorded by those commands
                              themselves.)
workflow link [<id>] <record> --message <msg> [--note <n>] [--author <who>]
                              associate a recorded operation with the message it belongs to, later
                              (a run links its own records; the person any, with a note)
workflow list [<id>]          the workflows of the discussion: each record's relation, role, version,
                              turn (run, attempt, invitation), messages and evidence
workflow show [<id>] <record> [--current]
                              one record's pinned version (and the version before an edit), the change
                              by node id and edge, and the node states at the recorded point;
                              --current: the target as it is now, labelled current
workflow repair [<id>] [--all]
                              resolve operations interrupted before their record (from the operation's
                              own evidence, else unconfirmed) and record the revisions and delegated
                              children of the discussion's runs (also done by the executor's reconcile
                              for open discussions); --all: every discussion, as backfill
dispatch                      start invitations not started yet, mark those whose run ended
                              without a contribution unanswered, tell waiting facilitators
                              (also done by the executor's reconcile every minute)
archive [<id>…] [--status]    publish the archive (the archive project's discussions/<id>/
                              manifest.json and transcript.jsonl) for the named or every due
                              discussion, or say what is published: commit, horizon, the
                              repository it was verified in, and what is still behind
                              (unverified: published in another repository than the configured one)

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
      return { run, attempt, agent: rec.executor.name, rec, discussion: src && ds.discussion(src.conversation) ? src.conversation : ds.conductedBy(run)[0] ?? null, invitation: src && ds.discussion(src.conversation) ? src.invitation ?? null : null }
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
        const l = await ds.listing({ category: c.opt('category'), state: c.opt('state') })
        const rows = l.discussions
        const cov = (r: typeof rows[number]) => !r.overview ? 'no overview' : r.overview.after ? `overview +${r.overview.after}` : 'overview'
        c.out(rows.length ? rows.map(r => `${r.id.padEnd(24)} ${r.category.padEnd(10)} ${r.state.padEnd(6)} ${String(r.count).padStart(4)} msgs  ${String(r.open).padStart(2)} open  ${cov(r).padEnd(12)} [${r.members.join(', ')}]  ${r.displayTitle ?? r.title}`).join('\n') : 'No discussions.', l)
        return 0
      }
      case 'show': {
        const id = await disc(args[0])
        const o = await own()
        const v = await ds.view(id, { viewBase: viewBaseOf(c.area()), since: Number(c.opt('since') ?? 0) || 0 })
        const archive = await new DiscussionArchive(ds).status(id)
        const mine = o?.invitation ? v.invitations.find(i => i.id === o.invitation) : undefined
        const req = v.discussion.requester
        const ov = v.overview
        const lines = [`Discussion ${id} (${v.discussion.state}, ${v.discussion.category}): ${v.discussion.title}${v.discussion.displayTitle ? ` — shown as "${v.discussion.displayTitle}"` : ''}`,
          ov ? `Overview by ${ov.author}${ov.run ? ` (${ov.run})` : ''} ${ov.at}, through #${ov.through}${ov.after ? ` (${ov.after} newer message${ov.after === 1 ? '' : 's'})` : ''}: purpose ${ov.purpose.split('\n')[0].slice(0, 160)}${ov.outcome ? ` | outcome ${ov.outcome.split('\n')[0].slice(0, 160)}` : ''}${ov.unresolved.length ? ` | ${ov.unresolved.length} unresolved` : ''}` : 'Overview: none (wfe discussion overview)',
          `Facilitator: ${v.discussion.facilitator}${v.discussion.conductor ? `; conductor ${v.discussion.conductor}` : ''}${req ? `; requester ${req.kind === 'person' ? req.id : req.run}` : ''}. Members: ${v.members.map(m => `${m.participant} (${m.kind}${m.workspace ? ` ${m.workspace}/${m.workflow}` : ''})`).join(', ')}`]
        if (mine) lines.push(`You are ${mine.participant}, invited (invitation ${mine.id}) by ${mine.by}${mine.byRun ? ` (${mine.byRun})` : ''} about ${mine.source.map(n => `#${n}`).join(', ')}; horizon #${mine.horizon}.`)
        const history = v.membership.filter(r => r.action === 'leave' || r.note !== 'created the discussion')
        if (history.length) lines.push('Membership:', ...history.map(r => `  ${r.at} ${r.participant} ${r.action} (by ${r.by}${r.note ? `: ${r.note}` : ''})`))
        for (const m of v.messages) {
          const after = mine && m.id > mine.horizon ? ' (after your invitation)' : ''
          const head = m.role === 'person'
            ? `${m.author} (person)${m.via ? ` via ${m.via}` : ''}${m.addressed.length ? ` to ${m.addressed.join(', ')}` : ''}`
            : `${m.participant ?? m.author} (${m.author}${m.run ? ` for ${m.run}` : ''}${m.invitation ? `, invitation ${m.invitation}` : ''})`
          lines.push('', `#${m.id} ${m.at} ${head}${m.kind !== 'message' ? ` [${m.kind}${m.question ? ` ${m.question}` : ''}${m.node ? ` node ${m.node}` : ''}]` : ''}${m.re.length ? ` re ${m.re.map(n => `#${n}`).join(', ')}` : ''}${after}`)
          lines.push(...m.text.split('\n').map(l => `    ${l}`))
          for (const l of v.links.filter(l => l.message === m.id && !v.links.some(y => y.supersedes === l.id))) lines.push(`    → ${l.relation} ${l.run} by ${l.by}: ${l.note}`)
        }
        lines.push('', 'Invitations:', ...v.invitations.map(i => `  ${i.id} → ${i.participant} (${i.target}) by ${i.by}${i.byRun ? ` ${i.byRun}` : ''}${i.awaits ? ', awaited result' : i.awaitedBy ? ', awaited' : ''}: ${i.state}${i.late ? ' (late)' : ''}${i.run ? ` ${i.run}` : ''}${i.answeredBy ? ` answered by #${i.answeredBy}` : ''}${i.error ? ` — ${i.error}` : ''}; about ${i.source.map(n => `#${n}`).join(', ')}; "${i.question.split('\n')[0].slice(0, 100)}"`))
        if (!v.invitations.length) lines.push('  (none)')
        lines.push('', 'Runs (run view; files: append a path in the run folder):', ...v.runs.map(r => `  ${r.key} — ${r.status?.text ?? r.situation} (${r.situation}, ${r.execution}); ${r.relation}${r.url ? `; ${r.url}` : ''}${r.files ? `; files ${r.files}` : ''}${r.presentations.map(p => `; review ${p.id} ${p.url}`).join('')}${r.problem ? `; ${r.problem}` : ''}`))
        lines.push(`Waiting for the person: ${v.asking.length ? v.asking.map(n => `#${n}`).join(', ') : 'nothing'}`)
        if (v.activities.length) lines.push(`Activities: ${v.activities.length} (wfe discussion state ${id})`)
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
        const r = ds.create(id, { title, by: author, members: c.opts('member'), category: c.opt('category'), ...(conducting ? { conductor: conducting.run, requester } : {}) })
        c.out(`${r.duplicate ? 'Already exists' : 'Created'}: ${r.discussion.category === 'check' ? 'check' : 'discussion'} ${id} with ${ds.members(id).map(m => m.participant).join(', ')}.`, { ok: true, ...r, members: ds.members(id) })
        return 0
      }
      case 'post': {
        const id = args[0]; if (!id) throw c.usage('post needs <id>')
        const author = c.opt('author'); if (!author) throw c.usage('--author <person> is required: whose words these are')
        // The person's route (argue p4 step 5: ponderer/conduct/run-004 posted
        // the requester's brief as a person named front-agent): an executing
        // attempt speaks as its own run.
        const o = await own()
        if (o) throw c.refused(`post is the person's route; ${o.run} speaks as itself: wfe discussion contribute, or announce from the conductor (quote the request and name whose it is)`, { code: 'not-person' })
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
        const complete = c.opt('completing')
        // One way to ask (workflow_editor fix3): WFE posts the run's question.
        if (c.opt('kind') === 'question' || c.opt('question')) throw c.refused('a question is your run\'s question: wfe run ask <run> <node> --to <whom> --question <q>. WFE posts it in this discussion and the reply comes back to your run as its answer', { code: 'question-is-run-ask' })
        const r = await ds.contribute(id, { text: text(), author: o.agent, run: o.run, attempt: o.attempt, invitation: o.discussion === id ? o.invitation : null, re, kind: (c.opt('kind') ?? 'reply') as MessageKind, key: c.opt('key'), node: complete ?? null, complete: !!complete })
        const wfs = new DiscussionWorkflows(ds)
        const linked = c.opts('workflow').map(v => wfs.link(id, Number(v.replace(/^#/, '')), { message: r.message.id, by: o.agent, run: o.run }).ref.id)
        c.out(`${r.duplicate ? 'Already posted (same key); nothing changed' : 'Posted'}: #${r.message.id} in ${id} as ${r.message.participant} for ${o.run}${r.invitation ? `; invitation ${r.invitation.id} ${r.invitation.state}${r.invitation.late ? ' (late)' : ''}` : ''}${r.completed ? `; node ${r.completed} completed` : ''}${linked.length ? `; workflow record${linked.length === 1 ? '' : 's'} ${linked.join(', ')} shown with it` : ''}.`, { ok: true, ...r, workflows: linked })
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
        c.out(`${r.duplicate ? 'Already invited (same invitation)' : 'Invited'}: invitation ${i.id} → ${i.participant}: ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}${i.awaited_by ? `; awaited by ${i.awaited_by}` : ''}.`, { ok: true, ...r })
        return 0
      }
      case 'await': {
        if (c.opt('node')) return discussionCommand({ ...c, positional: ['ask', ...args], opt: k => k === 'question' ? c.opt('question') ?? c.opt('note') : c.opt(k) })
        const id = await disc(args[0])
        const o = await own()
        if (!o) throw c.usage('await is the facilitator\'s, from its executing attempt (WFE_ATTEMPT)')
        const run = c.opt('run'); if (!run) throw c.usage('--run <workspace>/<workflow>/<run> is required: whose result is awaited')
        parseRunName(run)
        const note = c.opt('note'); if (!note) throw c.usage('--note <what> is required: the result awaited')
        const r = await ds.awaitResult(id, { run, note, re: ids('re'), by: o.agent, byRun: o.run })
        const i = r.invitation
        c.out(`${r.duplicate ? 'Already awaited' : 'Awaiting'}: the result of ${run} (invitation ${i.id}): ${i.state}${i.answered_by ? ` by #${i.answered_by}` : ''}; awaited by ${i.awaited_by}.`, { ok: true, ...r })
        return 0
      }
      case 'announce':
      case 'ask':
      case 'settle':
      case 'ponder': {
        const o = await own()
        if (!o) throw c.usage(`${sub} is the conductor's, from its executing attempt (WFE_ATTEMPT)`)
        const given = sub === 'ask' ? (args[0] && ds.discussion(args[0]) ? args[0] : undefined) : args[0]
        const id = await disc(given)
        const node = c.opt('node'); if (!node) throw c.usage(`--node <node> is required: the ${sub === 'settle' ? 'ask' : sub} node of your run`)
        const base = { run: o.run, attempt: o.attempt, author: o.agent, node }
        if (sub === 'announce') {
          // The opening of a discussion the conductor created has nothing to name.
          const re = ids('re'); if (!re.length && ds.horizon(id).message) throw c.usage('--re <msg> is required: what the announcement is about')
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
          c.out(`${r.duplicate ? 'Already asked' : 'Asked'} (activity ${r.activity.id}): ${r.invitations.map(i => `invitation ${i.id} → ${i.participant}: ${i.state}${i.run ? ` ${i.run}` : ''}${i.error ? ` — ${i.error}` : ''}`).join('; ')}. Node ${node} waits; end your attempt when nothing else is to be done: WFE completes ${node} with the outcomes and continues this run.`, { ok: true, ...r })
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
          const r = await ds.ponder(id, { ...base, decision, sources: ids('source'), next, ...(def ? { definition: readFileSync(def === '-' ? 0 : resolve(def), 'utf8') } : {}) })
          c.out(`${r.duplicate ? 'Already decided' : 'Decided'} (activity ${r.activity.id}): node ${node} completed${r.revision ? `; revision ${r.revision}${next.length ? ` adds ${next.map(x => `${x.activity}:${x.node}`).join(' → ')}` : ''}` : ''}.`, { ok: true, ...r })
          return 0
        }
        return 0
      }
      case 'talk': throw c.refused('there is no talk command: ask the requester with wfe run ask <run> <talk node> --to <requester> --question <q> (wfe discussion state names the requester). WFE posts it here as the talk activity', { code: 'question-is-run-ask' })
      case 'state': {
        const id = await disc(args[0])
        const v = await ds.view(id, { viewBase: viewBaseOf(c.area()) })
        const d = v.discussion
        const lines = [`Discussion ${id} (${d.state}): ${d.title}`, `Conductor: ${d.conductor ?? 'none'}${d.conductor ? ` — ${v.runs.find(r => r.key === d.conductor)?.status?.text ?? ''}` : ''}. Requester: ${d.requester ? d.requester.kind === 'person' ? `${d.requester.id} (person)` : `${d.requester.run} (${d.requester.agent ?? 'agent'})` : 'unknown'}.`,
          `Members: ${v.members.map(m => m.participant).join(', ')}. Newest message #${v.horizon.message}.`]
        if (d.conductor) {
          try {
            const { workspace, ref } = parseRunName(d.conductor)
            const read = await readRun(await x.workspace(workspace), ref)
            const rec = read.record
            if (rec) lines.push('Conductor graph:', ...Object.entries(rec.nodes).map(([n, s]) => { const a = v.activities.find(y => y.run === d.conductor && y.node === n); return `  ${n}: ${s.state}${a ? ` — ${a.kind} (activity ${a.id}, ${a.state})${a.kind === 'ponder' ? `: ${a.text.split('\n')[0].slice(0, 120)}` : ''}` : ''}${s.wait ? ` — waits: ${s.wait.reason}` : ''}` }))
          } catch (e) { lines.push(`Conductor graph: unreadable (${(e as Error).message})`) }
        }
        lines.push('Activities:', ...(v.activities.length ? v.activities.map(a => `  ${a.id} ${a.kind.padEnd(8)} ${a.state.padEnd(9)} ${a.run}#${a.node}${a.message ? ` #${a.message}` : ''}${a.invitations.length ? ` invitations ${a.invitations.join(', ')}` : ''}${a.question ? ` ${a.question}` : ''}${a.text ? ` — ${a.text.split('\n')[0].slice(0, 100)}` : ''}`) : ['  (none)']))
        const open = v.invitations.filter(i => i.state === 'pending' || i.state === 'started')
        lines.push('Open invitations:', ...(open.length ? open.map(i => `  ${i.id} → ${i.participant}${i.run ? ` ${i.run}` : ''} (${i.state}${i.awaits ? ', awaited result' : ''}${i.activity ? `, activity ${i.activity}` : ''})`) : ['  (none)']))
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
        const r = ds.setMeta(id, { category: c.opt('category'), displayTitle: title, by, run: (await own())?.run ?? null, note })
        c.out(r.changed.length ? `Recorded for ${id}: ${r.changed.map(m => `${m.field} = ${m.value ?? '(none)'}`).join('; ')}.` : `Nothing changed for ${id}: it already reads so.`, { ok: true, ...r })
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
        const given = f ? JSON.parse(readFileSync(f === '-' ? 0 : resolve(f), 'utf8')) as { purpose?: string; outcome?: string; unresolved?: string[]; through?: number; title?: string; note?: string } : null
        const purpose = given?.purpose ?? c.opt('purpose'); if (!purpose) throw c.usage('--purpose <text> is required (or --file)')
        const note = given?.note ?? c.opt('note'); if (!note) throw c.usage('--note <what changed> is required: why this revision')
        const through = given?.through ?? (c.opt('through') ? Number(c.opt('through')!.replace(/^#/, '')) : undefined)
        const r = ds.publishOverview(id, { purpose, outcome: given?.outcome ?? c.opt('outcome') ?? null, unresolved: given?.unresolved ?? c.opts('unresolved'), through, title: given?.title ?? c.opt('title'), note, author, run: o?.run ?? null })
        c.out(`${r.duplicate ? 'Already recorded (same overview)' : 'Recorded'}: overview ${r.overview.id} of ${id}, through #${r.overview.through}, citing ${r.overview.sources.map(n => `#${n}`).join(' ')}${r.changed.length ? `; display title "${r.changed[0].value}"` : ''}. Nothing was sent or started.`, { ok: true, ...r })
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
          const repo = rows[0]?.repository ?? (await a.origin() as { web?: string | null; url?: string }).web ?? null
          c.out([...(repo ? [`Archive repository: ${repo}`] : []), ...rows.map(r => `${r.id.padEnd(24)} ${r.state.padEnd(10)} ${r.published ? `${r.published.commit.slice(0, 12)} through #${r.published.horizon.message} (live #${r.live.message})` : `live #${r.live.message}`}${r.error ? ` — ${r.error}` : ''}`)].join('\n') || 'No discussions.', rows)
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

const RELATION_WORDS: Record<string, string> = { referenced: 'referenced', created: 'created', edited: 'edited', executed: 'executed' }
const versionLine = (v: WorkflowRef['after']) => !v ? 'no version recorded' : v.kind === 'revision' ? `${v.run} ${v.revision} (sha256 ${v.sha256.slice(0, 12)}, seq ${v.seq ?? '?'})` : `${v.kind}${v.commit ? ` at ${v.commit.slice(0, 12)}` : ''} ${v.path ?? ''} (sha256 ${v.sha256.slice(0, 12)})`
const refLine = (r: WorkflowRef) => `${String(r.id).padStart(3)} ${RELATION_WORDS[r.relation].padEnd(10)} ${r.role.padEnd(11)} ${r.project}/${r.workflow}${r.target.kind === 'run' ? ` run ${r.target.run}` : ' definition'} — ${versionLine(r.after)}${r.before ? ` (before: ${versionLine(r.before)})` : ''}\n      turn ${r.run ?? r.actor}${r.attempt ? ` attempt ${r.attempt}` : ''}${r.invitation ? ` invitation ${r.invitation}` : ''}${r.origin ? ` for ${r.origin}` : ''}${r.activity ? ` activity ${r.activity}` : ''}; ${r.messages.length ? `messages ${r.messages.map(n => `#${n}`).join(', ')}` : 'no message'}; ${r.evidence} (${r.operation})${r.state !== 'recorded' ? ` [${r.state}]` : ''}${r.nodes.length ? `; nodes ${r.nodes.join(', ')}` : ''}${r.note ? `\n      ${r.note.split('\n')[0].slice(0, 200)}` : ''}`

async function workflowCommand(c: DiscussionCli, ds: DiscussionStore, args: string[], h: {
  own: () => Promise<{ run: string; attempt: string; agent: string; discussion: string | null; invitation: number | null } | null>
  disc: (given?: string) => Promise<string>
  ids: (k: string) => number[]
  isNum: (v: string | undefined) => boolean
  who: () => Promise<string | undefined>
}): Promise<number> {
  const [op, ...rest] = args
  const wfs = new DiscussionWorkflows(ds)
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
  throw c.usage('workflow needs attach, link, list, show or repair (see: wfe discussion help)')
}
