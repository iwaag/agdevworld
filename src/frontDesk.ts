// `/?view=frontdesk` and `/?view=argue` — the two rooms, on one scene and
// their own Phaser game.
//
// A room is not one of the `PanelGridScene` views: there is no grid, no chat
// panel overlay and no ⇄ cycle, and the frame is the whole window. So it
// gets its own game rather than a slot in `worldViews.ts`, which keeps the
// world views' wiring exactly as it was. Which room it is, is the adapter
// (`roomState.ts`); the scene is the same.

import Phaser from 'phaser'
import { FrontDeskScene } from './scenes/FrontDeskScene'
import { demoAdapter } from './roomDemo'
import { ANCHOR_PATTERN, argueAdapter, DESK_ID_PATTERN, deskAdapter, newConversationId } from './roomState'

const params = new URLSearchParams(location.search)
const argue = params.get('view') === 'argue'
const demo = params.get('demo') === '1'
// `&demorev=<sha>` makes the demo's interpretations claim that settings revision.
const adapter = demo ? demoAdapter(argue ? 'argue' : 'front', params.get('demorev') ?? 'demo') : argue ? argueAdapter : deskAdapter

const requested = params.get(adapter.param) ?? ''
let key: string | null
if (argue) {
  // An argue is named by its anchor; none named is the room's list and a
  // blank composer for a new one.
  key = demo ? null : ANCHOR_PATTERN.test(requested) ? requested : null
} else {
  key = DESK_ID_PATTERN.test(requested) ? requested : demo ? 'demo' : newConversationId()
}
if ((key ?? '') !== requested) {
  const url = new URL(location.href)
  if (key === null) url.searchParams.delete(adapter.param)
  else url.searchParams.set(adapter.param, key)
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
  scene: [new FrontDeskScene({ adapter, conversationKey: key })],
})
