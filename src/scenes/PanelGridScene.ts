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

    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    void this.loadSnapshot()
  }

  private async loadSnapshot() {
    try {
      const rows = await this.config.loadRows()
      this.createPanels(rows)
      this.subtitle.setText(this.config.subtitle(rows.length))
    } catch (error) {
      console.error(error)
      this.subtitle.setText(this.config.unavailableText)
      this.footer.setText(error instanceof Error ? error.message : 'unknown snapshot error')
    }
    this.layout(this.scale.width, this.scale.height)
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
    })

    const floatLayer = this.add.container(0, 0, [shadow, chrome, nameText, statusText])
    floatLayer.angle = index % 2 === 0 ? -0.7 : 0.7
    const anchor = this.add.container(0, 0, [floatLayer])

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

    if (this.panels.length === 0) return

    const usableWidth = Math.max(1, width - 40)
    const usableHeight = Math.max(1, height - 190)
    const maxColumns = Math.max(1, Math.floor((usableWidth + COLUMN_GAP) / (PANEL_WIDTH + COLUMN_GAP)))
    const columns = Math.min(this.panels.length, maxColumns, 4)
    const rows = Math.ceil(this.panels.length / columns)
    const gridWidth = columns * PANEL_WIDTH + (columns - 1) * COLUMN_GAP
    const gridHeight = rows * PANEL_HEIGHT + (rows - 1) * ROW_GAP
    const scale = Math.min(1, usableWidth / gridWidth, usableHeight / gridHeight)
    const scaledCellWidth = (PANEL_WIDTH + COLUMN_GAP) * scale
    const scaledCellHeight = (PANEL_HEIGHT + ROW_GAP) * scale
    const scaledGridHeight = gridHeight * scale
    const startY = 150 + Math.max(0, (usableHeight - scaledGridHeight) / 2) + (PANEL_HEIGHT * scale) / 2

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
