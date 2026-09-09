// The Front Desk's completion panel: the preview, the click, the outcomes.
//
// A Front Desk conversation is rarely one topic — Front opens a workplan,
// autolab plans a Plane Work with a Sub-Work per task and a `work-` channel
// per mission, forge runs an `assetrun-` beside its `assetplan-`. This panel
// is where a human sees all of that named before deciding it is finished,
// and where they see what happened afterwards.
//
// **Nothing here decides anything.** Which targets exist, which may move and
// why is entirely the relay's plan; this file draws the lines
// `completionState.planLines` produces — the same lines the DOM overlay of
// the operation room and the agent room draws — and sends back the
// fingerprint of the plan that was actually read. A row that is blocked or
// failed stays on screen with its reason, and the panel distinguishes a
// partial run from a finished one — a screen that shows only successes is
// the same lie as an empty board.
//
// It is a Phaser container rather than DOM, like everything else in the
// scene, and it lays out for a narrow window by taking the whole frame.

import Phaser from 'phaser'
import {
  isCompletionPlan,
  planButtons,
  planLines,
  summaryLine,
  summaryTone,
  titleLine,
  type Tone,
} from './completionState'
import type { ClosePlan, DeskSource } from './frontDeskState'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif'
const NARROW = 720

const COLOR: Record<Tone, string> = {
  ink: '#f7f4ff',
  muted: '#b9bdd6',
  dim: '#7d8199',
  accent: '#70c7ff',
  ready: '#67e8a5',
  warn: '#ffc56d',
  bad: '#ff8aa8',
}

type Phase =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'unreadable'; text: string }
  | { kind: 'preview'; plan: ClosePlan }
  | { kind: 'working'; plan: ClosePlan }
  | { kind: 'done'; plan: ClosePlan }

export interface ClosePanelOptions {
  scene: Phaser.Scene
  source: DeskSource
  // The conversation the panel is for, asked at every step: a request that
  // comes back after the user switched conversations is dropped, never drawn.
  conversationId: () => string
  // Called after anything moved, so the frame re-reads the conversation and
  // the board (a closed conversation is ✔ and the chip list says so).
  onChanged: () => void
}

export class FrontDeskClosePanel {
  private readonly scene: Phaser.Scene
  private readonly source: DeskSource
  private readonly conversationId: () => string
  private readonly onChanged: () => void

  private phase: Phase = { kind: 'closed' }
  private container: Phaser.GameObjects.Container
  private backdrop: Phaser.GameObjects.Graphics
  private list: Phaser.GameObjects.Container
  private nodes: Phaser.GameObjects.Text[] = []
  private buttons: Phaser.GameObjects.Text[] = []
  private title!: Phaser.GameObjects.Text
  private summary!: Phaser.GameObjects.Text
  private scroll = 0
  private contentHeight = 0
  private viewport = { x: 0, y: 0, width: 0, height: 0 }
  private rect = { x: 0, y: 0, width: 0, height: 0 }
  private inFlight = 0

  constructor(options: ClosePanelOptions) {
    this.scene = options.scene
    this.source = options.source
    this.conversationId = options.conversationId
    this.onChanged = options.onChanged
    this.container = this.scene.add.container(0, 0).setVisible(false).setDepth(50)
    this.backdrop = this.scene.add.graphics()
    this.title = this.text(0, 0, 'FINISH THIS CONVERSATION', MONO, 11, COLOR.accent).setLetterSpacing(2)
    this.summary = this.text(0, 0, '', MONO, 11, COLOR.muted)
    this.list = this.scene.add.container(0, 0)
    this.container.add([this.backdrop, this.title, this.summary, this.list])
  }

  get open(): boolean {
    return this.phase.kind !== 'closed'
  }

  // The panel is modal for the wheel: a scroll inside it scrolls it.
  contains(pointer: Phaser.Input.Pointer): boolean {
    return this.open && pointer.x >= this.rect.x && pointer.x <= this.rect.x + this.rect.width
      && pointer.y >= this.rect.y && pointer.y <= this.rect.y + this.rect.height
  }

  toggle() {
    if (this.open) this.close()
    else void this.load()
  }

  close() {
    this.phase = { kind: 'closed' }
    this.container.setVisible(false)
  }

  destroy() {
    this.container.destroy(true)
  }

  // Dropped when the conversation changed under it: a plan is one
  // conversation's, and drawing another's would be the worst kind of lie
  // this screen could tell.
  private async load(): Promise<void> {
    const id = this.conversationId()
    this.phase = { kind: 'loading' }
    this.render()
    this.inFlight += 1
    const found = await this.source.closePlan(id)
    this.inFlight -= 1
    if (id !== this.conversationId()) return
    this.phase = isCompletionPlan(found)
      ? { kind: 'preview', plan: found }
      : { kind: 'unreadable', text: found.error ?? 'the plan could not be read' }
    this.render()
  }

  private async apply(): Promise<void> {
    const current = this.phase
    if (current.kind !== 'preview' && current.kind !== 'done') return
    const id = this.conversationId()
    const plan = current.plan
    this.phase = { kind: 'working', plan }
    this.render()
    this.inFlight += 1
    const found = await this.source.close(id, plan.fingerprint)
    this.inFlight -= 1
    if (id !== this.conversationId()) return
    if (!isCompletionPlan(found)) {
      this.phase = { kind: 'unreadable', text: found.error ?? 'the relay did not answer' }
      this.render()
      this.onChanged()
      return
    }
    // A refusal is a preview again — the targets changed and nothing moved,
    // so what the human sees next is the plan to approve, not a result.
    this.phase = found.refused ? { kind: 'preview', plan: found } : { kind: 'done', plan: found }
    this.scroll = 0
    this.render()
    this.onChanged()
  }

