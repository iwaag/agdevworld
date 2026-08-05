import Phaser from 'phaser'
import { PanelGridScene } from './scenes/PanelGridScene'
import { nodesViewConfig, workspacesViewConfig } from './views'
import { currentView, registerGame, switchView } from './viewSwitcher'
import { initChatPanel } from './chatPanel'
import { loadDriftEnvelope, summarizeClusterContext } from './clusterState'

let clusterContext = ''
initChatPanel(
  () => [`Currently visible view: ${currentView()}`, clusterContext].filter(Boolean).join('\n\n'),
  (action) => {
    // Unknown actions are ignored silently; the protocol may grow.
    if (action.action === 'switch_view' && typeof action.view === 'string') switchView(action.view)
  },
)
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
  scene: [new PanelGridScene(nodesViewConfig), new PanelGridScene(workspacesViewConfig)],
})
registerGame(game, 'nodes')
