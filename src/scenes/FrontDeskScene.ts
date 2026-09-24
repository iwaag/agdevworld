// A room: a graphic-novel scene for talking in one Zulip conversation.
//
// Two rooms share it (`roomState.ts`): the Front Desk — `#front` ›
// `front-desk-<id>`, talking with Front — and, since `argue` p2, the Arguing
// Room — `#argue` › `argue-<stem>`, where a human leads a discussion with
// every agent. The room is an adapter and a background; the scene is one.
//
// The conversation is drawn as a visual novel frame: the background fills the screen, Front's portrait stands in
// the lower left with the dialogue beside it, another character speaks from
// a portrait and text box in the upper left, a prompt bar runs along the
// bottom, and the whole history is a panel that can be shown or hidden.
// Everything visible is Phaser except the composer — a real, visible
// textarea over the bar, because a canvas cannot host an IME
// (`frontDeskInput.ts`) — and the links to the other room and the dashboard.
//
// Since `front_desk` p2 nothing drawn here is bundled: the faces, the names
// and the background come from the settings revision the relay serves
// (`frontDeskSettings.ts`), a dialogue is played with the revision it was
// written for, and a reply is turns to page through (`frontDeskPlayback.ts`).
// Replies that arrive while the user is reading queue behind the one on
// show, with a visible way to advance.
//
// **The discussion is plain, and the dialogue is a rendering of it.** Every
// agent post is a reply to page through. In the *dialogue* view its turns
// are Front's saved re-voicing (an interpretation, at one settings
// revision, each line citing the posts it came from); in the *original*
// view it is the post as written. A post with no rendering yet — or a failed
// one — is shown as written with the reason, so reading never waits for a
// rendering, and the composer always posts into the source conversation
// whichever view is on. An interpretation can be chosen, and another one
// asked for with the current settings; earlier ones keep their own faces.
//
// Nothing here decides what a post *is*. The relay says which posts are the
// human's, which are acks and which are agents' speech, who spoke and which
// renderings exist; this scene renders those words.
//
// Since `clearer_chat_ui` step 3 the relay also says what each post is for —
// progress, a report, or a request for somebody's answer — and which
// requests are still waiting (`postMeaning.ts`). The reply on show carries
// its label in either view (a rendering inherits its source post's), the
// strip above the dialogue lists what is waiting for *you* and takes you to
// each one, and picking one makes your next post name it as the answer.
// When the relay cannot be read the last known history stays on screen
// under an amber `unknown`, never a blank frame — the rule every
// relay-backed view in this app follows.

import Phaser from 'phaser'
import { announceCompleted } from '../completionState'
import { FrontDeskClosePanel } from '../frontDeskClosePanel'
import { createFrontDeskInput, type FrontDeskInputHandle } from '../frontDeskInput'
import {
  atEnd,
  citation,
  queuedAfter,
  renderingOf,
  repliesOf,
  settle,
  START,
  step,
  type Cursor,
  type PlayReply,
  type PlayTurn,
  type ViewMode,
} from '../frontDeskPlayback'
import { FrontDeskSettings } from '../frontDeskSettings'
import { LABEL_STYLE, labelOf, overtakenFor, pendingFor, requestOf, shortText, type PostLabel } from '../postMeaning'
import { AUTO, ago, clock, submitToken, type Citation, type Correlation, type PostMeaning, type RoomAdapter, type RoomDetail, type RoomRow } from '../roomState'
import { assetUrl, type SettingsCharacter, type SettingsManifest } from '../settingsState'
import { linksIn, paginate, wrapText, type FoundLink, type Measure } from '../textLayout'
import { ROOM_TINT_ALPHA, ROOM_TINT_COLOR } from './roomTint'

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BODY_PX = 18
const HISTORY_PX = 14
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
  // The post re-opened a ✔'d conversation. Said once, because what was
  // closed with it — the resolved work topics, an archived channel, a Done
  // Work — did **not** come back, and a bare "resumed" would imply it did.
  | { kind: 'resumed' }

interface Rect { x: number; y: number; width: number; height: number }

export interface FrontDeskOptions {
  adapter: RoomAdapter
  // The open conversation; null is a room with none open yet (a new argue
  // is opened by its first post).
  conversationKey: string | null
}

export class FrontDeskScene extends Phaser.Scene {
  private readonly adapter: RoomAdapter
  private conversationId: string | null
  private detail: RoomDetail | undefined
  private board: RoomRow[] | undefined
  // What the dialogue box plays: Front's re-voicing, or the posts as written.
  private mode: ViewMode = 'dialogue'
  // The interpretation asked for by revision; null follows the active settings.
  private wanted: string | null = null
  private renderNote: { text: string; color: string; until: number } | undefined
  private asking = false
  private signature = ''
  private unreadable: string | undefined
  private send: SendPhase = { kind: 'idle' }
  private sending = false
  private settings!: FrontDeskSettings
  // What the next post answers (`clearer_chat_ui` ex1): `auto` lets the
  // relay's next-post rule decide (it settles only a single pending one),
  // `answer` is a request picked from the strip, `none` an aside that must
  // leave every question waiting. Kept through a failed or uncertain send,
  // so the retry means the same; reset after a send and on a switch.
  private correlation: Correlation = AUTO

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
  private bgTint!: Phaser.GameObjects.Rectangle
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
  private sendButton!: Phaser.GameObjects.Text
  private counter!: Phaser.GameObjects.Text
  private historyButton!: Phaser.GameObjects.Text
  private newButton!: Phaser.GameObjects.Text
  private settingsButton!: Phaser.GameObjects.Text
  private finishButton!: Phaser.GameObjects.Text
  private viewButton!: Phaser.GameObjects.Text
  private interpretationButton!: Phaser.GameObjects.Text
  private reinterpretButton!: Phaser.GameObjects.Text
  // What the renderer is doing, from the detail payload the room already
  // reads: the one place the paid button's consequences are shown.
  private rendererLine!: Phaser.GameObjects.Text
  private closePanel: FrontDeskClosePanel | undefined
  private historyPanel!: Phaser.GameObjects.Container
  private historyBackdrop!: Phaser.GameObjects.Graphics
  private historyTitle!: Phaser.GameObjects.Text
  private historyList!: Phaser.GameObjects.Container
  private conversationChips: Phaser.GameObjects.Text[] = []
  // What the reply on show is for, beside its speaker's name.
  private labelChip!: Phaser.GameObjects.Text
  // What is waiting for the viewer, above the dialogue.
  private askChips: Phaser.GameObjects.Text[] = []

