import Phaser from 'phaser'
import { PanelGridScene } from './scenes/PanelGridScene'
import { autolabViewConfig, nodesViewConfig, workspacesViewConfig, type PanelSelection } from './views'
import { currentView, registerGame, switchView } from './viewSwitcher'
import { initChatPanel } from './chatPanel'
import { setAskHandler, showDetailPopup } from './detailPopup'
import { summarizeJob } from './autolabState'
import {
  loadActualDevices,
  loadDriftEnvelope,
  matchDeviceForTarget,
  summarizeClusterContext,
  summarizeNode,
  summarizeWorkspace,
  type ActualDeviceModel,
} from './clusterState'

// Devices from the optional nctl.actual.v2 detail snapshot; empty until (and
// unless) that snapshot loads. Node selections are enriched opportunistically.
let actualDevices: ActualDeviceModel[] = []
loadActualDevices()
  .then((devices) => {
    actualDevices = devices
  })
  .catch((error) => console.warn('actual detail snapshot unavailable:', error))

function handleSelection(selection: PanelSelection) {
  if (selection.view === 'nodes' && selection.device === undefined) {
    selection.device = matchDeviceForTarget(actualDevices, selection.target.target)
  }
  showDetailPopup(selection)
}

let clusterContext = ''
// Digest of the panel the user last asked the agent about; rides along in the
// chat context so follow-up questions keep working.
let selectedDigest = ''
const chat = initChatPanel(
  () =>
    [`Currently visible view: ${currentView()}`, clusterContext, selectedDigest]
      .filter(Boolean)
      .join('\n\n'),
  (action) => {
    // Unknown actions are ignored silently; the protocol may grow.
    if (action.action === 'switch_view' && typeof action.view === 'string') switchView(action.view)
    if (action.action === 'generate_image') {
      // Missing/mangled desire falls back to the latest user message inside
      // the chat panel (small local models sometimes break the JSON string).
      const desire = typeof action.desire === 'string' && action.desire.trim() !== '' ? action.desire : undefined
      chat.generateImage(desire)
    }
  },
)

setAskHandler((selection) => {
  if (selection.view === 'autolab') {
    const detail = selection.detail ?? { ...selection.job, evidence: [] }
    const digest = [`Details of the selected autolab job:\n${summarizeJob(selection.node, detail)}`]
    // The iteration summary was written by a Claude agent on the node and is
    // already prose. It goes into the context verbatim — the popup shows the
    // same text unabridged, and the local model's job is only to answer
    // questions about it, never to re-summarize it.
    if (selection.summary) {
      digest.push(
        `Summary of iteration ${selection.summary.iter}, written on the node:\n${selection.summary.text}`,
      )
    }
    selectedDigest = digest.join('\n\n')
    chat.ask(
      selection.summary
        ? `What does iteration ${selection.summary.iter} of autolab job ${selection.job.name} tell us?`
        : `Explain the current state of autolab job ${selection.job.name} in plain language.`,
    )
    return
  }
  if (selection.view === 'nodes') {
    const target = selection.target.target
    const name = target.slug ?? target.name ?? target.id ?? 'this node'
    selectedDigest = `Details of the selected node:\n${summarizeNode(selection.target, selection.device)}`
    chat.ask(`Explain the current state of node ${name} in plain language.`)
  } else {
    selectedDigest = `Details of the selected workspace:\n${summarizeWorkspace(selection.row)}`
    chat.ask(`Explain the current state of workspace ${selection.row.name} in plain language.`)
  }
})
loadDriftEnvelope()
  .then((envelope) => {
    clusterContext = summarizeClusterContext(envelope)
  })
  .catch((error) => console.error('cluster context unavailable for assistant:', error))

// Phaser auto-starts only the first scene in the list; 'workspaces' stays
// dormant until switchView() runs it.
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#0d0f14',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [
    new PanelGridScene(nodesViewConfig(handleSelection)),
    new PanelGridScene(workspacesViewConfig(handleSelection)),
    new PanelGridScene(autolabViewConfig(handleSelection)),
  ],
})
registerGame(game, 'nodes')
