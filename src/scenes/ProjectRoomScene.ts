// The Project Room's stage: a room background, softened, and the portrait of
// whoever answers in the selected conversation.
//
// `project_room` p1 step 3. Unlike the Front Desk this room is mostly
// *board*: lists, a hierarchy, a long document, a history — text that has to
// scroll, wrap, be selected and be typed into. Those are DOM panels
// (`projectRoom.ts`) laid over this scene; what the scene draws is the part a
// canvas is for: the settings' room background scaled to cover the window,
// a shared tint over it so the panels and the portrait stay legible (a
// background at full strength competes with the board — the braindump's own
// observation, and step 4 tunes the value), and the portrait of the
// responsible agent — autolab's character for a plan or a run, Front's for a
// document, the common icon for a speaker the settings do not know.
//
// Nothing here decides who answers; the relay's `destination.responsible`
// says, and the controller hands this scene a character.

import Phaser from 'phaser'
import { FrontDeskSettings } from '../frontDeskSettings'
import { assetUrl, type SettingsCharacter } from '../settingsState'
import { ROOM_TINT_ALPHA, ROOM_TINT_COLOR } from './roomTint'

const FALLBACK_BG = 'projectroom-fallback-bg'
const FALLBACK_FACE = 'projectroom-fallback-face'
const UNKNOWN_FACE = 'projectroom-unknown-face'
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
// The room's own background, by the settings' room id; the Front Desk's when
// a revision predates the room (`FrontDeskSettings.background` falls back).
export const ROOM_ID = 'project'
// How much of the background the tint takes away: the shared value every
// image-backed room uses (`roomTint.ts`).
export const TINT_COLOR = ROOM_TINT_COLOR
export const TINT_ALPHA = ROOM_TINT_ALPHA

export interface Speaker {
  character: SettingsCharacter | null
  label: string
  sub: string
}

export class ProjectRoomScene extends Phaser.Scene {
  readonly settings: FrontDeskSettings
  private bg!: Phaser.GameObjects.Image
  private tint!: Phaser.GameObjects.Rectangle
  private portrait!: Phaser.GameObjects.Image
  private nameplate!: Phaser.GameObjects.Graphics
  private name!: Phaser.GameObjects.Text
  private sub!: Phaser.GameObjects.Text
  private speaker: Speaker = { character: null, label: '', sub: '' }
  private readonly failedTextures = new Set<string>()
  private loading = false
  private loadQueued = false
  // Where the portrait may stand: the controller says which rectangle of the
  // window the board leaves free (the lower left, beside the conversation).
  private stage: { x: number; y: number; width: number; height: number } | null = null
  private onLayout: (() => void) | undefined

  constructor(onSettingsChange?: () => void) {
    super({ key: 'projectroom' })
    this.settings = new FrontDeskSettings(() => { this.redraw(); onSettingsChange?.() })
  }

  preload() {
    this.load.image(FALLBACK_BG, '/frontdesk/bg.png')
    this.load.image(FALLBACK_FACE, '/frontdesk/agfront.jpg')
  }

  create() {
    const unknown = this.add.graphics()
    unknown.fillStyle(0x3a3f50, 1).fillRoundedRect(0, 0, 128, 128, 20)
    unknown.lineStyle(6, 0x7d8199, 1).strokeCircle(64, 52, 22).strokeRoundedRect(28, 82, 72, 34, 12)
    unknown.generateTexture(UNKNOWN_FACE, 128, 128)
    unknown.destroy()

    this.bg = this.add.image(0, 0, FALLBACK_BG).setOrigin(0.5, 0.5)
    this.tint = this.add.rectangle(0, 0, 10, 10, TINT_COLOR, TINT_ALPHA).setOrigin(0, 0)
    this.portrait = this.add.image(0, 0, FALLBACK_FACE).setOrigin(0, 1)
    this.nameplate = this.add.graphics()
    this.name = this.add.text(0, 0, '', { fontFamily: FONT, fontSize: '15px', color: '#ffb3d9', fontStyle: 'bold' })
    this.sub = this.add.text(0, 0, '', { fontFamily: MONO, fontSize: '10.5px', color: '#b9bdd6' })
    this.load.on('loaderror', (file: Phaser.Loader.File) => { this.failedTextures.add(file.key) })
    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    void this.settings.refresh()
  }

  // The controller's seams.
  setSpeaker(speaker: Speaker) {
    this.speaker = speaker
    this.redraw()
  }

  setStage(rect: { x: number; y: number; width: number; height: number } | null) {
    this.stage = rect
    this.redraw()
  }

  whenLaidOut(callback: () => void) { this.onLayout = callback }

  get unreadableImages(): number { return this.failedTextures.size }

  private texture(url: string | null, fallback: string): string {
    if (!url) return fallback
    if (this.textures.exists(url)) return url
    if (this.failedTextures.has(url)) return fallback
    this.load.image(url, assetUrl(url))
    this.startLoading()
    return fallback
  }

  private startLoading() {
    if (this.loading) { this.loadQueued = true; return }
    this.loading = true
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      this.loading = false
      this.redraw()
      if (this.loadQueued) { this.loadQueued = false; this.startLoading() }
    })
    this.load.start()
  }

  private layout(width: number, height: number) {
    this.tint.setPosition(0, 0).setSize(width, height)
    this.redraw()
    this.onLayout?.()
  }

  private redraw() {
    if (!this.bg) return
    const width = this.scale.width, height = this.scale.height
    // Background: the room's own from the active settings, covering the window.
    const manifest = this.settings.activeManifest
    const bgKey = this.texture(FrontDeskSettings.background(manifest, ROOM_ID), FALLBACK_BG)
    if (this.bg.texture.key !== bgKey) this.bg.setTexture(bgKey)
    const cover = Math.max(width / Math.max(1, this.bg.width), height / Math.max(1, this.bg.height))
    this.bg.setPosition(width / 2, height / 2).setScale(cover)
    this.tint.setSize(width, height)

    // Portrait: in the stage the board leaves free, aspect preserved.
    const stage = this.stage ?? { x: 16, y: height * 0.55, width: Math.min(260, width * 0.25), height: height * 0.4 }
    const character = this.speaker.character
    const faceKey = character ? this.texture(character.face, FALLBACK_FACE) : UNKNOWN_FACE
    if (this.portrait.texture.key !== faceKey) this.portrait.setTexture(faceKey)
    const visible = stage.width >= 90 && stage.height >= 120
    this.portrait.setVisible(visible)
    this.nameplate.clear()
    this.name.setVisible(visible)
    this.sub.setVisible(visible)
    if (!visible) return
    const maxHeight = stage.height - 44
    const scale = Math.min(maxHeight / Math.max(1, this.portrait.height), stage.width / Math.max(1, this.portrait.width))
    this.portrait.setScale(scale).setPosition(stage.x, stage.y + stage.height - 40)
    const plateWidth = Math.max(this.portrait.displayWidth, Math.min(stage.width, Math.max(this.name.width, this.sub.width) + 24))
    const plateY = stage.y + stage.height - 38
    this.nameplate.fillStyle(0x0d0f14, 0.78).fillRoundedRect(stage.x, plateY, plateWidth, 36, 8)
    this.nameplate.lineStyle(1, 0x3a4060, 1).strokeRoundedRect(stage.x, plateY, plateWidth, 36, 8)
    this.name.setText(this.speaker.label).setPosition(stage.x + 10, plateY + 4)
    this.sub.setText(this.speaker.sub).setPosition(stage.x + 10, plateY + 21)
  }
}
