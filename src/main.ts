import Phaser from 'phaser'
import { MainScene } from './scenes/MainScene'
import { initChatPanel } from './chatPanel'
import { loadDriftEnvelope, summarizeClusterContext } from './clusterState'

let clusterContext = ''
initChatPanel(() => clusterContext)
loadDriftEnvelope()
  .then((envelope) => {
    clusterContext = summarizeClusterContext(envelope)
  })
  .catch((error) => console.error('cluster context unavailable for assistant:', error))

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#0d0f14',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [MainScene],
})
