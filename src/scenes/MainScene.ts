import Phaser from 'phaser'
import { loadExistingNodes, type ClusterStatus, type NodePanelModel } from '../clusterState'

const PANEL_WIDTH = 252
const PANEL_HEIGHT = 84
const COLUMN_GAP = 34
const ROW_GAP = 34

const STATUS_STYLE: Record<ClusterStatus, { emoji: string; color: number; label: string }> = {
  converged: { emoji: '✅', color: 0x67e8a5, label: 'CONVERGED' },
  converging: { emoji: '🔄', color: 0x70c7ff, label: 'CONVERGING' },
  drifting: { emoji: '⚠️', color: 0xffc56d, label: 'DRIFTING' },
  unknown: { emoji: '❓', color: 0xb7b5d8, label: 'UNKNOWN' },
}

interface PanelView {
  anchor: Phaser.GameObjects.Container
  floatLayer: Phaser.GameObjects.Container
}

export class MainScene extends Phaser.Scene {
  private backdrop!: Phaser.GameObjects.Rectangle
  private hazeLeft!: Phaser.GameObjects.Arc
  private hazeRight!: Phaser.GameObjects.Arc
  private title!: Phaser.GameObjects.Text
  private subtitle!: Phaser.GameObjects.Text
  private footer!: Phaser.GameObjects.Text
  private panels: PanelView[] = []

  constructor() {
    super('main')
  }

  create() {
    this.backdrop = this.add.rectangle(0, 0, 1, 1, 0x080b14).setOrigin(0)
    this.hazeLeft = this.add.circle(0, 0, 230, 0x173f5f, 0.22)
    this.hazeRight = this.add.circle(0, 0, 300, 0x42275f, 0.18)

    this.title = this.add
      .text(0, 0, 'cluster / now', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '13px',
        color: '#70c7ff',
        letterSpacing: 3,
      })
      .setOrigin(0.5)

    this.subtitle = this.add
      .text(0, 0, 'listening for a cluster snapshot…', {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '25px',
        color: '#f4f1ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)

    this.footer = this.add
      .text(0, 0, 'desired nodes with confirmed actual state', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: '#777a91',
        letterSpacing: 1,
      })
      .setOrigin(0.5)

    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    void this.loadClusterSnapshot()
  }

  private async loadClusterSnapshot() {
    try {
      const nodes = await loadExistingNodes()
      this.createPanels(nodes)
      this.subtitle.setText(`${nodes.length} nodes are present`)
    } catch (error) {
      console.error(error)
      this.subtitle.setText('cluster snapshot unavailable')
      this.footer.setText(error instanceof Error ? error.message : 'unknown snapshot error')
    }
    this.layout(this.scale.width, this.scale.height)
  }

  private createPanels(nodes: NodePanelModel[]) {
    for (const panel of this.panels) panel.anchor.destroy(true)
    this.panels = nodes.map((node, index) => this.createPanel(node, index))
  }

  private createPanel(node: NodePanelModel, index: number): PanelView {
    const style = STATUS_STYLE[node.status]
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

    const nodeText = this.add.text(-PANEL_WIDTH / 2 + 35, -23, `${style.emoji}  ${node.name}`, {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '19px',
      color: '#f7f5ff',
      fontStyle: 'bold',
      fixedWidth: PANEL_WIDTH - 50,
    })

    const statusText = this.add.text(-PANEL_WIDTH / 2 + 67, 10, style.label, {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '10px',
      color: `#${style.color.toString(16).padStart(6, '0')}`,
      letterSpacing: 2,
    })

    const floatLayer = this.add.container(0, 0, [shadow, chrome, nodeText, statusText])
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
