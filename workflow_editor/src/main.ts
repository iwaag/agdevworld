// Hash routes: #/ (projects, create and register), #/nodes (user nodes, p7/ex1), #/ws/<workspace>
// (project editor), #/ws/<workspace>/wf/<file> (workflow editor) and
// #/ws/<workspace>/run/<workflow>/<run>[/at/<devdocs commit>] (run view) and
// #/ws/<workspace>/run/<workflow>/<run>/io/<attempt>/<line> (one IO entry in full, p10)
// and #/context[/<workspace>[/<workflow>]] (the scoped context overview, p13)
// and #/usage (subscription windows and what executions used, retire_old_ui p1).
// A trailing /context on Home (#/home/context), a project or a workflow opens
// that editor's Context section (p13 ex1).
import './styles.css'
import { renderHomeView } from './homeView.ts'
import { renderNodesView } from './nodesView.ts'
import { renderProjectView } from './projectView.ts'
import { renderRunView } from './runView.ts'
import { renderIoEntry } from './ioEntryView.ts'
import { renderWorkflowView } from './workflowView.ts'
import { renderContextChooser, renderContextView } from './contextView.ts'
import { renderUsageView } from './usageView.ts'
import { closeReader } from './contextParts.ts'

const app = document.getElementById('app')!
let dispose: (() => void) | undefined

// A view with unsaved changes can veto navigation away from it.
export interface ViewHandle { dispose: () => void; isDirty: () => boolean }
let current: ViewHandle | undefined
let lastHash = location.hash

function route() {
  if (current?.isDirty() && location.hash !== lastHash) {
    if (!confirm('Discard unsaved changes in this view?')) { history.replaceState(null, '', lastHash); return }
  }
  lastHash = location.hash
  dispose?.(); current = undefined
  closeReader()
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  app.replaceChildren()
  if (parts[0] === 'ws' && parts[1] && parts[2] === 'run' && parts[3] && parts[4] && parts[5] === 'io' && parts[6] && parts[7]) {
    current = renderIoEntry(app, parts[1], parts[3], parts[4], parts[6], Number(parts[7]))
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'run' && parts[3] && parts[4]) {
    current = renderRunView(app, parts[1], parts[3], parts[4], parts[5] === 'at' ? parts[6] : undefined)
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'wf' && parts[3]) {
    current = renderWorkflowView(app, parts[1], parts[3], { context: parts[4] === 'context' })
  } else if (parts[0] === 'context') {
    current = parts[1] ? renderContextView(app, parts[1], parts[2]) : renderContextChooser(app)
  } else if (parts[0] === 'usage') {
    current = renderUsageView(app)
  } else if (parts[0] === 'nodes') {
    current = renderNodesView(app)
  } else if (parts[0] === 'ws' && parts[1]) {
    current = renderProjectView(app, parts[1], { context: parts[2] === 'context' })
  } else {
    current = renderHomeView(app, { context: parts[0] === 'home' && parts[1] === 'context' })
  }
  dispose = current?.dispose
}

window.addEventListener('hashchange', route)
window.addEventListener('beforeunload', e => { if (current?.isDirty()) e.preventDefault() })
route()
