// The Front Desk's completion panel: the preview, the click, the outcomes.
//
// A Front Desk conversation is rarely one topic — Front opens a workplan,
// autolab plans a Plane Work with a Sub-Work per task and a `work-` channel
// per mission, forge runs an `assetrun-` beside its `assetplan-`. This panel
// is where a human sees all of that named before deciding it is finished,
// and where they see what happened afterwards.
//
// **Nothing here decides anything.** Which targets exist, which may move and
// why is entirely the relay's `close-plan`; this file draws those words and
// sends back the fingerprint of the plan that was actually read. A row that
// is blocked or failed stays on screen with its reason, and the panel
// distinguishes a partial run from a finished one — a screen that shows only
// successes is the same lie as an empty board.
//
// It is a Phaser container rather than DOM, like everything else in the
// scene, and it lays out for a narrow window by taking the whole frame.

import Phaser from 'phaser'
import type { CloseResult, ClosePlan, DeskSource } from './frontDeskState'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif'
const NARROW = 720

const COLOR = {
  ink: '#f7f4ff',
  muted: '#b9bdd6',
  dim: '#7d8199',
  accent: '#70c7ff',
  ready: '#67e8a5',
  warn: '#ffc56d',
  bad: '#ff8aa8',
}

// One glyph per state, so a row reads before it is read.
const MARK: Record<string, string> = {
  ready: '▶', done: '✔', blocked: '⨯', kept: '·',
  applied: '✔', already: '·', failed: '⨯', skipped: '—',
}
const TINT: Record<string, string> = {
  ready: COLOR.ready, done: COLOR.dim, blocked: COLOR.bad, kept: COLOR.muted,
  applied: COLOR.ready, already: COLOR.dim, failed: COLOR.bad, skipped: COLOR.warn,
}
const KIND: Record<string, string> = {
  work: 'Work', topic: 'topic', channel: 'channel', conversation: 'this conversation',
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
    this.phase = 'error' in found
      ? { kind: 'unreadable', text: found.error ?? 'the plan could not be read' }
      : { kind: 'preview', plan: found }
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
    if ('error' in found) {
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
      const working = phase.kind === 'working'
      const finished = phase.kind === 'done'
      this.title.setText(finished && !plan.partial ? 'CLOSED' : 'FINISH THIS CONVERSATION')
      this.summary.setText(this.summaryLine(plan, phase.kind)).setColor(
        plan.refused ? COLOR.warn
          : finished ? (plan.partial ? COLOR.warn : COLOR.ready)
            : plan.counts.blocked ? COLOR.warn : COLOR.muted,
      )
      if (plan.refused && plan.error) line(plan.error, 12, COLOR.warn)
      if (!plan.status.zulip_write) line(plan.status.reason, 12, COLOR.bad)
      if (!plan.status.plane && plan.actions.some((one) => one.kind === 'work')) {
        line('No Plane credential: the Work states below are what the relay could not read.', 11.5, COLOR.warn)
      }

      const results = new Map<string, CloseResult>(plan.results.map((one) => [one.key, one]))
      for (const action of plan.actions) {
        const result = results.get(action.key)
        const state = result ? result.outcome : action.state
        const color = TINT[state] ?? COLOR.muted
        line(`${MARK[state] ?? '·'} ${KIND[action.kind] ?? action.kind} · ${action.label}`,
             12.5, state === 'ready' ? COLOR.ink : color, 0, FONT)
        line(result ? result.note : action.reason, 11, color, 18)
        const unreached = (action.detail?.unreached_children as string[] | undefined) ?? []
        if (unreached.length) {
          line(`sub-works this conversation never reached: ${unreached.join(', ')}`, 10.5, COLOR.warn, 18)
        }
        cursor += 4
      }

      if (plan.excluded.length) {
        cursor += 6
        line('not this conversation’s — left alone', 11, COLOR.accent)
        for (const row of plan.excluded) {
          line(`· #${row.channel} › ${row.topic}`, 11.5, COLOR.muted, 8, FONT)
          line(row.reason, 10.5, COLOR.dim, 20)
        }
      }
      const gaps = [
        ...plan.gaps.unread.map((one) => `${one} could not be read`),
        ...plan.gaps.bounded.map((one) => `${one} was read as a window; older posts are in Zulip`),
        ...plan.gaps.plane,
        ...(plan.gaps.truncated ? ['the walk hit its node cap; there may be more'] : []),
      ]
      if (gaps.length) {
        cursor += 6
        line('what is not known', 11, COLOR.warn)
        for (const gap of gaps) line(`· ${gap}`, 10.5, COLOR.warn, 8)
      }
      cursor += 6
      line(plan.note, 10.5, COLOR.dim)
      if (working) line('closing…', 12, COLOR.accent)
    }

    this.contentHeight = cursor - this.viewport.y
    this.renderButtons()
    this.scrollBy(0)
  }

  private summaryLine(plan: ClosePlan, phase: Phase['kind']): string {
    const counts = plan.counts
    if (phase === 'working') return 'closing…'
    if (phase === 'done') {
      const applied = plan.results.filter((one) => one.outcome === 'applied').length
      const failed = plan.results.filter((one) => one.outcome === 'failed').length
      const skipped = plan.results.filter((one) => one.outcome === 'skipped').length
      if (plan.partial) {
        return `partially closed — ${applied} changed, ${failed} failed, ${skipped} left; the conversation stays open`
      }
      return `closed — ${applied} changed, ${plan.results.length - applied} already were`
    }
    return `${counts.ready} to change · ${counts.done} already · ${counts.blocked} blocked · ${counts.kept} kept`
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
    add('close panel', () => this.close())
    if (this.phase.kind === 'preview' || this.phase.kind === 'done' || this.phase.kind === 'unreadable') {
      add('refresh', () => void this.load())
    }
    if (this.phase.kind === 'preview' && this.phase.plan.counts.ready > 0 && this.phase.plan.status.zulip_write) {
      add(`close ${this.phase.plan.counts.ready} target${this.phase.plan.counts.ready > 1 ? 's' : ''}`,
          () => void this.apply(), COLOR.ready)
    }
    if (this.phase.kind === 'done' && this.phase.plan.partial && this.phase.plan.counts.ready > 0) {
      add('try the rest again', () => void this.apply(), COLOR.warn)
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
