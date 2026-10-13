// Starting points for a new workflow (p8/ex2). A template produces an
// ordinary definition: once written, the file is the person's and nothing
// links it back to the template. The editor's creation form and
// `wfe workflow new --template` list the same entries.
import { emptyWorkflow, type Documentation, type Workflow } from '../shared/model.ts'
import type { Workspace } from './workspace.ts'

export interface WorkflowTemplate {
  id: string
  name: string // short label for the creation form
  description: string // one sentence: what a workflow made from it starts with
  documentation: Documentation // its starting documentation setting (the form may change it)
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  { id: 'empty', name: 'Empty workflow', description: 'No steps yet: you add them in the editor.', documentation: { policy: 'default' } },
  // The basic freework (server/basics.ts) under the id and name given here,
  // with this project's resolved bindings and execution.
  { id: 'freework', name: 'Free work', description: 'One talk with the person; the run adds the work agreed in the conversation as it goes. A final report at the end.', documentation: { policy: 'custom', plan: false, reports: false, final: true } },
]

export const templateIds = () => WORKFLOW_TEMPLATES.map(t => t.id)

// The definition a template starts a workflow with.
// `ws` is the project the workflow is made in (templates that resolve
// project settings read it).
export async function workflowFromTemplate(template: string, id: string, name: string, ws?: Workspace): Promise<Workflow> {
  const t = WORKFLOW_TEMPLATES.find(x => x.id === template)
  if (template === 'empty') return { ...emptyWorkflow(id, name), documentation: { ...t!.documentation } }
  if (template === 'freework') {
    const { freeworkWorkflow, newProjectSettings, resolveSettings } = await import('./basics.ts')
    return freeworkWorkflow(ws ? await resolveSettings(ws) : newProjectSettings([]), id, name || 'Free work')
  }
  throw new Error(`unknown workflow template "${template}"`)
}
