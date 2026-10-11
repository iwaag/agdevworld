// Hash routes: #/ (projects, create and register), #/ws/<workspace>
// (project editor), #/ws/<workspace>/wf/<file> (workflow editor) and
// #/ws/<workspace>/run/<workflow>/<run>[/at/<devdocs commit>] (run view).
import './styles.css'
import { renderHomeView } from './homeView.ts'
import { renderProjectView } from './projectView.ts'
import { renderRunView } from './runView.ts'
import { renderWorkflowView } from './workflowView.ts'

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
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  app.replaceChildren()
  if (parts[0] === 'ws' && parts[1] && parts[2] === 'run' && parts[3] && parts[4]) {
    current = renderRunView(app, parts[1], parts[3], parts[4], parts[5] === 'at' ? parts[6] : undefined)
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'wf' && parts[3]) {
    current = renderWorkflowView(app, parts[1], parts[3])
  } else if (parts[0] === 'ws' && parts[1]) {
    current = renderProjectView(app, parts[1])
  } else {
    current = renderHomeView(app)
  }
  dispose = current?.dispose
}

window.addEventListener('hashchange', route)
window.addEventListener('beforeunload', e => { if (current?.isDirty()) e.preventDefault() })
route()