  constructor(options: FrontDeskOptions) {
    super({ key: 'frontdesk' })
    this.adapter = options.adapter
    this.conversationId = options.conversationKey
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
    // The shared room tint (`project_room` p1 step 4): the background at
    // full strength competed with the portraits and the panels, so every
    // image-backed room softens it the same way, at the same strength.
    this.bgTint = this.add.rectangle(0, 0, 10, 10, ROOM_TINT_COLOR, ROOM_TINT_ALPHA).setOrigin(0, 0)
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
    this.labelChip = this.text(0, 0, '', MONO, 11, COLOR.dim).setPadding(6, 2, 6, 2).setVisible(false)

    this.sendButton = this.button('Send ⏎ · buys a run', () => void this.submit(), COLOR.accent2)
    this.counter = this.text(0, 0, '', MONO, 10.5, COLOR.dim)
    this.historyButton = this.button('history', () => this.toggleHistory())
    this.newButton = this.button(this.adapter.words.newButton, () => this.startConversation())
    this.settingsButton = this.button('settings ⟳', () => void this.settings.refresh())
    // Finishing the conversation: a preview first, always. The button opens
    // the panel; only the panel's own button writes anything.
    this.finishButton = this.button('finish ✔', () => this.toggleClose(), COLOR.live)
    const completion = this.adapter.completion
    if (completion) {
      this.closePanel = new FrontDeskClosePanel({
        scene: this,
        source: completion,
        conversationId: () => this.conversationId ?? '',
        onChanged: () => {
          // Every relay-backed view on the page re-reads on this event; the
          // room's own list shows the ✔ through the same door.
          const conversation = this.detail?.conversation
          if (conversation) announceCompleted({ channel: conversation.channel, topic: conversation.topic })
          void this.refresh()
          void this.refreshBoard()
        },
      })
    } else {
      // A room without a completion door of its own shows no button that
      // could not do anything.
      this.finishButton.setVisible(false)
    }
    // Reading and writing, apart (`argue` p2 ex1). The two on the right only
    // change what this screen shows; the one on the left, drawn as an
    // action, asks Front for a run and confirms first.
    this.viewButton = this.button('', () => this.toggleView(), COLOR.accent)
    this.interpretationButton = this.button('', () => this.cycleInterpretation())
    this.reinterpretButton = this.button('', () => void this.reinterpret(), '#0d0f14')
      .setBackgroundColor(COLOR.warn)
    this.rendererLine = this.text(0, 0, '', MONO, 10.5, COLOR.dim)

    this.historyPanel = this.add.container(0, 0).setVisible(false)
    this.historyBackdrop = this.add.graphics()
    this.historyTitle = this.text(0, 0, 'HISTORY', MONO, 11, COLOR.accent2).setLetterSpacing(2)
    this.historyList = this.add.container(0, 0)
    this.historyPanel.add([this.historyBackdrop, this.historyTitle, this.historyList])

    // The composer is the textarea itself; the scene keeps the draft only
    // for the counter, the Send button and the submit.
    this.keys = createFrontDeskInput({
      onChange: (text) => {
        this.draft = text
        this.renderPrompt()
      },
      onSubmit: () => void this.submit(),
      onEscape: () => {
        if (this.closePanel?.open) this.closePanel.close()
        else if (this.historyOpen) this.toggleHistory()
      },
    })
    // Clicking anywhere on the frame puts the keyboard back in the bar.
    this.keys.focus()
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, over: unknown[]) => {
      this.keys.focus()
      // A click on the frame itself advances; a click on a button is the button's.
      if (this.closePanel?.contains(pointer)) return
      if (over.length === 0 && (this.inside(pointer, this.dialogueRect) || this.inside(pointer, this.coRect))) this.turn(1)
    })
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
      if (this.closePanel?.contains(pointer)) {
        this.closePanel.scrollBy(dy)
      } else if (this.historyOpen && this.inside(pointer, this.historyViewport)) {
        this.scrollHistory(dy)
      } else if (this.inside(pointer, this.dialogueRect) || this.inside(pointer, this.coRect)) {
        this.turn(dy > 0 ? 1 : -1)
      }
    })
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      this.failedTextures.add(file.key)
    })

    // The ways out: the other room, and the dashboard.
    const nav = document.createElement('nav')
    nav.style.cssText = 'position:fixed;top:10px;right:16px;z-index:20;display:flex;gap:8px'
    const demo = new URLSearchParams(location.search).get('demo') === '1'
    for (const [label, href] of [[this.adapter.other.label, this.adapter.other.href], ['Project Room ↗', demo ? '/?view=project&demo=1' : '/?view=project'], ['Operation room ↗', '/']]) {
      const link = document.createElement('a')
      link.href = href
      link.textContent = label
      link.style.cssText = 'color:#8dccff;font:12px system-ui;background:rgba(13,20,32,0.85);padding:6px 10px;border-radius:6px;text-decoration:none'
      nav.append(link)
    }
    document.body.append(nav)
    this.events.once('shutdown', () => { nav.remove(); this.keys.destroy(); this.closePanel?.destroy() })

    this.layout(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.layout(size.width, size.height))
    this.time.addEvent({ delay: REFRESH_MS, loop: true, callback: () => void this.refresh() })
    this.time.addEvent({ delay: BOARD_MS, loop: true, callback: () => void this.refreshBoard() })
    this.time.addEvent({ delay: 1000, loop: true, callback: () => this.renderStatus() })
    void this.settings.refresh()
    void this.refresh()
    void this.refreshBoard()
    // `&finish=1` opens the completion panel on arrival: a fixture's door
    // (the demo plays the whole flow), never a shortcut past the preview.
    if (new URLSearchParams(location.search).get('finish') === '1') this.toggleClose()
    // `&mode=original` opens on the posts as written.
    if (new URLSearchParams(location.search).get('mode') === 'original') this.mode = 'original'
  }

  // --- reads -----------------------------------------------------------------

  private async refresh() {
    const id = this.conversationId
    if (id === null) {
      // No conversation is open: the room's list is all there is to read.
      this.renderCaption()
      this.renderStatus()
      this.renderPrompt()
      return
    }
    const found = await this.adapter.detail(id)
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
    // Content and every rendering are part of the signature, so an edit and
    // an interpretation that lands later are visible too, not only a new post.
    const shown = conversation.presentation
    const signature = JSON.stringify([
      found.health.state, conversation.known, conversation.resolved, conversation.status,
      conversation.posts.map((post) => [post.message_id, post.content]),
      shown && [shown.active_revision, shown.pending, shown.failed.map((one) => one.job), shown.renderer.state,
        Object.entries(shown.renderings).map(([id, list]) => [id, list.map((one) => [one.job, one.stale])])],
      found.chat.configured,
      conversation.requests && conversation.requests.requests.map((row) => [row.id, row.state, row.settled_by]),
    ])
    if (signature !== this.signature) {
      this.signature = signature
      // A reader who had finished the newest reply is waiting for the next
      // one and is taken to it; a reader still inside a reply keeps it, and
      // what arrived queues behind with a visible way forward.
      const finished = this.cursor.reply < 0 || (queuedAfter(this.cursor, this.replies) === 0
        && atEnd(this.cursor, this.replies, (r, t) => this.pagesOf(r, t)))
      this.replies = repliesOf(conversation.posts, conversation.presentation, this.mode, this.wanted)
      this.pageCache.clear()
      this.cursor = settle(this.cursor, this.replies, this.shownId)
      if (finished && queuedAfter(this.cursor, this.replies) > 0) {
        this.cursor = { reply: this.cursor.reply + 1, turn: 0, page: 0 }
      }
      this.shownId = this.cursor.reply >= 0 ? this.replies[this.cursor.reply].message_id : null
      // A picked request that stopped waiting is no longer the target, and
      // "not an answer" means nothing once nothing waits for the viewer.
      const choice = this.correlation
      if (choice.kind === 'answer' && requestOf(conversation.requests, choice.id)?.state !== 'pending') this.correlation = AUTO
      if (choice.kind === 'none' && pendingFor(conversation.requests, this.viewer()).length === 0) this.correlation = AUTO
      this.renderDialogue()
      this.renderHistory()
    }
    this.renderAsks()
    this.renderCaption()
    this.renderStatus()
    this.renderPrompt()
  }

  private async refreshBoard() {
    const found = await this.adapter.list()
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
    const creating = this.conversationId === null && Boolean(this.adapter.create)
    if (!creating && (this.unreadable || !chat?.configured)) {
      this.send = { kind: 'failed', text: this.unreadable ?? chat?.reason ?? 'the relay cannot post right now' }
      this.renderStatus()
      return
    }
    if (chat?.max_chars && text.length > chat.max_chars) {
      this.send = { kind: 'failed', text: `${text.length} characters is over the ${chat.max_chars} the relay sends` }
      this.renderStatus()
      return
    }
    // One submit, one token: a double click, a second Enter or a retry after
    // a timeout all carry the same token and the relay refuses the repeat.
    this.sending = true
    this.send = { kind: 'sending', at: Date.now() / 1000 }
    this.renderStatus()
    this.renderPrompt()
    // With no conversation open the first post opens one (an argue); after
    // that a post goes into the source conversation, whichever view is on.
    const opening = this.conversationId === null
    const result = opening
      ? (this.adapter.create ? await this.adapter.create(text, submitToken()) : { sent: false, error: 'this room cannot open a conversation' })
      : await this.adapter.send(this.conversationId as string, text, submitToken(), this.correlation)
    this.sending = false
    if (result.sent && opening && result.key) {
      this.send = { kind: 'idle' }
      this.keys.set('')
      this.openConversation(result.key)
      void this.refreshBoard()
    } else if (result.sent) {
      this.send = result.resumed ? { kind: 'resumed' } : { kind: 'idle' }
      this.keys.set('')
      this.correlation = AUTO
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
    this.openConversation(this.adapter.newKey())
    this.keys.focus()
  }

  private openConversation(id: string | null) {
    if (id === this.conversationId) return
    // A plan is one conversation's. Switching drops it rather than leaving
    // another conversation's targets on the screen.
    this.closePanel?.close()
    this.conversationId = id
    this.wanted = null
    const url = new URL(location.href)
    if (id === null) url.searchParams.delete(this.adapter.param)
    else url.searchParams.set(this.adapter.param, id)
    history.replaceState(null, '', url)
    this.detail = undefined
    this.signature = ''
    this.replies = []
    this.cursor = START
    this.shownId = null
    this.pageCache.clear()
    this.send = { kind: 'idle' }
    this.correlation = AUTO
    this.historyScroll = 0
    this.renderAsks()
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

  // Who a turn is drawn as. A rendered turn names its character; a post as
  // written is drawn with its speaker's own character when the settings have
  // one (`sage:arxiv` by its label, an agent by its roster name), and with
  // the common icon under its label when they do not. Front — the account
  // itself, never a logical speaker on it — stands in the lower left.
  private speakerOf(turn: PlayTurn | null, manifest: SettingsManifest | null): { character: SettingsCharacter | null; label: string; front: boolean } {
    const home = this.frontOf(manifest)
    if (!turn) return { character: home, label: home?.name ?? 'Front', front: true }
    if (turn.character === null) {
      const character = FrontDeskSettings.forSpeaker(manifest, turn.agent, turn.speaker)
      const front = turn.agent === 'front' && !turn.speaker.includes(':')
      return { character: character ?? (front ? home : null), label: character?.name ?? turn.speaker, front }
    }
    const character = FrontDeskSettings.character(manifest, turn.character)
    const front = character !== null && character === home
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

    this.sendButton.setPosition(width - MARGIN - 12, barY + BAR_HEIGHT / 2).setOrigin(1, 0.5)
    this.counter.setPosition(this.sendButton.x - this.sendButton.width - 12, barY + BAR_HEIGHT / 2).setOrigin(1, 0.5)
    // The composer takes the bar's left part and grows upward from its
    // bottom edge; the counter and the Send button keep the right.
    this.renderPrompt()
    this.keys.place({
      x: MARGIN + 10, y: barY + 10,
      width: Math.max(40, this.counter.x - this.counter.width - 10 - (MARGIN + 10)), height: BAR_HEIGHT - 20,
    })

    const buttonsY = this.narrow ? 68 : 44
    this.historyButton.setPosition(width - MARGIN, buttonsY).setOrigin(1, 0)
    this.newButton.setPosition(this.historyButton.x - this.historyButton.width - 8, buttonsY).setOrigin(1, 0)
    this.finishButton.setPosition(this.newButton.x - this.newButton.width - 8, buttonsY).setOrigin(1, 0)
    const afterFinish = this.finishButton.visible ? this.finishButton.x - this.finishButton.width - 8 : this.newButton.x - this.newButton.width - 8
    this.settingsButton.setPosition(afterFinish, buttonsY).setOrigin(1, 0)
    // The view row sits under the room's buttons, right-aligned like them.
    const viewY = buttonsY + 30
    this.viewButton.setPosition(width - MARGIN, viewY).setOrigin(1, 0)
    this.interpretationButton.setPosition(this.viewButton.x - this.viewButton.width - 8, viewY).setOrigin(1, 0)
    // The paid action stands apart from the two read-only controls, with
    // the renderer's state under it.
    this.reinterpretButton.setPosition(this.interpretationButton.x - this.interpretationButton.width - 36, viewY).setOrigin(1, 0)
    this.rendererLine.setPosition(width - MARGIN, viewY + 28).setOrigin(1, 0)
    this.closePanel?.layout(width, barY)

    // History panel: right side, above the bar; the whole frame when narrow.
    const panelX = width - MARGIN - historyWidth
    const panelY = this.narrow ? 130 : 110
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
    this.renderAsks()
    this.renderPrompt()
    this.renderCaption()
    this.renderStatus()
  }

  // --- rendering ---------------------------------------------------------------

  private renderCaption() {
    const conversation = this.detail?.conversation
    const where = conversation ? `#${conversation.channel} › ${conversation.live_topic}`
      : this.conversationId === null ? 'no conversation open' : `${this.adapter.param} ${this.conversationId}`
    this.caption.setText(`${this.adapter.title} · ${where}`)
    this.renderViewButtons()
    if (this.conversationId === null) {
      this.health.setText('nothing is open — pick a conversation in the history panel, or start one below').setColor(COLOR.dim)
    } else if (this.unreadable) {
      this.health.setText(`⚠ UNKNOWN — ${this.unreadable}; last known history`).setColor(COLOR.warn)
    } else if (!this.detail) {
      this.health.setText('reading the conversation…').setColor(COLOR.dim)
    } else if (this.detail.health.state !== 'live') {
      this.health.setText(`⚠ UNKNOWN — ${this.detail.health.reason}; last known history`).setColor(COLOR.warn)
    } else {
      const chat = this.detail.chat.configured ? 'you post as the Developer' : (this.detail.chat.reason ?? 'chat read-only')
      const known = conversation?.known === 'read' ? ' · read from Zulip' : conversation?.known === 'unknown' ? ' · history unknown' : ''
      this.health.setText(`relay live · ${chat}${known}${conversation?.resolved ? ' · ✔ resolved' : ''}`).setColor(COLOR.live)
    }
    const view = this.manifestInView()
    const parts = [this.settings.summary()]
    if (this.current?.revision && !view.note) parts.push(`dialogue at ${this.current.revision.slice(0, 12)}`)
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
    const bgKey = this.texture(FrontDeskSettings.background(manifest, this.adapter.room), FALLBACK_BG)
    if (this.bg.texture.key !== bgKey) this.bg.setTexture(bgKey)
    const width = this.scale.width
    const height = this.scale.height
    const bgScale = Math.max(width / this.bg.width, height / this.bg.height)
    this.bg.setPosition(width / 2, height / 2).setScale(bgScale)
    this.bgTint.setPosition(0, 0).setSize(width, height)
    const portraitHeight = this.narrow ? Math.max(140, Math.min(height * 0.42, width * 0.4)) : Math.max(140, Math.min(height * 0.42, width * 0.3))
    this.portrait.setScale(portraitHeight / Math.max(1, this.portrait.height))

    for (const chip of this.chips) chip.destroy()
    this.chips = []

    const reply = this.current
    const turn = this.currentTurn
    const { x, y, width: boxWidth } = this.dialogueRect

    if (!reply || !turn) {
      this.speaker.setText(front?.name ?? 'Front')
      const placeholder = this.conversationId === null
        ? this.adapter.words.empty
        : this.detail === undefined
          ? '…'
          : this.detail.conversation.posts.length === 0
            ? this.adapter.words.empty
            : 'No agent has spoken in this conversation yet.'
      const box = this.boxFor({ character: null, text: placeholder, sources: [], speaker: 'Front', agent: 'front' }, null)
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
      this.labelChip.setVisible(false)
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
    this.placeLabel(reply.message_id, reply.meaning, who.front)
    this.renderLinks(reply)
  }

  // --- what a post is for ---------------------------------------------------------

  private viewer(): number | null {
    return this.detail?.conversation.viewer_id ?? null
  }

  private labelFor(messageId: number, meaning: PostMeaning | null | undefined): PostLabel | null {
    return labelOf(messageId, meaning, this.detail?.conversation.requests, this.viewer())
  }

  // The reply's label beside the name of the box it is spoken in. The same
  // label in the dialogue and the original view: it is the source post's.
  private placeLabel(messageId: number, meaning: PostMeaning | null, front: boolean) {
    const label = this.labelFor(messageId, meaning)
    if (!label) { this.labelChip.setVisible(false); return }
    const style = LABEL_STYLE[label.tone]
    const name = front ? this.speaker : this.coSpeaker
    this.labelChip.setText(`${label.icon} ${label.text}`).setColor(style.color)
      .setBackgroundColor(style.background ?? 'rgba(0,0,0,0)').setFontStyle(style.bold ? 'bold' : 'normal')
      .setPosition(name.x + name.width + 10, name.y).setOrigin(0, 0).setVisible(true)
  }

  // What is waiting for the viewer, above the dialogue: a count, one chip
  // per request (it takes you to the question and makes your next post its
  // answer), and a word when a question is held back because your newer
  // post is being read first. History is never read from here — only the
  // relay's current states.
  private renderAsks() {
    for (const chip of this.askChips) chip.destroy()
    this.askChips = []
    if (!this.labelChip) return
    const requests = this.detail?.conversation.requests
    const viewer = this.viewer()
    const waiting = pendingFor(requests, viewer)
    const held = overtakenFor(requests, viewer)
    const choice = this.correlation
    if (this.conversationId === null || (waiting.length === 0 && held.length === 0 && choice.kind === 'auto')) return
    const { x, y, width } = this.dialogueRect
    const limit = x + width - (this.queueButton.visible ? this.queueButton.width + 24 : 14)
    let chipX = x
    const place = (chip: Phaser.GameObjects.Text) => {
      if (chipX + chip.width > limit && this.askChips.length > 0) { chip.destroy(); return false }
      chip.setPosition(chipX, y - 8).setOrigin(0, 1)
      chipX += chip.width + 6
      this.askChips.push(chip)
      return true
    }
    const style = LABEL_STYLE['ask-you']
    if (waiting.length) {
      const asker = waiting[0].sender_name || 'Front'
      place(this.text(0, 0, `❓ ${waiting.length} waiting for your reply`, MONO, 11.5, style.color)
        .setBackgroundColor(style.background ?? '').setFontStyle('bold').setPadding(8, 4, 8, 4)
        .setInteractive({ useHandCursor: true }).on('pointerup', () => this.goToRequest(waiting[0].id)))
      // The choice comes before the chips, so it is never the one crowded out.
      if (choice.kind === 'none') {
        place(this.text(0, 0, `↷ NOT AN ANSWER — ${waiting.map((row) => `#${row.id}`).join(', ')} stay${waiting.length === 1 ? 's' : ''} waiting`,
          MONO, 11, '#0d0f14').setBackgroundColor('#b9bdd6').setFontStyle('bold').setPadding(7, 4, 7, 4))
      }
      for (const row of waiting) {
        const picked = choice.kind === 'answer' && row.id === choice.id
        const who = row.sender_name && row.sender_name !== asker ? `${row.sender_name}: ` : ''
        const chip = this.text(0, 0, `${picked ? '↩ answering ' : ''}#${row.id} ${who}${shortText(row.text, picked ? 34 : 26)}`, MONO, 11,
          picked ? '#0d0f14' : COLOR.warn)
          .setBackgroundColor(picked ? COLOR.accent2 : '#2a2210').setPadding(7, 4, 7, 4)
          .setInteractive({ useHandCursor: true })
          .on('pointerup', () => (picked ? this.choose(AUTO) : this.goToRequest(row.id)))
        if (!place(chip)) break
      }
      if (choice.kind === 'auto') {
        place(this.text(0, 0, waiting.length > 1 ? 'pick the one your next post answers' : 'your next post answers it',
          MONO, 10.5, COLOR.muted).setPadding(4, 4, 4, 4))
      }
      if (choice.kind !== 'none') place(this.button('↷ not an answer', () => this.choose({ kind: 'none' })).setFontSize(10.5))
      if (choice.kind !== 'auto') place(this.button('↺ automatic', () => this.choose(AUTO)).setFontSize(10.5))
    }
    if (held.length) {
      place(this.text(0, 0, `📩 ${held.map((row) => `#${row.id}`).join(', ')} was asked before your newer post was read — Front answers that first`,
        MONO, 10.5, COLOR.muted).setBackgroundColor('#1b2030').setPadding(7, 4, 7, 4))
    }
  }

  // Show the question and make the next post its answer.
  private goToRequest(id: number) {
    if (this.mode === 'dialogue' && !this.replies.some((reply) => reply.message_id === id)) this.mode = 'original'
    const found = this.replies.findIndex((reply) => reply.message_id === id)
    if (found >= 0) {
      this.cursor = { reply: found, turn: 0, page: 0 }
      this.shownId = id
    }
    this.highlighted = this.historyOpen ? id : this.highlighted
    this.choose({ kind: 'answer', id })
    this.renderDialogue()
    if (this.historyOpen) this.renderHistory()
    this.renderCaption()
    this.renderStatus()
  }

  private choose(choice: Correlation) {
    this.correlation = choice
    this.renderAsks()
    this.renderPrompt()
    this.keys.focus()
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
    // A logical speaker keeps its own label beside the face it borrows.
    const named = who.character ? `${who.character.name}${who.character.nickname ? `（${who.character.nickname}）` : ''}` : null
    const label = named ? (turn.speaker.includes(':') ? `${named} · ${turn.speaker}` : named)
      : turn.character === null ? who.label : `${who.label} · not in these settings`
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
    // A rendered line leads back to what was actually said: the chip opens
    // the cited post as written.
    for (const source of sources) {
      const label = citation(source)
      const chip = this.text(0, 0, `📎 ${label.length > maxLabel ? `${label.slice(0, maxLabel - 1)}…` : label}`, MONO, 11, COLOR.other)
        .setBackgroundColor('#1b1830').setPadding(8, 4, 8, 4)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => this.showSource(source))
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
      text = `posting… (${Math.round(now - this.send.at)}s)`
      color = COLOR.accent2
    } else if (this.send.kind === 'failed') {
      text = `✖ not sent — ${this.send.text}`
      color = COLOR.bad
    } else if (this.send.kind === 'uncertain') {
      text = `? uncertain — ${this.send.text}`
      color = COLOR.warn
    } else if (this.send.kind === 'resumed') {
      text = this.adapter.words.resumed
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
          text = `answered ${ago(since)} ago · nothing is asked of you`
          color = COLOR.live
          break
        case 'asking': {
          const waiting = pendingFor(conversation.requests, this.viewer()).length
          text = waiting ? `❓ ${waiting} question${waiting > 1 ? 's' : ''} for you — reply below (${ago(since)})`
            : `❓ waiting for somebody's reply (${ago(since)})`
          color = COLOR.warn
          break
        }
        case 'done':
          text = this.adapter.words.done
          color = COLOR.dim
          break
        case 'quiet':
          text = ''
          break
        default:
          text = `⚠ ${conversation.status.evidence}`
          color = COLOR.warn
      }
      // Why the reply on show is drawn the way it is: a rendering still to
      // come, a failed one, a stale one. The words are already on screen.
      const note = this.mode === 'dialogue' ? this.current?.note : null
      if (note) {
        text = `${text ? `${text} · ` : ''}${note}`
        if (this.current?.state !== 'pending') color = COLOR.warn
      }
    }
    if (this.renderNote && this.renderNote.until > now && this.send.kind === 'idle') {
      text = this.renderNote.text
      color = this.renderNote.color
    }
    // The status shares the box header with the speaker's name: it is cut
    // to what fits rather than drawn over the name.
    const labelled = this.labelChip.visible && Math.abs(this.labelChip.y - this.speaker.y) < 2
    const room = Math.max(60, this.dialogueRect.width - 36 - this.speaker.width - 16 - (labelled ? this.labelChip.width + 10 : 0))
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
    // A room with nothing open can still open something: the composer is
    // live as soon as the room has a way to create a conversation.
    const opening = this.conversationId === null && Boolean(this.adapter.create)
    const usable = !this.sending && (opening || (!this.unreadable && Boolean(chat?.configured) && this.detail?.health.state === 'live'))
    // The hints live in the textarea's placeholder; the key note beside the
    // counter, where there is room for it.
    const words = opening ? 'State what you want, to open a new argue…'
      : this.correlation.kind === 'answer' ? `Your answer to #${this.correlation.id}…`
        : this.correlation.kind === 'none' ? 'Not an answer — the questions above stay waiting…' : this.adapter.words.prompt
    this.keys.setPlaceholder(usable ? words : this.sending ? 'sending…' : 'chat is not available right now')
    this.keys.setDisabled(!usable)
    const max = chat?.max_chars
    const length = Array.from(this.draft).length
    const count = max ? `${length}/${max}` : ''
    const keysNote = this.narrow ? '' : '⏎ sends · ⇧⏎ newline'
    this.counter.setText([count, keysNote].filter(Boolean).join(' · ')).setColor(max && length > max ? COLOR.bad : COLOR.dim)
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

    if (this.conversationId === null) {
      add('No conversation is open. Pick one above, or state what you want in the bar below to open a new one.', COLOR.dim, FONT, HISTORY_PX, false)
    } else if (!this.detail) {
      add(this.unreadable ? `History unknown — ${this.unreadable}` : 'reading…', this.unreadable ? COLOR.warn : COLOR.dim, FONT, HISTORY_PX, false)
    } else if (posts.length === 0) {
      add(this.detail.conversation.known === 'unknown' ? 'History unknown — the relay could not read this conversation.' : 'Nothing has been posted in this conversation yet.', COLOR.dim, FONT, HISTORY_PX, false)
    }
    if (this.detail?.conversation.bounded) {
      add(`Only the newest ${posts.length} posts are held; older ones are in Zulip.`, COLOR.warn, MONO, 11, false)
    }
    const active = this.settings.activeManifest
    const shown = this.detail?.conversation.presentation ?? null
    let highlightAt: number | null = null
    for (const post of posts) {
      if (post.kind === 'ack') {
        add(`· ${post.speaker} received it · ${clock(post.at)}`, COLOR.dim, MONO, 10.5, false)
        cursor += 4
        continue
      }
      const marked = post.message_id === this.highlighted
      if (marked) highlightAt = cursor
      const meaning = this.labelFor(post.message_id, post.meaning)
      const tag = meaning ? ` · ${meaning.icon} ${meaning.text}` : ''
      const tagColor = meaning?.tone === 'ask-you' ? COLOR.warn : null
      if (post.kind === 'human') {
        row('user', null, '👤', `${post.by}${tag}${marked ? '  ◀ cited' : ''}`, marked ? COLOR.warn : COLOR.accent2, post.content, COLOR.muted, post.at)
        continue
      }
      // An agent's post: the turns of the interpretation on show when the
      // view is the dialogue and one exists (each with the faces of its own
      // revision and the posts it cites), the post as written otherwise —
      // and always as written for the post a citation pointed at.
      const found = this.mode === 'dialogue' && !marked
        ? renderingOf(shown?.renderings[String(post.message_id)], this.wanted, shown?.active_revision ?? null) : null
      const voiced = found?.turns.filter((turn) => !turn.plain && turn.character && turn.text) ?? []
      if (!found || voiced.length === 0) {
        const character = FrontDeskSettings.forSpeaker(active, post.agent, post.speaker)
          ?? (post.agent === 'front' && !post.speaker.includes(':') ? this.frontOf(active) : null)
        const isFront = post.agent === 'front' && !post.speaker.includes(':')
        const named = character ? `${character.name}${character.nickname ? `（${character.nickname}）` : ''}` : null
        const label = `${named ? (post.speaker.includes(':') ? `${named} · ${post.speaker}` : named) : post.speaker} · as written${tag}${marked ? '  ◀ cited' : ''}`
        row(character ? 'character' : 'other', character?.face ?? null, '?', label,
          marked ? COLOR.warn : tagColor ?? (isFront ? COLOR.accent : character ? COLOR.other : COLOR.dim), post.content, COLOR.ink, post.at)
      } else {
        const { manifest, note } = this.settings.resolve(found.settings_revision)
        const front = this.frontOf(manifest)
        if (note) add(`⚠ ${note}`, COLOR.warn, MONO, 10.5, false)
        if (found.stale) add('⚠ the post changed after this was rendered', COLOR.warn, MONO, 10.5, false)
        // The rendering inherits what its source post is for.
        if (meaning) add(`${meaning.icon} ${meaning.text} · #${post.message_id}`, tagColor ?? LABEL_STYLE[meaning.tone].color, MONO, 10.5, false)
        for (const turn of voiced) {
          const character = FrontDeskSettings.character(manifest, turn.character)
          const isFront = character !== null && character === front
          const label = character ? `${character.name}${character.nickname ? `（${character.nickname}）` : ''}` : `${turn.character} · not in these settings`
          row('character', character?.face ?? null, '?', label, isFront ? COLOR.accent : character ? COLOR.other : COLOR.warn, turn.text ?? '', COLOR.ink, post.at)
          cursor -= 4
          if (turn.sources.length) {
            const chip = this.text(textX, y + cursor, `📎 ${turn.sources.map(citation).join('   ')}`, MONO, 10, COLOR.dim)
              .setInteractive({ useHandCursor: true })
              .on('pointerup', () => this.showSource(turn.sources[0]))
            this.historyList.add(chip)
            cursor += chip.height + 4
          }
        }
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
    // A cited post is brought into view; otherwise the scroll stays put.
    if (highlightAt !== null) this.historyScroll = Math.max(0, highlightAt - 8)
    this.scrollHistory(0)
  }

  private renderConversationChips() {
    for (const chip of this.conversationChips) chip.destroy()
    this.conversationChips = []
    if (!this.historyOpen) return
    const rows = this.board ?? []
    const { x: panelX } = { x: this.historyViewport.x - 8 }
    let chipX = panelX + 14
    let chipY = this.historyViewport.y - 6 - this.conversationChipRows() * 24
    const width = this.historyViewport.width + 16
    for (const row of this.recentConversations(rows)) {
      const active = row.key === this.conversationId
      const label = `${row.asking ? `❓${row.asking} ` : ''}${row.resolved ? '✔ ' : ''}${row.label}`
      const chip = this.text(0, 0, label, MONO, 10.5, active ? '#0d0f14' : COLOR.muted)
        .setBackgroundColor(active ? '#70c7ff' : '#1b2030').setPadding(7, 3, 7, 3)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => this.openConversation(row.key))
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

  private recentConversations(rows: RoomRow[]): RoomRow[] {
    const sorted = [...rows].sort((a, b) => (b.last_post?.at ?? 0) - (a.last_post?.at ?? 0))
    const recent = sorted.slice(0, 8)
    const open = this.conversationId
    if (open !== null && !recent.some((row) => row.key === open)) {
      recent.unshift({ key: open, label: open, resolved: false, last_post: null })
    }
    return recent
  }

  private conversationChipRows(): number {
    // A rough count for the layout: the chips are ~130px each.
    const count = this.recentConversations(this.board ?? []).length
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

  private toggleClose() {
    if (!this.closePanel || this.conversationId === null) return
    this.closePanel.toggle()
    this.closePanel.layout(this.scale.width, this.scale.height - BAR_HEIGHT - MARGIN)
    this.keys.focus()
  }

  // --- the view: dialogue or original, and which interpretation ----------------

  private highlighted: number | null = null

  // Rebuild the replies for the view on show, keeping the reader on the
  // reply they were reading.
  private replay() {
    const conversation = this.detail?.conversation
    this.replies = conversation ? repliesOf(conversation.posts, conversation.presentation, this.mode, this.wanted) : []
    this.pageCache.clear()
    this.cursor = settle({ ...this.cursor, turn: 0, page: 0 }, this.replies, this.shownId)
    this.shownId = this.cursor.reply >= 0 ? this.replies[this.cursor.reply].message_id : null
    this.renderDialogue()
    this.renderHistory()
    this.renderCaption()
    this.renderStatus()
  }

  private toggleView() {
    this.mode = this.mode === 'dialogue' ? 'original' : 'dialogue'
    this.highlighted = null
    this.replay()
    this.keys.focus()
  }

  // Through the saved interpretations, newest first, and back to following
  // the active settings.
  private cycleInterpretation() {
    const choices = this.interpretationChoices()
    const at = choices.indexOf(this.wanted)
    this.wanted = choices[(at + 1) % choices.length]
    this.mode = 'dialogue'
    this.replay()
    this.keys.focus()
  }

  // Whether asking for another interpretation is possible right now. A
  // second click during a render is the likeliest accidental double spend,
  // so a busy renderer disables the button rather than warning after.
  private canReinterpret(): { ok: boolean; why: string } {
    const shown = this.detail?.conversation.presentation
    if (this.conversationId === null) return { ok: false, why: 'nothing is open' }
    if (this.asking) return { ok: false, why: 'asking…' }
    if (this.sending) return { ok: false, why: 'a post is on its way' }
    if (!this.settings.activeRevision) return { ok: false, why: 'no settings revision is active' }
    if (!this.detail?.chat.configured || this.unreadable || this.detail.health.state !== 'live') return { ok: false, why: 'the relay cannot write right now' }
    if (!this.detail.conversation.posts.some((post) => post.kind === 'agent')) return { ok: false, why: 'no agent has spoken yet' }
    if (shown?.renderer.state === 'rendering') return { ok: false, why: 'the renderer is busy' }
    return { ok: true, why: '' }
  }

  // Ask Front for an interpretation with the settings that are current now.
  // The earlier ones stay; this only adds one, and only because it was asked
  // — and confirmed, because it is the one paid write on this row.
  private async reinterpret() {
    const key = this.conversationId
    const can = this.canReinterpret()
    if (key === null || !can.ok) return
    const revision = this.settings.activeRevision
    const shown = this.detail?.conversation.presentation
    const agentPosts = this.detail?.conversation.posts.filter((post) => post.kind === 'agent').length ?? 0
    const saved = shown?.interpretations.length ?? 0
    const already = shown?.interpretations.some((one) => one.settings_revision === revision)
    const words = [
      `Ask Front to re-voice this ${this.adapter.room === 'argue' ? 'argue' : 'conversation'} with the current settings?`,
      '',
      `Settings revision: ${(revision ?? '').slice(0, 12)}${already ? ' (an interpretation at this revision already exists; a new one is still made)' : ''}`,
      `Speech to re-voice: ${agentPosts} agent post${agentPosts === 1 ? '' : 's'} — the cost follows their length`,
      `Saved interpretations: ${saved}, all kept; this adds one`,
      '',
      'This buys one presentation run. Nothing is posted into the discussion.',
    ].join('\n')
    if (!window.confirm(words)) { this.keys.focus(); return }
    this.asking = true
    this.renderViewButtons()
    const result = await this.adapter.render(key, revision, submitToken())
    this.asking = false
    const until = Date.now() / 1000 + 12
    this.renderNote = result.sent
      ? { text: `asked Front to re-voice this at settings ${(revision ?? 'current').slice(0, 12)} — earlier interpretations stay`, color: COLOR.other, until }
      : { text: `✖ not asked — ${result.error ?? 'the relay refused'}`, color: COLOR.bad, until }
    this.wanted = null
    this.renderStatus()
    this.renderViewButtons()
    this.keys.focus()
    await this.refresh()
  }

  // From a rendered line to what was actually said: the posts as written,
  // on the cited post, with the history open on it.
  private showSource(source: Citation) {
    const id = source.message_id
    if (id === null || id === undefined) return
    this.mode = 'original'
    this.highlighted = id
    const conversation = this.detail?.conversation
    this.replies = conversation ? repliesOf(conversation.posts, conversation.presentation, this.mode, this.wanted) : []
    const found = this.replies.findIndex((reply) => reply.message_id === id)
    if (found >= 0) {
      this.cursor = { reply: found, turn: 0, page: 0 }
      this.shownId = id
    }
    this.pageCache.clear()
    if (!this.historyOpen) this.toggleHistory()
    else { this.renderDialogue(); this.renderHistory() }
    this.renderCaption()
    this.renderStatus()
  }

  private renderViewButtons() {
    const shown = this.detail?.conversation.presentation ?? null
    this.viewButton.setText(this.mode === 'dialogue' ? 'view: dialogue ⇄' : 'view: original ⇄')
    // The cycler says that it cycles and where it is: `active` follows the
    // current settings, a revision is one saved interpretation.
    const choices = this.interpretationChoices()
    const at = Math.max(0, choices.indexOf(this.wanted))
    const which = this.wanted ? `rev ${this.wanted.slice(0, 8)}` : 'active = current settings'
    this.interpretationButton.setText(choices.length > 1
      ? `‹ interpretation ${at + 1}/${choices.length}: ${which} ›`
      : `interpretation: ${which} · none saved yet`)
      .setColor(COLOR.muted)
      .setAlpha(this.mode === 'dialogue' ? 1 : 0.5)
    // The paid action: what it will use, and whether it can be asked now.
    const can = this.canReinterpret()
    const revision = this.settings.activeRevision
    this.reinterpretButton
      .setText(this.asking ? 'asking Front…' : `re-voice with current settings ($)${revision ? ` · ${revision.slice(0, 8)}` : ''}`)
      .setAlpha(can.ok ? 1 : 0.35)
    if (can.ok) this.reinterpretButton.setInteractive({ useHandCursor: true })
    else this.reinterpretButton.disableInteractive()
    // The renderer, from the payload the room already reads: what is being
    // rendered, what failed, when it is not answering.
    const parts: string[] = []
    let color = COLOR.dim
    if (shown) {
      const state = shown.renderer.state
      if (state === 'rendering') { parts.push(`renderer: rendering ${shown.pending.length} post${shown.pending.length === 1 ? '' : 's'}…`); color = COLOR.accent2 }
      else if (state === 'unavailable') { parts.push(`⚠ renderer unavailable — ${shown.renderer.reason}`); color = COLOR.warn }
      else if (state === 'idle') parts.push('renderer: idle')
      else parts.push(`renderer: ${state}`)
      if (shown.failed.length) { parts.push(`✖ ${shown.failed.length} rendering${shown.failed.length === 1 ? '' : 's'} failed`); color = COLOR.warn }
      if (shown.requests.length) parts.push(`${shown.requests.length} re-voicing${shown.requests.length === 1 ? '' : 's'} asked`)
    }
    if (!can.ok && this.conversationId !== null && can.why !== 'the renderer is busy') parts.push(`re-voice: ${can.why}`)
    this.rendererLine.setText(parts.join(' · ')).setColor(color)
    // Their widths follow their words.
    this.interpretationButton.setX(this.viewButton.x - this.viewButton.width - 8)
    this.reinterpretButton.setX(this.interpretationButton.x - this.interpretationButton.width - 36)
  }

  private interpretationChoices(): (string | null)[] {
    const saved = (this.detail?.conversation.presentation?.interpretations ?? []).map((one) => one.settings_revision)
    return [null, ...saved.filter((revision, index) => saved.indexOf(revision) === index)]
  }

  private toggleHistory() {
    this.historyOpen = !this.historyOpen
    this.historyButton.setText(this.historyOpen ? 'hide history' : 'history')
    // The draft is untouched: it lives in the textarea, not in this panel.
    this.layout(this.scale.width, this.scale.height)
    if (this.historyOpen) {
      if (this.highlighted === null) this.historyScroll = Number.MAX_SAFE_INTEGER
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
