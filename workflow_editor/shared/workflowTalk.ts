// A system node type, not an entry in the person's editable node catalog.
import type { WorkflowNode } from './model.ts'

export const WORKFLOW_TALK = 'workflow__talk'
export const WORKFLOW_TALK_NAME = 'Discuss the workflow'
export const WORKFLOW_TALK_INSTRUCTIONS = [
  'Before substantive work, build the actual run graph: add suitable work nodes with wfe run adjust (wfe run help adjust; wfe run nodes <run> shows the catalog).',
  'Present that recorded graph to the Developer, or to the agent that entrusted this run, and ask for agreement on the work, its order, intended results and checks. A prose plan alone is not the graph.',
  'Use the run\'s delivery route for the presentation and wfe run ask when an answer is needed; record answers and changes against this run. Do not claim agreement without an answer.',
  'Agreement records direction, not permission to execute. An already authorized task need not wait for another approval. Start and perform the work on its own nodes, not inside talk or workflow__talk; revise the graph when the work changes.',
].join('\n')

export function workflowTalkNode(): WorkflowNode {
  return { type: WORKFLOW_TALK, name: WORKFLOW_TALK_NAME, description: WORKFLOW_TALK_INSTRUCTIONS, repositories: [] }
}
