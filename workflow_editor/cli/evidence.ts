// Workflow evidence of a discussion turn (argue p4 ex3,
// server/discussionWorkflows.ts): the commands that save or create a
// definition, request a run or revise one record what they did when the
// executing attempt works for a discussion. Outside an attempt, or for a run
// with no discussion, nothing is opened and nothing is recorded. A failure
// to record never fails the operation: it is said on stderr, and the
// executor's repair resolves the journal entry.
import { ConversationStore } from '../server/conversations.ts'
import { DiscussionStore } from '../server/discussions.ts'
import { DiscussionWorkflows, type Turn } from '../server/discussionWorkflows.ts'
import type { ExecStore } from '../server/exec.ts'

export interface Evidence { wfs: DiscussionWorkflows; turn: Turn; close: () => void }

export async function discussionTurn(x: ExecStore, area: string): Promise<Evidence | null> {
  const attempt = process.env.WFE_ATTEMPT
  if (!attempt) return null
  const cs = new ConversationStore({ area, exec: x })
  try {
    const ds = new DiscussionStore(cs)
    if ('disabled' in ds.config()) { cs.close(); return null }
    const wfs = new DiscussionWorkflows(ds)
    const turn = await wfs.turnOf(attempt)
    if (!turn) { cs.close(); return null }
    return { wfs, turn, close: () => cs.close() }
  } catch (e) {
    cs.close()
    warn(e)
    return null
  }
}

export const warn = (e: unknown) => process.stderr.write(`wfe: the discussion's workflow record was not written: ${(e as Error).message}\n`)

// Runs `f` with the evidence, never letting a recording failure escape.
export async function quietly<T>(f: () => Promise<T>): Promise<T | null> {
  try { return await f() } catch (e) { warn(e); return null }
}
