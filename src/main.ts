import Phaser from 'phaser'
import { PanelGridScene } from './scenes/PanelGridScene'
import { autolabViewConfig, nodesViewConfig, workspacesViewConfig, type PanelSelection } from './views'
import { VIEW_KEYS, currentView, registerGame, switchView } from './viewSwitcher'
import { initChatPanel } from './chatPanel'
import { setAskHandler, showDetailPopup } from './detailPopup'
import { loadActualDevices, matchDeviceForTarget, type ActualDeviceModel } from './clusterState'

// Devices from the optional nctl.actual.v2 detail snapshot; empty until (and
// unless) that snapshot loads. Node selections are enriched opportunistically
// so the popup can show hardware — this is rendering, not context for the
// assistant, which reads the snapshots itself.
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

const chat = initChatPanel(
  // The one thing the assistant cannot look up: what is currently on screen.
  () => `The screen is showing the ${currentView()} view.`,
  (call) => {
    if (call.name === 'switch_view') {
      const view = String(call.arguments.view ?? '')
      return switchView(view)
        ? `the screen is showing the ${view} view`
        : `there is no view named "${view}"; the views are ${VIEW_KEYS.join(', ')}` +
            (view === currentView() ? ` (the ${view} view was already showing)` : '')
    }
    return `there is no tool named "${call.name}"`
  },
)

// Clicking "ask the agent" says what was clicked, and nothing more. What is
// worth looking up about it is the assistant's call.
setAskHandler((selection) => {
  if (selection.view === 'autolab-project') {
    chat.ask(`Tell me about the autolab project ${selection.project.name} on node ${selection.node}.`)
    return
  }
  if (selection.view === 'autolab') {
    if (selection.summary) {
      // The exception to "identity only": this text is already prose, written
      // by a Claude run on the node, and the popup shows it unabridged. Passing
      // along what is on screen is not a digest.
      chat.ask(
        `About iteration ${selection.summary.iter} of the autolab job ${selection.job.name} on node ` +
          `${selection.node}. The node's own summary of it reads:\n\n${selection.summary.text}`,
      )
      return
    }
    chat.ask(`Tell me about the autolab job ${selection.job.name} on node ${selection.node}.`)
    return
  }
  if (selection.view === 'nodes') {
    const target = selection.target.target
    const name = target.slug ?? target.name ?? target.id ?? 'the selected node'
    chat.ask(`Tell me about the node ${name}.`)
    return
  }
  chat.ask(`Tell me about the workspace ${selection.row.name}.`)
})

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
