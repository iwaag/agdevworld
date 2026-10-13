// Starting points for a new workflow (p8/ex2). A template produces an
// ordinary definition: once written, the file is the person's and nothing
// links it back to the template. The editor's creation form and
// `wfe workflow new --template` list the same entries.
import { emptyWorkflow, type Workflow } from '../shared/model.ts'

export interface WorkflowTemplate {
  id: string
  name: string // short label for the creation form
  description: string // one sentence: what a workflow made from it starts with
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  { id: 'empty', name: 'Empty workflow', description: 'No steps yet: you add them in the editor.' },
]

export const templateIds = () => WORKFLOW_TEMPLATES.map(t => t.id)

// The definition a template starts a workflow with.
export async function workflowFromTemplate(template: string, id: string, name: string): Promise<Workflow> {
  if (template === 'empty') return emptyWorkflow(id, name)
  throw new Error(`unknown workflow template "${template}"`)
}
