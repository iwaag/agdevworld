// A conversation's progression (workflow_editor p18, docs/conversations.md
// *Progression*): the conductor's one run read as the room's growing graph —
// its stretches (the opening and one per wake), each node with its activity,
// the messages it concerns, and, for an ask or a delegate node, the
// recipients' own runs as links with their state (never their nodes: those
// are the recipients' to show). Earlier conductor runs of the room (before
// p18, or a cancelled one replaced) are listed apart, as history. Read from
// records only: no model, no write, no child record beyond what the room's
// view already lists.
import { delegationState } from '../shared/delegation.ts'
import { runStatus, type RunStatus } from '../shared/status.ts'
import { stretchesOf } from '../shared/stretches.ts'
import type { RunRecord } from '../shared/run.ts'
import { parseRunName, runUrl, type MessageRow, type RunEntry } from './conversations.ts'
import type { ActivityRow, ConversationService, InvitationRow } from './conversationService.ts'
import { activeDefinition, readRun } from './runs.ts'

export interface ProgressRecipient {
  kind: 'ask' | 'await' | 'delegation'
  participant: string // the project asked (or whose run is awaited)
  workflow: string | null
  run: string | null; url: string | null
  state: string // the request's state, or the delegation's
  status: RunStatus | null // the recipient run as the room's view reads it
  purpose: string // what was asked
  request: number | null; delegation: string | null
  corrections: number // results returned to the same child: each revise (fix6), a review follow-up (p17) or the person's later words reopening an accepted result (p18) among them
  answeredBy: number | null
}
export interface ProgressNode {
  id: string; name: string; type: string; activity: string | null; state: string
  started: string | null; ended: string | null; outcome: string | null; wait: string | null
  messages: number[] // messages spoken for it, its activity's message, the messages it rests on
  topic: string | null
  recipients: ProgressRecipient[]
  review: { id: string; state: string } | null
}
export interface ProgressStretch { n: number; at: string; topic: string | null; open: boolean; wake: { node: string; events: string[]; messages: number[] } | null; nodes: ProgressNode[] }
export interface Progression {
  conductor: { run: string; url: string | null; status: RunStatus | null; standing: RunRecord['standing'] | null } | null
  stretches: ProgressStretch[]
  earlier: { run: string; url: string | null; status: RunStatus | null; relation: 'replaced' | 'earlier' }[]
}

const short = (t: string | null | undefined, n = 200) => !t ? null : t.length > n ? `${t.slice(0, n - 1)}…` : t

