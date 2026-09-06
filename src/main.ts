import Phaser from 'phaser'
import { PanelGridScene } from './scenes/PanelGridScene'
import {
  agentRoomViewConfig,
  autolabViewConfig,
  nodesViewConfig,
  opsViewConfig,
  routinesViewConfig,
  tasksViewConfig,
  workspacesViewConfig,
  type PanelSelection,
} from './views'
import { registerGame } from './viewSwitcher'
import { initChatPanel } from './chatPanel'
import { setAskHandler, showDetailPopup } from './detailPopup'
import { loadActualDevices, matchDeviceForTarget, type ActualDeviceModel } from './clusterState'

// Devices from the optional nctl.actual.v2 detail snapshot; empty until (and
// unless) that snapshot loads. Node selections are enriched opportunistically
// so the popup can show hardware.
let actualDevices: ActualDeviceModel[] = []
loadActualDevices()
  .then((devices) => {
    actualDevices = devices
  })
  .catch((error) => console.warn('actual detail snapshot unavailable:', error))

// The chat panel is one Zulip topic and nothing else since `operation_room` p3.
// There is no assistant to route tool calls to — the entrance is Front, in the
// realm — so selecting a routine is the only thing that fills it.
const chat = initChatPanel()

function handleSelection(selection: PanelSelection) {
  if (selection.view === 'nodes' && selection.device === undefined) {
    selection.device = matchDeviceForTarget(actualDevices, selection.target.target)
  }
  if (selection.view === 'routine') chat.select(selection.routine.name)
  showDetailPopup(selection)
}

// "Ask Front" **composes**, it does not send: a post into a routine topic
// starts a paid Front run, and a run is bought by a human pressing Send, never
// by a click that happened to land on a card. Only the routine view offers it,
// because Front's entrance is the only one this application can reach.
setAskHandler((selection) => {
  if (selection.view !== 'routine') return
  const routine = selection.routine
  const owed = selection.detail?.sessions?.[0]?.nodes ?? []
  const where = owed.length > 0
    ? `\n\nThe last run touched: ${owed.map((node) => `${node.channel}/${node.topic}`).join(', ')}.`
    : ''
  chat.compose(
    `About the \`${routine.name}\` routine: its last fire was ` +
      `${routine.answer.state === 'answered' ? 'answered' : routine.answer.state}.${where}`,
  )
})

// Phaser auto-starts only the first scene in the list; the rest stay dormant
// until switchView() runs them.
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
    new PanelGridScene(tasksViewConfig()),
    new PanelGridScene(agentRoomViewConfig(handleSelection)),
    new PanelGridScene(opsViewConfig(handleSelection)),
    new PanelGridScene(routinesViewConfig(handleSelection)),
  ],
})
registerGame(game, 'nodes')
