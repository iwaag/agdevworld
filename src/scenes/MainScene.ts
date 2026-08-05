import Phaser from 'phaser'
import { loadExistingNodes, type NodePanelModel } from '../clusterState'

export class MainScene extends Phaser.Scene {
  private title!: Phaser.GameObjects.Text
  private button!: Phaser.GameObjects.Text
  private pushCount = 0
  private nodes: NodePanelModel[] = []

  constructor() {
    super('main')
  }

  create() {
    this.title = this.add
      .text(0, 0, 'agdev', { fontSize: '64px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5)

    this.button = this.add
      .text(0, 0, 'Push', {
        fontSize: '32px',
        color: '#ffffff',
        backgroundColor: '#444444',
        padding: { x: 24, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })

    this.button.on('pointerover', () => this.button.setStyle({ backgroundColor: '#666666' }))
    this.button.on('pointerout', () => this.button.setStyle({ backgroundColor: '#444444' }))
    this.button.on('pointerdown', () => {
      this.pushCount++
      this.button.setText(`Pushed x${this.pushCount}`)
      this.button.setStyle({ backgroundColor: '#e91e63' })
      this.tweens.add({
        targets: this.title,
        scale: { from: 1.3, to: 1 },
        duration: 300,
        ease: 'Back.easeOut',
      })
      this.cameras.main.shake(100, 0.005)
    })

    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    void this.loadClusterSnapshot()
  }

  private async loadClusterSnapshot() {
    try {
      this.nodes = await loadExistingNodes()
      this.title.setText(`agdev · ${this.nodes.length} nodes`)
    } catch (error) {
      console.error(error)
      this.title.setText('agdev · cluster unavailable')
    }
    this.layout(this.scale.width, this.scale.height)
  }

  private layout(width: number, height: number) {
    this.title.setPosition(width / 2, height / 2 - 60)
    this.button.setPosition(width / 2, height / 2 + 60)
  }
}
