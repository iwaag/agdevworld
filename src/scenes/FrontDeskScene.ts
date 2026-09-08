// Front Desk: a graphic-novel scene for talking with Front.
//
// One Zulip conversation, `#front` › `front-desk-<id>`, drawn as a visual
// novel frame: the background fills the screen, Front's portrait stands in
// the lower left with the dialogue beside it, another character speaks from
// a portrait and text box in the upper left, a prompt bar runs along the
// bottom, and the whole history is a panel that can be shown or hidden.
// Everything visible is Phaser; the only DOM is the hidden textarea that
// gives the prompt bar an IME (`frontDeskInput.ts`) and the link back to the
// dashboard.
//
// Since `front_desk` p2 nothing drawn here is bundled: the faces, the names
// and the background come from the settings revision the relay serves
// (`frontDeskSettings.ts`), a dialogue is played with the revision it was
// written for, and a reply is turns to page through (`frontDeskPlayback.ts`).
// Replies that arrive while the user is reading queue behind the one on
// show, with a visible way to advance.
//
// Nothing here decides what a post *is*. The relay says which posts are the
// Developer's, which are Front's acks and which are replies, what a reply's
// dialogue is and whether one was unusable; this scene renders those words.
// When the relay cannot be read the last known history stays on screen
// under an amber `unknown`, never a blank frame — the rule every
// relay-backed view in this app follows.

import Phaser from 'phaser'
import { createFrontDeskInput, type FrontDeskInputHandle } from '../frontDeskInput'
import {
  atEnd,
  citation,
  queuedAfter,
  repliesOf,
  settle,
  START,
  step,
  type Cursor,
  type PlayReply,
  type PlayTurn,
} from '../frontDeskPlayback'
import { FrontDeskSettings } from '../frontDeskSettings'
import {
  ago,
  clock,
  newConversationId,
  submitToken,
  type DeskBoard,
  type DeskConversationRow,
  type DeskDetail,
  type DeskSource,
} from '../frontDeskState'
import { assetUrl, type SettingsCharacter, type SettingsManifest } from '../settingsState'
import { linksIn, paginate, wrapText, type FoundLink, type Measure } from '../textLayout'

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BODY_PX = 18
const HISTORY_PX = 14
const PROMPT_PX = 16
const REFRESH_MS = 4000
const BOARD_MS = 30000
const BAR_HEIGHT = 64
const MARGIN = 16
const AVATAR = 30
const NARROW = 720

const COLOR = {
  ink: '#f7f4ff',
  muted: '#b9bdd6',
  dim: '#7d8199',
  accent: '#ffb3d9',
  accent2: '#70c7ff',
  live: '#67e8a5',
  warn: '#ffc56d',
  bad: '#ff8aa8',
  other: '#c9b8ff',
}

const FALLBACK_BG = 'frontdesk-fallback-bg'
const FALLBACK_FACE = 'frontdesk-fallback-face'
const UNKNOWN_FACE = 'frontdesk-unknown-face'

type SendPhase =
  | { kind: 'idle' }
  | { kind: 'sending'; at: number }
  | { kind: 'failed'; text: string }
  | { kind: 'uncertain'; text: string }

interface Rect { x: number; y: number; width: number; height: number }

export interface FrontDeskOptions {
  source: DeskSource
  conversationId: string
}

export class FrontDeskScene extends Phaser.Scene {
  private readonly source: DeskSource
  private conversationId: string
  private detail: DeskDetail | undefined
  private board: DeskBoard | undefined
  private signature = ''
  private unreadable: string | undefined
  private send: SendPhase = { kind: 'idle' }
  private sending = false
  private settings!: FrontDeskSettings

  // Playback: the replies as turns, and where the reader is.
  private replies: PlayReply[] = []
  private cursor: Cursor = START
  private shownId: number | null = null
  private pages: string[][] = [[]]
  private lineHeight = BODY_PX * 1.5
  private pageCache = new Map<string, number>()

  private historyOpen = false
  private historyScroll = 0
  private historyHeight = 0
  private historyViewport: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private dialogueRect: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private coRect: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private narrow = false

  private draft = ''
  private keys!: FrontDeskInputHandle
  private measure!: Measure
  private measureHistory!: Measure

  // Textures loaded at runtime, keyed by their revision-addressed URL.
  private readonly failedTextures = new Set<string>()
  private loading = false
  private loadQueued = false

  // Game objects
  private bg!: Phaser.GameObjects.Image
  private portrait!: Phaser.GameObjects.Image
  private coPortrait!: Phaser.GameObjects.Image
  private frame!: Phaser.GameObjects.Graphics
  private coFrame!: Phaser.GameObjects.Graphics
  private caption!: Phaser.GameObjects.Text
  private health!: Phaser.GameObjects.Text
  private settingsLine!: Phaser.GameObjects.Text
  private speaker!: Phaser.GameObjects.Text
  private body!: Phaser.GameObjects.Text
  private coSpeaker!: Phaser.GameObjects.Text
  private coBody!: Phaser.GameObjects.Text
  private pageLabel!: Phaser.GameObjects.Text
  private prevButton!: Phaser.GameObjects.Text
  private nextButton!: Phaser.GameObjects.Text
  private queueButton!: Phaser.GameObjects.Text
  private status!: Phaser.GameObjects.Text
  private chips: Phaser.GameObjects.Text[] = []
  private promptText!: Phaser.GameObjects.Text
  private sendButton!: Phaser.GameObjects.Text
  private counter!: Phaser.GameObjects.Text
  private historyButton!: Phaser.GameObjects.Text
  private newButton!: Phaser.GameObjects.Text
  private settingsButton!: Phaser.GameObjects.Text
  private historyPanel!: Phaser.GameObjects.Container
  private historyBackdrop!: Phaser.GameObjects.Graphics
  private historyTitle!: Phaser.GameObjects.Text
  private historyList!: Phaser.GameObjects.Container
  private conversationChips: Phaser.GameObjects.Text[] = []

  constructor(options: FrontDeskOptions) {
    super({ key: 'frontdesk' })
    this.source = options.source
    this.conversationId = options.conversationId
  }

  preload() {
    // The bundled pair is the fallback for a settings image that cannot be
    // read; the settings' own images are loaded at runtime by revision.
    this.load.image(FALLBACK_BG, '/frontdesk/bg.png')
    this.load.image(FALLBACK_FACE, '/frontdesk/agfront.jpg')
  }

