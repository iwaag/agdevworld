import Phaser from 'phaser'
import { switchView } from '../viewSwitcher'

const PANEL_WIDTH = 252
const PANEL_HEIGHT = 84
const COLUMN_GAP = 34
const ROW_GAP = 34

export interface PanelRowStatus {
  emoji: string
  color: number
  label: string
}

export interface PanelRow {
  id: string
  name: string
  status: PanelRowStatus
  detail?: string
  // Opaque source record (drift target, workspace row, …) carried through so
  // selection handlers get the full data, not the flattened display fields.
  payload?: unknown
}

// A small clickable label under the subtitle: the autolab view's node picker
// and its refresh affordance. Views that do not need one simply omit `chips`.
export interface PanelChip {
  id: string
  label: string
  active?: boolean
  onClick: () => void
}

export interface PanelGridApi {
  reload: () => void
}

export interface PanelGridConfig {
  key: string
  title: string
  loadingText: string
  unavailableText: string
  subtitle: (count: number) => string
  footer: string
  switchTo?: { key: string; label: string }
  loadRows: () => Promise<PanelRow[]>
  onSelect?: (row: PanelRow) => void
  // Read after every load, so a view that fetches extra context in loadRows()
  // (the autolab mediator headline) can show it without changing loadRows.
  headline?: () => string | undefined
  chips?: () => PanelChip[]
  // Handed the scene's reload seam on create, so a chip click or an assistant
  // action can re-fetch without reaching into Phaser.
  bind?: (api: PanelGridApi) => void
}

interface PanelView {
  anchor: Phaser.GameObjects.Container
  floatLayer: Phaser.GameObjects.Container
}

export class PanelGridScene extends Phaser.Scene {
  private readonly config: PanelGridConfig
  private backdrop!: Phaser.GameObjects.Rectangle
  private hazeLeft!: Phaser.GameObjects.Arc
  private hazeRight!: Phaser.GameObjects.Arc
  private title!: Phaser.GameObjects.Text
  private subtitle!: Phaser.GameObjects.Text
  private footer!: Phaser.GameObjects.Text
  private switchLabel?: Phaser.GameObjects.Text
  private headline?: Phaser.GameObjects.Text
  private chips: Phaser.GameObjects.Text[] = []
  private panels: PanelView[] = []

  constructor(config: PanelGridConfig) {
    super(config.key)
    this.config = config
  }

  create() {
    this.backdrop = this.add.rectangle(0, 0, 1, 1, 0x080b14).setOrigin(0)
    this.hazeLeft = this.add.circle(0, 0, 230, 0x173f5f, 0.22)
    this.hazeRight = this.add.circle(0, 0, 300, 0x42275f, 0.18)

    this.title = this.add
      .text(0, 0, this.config.title, {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '13px',
        color: '#70c7ff',
        letterSpacing: 3,
      })
      .setOrigin(0.5)

    this.subtitle = this.add
      .text(0, 0, this.config.loadingText, {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '25px',
        color: '#f4f1ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)

    this.headline = this.add
      .text(0, 0, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: '#9a9db5',
      })
      .setOrigin(0.5)

    this.footer = this.add
      .text(0, 0, this.config.footer, {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: '#777a91',
        letterSpacing: 1,
      })
      .setOrigin(0.5)

    if (this.config.switchTo) {
      const target = this.config.switchTo
      this.switchLabel = this.add
        .text(0, 0, `⇄ ${target.label}`, {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          color: '#70c7ff',
          letterSpacing: 2,
        })
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => switchView(target.key))
      // Keyboard fallback for testing; ignored while typing in the chat panel.
      this.input.keyboard?.on('keydown-V', () => {
        const active = document.activeElement
        if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return
        switchView(target.key)
      })
    }

    this.config.bind?.({ reload: () => void this.loadSnapshot() })
    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    void this.loadSnapshot()
  }

  private async loadSnapshot() {
    this.subtitle.setText(this.config.loadingText)
    this.createPanels([])
    this.createChips()
    this.layout(this.scale.width, this.scale.height)
    try {
      const rows = await this.config.loadRows()
      this.createPanels(rows)
      this.subtitle.setText(this.config.subtitle(rows.length))
      this.footer.setText(this.config.footer)
    } catch (error) {
      console.error(error)
      this.subtitle.setText(this.config.unavailableText)
      this.footer.setText(error instanceof Error ? error.message : 'unknown snapshot error')
    }
    // Chips and headline are rebuilt after the load either way: a failed fetch
    // still has to leave the node picker usable, or the view is a dead end.
    this.createChips()
    this.headline?.setText(this.config.headline?.() ?? '')
    this.layout(this.scale.width, this.scale.height)
  }

  private createChips() {
    for (const chip of this.chips) chip.destroy()
    this.chips = (this.config.chips?.() ?? []).map((chip) =>
      this.add
        .text(0, 0, chip.label, {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          color: chip.active ? '#0d0f14' : '#c3c7de',
          backgroundColor: chip.active ? '#70c7ff' : '#1b2030',
          padding: { x: 9, y: 4 },
          letterSpacing: 1,
        })
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', chip.onClick),
    )
  }

  private createPanels(rows: PanelRow[]) {
    for (const panel of this.panels) panel.anchor.destroy(true)
    this.panels = rows.map((row, index) => this.createPanel(row, index))
  }