  // --- layout ------------------------------------------------------------------

  layout(width: number, barTop: number) {
    const narrow = width < NARROW
    const margin = 16
    const panelWidth = narrow ? width - 2 * margin : Math.min(620, Math.max(360, width * 0.52))
    const panelX = narrow ? margin : width - margin - panelWidth
    const panelY = narrow ? 100 : 80
    const panelHeight = Math.max(160, barTop - 8 - panelY)
    this.rect = { x: panelX, y: panelY, width: panelWidth, height: panelHeight }
    this.backdrop.clear()
    this.backdrop.fillStyle(0x0d0f14, 0.96)
    this.backdrop.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 12)
    this.backdrop.lineStyle(1, 0x3a4060, 1)
    this.backdrop.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 12)
    this.title.setPosition(panelX + 14, panelY + 10)
    this.summary.setPosition(panelX + 14, panelY + 28)
    this.viewport = {
      x: panelX + 8, y: panelY + 48,
      width: panelWidth - 16, height: panelHeight - 48 - 46,
    }
    this.render()
  }

  scrollBy(delta: number) {
    const overflow = Math.max(0, this.contentHeight - this.viewport.height)
    this.scroll = Math.max(0, Math.min(overflow, this.scroll + delta))
    this.list.setY(-this.scroll)
    this.clip()
  }

  // --- rendering ---------------------------------------------------------------

  private render() {
    const phase = this.phase
    this.container.setVisible(phase.kind !== 'closed')
    if (phase.kind === 'closed') return
    for (const node of this.nodes) node.destroy()
    for (const button of this.buttons) button.destroy()
    this.nodes = []
    this.buttons = []
    const width = this.viewport.width - 16
    let cursor = this.viewport.y

    const line = (text: string, size: number, color: string, indent = 0, font = MONO) => {
      const node = this.text(this.viewport.x + 8 + indent, cursor, text, font, size, color)
      node.setWordWrapWidth(width - indent, true)
      this.nodes.push(node)
      this.list.add(node)
      cursor += node.height + 3
      return node
    }

    if (phase.kind === 'loading') {
      this.title.setText('FINISH THIS CONVERSATION')
      this.summary.setText('reading the realm and Plane…').setColor(COLOR.dim)
      line('Nothing is changed by asking. This reads Zulip and Plane and writes to neither.', 11.5, COLOR.dim)
    } else if (phase.kind === 'unreadable') {
      this.summary.setText('the plan could not be read').setColor(COLOR.warn)
      line(phase.text, 12, COLOR.warn)
      line('Nothing was changed by this attempt unless a result below says so.', 11.5, COLOR.dim)
    } else {
      const plan = phase.plan
      this.title.setText(titleLine(plan, phase.kind))
      this.summary.setText(summaryLine(plan, phase.kind)).setColor(COLOR[summaryTone(plan, phase.kind)])
      // The same lines the DOM overlay draws (`completionState.planLines`):
      // a body line at the margin starts a new row, so the rows breathe.
      let previousBody = false
      for (const entry of planLines(plan, phase.kind)) {
        if (entry.size === 'body' && entry.indent === 0 && previousBody) cursor += 4
        line(entry.text, entry.size === 'body' ? 12.5 : entry.indent >= 18 ? 11 : 10.5,
             COLOR[entry.tone], entry.indent, entry.size === 'body' ? FONT : MONO)
        previousBody = previousBody || entry.size === 'body'
      }
    }

    this.contentHeight = cursor - this.viewport.y
    this.renderButtons()
    this.scrollBy(0)
  }

  private renderButtons() {
    const bottom = this.rect.y + this.rect.height - 12
    let x = this.rect.x + this.rect.width - 14
    const add = (label: string, onClick: () => void, color = COLOR.muted) => {
      const button = this.text(0, 0, label, MONO, 12, color)
        .setBackgroundColor('#1b2030').setPadding(10, 5, 10, 5)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', onClick)
        .setOrigin(1, 1)
      button.setPosition(x, bottom)
      x -= button.width + 8
      this.buttons.push(button)
      this.container.add(button)
    }
    const plan = 'plan' in this.phase ? this.phase.plan : undefined
    const phase = this.phase.kind === 'closed' ? 'loading' : this.phase.kind
    for (const button of planButtons(plan, phase)) {
      add(button.label, () => {
        if (button.id === 'close') this.close()
        else if (button.id === 'refresh') void this.load()
        else void this.apply()
      }, COLOR[button.tone])
    }
  }

  private clip() {
    const top = this.viewport.y
    const bottom = top + this.viewport.height
    for (const node of this.nodes) {
      const y0 = node.y - this.scroll
      const y1 = y0 + node.height
      if (y1 <= top || y0 >= bottom) { node.setVisible(false); continue }
      node.setVisible(true)
      const cropTop = Math.max(0, top - y0)
      const cropBottom = Math.max(0, y1 - bottom)
      if (cropTop > 0 || cropBottom > 0) node.setCrop(0, cropTop, node.width, node.height - cropTop - cropBottom)
      else node.setCrop()
    }
  }

  private text(x: number, y: number, content: string, fontFamily: string, size: number, color: string) {
    return this.scene.add.text(x, y, content, { fontFamily, fontSize: `${size}px`, color })
  }
}
