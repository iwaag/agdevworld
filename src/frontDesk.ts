// `/?view=frontdesk` — the Front Desk scene on its own Phaser game.
//
// It is not one of the seven `PanelGridScene` views: there is no grid, no
// chat panel overlay and no ⇄ cycle, and the frame is the whole window. So it
// gets its own game rather than a slot in `worldViews.ts`, which keeps the
// world views' wiring exactly as it was.

import Phaser from 'phaser'
import { FrontDeskScene } from './scenes/FrontDeskScene'
import { demoSource, ID_PATTERN, newConversationId, relaySource } from './frontDeskState'

const params = new URLSearchParams(location.search)
const requested = params.get('conv') ?? ''
const conversationId = ID_PATTERN.test(requested) ? requested : newConversationId()
if (conversationId !== requested) {
  const url = new URL(location.href)
  url.searchParams.set('conv', conversationId)
  history.replaceState(null, '', url)
}

// The chat panel overlay of the world views is not here, so the frame takes
// the whole window back.
const app = document.getElementById('app')
if (app) app.style.inset = '0'

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#0d0f14',
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [new FrontDeskScene({
    source: params.get('demo') === '1' ? demoSource() : relaySource,
    conversationId,
  })],
})
