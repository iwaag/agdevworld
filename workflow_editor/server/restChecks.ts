// What a conductor run leaves unsaid when its last open node completes
// (fix3, tidy p1, tidy p2): checks that need this area's discussions, added
// to the completion's reminders (shared/reminders.ts) by the CLI and the
// HTTP completion alike. Each one is a fact of the records, passed with
// --yes like any reminder.
import type { Reminder } from '../shared/reminders.ts'
import { delegationStanding, lastResultFact } from '../shared/resultEvidence.ts'
import type { RunRecord } from '../shared/run.ts'
import type { ConversationService } from './conversationService.ts'

// The kinds of post that speak to the room for the run (a progress note does not).
const SPOKEN = ['reply', 'result', 'synthesis', 'announce', 'question']

export function restReminders(ds: ConversationService, record: RunRecord, run: string, completing: string): Reminder[] {
  const others = Object.entries(record.nodes).filter(([id]) => id !== completing)
  if (!others.every(([, x]) => x.state === 'completed' || x.state === 'cancelled')) return []
  const out: Reminder[] = []
  const open = ds.conductedBy(run).filter(id => ds.conversation(id)?.state === 'open')
  // p18: a standing conductor's last node leaves it at rest, not ended: it
  // speaks again at the room's next words, so nothing is left unsaid.
  if (!record.standing) {
    const unconcluded = open.filter(id => !ds.activityRows(id).some(a => a.run === run && a.kind === 'announce' && a.obligations !== null))
    if (unconcluded.length) out.push({ code: 'discussion-open', refs: unconcluded, text: `This completes ${run}, which conducts ${unconcluded.join(', ')}: still open, and this run has announced no conclusion there. A completed run can no longer speak; the discussion would wait for the next message.`, repair: ['if it is finished, add a conclusion first: wfe discussion ponder --node <a ponder node> --next announce:<id>, then wfe discussion announce --node <id> --conclude [--close]', 'if it is not, say there what happens next'], summary: `${unconcluded.join(', ')} still open with no conclusion from this run → wfe discussion ponder … --next announce:<id>, then wfe discussion announce --conclude` })
    return out
  }
  // tidy p1: a standing conductor that rests still owes the room an answer
  // to the person's latest words. ponderer/conduct/run-048 posted only
  // progress ("I will summarize when the results are back"), judged the
  // three results, and its last completion put it to rest with nothing said.
  const owed = open.flatMap(id => {
    const ms = ds.messages(id)
    const last = ms.filter(m => m.role === 'person').at(-1)
    return last && !ms.some(m => m.id > last.id && m.run === run && SPOKEN.includes(m.kind)) ? [`${id} #${last.id}`] : []
  })
  if (owed.length) out.push({ code: 'conversation-unanswered', refs: owed, text: `This puts ${run} to rest, and the person's latest words (${owed.join(', ')}) have no reply, result or announcement from it since (a progress note does not answer). At rest it says nothing until someone speaks again.`, repair: ['answer first: wfe conversation reply --re <msg> … --kind result (or announce from a node of its own), then complete', 'if the answer is still to come from work under way, say so and what it waits for'], summary: `${owed.join(', ')} unanswered as ${run} rests → wfe conversation reply --re … first` })
  // tidy p2: results that came back, were judged or were returned after the
  // run last spoke in the room. conversation-unanswered cannot see them once
  // an earlier reply exists (run-048's #452 promised to report the two
  // corrections; at rest the room would not hear of a result judged after it).
  const posts = open.flatMap(id => ds.messages(id).filter(m => m.run === run && SPOKEN.includes(m.kind)).map(m => ({ id, at: m.at, n: m.id })))
  const lastPost = posts.sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null
  if (open.length) {
    const unreported = Object.values(record.delegations ?? {}).filter(d => { const t = lastResultFact(d); return !!t && (!lastPost || t > lastPost.at) })
    if (unreported.length) out.push({
      code: 'results-unreported', refs: unreported.map(d => d.id),
      text: `This puts ${run} to rest, and ${unreported.length === 1 ? 'a commissioned result has' : `${unreported.length} commissioned results have`} a fact the room has not heard from it${lastPost ? ` since its last post (${lastPost.id} #${lastPost.n})` : ''}: ${unreported.map(delegationStanding).join('; ')}.`,
      repair: [`account for each in the room first: wfe conversation reply --re <the person's message> … --kind result, naming each commissioned result, how you judged it and what stays unverified or open`, 'if a result is still to be checked or corrected, say so and what it waits for'],
      summary: `${unreported.map(d => d.id).join(', ')} not reported to the room since ${lastPost ? `#${lastPost.n}` : 'the run began'} → wfe conversation reply … first`,
    })
  }
  return out
}
