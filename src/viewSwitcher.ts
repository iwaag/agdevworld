// Single seam for changing the visible view. Keyboard shortcuts, clickable
// labels, and AI-driven actions must all go through switchView() so behavior
// stays identical regardless of who initiates the switch.

import type Phaser from 'phaser'

// Four views, cycled in this order by the ⇄ label and the V key: each view's
// `switchTo` names the next one, so the nav stays a one-control cycle instead
// of growing a menu.
export const VIEW_KEYS = ['nodes', 'workspaces', 'autolab', 'tasks'] as const
export type ViewKey = (typeof VIEW_KEYS)[number]

let game: Phaser.Game | undefined
let current: ViewKey

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === 'string' && (VIEW_KEYS as readonly string[]).includes(value)
}

export function registerGame(instance: Phaser.Game, initialView: ViewKey): void {
  game = instance
  current = initialView
}

export function currentView(): ViewKey {
  return current
}

// Sleeps the outgoing scene and runs/wakes the target, preserving each
// scene's state (panels, fetched snapshots) across round trips.
export function switchView(key: string): boolean {
  if (!game || !isViewKey(key) || key === current) return false
  game.scene.sleep(current)
  game.scene.run(key)
  current = key
  return true
}