  private createPanel(row: PanelRow, index: number): PanelView {
    const style = row.status
    const shadow = this.add.graphics()
    shadow.fillStyle(0x000000, 0.28)
    shadow.fillRoundedRect(-PANEL_WIDTH / 2 + 5, -PANEL_HEIGHT / 2 + 7, PANEL_WIDTH, PANEL_HEIGHT, 22)

    const chrome = this.add.graphics()
    chrome.fillStyle(0x151927, 0.96)
    chrome.fillRoundedRect(-PANEL_WIDTH / 2, -PANEL_HEIGHT / 2, PANEL_WIDTH, PANEL_HEIGHT, 22)
    chrome.lineStyle(1, style.color, 0.58)
    chrome.strokeRoundedRect(-PANEL_WIDTH / 2, -PANEL_HEIGHT / 2, PANEL_WIDTH, PANEL_HEIGHT, 22)
    chrome.fillStyle(style.color, 0.85)
    chrome.fillCircle(-PANEL_WIDTH / 2 + 20, 0, 3)

    const nameText = this.add.text(-PANEL_WIDTH / 2 + 35, -23, `${style.emoji}  ${row.name}`, {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '19px',
      color: '#f7f5ff',
      fontStyle: 'bold',
      fixedWidth: PANEL_WIDTH - 50,
    })

    const statusLine = row.detail ? `${style.label} · ${row.detail}` : style.label
    const statusText = this.add.text(-PANEL_WIDTH / 2 + 67, 10, statusLine, {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '10px',
      color: `#${style.color.toString(16).padStart(6, '0')}`,
      letterSpacing: 2,
      // autolab's status line (status · iteration · gates · cost) is longer
      // than a cluster status word and used to run off the panel edge.
      wordWrap: { width: PANEL_WIDTH - 82 },
    })

    const floatLayer = this.add.container(0, 0, [shadow, chrome, nameText, statusText])
    floatLayer.angle = index % 2 === 0 ? -0.7 : 0.7
    const anchor = this.add.container(0, 0, [floatLayer])

    // The hit area lives on the static anchor, not the tweened floatLayer, so
    // clicks land even while the panel floats.
    anchor
      .setInteractive({
        hitArea: new Phaser.Geom.Rectangle(-PANEL_WIDTH / 2, -PANEL_HEIGHT / 2, PANEL_WIDTH, PANEL_HEIGHT),
        hitAreaCallback: Phaser.Geom.Rectangle.Contains,
        useHandCursor: true,
      })
      .on('pointerup', () => this.config.onSelect?.(row))

    this.tweens.add({
      targets: floatLayer,
      y: 8,
      duration: 1800 + index * 120,
      delay: index * 250,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
    this.tweens.add({
      targets: floatLayer,
      angle: index % 2 === 0 ? 0.8 : -0.8,
      duration: 2600 + index * 140,
      delay: index * 170,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })

    return { anchor, floatLayer }
  }

  private layout(width: number, height: number) {
    this.backdrop?.setSize(width, height)
    this.hazeLeft?.setPosition(width * 0.12, height * 0.78).setScale(Math.max(0.65, width / 1200))
    this.hazeRight?.setPosition(width * 0.9, height * 0.15).setScale(Math.max(0.65, width / 1200))
    this.title?.setPosition(width / 2, Math.max(36, height * 0.07))
    this.subtitle?.setPosition(width / 2, Math.max(76, height * 0.13))
    this.footer?.setPosition(width / 2, height - 28)
    this.switchLabel?.setPosition(20, Math.max(36, height * 0.07))

    const headlineY = Math.max(104, height * 0.185)
    this.headline?.setPosition(width / 2, headlineY)
    // Chips sit on one centered row below the headline; they push the grid
    // down by exactly the space they occupy so the two never overlap.
    let chipTop = 0
    if (this.chips.length > 0) {
      const gap = 8
      const total = this.chips.reduce((sum, chip) => sum + chip.width + gap, -gap)
      let x = (width - total) / 2
      const y = headlineY + 24
      for (const chip of this.chips) {
        chip.setPosition(x, y)
        x += chip.width + gap
      }
      chipTop = 34
    }

    if (this.panels.length === 0) return

    const usableWidth = Math.max(1, width - 40)
    const usableHeight = Math.max(1, height - 190 - chipTop)
    const maxColumns = Math.max(1, Math.floor((usableWidth + COLUMN_GAP) / (PANEL_WIDTH + COLUMN_GAP)))
    const columns = Math.min(this.panels.length, maxColumns, 4)
    const rows = Math.ceil(this.panels.length / columns)
    const gridWidth = columns * PANEL_WIDTH + (columns - 1) * COLUMN_GAP
    const gridHeight = rows * PANEL_HEIGHT + (rows - 1) * ROW_GAP
    const scale = Math.min(1, usableWidth / gridWidth, usableHeight / gridHeight)
    const scaledCellWidth = (PANEL_WIDTH + COLUMN_GAP) * scale
    const scaledCellHeight = (PANEL_HEIGHT + ROW_GAP) * scale
    const scaledGridHeight = gridHeight * scale
    const startY =
      150 + chipTop + Math.max(0, (usableHeight - scaledGridHeight) / 2) + (PANEL_HEIGHT * scale) / 2

    this.panels.forEach(({ anchor, floatLayer }, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      const itemsInRow = Math.min(columns, this.panels.length - row * columns)
      const rowWidth = (itemsInRow * PANEL_WIDTH + (itemsInRow - 1) * COLUMN_GAP) * scale
      const rowStartX = (width - rowWidth) / 2 + (PANEL_WIDTH * scale) / 2
      anchor.setPosition(rowStartX + column * scaledCellWidth, startY + row * scaledCellHeight)
      anchor.setScale(scale)
      // The anchor owns layout; only the inner layer moves, so resize never
      // bakes the tween's transient y value into the new grid position.
      floatLayer.setVisible(true)
    })
  }
}