export async function progression(ds: ConversationService, conv: string, o: { viewBase?: string | null; runs: RunEntry[]; messages: MessageRow[]; activities: ActivityRow[]; invitations: InvitationRow[] }): Promise<Progression> {
  const c = ds.conversation(conv)
  const cfg = ds.config()
  const facilitator = 'disabled' in cfg ? null : cfg.facilitator
  const runOf = (key: string) => o.runs.find(r => r.key === key) ?? null
  // Earlier conductor runs: every facilitator run a conductor request started here.
  const conductors = [...new Set(o.invitations.filter(i => i.run && (i.role === 'conduct' || (facilitator && i.workspace === facilitator.workspace && i.workflow === facilitator.workflow && !i.delivery && !i.awaits))).map(i => i.run!))]
  const current = c?.conductor ?? null
  let record: RunRecord | null = null
  let names: Record<string, string> = {}
  let descriptions: Record<string, string> = {}
  if (current && ds.exec) {
    try {
      const { workspace, ref } = parseRunName(current)
      const read = await readRun(await ds.exec.workspace(workspace), ref)
      record = read.record as RunRecord | null
      if (record) {
        const nodes = Object.entries(activeDefinition(record, read.bundle).workflow.nodes)
        names = Object.fromEntries(nodes.map(([id, n]) => [id, n.name || id]))
        descriptions = Object.fromEntries(nodes.map(([id, n]) => [id, n.description ?? '']))
      }
    } catch { record = null }
  }
  const earlier = conductors.filter(r => r !== current).map(r => ({ run: r, url: runOf(r)?.url ?? runUrl(o.viewBase, r), status: runOf(r)?.status ?? null, relation: (record?.standing?.replaces === r ? 'replaced' : 'earlier') as 'replaced' | 'earlier' }))
  if (!current) return { conductor: null, stretches: [], earlier }
  const conductor = { run: current, url: runOf(current)?.url ?? runUrl(o.viewBase, current), status: record ? runStatus(record) : runOf(current)?.status ?? null, standing: record?.standing ?? null }
  if (!record) return { conductor, stretches: [], earlier }
  const acts = o.activities.filter(a => a.run === current)
  const recipientsOf = (node: string): ProgressRecipient[] => {
    const out: ProgressRecipient[] = []
    const act = acts.find(a => a.node === node && a.kind === 'ask')
    if (act) for (const i of o.invitations.filter(x => x.activity === act.id)) {
      out.push({ kind: i.awaits ? 'await' : 'ask', participant: i.participant, workflow: i.workflow, run: i.run, url: i.run ? runOf(i.run)?.url ?? runUrl(o.viewBase, i.run) : null, state: i.state, status: i.run ? runOf(i.run)?.status ?? null : null, purpose: short(i.question, 300) ?? '', request: i.id, delegation: null, corrections: 0, answeredBy: i.answered_by })
    }
    for (const d of Object.values(record!.delegations ?? {}).filter(x => x.node === node)) {
      const child = d.child ? `${d.child.workspace}/${d.child.workflow}/${d.child.run}` : null
      out.push({ kind: 'delegation', participant: d.target.project, workflow: d.target.workflow, run: child, url: child ? runOf(child)?.url ?? runUrl(o.viewBase, child) : null, state: delegationState(d), status: child ? runOf(child)?.status ?? null : null, purpose: short(descriptions[node] || names[node], 300) ?? '', request: null, delegation: d.id, corrections: (d.revisions ?? []).length, answeredBy: null })
    }
    return out
  }
  const messagesOf = (node: string): number[] => {
    const a = acts.filter(x => x.node === node)
    const own = [...o.messages.filter(m => m.run === current && m.node === node).map(m => m.id), ...a.map(x => x.message).filter((n): n is number => !!n), ...a.flatMap(x => JSON.parse(x.sources) as number[])]
    // The conductor's reply spoken for no node belongs to the steps whose
    // messages it answers (--re).
    const replies = o.messages.filter(m => m.run === current && !m.node && (JSON.parse(m.re) as number[]).some(r => own.includes(r))).map(m => m.id)
    return [...new Set([...own, ...replies])].sort((x, y) => x - y)
  }
  const stretches = stretchesOf(record).map(s => {
    const nodes: ProgressNode[] = s.nodes.map(id => {
      const n = record!.nodes[id]
      const g = (record!.definition.revisions?.at(-1)?.effective ?? record!.definition.effective)?.nodes[id]
      const a = acts.filter(x => x.node === id).at(-1)
      const review = Object.values(record!.reviews ?? {}).filter(v => v.node === id).at(-1)
      return {
        id, name: names[id] ?? id, type: g?.type ?? 'do', activity: g?.activity ?? null, state: n.state,
        started: n.started ?? null, ended: n.ended ?? null, outcome: short(n.outcome?.text), wait: n.wait ? short(`${n.wait.reason} (${n.wait.holder})`) : null,
        messages: messagesOf(id), topic: a?.topic ?? null, recipients: recipientsOf(id), review: review ? { id: review.id, state: review.state } : null,
      }
    })
    const wakeMessages = (s.wake?.events ?? []).map(e => record!.instructions?.[e]?.source).filter(x => x?.kind === 'conversation').map(x => (x as { message: number }).message)
    return { n: s.n, at: s.at, topic: nodes.find(x => x.topic)?.topic ?? null, open: s.open, wake: s.wake ? { node: s.wake.node, events: s.wake.events, messages: wakeMessages } : null, nodes }
  })
  return { conductor, stretches, earlier }
}