  create() {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')!
    this.measure = (text) => {
      context.font = `${BODY_PX}px ${FONT}`
      return context.measureText(text).width
    }
    this.measureHistory = (text) => {
      context.font = `${HISTORY_PX}px ${FONT}`
      return context.measureText(text).width
    }
    this.settings = new FrontDeskSettings(() => this.onSettingsChange())
    // The common icon for a speaker the settings do not know: never
    // somebody else's face.
    const unknown = this.add.graphics()
    unknown.fillStyle(0x3a3f50, 1).fillRoundedRect(0, 0, 128, 128, 20)
    unknown.lineStyle(6, 0x7d8199, 1).strokeCircle(64, 52, 22).strokeRoundedRect(28, 82, 72, 34, 12)
    unknown.generateTexture(UNKNOWN_FACE, 128, 128)
    unknown.destroy()

    this.bg = this.add.image(0, 0, FALLBACK_BG).setOrigin(0.5, 0.5)
    this.frame = this.add.graphics()
    this.coFrame = this.add.graphics()
    this.portrait = this.add.image(0, 0, FALLBACK_FACE).setOrigin(0, 1)
    this.coPortrait = this.add.image(0, 0, FALLBACK_FACE).setOrigin(0, 0).setVisible(false)

    this.caption = this.text(MARGIN, 12, '', MONO, 12, COLOR.accent2).setLetterSpacing(2)
    this.health = this.text(MARGIN, 32, '', MONO, 11, COLOR.dim)
    this.settingsLine = this.text(MARGIN, 48, '', MONO, 10.5, COLOR.dim)
    this.speaker = this.text(0, 0, 'Front', FONT, 15, COLOR.accent).setFontStyle('bold')
    this.body = this.text(0, 0, '', FONT, BODY_PX, COLOR.ink)
    this.coSpeaker = this.text(0, 0, '', FONT, 15, COLOR.other).setFontStyle('bold')
    this.coBody = this.text(0, 0, '', FONT, BODY_PX, COLOR.ink)
    // One line of text tells the layout how tall a line is on this machine.
    const probe = this.text(0, 0, 'あA🙂', FONT, BODY_PX, COLOR.ink)
    this.lineHeight = Math.ceil(probe.height)
    probe.destroy()
    this.pageLabel = this.text(0, 0, '', MONO, 11, COLOR.dim)
    this.prevButton = this.button('◀', () => this.turn(-1))
    this.nextButton = this.button('▶', () => this.turn(1))
    this.queueButton = this.button('', () => this.turn(1), COLOR.accent2).setVisible(false)
    this.status = this.text(0, 0, '', MONO, 11.5, COLOR.muted)

    this.promptText = this.text(0, 0, '', FONT, PROMPT_PX, COLOR.ink)
    this.sendButton = this.button('Send ⏎ · buys a run', () => void this.submit(), COLOR.accent2)
    this.counter = this.text(0, 0, '', MONO, 10.5, COLOR.dim)
    this.historyButton = this.button('history', () => this.toggleHistory())
    this.newButton = this.button('new conversation', () => this.startConversation())
    this.settingsButton = this.button('settings ⟳', () => void this.settings.refresh())

    this.historyPanel = this.add.container(0, 0).setVisible(false)
    this.historyBackdrop = this.add.graphics()
    this.historyTitle = this.text(0, 0, 'HISTORY', MONO, 11, COLOR.accent2).setLetterSpacing(2)
    this.historyList = this.add.container(0, 0)
    this.historyPanel.add([this.historyBackdrop, this.historyTitle, this.historyList])

    this.keys = createFrontDeskInput({
      onChange: (text) => {
        this.draft = text
        this.renderPrompt()
      },
      onSubmit: () => void this.submit(),
      onEscape: () => { if (this.historyOpen) this.toggleHistory() },
    })
    // Clicking anywhere on the frame puts the keyboard back in the bar.
    this.keys.focus()
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, over: unknown[]) => {
      this.keys.focus()
      // A click on the frame itself advances; a click on a button is the button's.
      if (over.length === 0 && (this.inside(pointer, this.dialogueRect) || this.inside(pointer, this.coRect))) this.turn(1)
    })
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
      if (this.historyOpen && this.inside(pointer, this.historyViewport)) {
        this.scrollHistory(dy)
      } else if (this.inside(pointer, this.dialogueRect) || this.inside(pointer, this.coRect)) {
        this.turn(dy > 0 ? 1 : -1)
      }
    })
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      this.failedTextures.add(file.key)
    })

    const link = document.createElement('a')
    link.href = '/'
    link.textContent = 'Operation room ↗'
    link.style.cssText = 'position:fixed;top:10px;right:16px;z-index:20;color:#8dccff;font:12px system-ui;background:rgba(13,20,32,0.85);padding:6px 10px;border-radius:6px;text-decoration:none'
    document.body.append(link)
    this.events.once('shutdown', () => { link.remove(); this.keys.destroy() })

    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    this.time.addEvent({ delay: REFRESH_MS, loop: true, callback: () => void this.refresh() })
    this.time.addEvent({ delay: BOARD_MS, loop: true, callback: () => void this.refreshBoard() })
    this.time.addEvent({ delay: 1000, loop: true, callback: () => this.renderStatus() })
    void this.settings.refresh()
    void this.refresh()
    void this.refreshBoard()
  }

  // --- reads -----------------------------------------------------------------

  private async refresh() {
    const id = this.conversationId
    const found = await this.source.detail(id)
    if (id !== this.conversationId) return
    if ('error' in found) {
      this.unreadable = found.error
      this.renderStatus()
      this.renderCaption()
      return
    }
    this.unreadable = undefined
    this.detail = found
    const conversation = found.conversation
    // Content and dialogue are part of the signature, so an edit is visible
    // too, not only a new post.
    const signature = JSON.stringify([
      found.health.state, conversation.known, conversation.resolved, conversation.status,
      conversation.posts.map((post) => [post.message_id, post.content, post.dialogue, post.dialogue_error]),
      found.chat.configured,
    ])
    if (signature !== this.signature) {
      this.signature = signature
      // A reader who had finished the newest reply is waiting for the next
      // one and is taken to it; a reader still inside a reply keeps it, and
      // what arrived queues behind with a visible way forward.
      const finished = this.cursor.reply < 0 || (queuedAfter(this.cursor, this.replies) === 0
        && atEnd(this.cursor, this.replies, (r, t) => this.pagesOf(r, t)))
      this.replies = repliesOf(conversation.posts)
      this.pageCache.clear()
      this.cursor = settle(this.cursor, this.replies, this.shownId)
      if (finished && queuedAfter(this.cursor, this.replies) > 0) {
        this.cursor = { reply: this.cursor.reply + 1, turn: 0, page: 0 }
      }
      this.shownId = this.cursor.reply >= 0 ? this.replies[this.cursor.reply].message_id : null
      this.renderDialogue()
      this.renderHistory()
    }
    this.renderCaption()
    this.renderStatus()
    this.renderPrompt()
  }

  private async refreshBoard() {
    const found = await this.source.board()
    if ('error' in found) return
    this.board = found
    // The chip rows decide where the list starts, so the panel is laid out again.
    if (this.historyOpen) this.layout(this.scale.width, this.scale.height)
    else this.renderConversationChips()
  }

  private onSettingsChange() {
    this.pageCache.clear()
    this.renderDialogue()
    this.renderHistory()
    this.renderCaption()
  }

  // --- writes ----------------------------------------------------------------

  private async submit() {
    const text = this.draft.trim()
    if (text === '' || this.sending || this.keys.composing()) return
    const chat = this.detail?.chat
    if (this.unreadable || !chat?.configured) {
      this.send = { kind: 'failed', text: this.unreadable ?? chat?.reason ?? 'the relay cannot post right now' }
      this.renderStatus()
      return
    }
    if (chat.max_chars && text.length > chat.max_chars) {
      this.send = { kind: 'failed', text: `${text.length} characters is over the ${chat.max_chars} the relay sends` }
      this.renderStatus()
      return
    }
    // One submit, one token: a double click, a second Enter or a retry after
    // a timeout all carry the same token and the relay refuses the repeat.
    this.sending = true
    this.keys.setDisabled(true)
    this.send = { kind: 'sending', at: Date.now() / 1000 }
    this.renderStatus()
    this.renderPrompt()
    const result = await this.source.send(this.conversationId, text, submitToken())
    this.sending = false
    this.keys.setDisabled(false)
    if (result.sent) {
      this.send = { kind: 'idle' }
      this.keys.set('')
      // The developer just spoke: the next reply is what they are waiting
      // for, so the reader moves to the newest reply and the answer will
      // follow it rather than queue behind an old one.
      if (this.replies.length) {
        this.cursor = { reply: this.replies.length - 1, turn: this.replies[this.replies.length - 1].turns.length - 1, page: 0 }
        this.cursor.page = this.pagesOf(this.cursor.reply, this.cursor.turn) - 1
        this.shownId = this.replies[this.cursor.reply].message_id
        this.renderDialogue()
      }
    } else if (result.uncertain) {
      this.send = { kind: 'uncertain', text: `${result.error ?? 'the post may have landed'}${result.note ? ` — ${result.note}` : ''}` }
    } else {
      this.send = { kind: 'failed', text: result.error ?? 'the post was refused' }
    }
    this.renderStatus()
    this.renderPrompt()
    this.keys.focus()
    await this.refresh()
  }

  private startConversation() {
    this.openConversation(newConversationId())
  }

  private openConversation(id: string) {
    if (id === this.conversationId) return
    this.conversationId = id
    const url = new URL(location.href)
    url.searchParams.set('conv', id)
    history.replaceState(null, '', url)
    this.detail = undefined
    this.signature = ''
    this.replies = []
    this.cursor = START
    this.shownId = null
    this.pageCache.clear()
    this.send = { kind: 'idle' }
    this.historyScroll = 0
    this.renderDialogue()
    this.renderHistory()
    this.renderCaption()
    this.renderStatus()
    void this.refresh()
  }

  // --- settings: manifests, characters, textures ------------------------------

  private get current(): PlayReply | null {
    return this.cursor.reply >= 0 ? this.replies[this.cursor.reply] ?? null : null
  }

  private get currentTurn(): PlayTurn | null {
    return this.current?.turns[this.cursor.turn] ?? null
  }

  // The manifest the frame is drawn with: the current reply's revision when
  // it names one, else the active settings.
  private manifestInView(): { manifest: SettingsManifest | null; note: string | null } {
    const found = this.settings.resolve(this.current?.revision ?? null)
    return { manifest: found.manifest, note: found.note }
  }

  private frontOf(manifest: SettingsManifest | null): SettingsCharacter | null {
    return FrontDeskSettings.front(manifest)
  }

  private speakerOf(turn: PlayTurn | null, manifest: SettingsManifest | null): { character: SettingsCharacter | null; label: string; front: boolean } {
    if (!turn || turn.character === null) {
      const front = this.frontOf(manifest)
      return { character: front, label: front?.name ?? 'Front', front: true }
    }
    const character = FrontDeskSettings.character(manifest, turn.character)
    const front = character !== null && character === this.frontOf(manifest)
    return { character, label: character?.name ?? turn.character, front }
  }

  // A texture for a settings image URL: the loaded one, the fallback while
  // it loads or after it failed. Loading is started once per URL.
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
      // A loaded portrait may have another shape: lay the frame out again.
      this.layout(this.scale.width, this.scale.height)
      if (this.loadQueued) { this.loadQueued = false; this.startLoading() }
    })
    this.load.start()
  }

  // --- layout ----------------------------------------------------------------

  private layout(width: number, height: number) {
    this.narrow = width < NARROW
    const barY = height - BAR_HEIGHT - MARGIN
    // Portrait: lower left, aspect preserved, sized by the frame.
    const portraitHeight = Math.max(140, Math.min(height * 0.42, width * (this.narrow ? 0.4 : 0.3)))
    const portraitScale = portraitHeight / Math.max(1, this.portrait.height)
    this.portrait.setPosition(MARGIN, barY - 8).setScale(portraitScale)
    const portraitWidth = this.portrait.width * portraitScale

    const historyWidth = this.historyOpen ? (this.narrow ? width - 2 * MARGIN : Math.min(440, Math.max(280, width * 0.36))) : 0
    const dialogueX = this.narrow ? MARGIN : MARGIN + portraitWidth + 14
    const dialogueWidth = Math.max(200, width - dialogueX - MARGIN - (historyWidth && !this.narrow ? historyWidth + MARGIN : 0))
    const dialogueHeight = this.narrow ? Math.max(140, height * 0.3) : Math.min(portraitHeight, Math.max(160, height * 0.4))
    const dialogueY = barY - 8 - dialogueHeight
    this.dialogueRect = { x: dialogueX, y: dialogueY, width: dialogueWidth, height: dialogueHeight }
    if (this.narrow) {
      // Stacked: the portrait stands behind the box's left edge, smaller.
      this.portrait.setPosition(MARGIN, dialogueY - 4)
    }

    // The collaborator: upper left, portrait beside a box.
    const coTop = this.narrow ? 100 : 70
    const coPortraitHeight = Math.max(90, Math.min(height * 0.24, width * 0.18))
    const coPortraitScale = coPortraitHeight / Math.max(1, this.coPortrait.height)
    this.coPortrait.setPosition(MARGIN, coTop).setScale(coPortraitScale)
    const coPortraitWidth = this.coPortrait.width * coPortraitScale
    const coX = MARGIN + coPortraitWidth + 12
    const coWidth = Math.max(180, Math.min(this.narrow ? width - coX - MARGIN : width * 0.5, width - coX - MARGIN - (historyWidth && !this.narrow ? historyWidth + MARGIN : 0)))
    const coHeight = Math.max(110, Math.min(coPortraitHeight, dialogueY - coTop - 24))
    this.coRect = { x: coX, y: coTop, width: coWidth, height: coHeight }

    this.frame.clear()
    this.frame.fillStyle(0x0d0f14, 0.78)
    this.frame.fillRoundedRect(dialogueX, dialogueY, dialogueWidth, dialogueHeight, 14)
    this.frame.lineStyle(1, 0x3a4060, 1)
    this.frame.strokeRoundedRect(dialogueX, dialogueY, dialogueWidth, dialogueHeight, 14)
    // The prompt bar.
    this.frame.fillStyle(0x10131c, 0.94)
    this.frame.fillRoundedRect(MARGIN, barY, width - 2 * MARGIN, BAR_HEIGHT, 12)
    this.frame.lineStyle(1, 0x3a4060, 1)
    this.frame.strokeRoundedRect(MARGIN, barY, width - 2 * MARGIN, BAR_HEIGHT, 12)
    // A tint behind the caption so it reads over any background.
    this.frame.fillStyle(0x0d0f14, 0.55)
    this.frame.fillRoundedRect(MARGIN - 8, 6, Math.min(640, width * 0.6), 58, 8)

    this.speaker.setPosition(dialogueX + 18, dialogueY + 12)
    this.body.setPosition(dialogueX + 18, dialogueY + 38)
    this.coSpeaker.setPosition(coX + 16, coTop + 10)
    this.coBody.setPosition(coX + 16, coTop + 34)
    // The status sits in the box's own header so it reads over any background.
    this.status.setPosition(dialogueX + dialogueWidth - 18, dialogueY + 14).setOrigin(1, 0)
    this.nextButton.setPosition(dialogueX + dialogueWidth - 14, dialogueY + dialogueHeight - 12).setOrigin(1, 1)
    this.prevButton.setPosition(this.nextButton.x - this.nextButton.width - 8, this.nextButton.y).setOrigin(1, 1)
    this.pageLabel.setPosition(this.prevButton.x - this.prevButton.width - 10, this.nextButton.y - 6).setOrigin(1, 1)
    this.queueButton.setPosition(dialogueX + dialogueWidth - 14, dialogueY - 8).setOrigin(1, 1)

    this.promptText.setPosition(MARGIN + 16, barY + BAR_HEIGHT / 2).setOrigin(0, 0.5)
    this.sendButton.setPosition(width - MARGIN - 12, barY + BAR_HEIGHT / 2).setOrigin(1, 0.5)
    this.counter.setPosition(this.sendButton.x - this.sendButton.width - 12, barY + BAR_HEIGHT / 2).setOrigin(1, 0.5)
    this.keys.place({
      x: MARGIN + 12, y: barY + 8,
      width: Math.max(40, this.counter.x - this.counter.width - 8 - (MARGIN + 12)), height: BAR_HEIGHT - 16,
    })

    const buttonsY = this.narrow ? 68 : 44
    this.historyButton.setPosition(width - MARGIN, buttonsY).setOrigin(1, 0)
    this.newButton.setPosition(this.historyButton.x - this.historyButton.width - 8, buttonsY).setOrigin(1, 0)
    this.settingsButton.setPosition(this.newButton.x - this.newButton.width - 8, buttonsY).setOrigin(1, 0)

    // History panel: right side, above the bar; the whole frame when narrow.
    const panelX = width - MARGIN - historyWidth
    const panelY = this.narrow ? 100 : 80
    const panelHeight = barY - 8 - panelY
    this.historyPanel.setVisible(this.historyOpen)
    if (this.historyOpen) {
      this.historyBackdrop.clear()
      this.historyBackdrop.fillStyle(0x0d0f14, 0.92)
      this.historyBackdrop.fillRoundedRect(panelX, panelY, historyWidth, panelHeight, 12)
      this.historyBackdrop.lineStyle(1, 0x3a4060, 1)
      this.historyBackdrop.strokeRoundedRect(panelX, panelY, historyWidth, panelHeight, 12)
      this.historyTitle.setPosition(panelX + 14, panelY + 10)
      const listY = panelY + 30 + this.conversationChipRows() * 24 + 6
      this.historyViewport = { x: panelX + 8, y: listY, width: historyWidth - 16, height: panelY + panelHeight - listY - 8 }
      this.renderConversationChips()
    }
    this.pageCache.clear()
    this.renderDialogue()
    this.renderHistory()
    this.renderPrompt()
    this.renderCaption()
    this.renderStatus()
  }

  // --- rendering ---------------------------------------------------------------

  private renderCaption() {
    const conversation = this.detail?.conversation
    const topic = conversation?.live_topic ?? `front-desk-${this.conversationId}`
    this.caption.setText(`FRONT DESK · #front › ${topic}`)
    if (this.unreadable) {
      this.health.setText(`⚠ UNKNOWN — ${this.unreadable}; last known history`).setColor(COLOR.warn)
    } else if (!this.detail) {
      this.health.setText('reading the conversation…').setColor(COLOR.dim)
    } else if (this.detail.health.state !== 'live') {
      this.health.setText(`⚠ UNKNOWN — ${this.detail.health.reason}; last known history`).setColor(COLOR.warn)
    } else {
      const chat = this.detail.chat.configured ? 'chat posts as the Developer' : (this.detail.chat.reason ?? 'chat read-only')
      const known = conversation?.known === 'read' ? ' · read from Zulip' : conversation?.known === 'unknown' ? ' · history unknown' : ''
      this.health.setText(`relay live · ${chat}${known}${conversation?.resolved ? ' · ✔ resolved' : ''}`).setColor(COLOR.live)
    }
    const view = this.manifestInView()
    const parts = [this.settings.summary()]
    if (this.current?.revision && !view.note) parts.push(`scene at ${this.current.revision.slice(0, 12)}`)
    if (view.note) parts.push(view.note)
    const failed = this.failedTextures.size ? ` · ${this.failedTextures.size} image${this.failedTextures.size > 1 ? 's' : ''} unreadable, fallback shown` : ''
    const bad = Boolean(view.note) || this.failedTextures.size > 0 || !this.settings.activeManifest
    this.settingsLine.setText(parts.join(' · ') + failed).setColor(bad ? COLOR.warn : COLOR.dim)
  }

  private pagesOf(reply: number, turn: number): number {
    const key = `${reply}:${turn}`
    const cached = this.pageCache.get(key)
    if (cached !== undefined) return cached
    const found = this.replies[reply]?.turns[turn]
    if (!found) return 1
    const box = this.boxFor(found, this.replies[reply])
    const count = paginate(wrapText(found.text, box.innerWidth, this.measure), box.linesPerPage).length
    this.pageCache.set(key, count)
    return count
  }

  // The box a turn is read in and how much text fits on one page of it.
  private boxFor(turn: PlayTurn, reply: PlayReply | null = this.current): { front: boolean; innerWidth: number; linesPerPage: number } {
    const front = turn.character === null || this.speakerOf(turn, this.settings.resolve(reply?.revision ?? null).manifest).front
    const rect = front ? this.dialogueRect : this.coRect
    const innerWidth = rect.width - (front ? 36 : 32)
    const textTop = rect.y + (front ? 38 : 34)
    const linkRows = front && reply ? Math.min(2, Math.ceil((reply.links.length + (this.detail?.conversation.zulip_url ? 1 : 0)) / 3)) : 0
    const textBottom = rect.y + rect.height - (front ? 40 : 30)
    return { front, innerWidth, linesPerPage: Math.max(1, Math.floor((textBottom - textTop - linkRows * 26) / this.lineHeight)) }
  }

  private renderDialogue() {
    const { manifest } = this.manifestInView()
    const front = this.frontOf(manifest)
    // Front's portrait and the background follow the revision in view.
    this.portrait.setTexture(this.texture(front?.face ?? null, FALLBACK_FACE))
    const bgKey = this.texture(FrontDeskSettings.background(manifest), FALLBACK_BG)
    if (this.bg.texture.key !== bgKey) this.bg.setTexture(bgKey)
    const width = this.scale.width
    const height = this.scale.height
    const bgScale = Math.max(width / this.bg.width, height / this.bg.height)
    this.bg.setPosition(width / 2, height / 2).setScale(bgScale)
    const portraitHeight = this.narrow ? Math.max(140, Math.min(height * 0.42, width * 0.4)) : Math.max(140, Math.min(height * 0.42, width * 0.3))
    this.portrait.setScale(portraitHeight / Math.max(1, this.portrait.height))

    for (const chip of this.chips) chip.destroy()
    this.chips = []

    const reply = this.current
    const turn = this.currentTurn
    const { x, y, width: boxWidth } = this.dialogueRect

    if (!reply || !turn) {
      this.speaker.setText(front?.name ?? (this.detail?.conversation.posts.length ? 'Front' : 'Front Desk'))
      const placeholder = this.detail === undefined
        ? '…'
        : this.detail.conversation.posts.length === 0
          ? 'A new conversation. Say something in the bar below — Front answers here, and every post is kept in the history panel.'
          : 'No reply from Front in this conversation yet.'
      const box = this.boxFor({ character: null, text: placeholder, sources: [] }, null)
      this.pages = paginate(wrapText(placeholder, box.innerWidth, this.measure), box.linesPerPage)
      this.body.setColor(COLOR.muted).setText(this.pages[0].join('\n')).setAlpha(1)
      this.portrait.setAlpha(1).clearTint()
      this.coPortrait.setVisible(false)
      this.coFrame.clear()
      this.coSpeaker.setText('')
      this.coBody.setText('')
      this.pageLabel.setText('')
      this.prevButton.setVisible(false)
      this.nextButton.setVisible(false)
      this.queueButton.setVisible(false)
      this.renderLinks(reply)
      return
    }

    const who = this.speakerOf(turn, manifest)
    const box = this.boxFor(turn)
    this.pages = paginate(wrapText(turn.text, box.innerWidth, this.measure), box.linesPerPage)
    this.cursor.page = Math.min(this.cursor.page, this.pages.length - 1)
    const pageText = this.pages[this.cursor.page].join('\n')

    // The last thing each box said stays on show, dimmed, while the other
    // speaks — a graphic-novel frame, not a chat.
    const lastFront = this.lastTurnBefore(true)
    const lastOther = this.lastTurnBefore(false)
    if (who.front) {
      this.speaker.setText(who.label)
      this.body.setColor(COLOR.ink).setText(pageText).setAlpha(1)
      this.portrait.setAlpha(1).clearTint()
      if (lastOther) this.drawCollaborator(lastOther, manifest, 0.45)
      else this.hideCollaborator()
    } else {
      this.drawCollaborator(turn, manifest, 1, pageText)
      const frontName = front?.name ?? 'Front'
      this.speaker.setText(frontName)
      const previous = lastFront ? wrapText(lastFront.text, box.innerWidth, this.measure).slice(0, 3).join('\n') : ''
      this.body.setColor(COLOR.muted).setText(previous).setAlpha(0.6)
      this.portrait.setAlpha(1).setTint(0x6a6a7a)
    }

    const turns = reply.turns.length
    const paged = this.pages.length > 1 || turns > 1 || this.replies.length > 1
    const position = turns > 1 ? `${this.cursor.turn + 1}/${turns}` : ''
    const page = this.pages.length > 1 ? ` p${this.cursor.page + 1}/${this.pages.length}` : ''
    const which = this.replies.length > 1 ? ` · reply ${this.cursor.reply + 1}/${this.replies.length}` : ''
    this.pageLabel.setText(paged ? `${position}${page}${which}`.trim() : '')
    const canBack = this.cursor.page > 0 || this.cursor.turn > 0 || this.cursor.reply > 0
    const ended = atEnd(this.cursor, this.replies, (r, t) => this.pagesOf(r, t))
    const queued = queuedAfter(this.cursor, this.replies)
    this.prevButton.setVisible(paged).setAlpha(canBack ? 1 : 0.35)
    this.nextButton.setVisible(paged).setAlpha(!ended || queued > 0 ? 1 : 0.35)
    this.queueButton.setVisible(queued > 0).setText(`▶ ${queued} new repl${queued > 1 ? 'ies' : 'y'} waiting`)
    this.queueButton.setPosition(x + boxWidth - 14, y - 8).setOrigin(1, 1)
    this.renderLinks(reply)
  }

  private lastTurnBefore(front: boolean): PlayTurn | null {
    const reply = this.current
    if (!reply) return null
    const manifest = this.manifestInView().manifest
    for (let i = this.cursor.turn - 1; i >= 0; i--) {
      const turn = reply.turns[i]
      if (this.speakerOf(turn, manifest).front === front) return turn
    }
    return null
  }

  private drawCollaborator(turn: PlayTurn, manifest: SettingsManifest | null, alpha: number, pageText?: string) {
    const who = this.speakerOf(turn, manifest)
    const { x, y, width, height } = this.coRect
    this.coPortrait.setVisible(true).setAlpha(1).setTint(alpha < 1 ? 0x6a6a7a : 0xffffff)
      .setTexture(who.character ? this.texture(who.character.face, FALLBACK_FACE) : UNKNOWN_FACE)
    const coPortraitHeight = Math.max(90, Math.min(this.scale.height * 0.24, this.scale.width * 0.18))
    this.coPortrait.setScale(coPortraitHeight / Math.max(1, this.coPortrait.height))
    this.coFrame.clear()
    this.coFrame.fillStyle(0x14101f, 0.82 * alpha)
    this.coFrame.fillRoundedRect(x, y, width, height, 14)
    this.coFrame.lineStyle(1, 0x5a4a80, alpha)
    this.coFrame.strokeRoundedRect(x, y, width, height, 14)
    const label = who.character ? `${who.character.name}${who.character.nickname ? `（${who.character.nickname}）` : ''}` : `${who.label} · not in these settings`
    this.coSpeaker.setText(label).setAlpha(alpha).setColor(who.character ? COLOR.other : COLOR.warn)
    const text = pageText ?? wrapText(turn.text, width - 32, this.measure).slice(0, 3).join('\n')
    this.coBody.setText(text).setAlpha(alpha).setColor(pageText ? COLOR.ink : COLOR.muted)
  }

  private hideCollaborator() {
    this.coPortrait.setVisible(false)
    this.coFrame.clear()
    this.coSpeaker.setText('')
    this.coBody.setText('')
  }

  private renderLinks(reply: PlayReply | null) {
    const { x, y, width, height } = this.dialogueRect
    // Link chips: every URL the reply carries, the sources the turn on show
    // cites, plus the topic in Zulip.
    const links: FoundLink[] = reply ? [...reply.links] : []
    const zulip = this.detail?.conversation.zulip_url
    if (zulip) links.push({ label: 'open in Zulip', url: zulip })
    const sources = this.currentTurn?.sources ?? []
    let chipX = x + 18
    let chipY = y + height - 12
    const rows: Phaser.GameObjects.Text[][] = [[]]
    // A chip never outgrows the box: ~7px per monospace character at 11px.
    const maxLabel = Math.max(10, Math.floor((width - 140) / 7))
    const place = (chip: Phaser.GameObjects.Text) => {
      if (chipX + chip.width > x + width - 90 && rows[rows.length - 1].length > 0) {
        rows.push([])
        chipX = x + 18
      }
      rows[rows.length - 1].push(chip)
      chip.setPosition(chipX, 0)
      chipX += chip.width + 6
      this.chips.push(chip)
    }
    for (const source of sources) {
      const label = citation(source)
      const chip = this.text(0, 0, `📎 ${label.length > maxLabel ? `${label.slice(0, maxLabel - 1)}…` : label}`, MONO, 11, COLOR.other)
        .setBackgroundColor('#1b1830').setPadding(8, 4, 8, 4)
      place(chip)
    }
    for (const link of links) {
      const label = link.label.length > maxLabel ? `${link.label.slice(0, maxLabel - 1)}…` : link.label
      const chip = this.text(0, 0, `🔗 ${label}`, MONO, 11, COLOR.accent2)
        .setBackgroundColor('#1b2030').setPadding(8, 4, 8, 4)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => window.open(link.url, '_blank', 'noopener'))
      place(chip)
    }
    for (let row = rows.length - 1; row >= 0; row--) {
      for (const chip of rows[row]) chip.setY(chipY).setOrigin(0, 1)
      chipY -= 26
    }
  }

  private renderStatus() {
    const conversation = this.detail?.conversation
    const now = Date.now() / 1000
    let text = ''
    let color = COLOR.muted
    if (this.send.kind === 'sending') {
      text = `posting to #front… (${Math.round(now - this.send.at)}s)`
      color = COLOR.accent2
    } else if (this.send.kind === 'failed') {
      text = `✖ not sent — ${this.send.text}`
      color = COLOR.bad
    } else if (this.send.kind === 'uncertain') {
      text = `? uncertain — ${this.send.text}`
      color = COLOR.warn
    } else if (this.unreadable || (this.detail && this.detail.health.state !== 'live')) {
      text = '⚠ state unknown — the relay cannot be read; nothing here is current'
      color = COLOR.warn
    } else if (conversation) {
      const since = conversation.status.since === null ? null : now - conversation.status.since
      switch (conversation.status.state) {
        case 'waiting':
          text = `sent · waiting for Front to pick it up (${ago(since)})`
          color = COLOR.accent2
          break
        case 'received':
          text = `📩 Front received it and is working (${ago(since)})`
          color = COLOR.accent
          break
        case 'answered':
          text = `answered ${ago(since)} ago`
          color = COLOR.live
          break
        case 'done':
          text = '✔ resolved — posting here resumes the conversation'
          color = COLOR.dim
          break
        case 'quiet':
          text = ''
          break
        default:
          text = `⚠ ${conversation.status.evidence}`
          color = COLOR.warn
      }
      if (this.current?.error) {
        text = `${text ? `${text} · ` : ''}scene unusable: ${this.current.error}`
        color = COLOR.warn
      }
    }
    // The status shares the box header with the speaker's name: it is cut
    // to what fits rather than drawn over the name.
    const room = Math.max(60, this.dialogueRect.width - 36 - this.speaker.width - 16)
    const mono = (t: string) => this.measure(t) * (11.5 / BODY_PX) * 0.92
    if (mono(text) > room) {
      let shown = text
      while (shown.length > 1 && mono(`${shown}…`) > room) shown = shown.slice(0, -1)
      text = `${shown}…`
    }
    this.status.setText(text).setColor(color)
  }

  private renderPrompt() {
    const chat = this.detail?.chat
    const usable = !this.sending && !this.unreadable && Boolean(chat?.configured) && this.detail?.health.state === 'live'
    const maxWidth = Math.max(40, (this.counter.x - this.counter.width - 12) - (MARGIN + 16))
    if (this.draft === '') {
      const hint = usable ? (maxWidth < 420 ? 'Say something to Front…' : 'Say something to Front… (Enter sends, Shift+Enter is a newline)') : 'chat is not available right now'
      this.promptText.setText(hint).setColor(COLOR.dim)
    } else {
      // The bar shows the tail of a long draft, on one line; the history
      // panel is where a long text is read back.
      const oneLine = this.draft.replace(/\n/g, ' ⏎ ')
      let shown = oneLine
      while (shown !== '' && this.measure(shown) * (PROMPT_PX / BODY_PX) > maxWidth) shown = shown.slice(1)
      this.promptText.setText(shown === oneLine ? shown : `…${shown.slice(1)}`).setColor(usable ? COLOR.ink : COLOR.dim)
    }
    const max = chat?.max_chars
    const length = Array.from(this.draft).length
    this.counter.setText(max ? `${length}/${max}` : '').setColor(max && length > max ? COLOR.bad : COLOR.dim)
    this.sendButton.setAlpha(usable && this.draft.trim() !== '' ? 1 : 0.45)
    this.sendButton.setText(this.sending ? 'sending…' : 'Send ⏎ · buys a run')
  }

  // --- history: portrait, name, text per turn --------------------------------

  private renderHistory() {
    this.historyList.removeAll(true)
    if (!this.historyOpen) return
    const { x, y, width } = this.historyViewport
    const posts = this.detail?.conversation.posts ?? []
    let cursor = 0
    const textX = x + 10 + AVATAR + 10
    const textWidth = width - 24 - AVATAR - 10
    const add = (text: string, color: string, font = FONT, size = HISTORY_PX, indent = true) => {
      const lines = wrapText(text, indent ? textWidth : width - 24, this.measureHistory)
      const node = this.text(indent ? textX : x + 10, y + cursor, lines.join('\n'), font, size, color)
      this.historyList.add(node)
      cursor += node.height + 4
      return node
    }
    const avatar = (kind: 'character' | 'user' | 'other', face: string | null, letter: string) => {
      const top = y + cursor
      if (kind === 'character' && !face) {
        const image = this.add.image(x + 10, top, UNKNOWN_FACE).setOrigin(0, 0).setScale(AVATAR / 128)
        this.historyList.add(image)
        return
      }
      if (kind === 'character' && face) {
        const key = this.texture(face, FALLBACK_FACE)
        const image = this.add.image(x + 10, top, key).setOrigin(0, 0)
        const scale = AVATAR / Math.max(1, image.height)
        image.setScale(scale)
        // Crop to a square when the portrait is not one.
        const side = Math.min(image.width, image.height)
        image.setCrop((image.width - side) / 2, 0, side, side)
        image.setScale(AVATAR / side)
        image.setX(x + 10 - ((image.width - side) / 2) * (AVATAR / side))
        this.historyList.add(image)
        return
      }
      const badge = this.add.graphics()
      badge.setData('top', top)
      badge.fillStyle(kind === 'user' ? 0x2a4a6a : kind === 'character' ? 0x4a3a6a : 0x3a3f50, 1)
      badge.fillCircle(x + 10 + AVATAR / 2, top + AVATAR / 2, AVATAR / 2)
      this.historyList.add(badge)
      const glyph = this.add.text(x + 10 + AVATAR / 2, top + AVATAR / 2, letter, { fontFamily: FONT, fontSize: '14px', color: COLOR.ink }).setOrigin(0.5)
      this.historyList.add(glyph)
    }
    const row = (kind: 'character' | 'user' | 'other', face: string | null, letter: string, label: string, labelColor: string, text: string, textColor: string, time: number) => {
      avatar(kind, face, letter)
      add(`${label} · ${clock(time)}`, labelColor, MONO, 10.5)
      add(text, textColor)
      cursor += 8
    }

    if (!this.detail) {
      add(this.unreadable ? `History unknown — ${this.unreadable}` : 'reading…', this.unreadable ? COLOR.warn : COLOR.dim, FONT, HISTORY_PX, false)
    } else if (posts.length === 0) {
      add(this.detail.conversation.known === 'unknown' ? 'History unknown — the relay could not read this conversation.' : 'Nothing has been posted in this conversation yet.', COLOR.dim, FONT, HISTORY_PX, false)
    }
    if (this.detail?.conversation.history.bounded) {
      add(`Only the newest ${this.detail.conversation.history.posts} posts are held; older ones are in Zulip.`, COLOR.warn, MONO, 11, false)
    }
    const active = this.settings.activeManifest
    for (const post of posts) {
      if (post.kind === 'ack') {
        add(`· Front received it · ${clock(post.at)}`, COLOR.dim, MONO, 10.5, false)
        cursor += 4
        continue
      }
      if (post.kind === 'developer') {
        row('user', null, '👤', post.by, COLOR.accent2, post.content, COLOR.muted, post.at)
        continue
      }
      if (post.kind === 'other') {
        const known = FrontDeskSettings.bySender(active, post.by)
        row(known ? 'character' : 'other', known?.face ?? null, '?', known ? known.name : post.by, known ? COLOR.other : COLOR.dim, post.content, COLOR.muted, post.at)
        continue
      }
      // Front's reply: its turns when it has a scene (each with the face of
      // the revision the scene names), the reply itself when not. Never both.
      const scene = post.dialogue && post.dialogue.turns.length > 0 ? post.dialogue : null
      const { manifest, note } = this.settings.resolve(scene?.settings_revision ?? null)
      const front = this.frontOf(manifest)
      if (!scene) {
        const frontLabel = front ? `${front.name}${front.nickname ? `（${front.nickname}）` : ''}` : post.by
        row('character', front?.face ?? null, 'F', frontLabel, COLOR.accent, post.content, COLOR.ink, post.at)
        if (post.dialogue_error) add(`⚠ scene unusable: ${post.dialogue_error}`, COLOR.warn, MONO, 10.5)
        continue
      }
      if (note) add(`⚠ ${note}`, COLOR.warn, MONO, 10.5, false)
      for (const turn of scene.turns) {
        const character = FrontDeskSettings.character(manifest, turn.character)
        const isFront = character !== null && character === front
        const label = character ? `${character.name}${character.nickname ? `（${character.nickname}）` : ''}` : `${turn.character} · not in these settings`
        row('character', character?.face ?? null, '?', label, isFront ? COLOR.accent : character ? COLOR.other : COLOR.warn, turn.text, COLOR.ink, post.at)
        cursor -= 4
        if (turn.sources.length) add(turn.sources.map(citation).join('   '), COLOR.dim, MONO, 10)
      }
      const links = linksIn(post.content)
      if (links.length) {
        for (const link of links) {
          const chip = this.text(textX, y + cursor, `🔗 ${link.label}`, MONO, 10.5, COLOR.accent2)
            .setBackgroundColor('#1b2030').setPadding(6, 3, 6, 3)
            .setInteractive({ useHandCursor: true })
            .on('pointerup', () => window.open(link.url, '_blank', 'noopener'))
          this.historyList.add(chip)
          cursor += chip.height + 4
        }
      }
      cursor += 6
    }
    this.historyHeight = cursor
    this.scrollHistory(0)
  }

  private renderConversationChips() {
    for (const chip of this.conversationChips) chip.destroy()
    this.conversationChips = []
    if (!this.historyOpen) return
    const rows = this.board?.conversations ?? []
    const { x: panelX } = { x: this.historyViewport.x - 8 }
    let chipX = panelX + 14
    let chipY = this.historyViewport.y - 6 - this.conversationChipRows() * 24
    const width = this.historyViewport.width + 16
    for (const row of this.recentConversations(rows)) {
      const active = row.id === this.conversationId
      const label = `${row.resolved ? '✔ ' : ''}${row.id}`
      const chip = this.text(0, 0, label, MONO, 10.5, active ? '#0d0f14' : COLOR.muted)
        .setBackgroundColor(active ? '#70c7ff' : '#1b2030').setPadding(7, 3, 7, 3)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => this.openConversation(row.id))
      if (chipX + chip.width > panelX + width - 14) {
        chipX = panelX + 14
        chipY += 24
      }
      chip.setPosition(chipX, chipY)
      chipX += chip.width + 6
      this.conversationChips.push(chip)
      this.historyPanel.add(chip)
    }
  }

  private recentConversations(rows: DeskConversationRow[]): DeskConversationRow[] {
    const sorted = [...rows].sort((a, b) => (b.last_post?.at ?? 0) - (a.last_post?.at ?? 0))
    const recent = sorted.slice(0, 8)
    if (!recent.some((row) => row.id === this.conversationId)) {
      recent.unshift({
        id: this.conversationId, topic: `front-desk-${this.conversationId}`, live_topic: `front-desk-${this.conversationId}`,
        resolved: false, posts: 0, last_post: null, status: { state: 'quiet', since: null, evidence: 'new' },
      })
    }
    return recent
  }

  private conversationChipRows(): number {
    // A rough count for the layout: the chips are ~130px each.
    const count = this.recentConversations(this.board?.conversations ?? []).length
    const perRow = Math.max(1, Math.floor((this.historyViewport.width + 16 - 28) / 136))
    return Math.max(1, Math.ceil(count / perRow))
  }

  // --- interaction --------------------------------------------------------------

  private turn(delta: 1 | -1) {
    const next = step(this.cursor, this.replies, delta, (r, t) => this.pagesOf(r, t))
    if (next.reply === this.cursor.reply && next.turn === this.cursor.turn && next.page === this.cursor.page) return
    this.cursor = next
    this.shownId = this.replies[this.cursor.reply]?.message_id ?? null
    this.renderDialogue()
    this.renderCaption()
    this.renderStatus()
  }

  private toggleHistory() {
    this.historyOpen = !this.historyOpen
    this.historyButton.setText(this.historyOpen ? 'hide history' : 'history')
    // The draft is untouched: it lives in the textarea, not in this panel.
    this.layout(this.scale.width, this.scale.height)
    if (this.historyOpen) {
      this.historyScroll = Number.MAX_SAFE_INTEGER
      this.scrollHistory(0)
      void this.refreshBoard()
    }
    this.keys.focus()
  }

  private scrollHistory(delta: number) {
    const overflow = Math.max(0, this.historyHeight - this.historyViewport.height)
    this.historyScroll = Math.max(0, Math.min(overflow, this.historyScroll + delta))
    this.historyList.setY(-this.historyScroll)
    this.clipHistory()
  }

  // The viewport is enforced per node rather than by a geometry mask: a mask
  // on a container's child did not clip under Phaser 4 (seen in the p1
  // screenshots), and a crop is plain arithmetic. Portraits are cropped the
  // same way as text; a badge (Graphics) is hidden whole when it crosses an
  // edge, since it cannot be cropped.
  private clipHistory() {
    const top = this.historyViewport.y
    const bottom = top + this.historyViewport.height
    for (const child of this.historyList.list) {
      if (child instanceof Phaser.GameObjects.Graphics) {
        // A badge is drawn at the row's top in its own coordinates
        // (`badge.setData('top')`); it cannot be cropped, so it is hidden
        // whole when it crosses an edge.
        const y0 = (child.getData('top') as number) - this.historyScroll
        child.setVisible(y0 >= top && y0 + AVATAR <= bottom)
        continue
      }
      const node = child as Phaser.GameObjects.Text | Phaser.GameObjects.Image
      const scaleY = node instanceof Phaser.GameObjects.Image ? node.scaleY : 1
      const height = node instanceof Phaser.GameObjects.Image ? AVATAR : node.height
      const y0 = node.y - this.historyScroll
      const y1 = y0 + height
      if (y1 <= top || y0 >= bottom) { node.setVisible(false); continue }
      node.setVisible(true)
      const cropTop = Math.max(0, top - y0)
      const cropBottom = Math.max(0, y1 - bottom)
      if (node instanceof Phaser.GameObjects.Image) {
        if (cropTop > 0 || cropBottom > 0) node.setVisible(false)
        continue
      }
      if (cropTop > 0 || cropBottom > 0) node.setCrop(0, cropTop / scaleY, node.width, (height - cropTop - cropBottom) / scaleY)
      else node.setCrop()
    }
  }

  private inside(pointer: Phaser.Input.Pointer, rect: Rect): boolean {
    return pointer.x >= rect.x && pointer.x <= rect.x + rect.width && pointer.y >= rect.y && pointer.y <= rect.y + rect.height
  }

  // --- helpers -----------------------------------------------------------------

  private text(x: number, y: number, content: string, fontFamily: string, size: number, color: string) {
    return this.add.text(x, y, content, { fontFamily, fontSize: `${size}px`, color })
  }

  private button(label: string, onClick: () => void, color = COLOR.muted) {
    return this.text(0, 0, label, MONO, 12, color)
      .setBackgroundColor('#1b2030').setPadding(10, 5, 10, 5)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', onClick)
  }
}
