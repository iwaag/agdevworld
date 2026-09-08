// Front Desk: a graphic-novel scene for talking with Front.
//
// One Zulip conversation, `#front` › `front-desk-<id>`, drawn as a visual
// novel frame: the background fills the screen, Front's portrait stands in
// the lower left, the latest reply is the dialogue beside it, a prompt bar
// runs along the bottom, and the whole history is a panel that can be shown
// or hidden. Everything visible is Phaser; the only DOM is the hidden
// textarea that gives the prompt bar an IME (`frontDeskInput.ts`) and the
// link back to the dashboard.
//
// Nothing here decides what a post *is*. The relay says which posts are the
// Developer's, which are Front's acks and which are replies, and whether a
// reply is owed; this scene renders those words. When the relay cannot be
// read the last known history stays on screen under an amber `unknown`, never
// a blank frame — the rule every relay-backed view in this app follows.

import Phaser from 'phaser'
import { createFrontDeskInput, type FrontDeskInputHandle } from '../frontDeskInput'
import {
  ago,
  clock,
  newConversationId,
  submitToken,
  type DeskBoard,
  type DeskConversationRow,
  type DeskDetail,
  type DeskPost,
  type DeskSource,
} from '../frontDeskState'
import { linksIn, paginate, wrapText, type Measure } from '../textLayout'

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BODY_PX = 18
const HISTORY_PX = 14
const PROMPT_PX = 16
const REFRESH_MS = 4000
const BOARD_MS = 30000
const BAR_HEIGHT = 64
const MARGIN = 16

const COLOR = {
  ink: '#f7f4ff',
  muted: '#b9bdd6',
  dim: '#7d8199',
  accent: '#ffb3d9',
  accent2: '#70c7ff',
  live: '#67e8a5',
  warn: '#ffc56d',
  bad: '#ff8aa8',
}

type SendPhase =
  | { kind: 'idle' }
  | { kind: 'sending'; at: number }
  | { kind: 'failed'; text: string }
  | { kind: 'uncertain'; text: string }

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

  // The reply on show and how it is paged.
  private reply: DeskPost | null = null
  private pages: string[][] = [[]]
  private page = 0
  private lineHeight = BODY_PX * 1.5

  private historyOpen = false
  private historyScroll = 0
  private historyHeight = 0
  private historyViewport = { x: 0, y: 0, width: 0, height: 0 }
  private dialogueRect = { x: 0, y: 0, width: 0, height: 0 }

  private draft = ''
  private keys!: FrontDeskInputHandle
  private measure!: Measure
  private measureHistory!: Measure

  // Game objects
  private bg!: Phaser.GameObjects.Image
  private portrait!: Phaser.GameObjects.Image
  private frame!: Phaser.GameObjects.Graphics
  private caption!: Phaser.GameObjects.Text
  private health!: Phaser.GameObjects.Text
  private speaker!: Phaser.GameObjects.Text
  private body!: Phaser.GameObjects.Text
  private pageLabel!: Phaser.GameObjects.Text
  private prevButton!: Phaser.GameObjects.Text
  private nextButton!: Phaser.GameObjects.Text
  private status!: Phaser.GameObjects.Text
  private chips: Phaser.GameObjects.Text[] = []
  private promptText!: Phaser.GameObjects.Text
  private sendButton!: Phaser.GameObjects.Text
  private counter!: Phaser.GameObjects.Text
  private historyButton!: Phaser.GameObjects.Text
  private newButton!: Phaser.GameObjects.Text
  private historyPanel!: Phaser.GameObjects.Container
  private historyBackdrop!: Phaser.GameObjects.Graphics
  private historyTitle!: Phaser.GameObjects.Text
  private historyList!: Phaser.GameObjects.Container
  private historyMaskShape!: Phaser.GameObjects.Graphics
  private conversationChips: Phaser.GameObjects.Text[] = []

  constructor(options: FrontDeskOptions) {
    super({ key: 'frontdesk' })
    this.source = options.source
    this.conversationId = options.conversationId
  }

  preload() {
    this.load.image('frontdesk-bg', '/frontdesk/bg.png')
    this.load.image('frontdesk-portrait', '/frontdesk/agfront.jpg')
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

    this.bg = this.add.image(0, 0, 'frontdesk-bg').setOrigin(0.5, 0.5)
    this.frame = this.add.graphics()
    this.portrait = this.add.image(0, 0, 'frontdesk-portrait').setOrigin(0, 1)

    this.caption = this.text(MARGIN, 12, '', MONO, 12, COLOR.accent2).setLetterSpacing(2)
    this.health = this.text(MARGIN, 32, '', MONO, 11, COLOR.dim)
    this.speaker = this.text(0, 0, 'Front', FONT, 15, COLOR.accent).setFontStyle('bold')
    this.body = this.text(0, 0, '', FONT, BODY_PX, COLOR.ink)
    // One line of text tells the layout how tall a line is on this machine.
    const probe = this.text(0, 0, 'あA🙂', FONT, BODY_PX, COLOR.ink)
    this.lineHeight = Math.ceil(probe.height)
    probe.destroy()
    this.pageLabel = this.text(0, 0, '', MONO, 11, COLOR.dim)
    this.prevButton = this.button('◀', () => this.turn(-1))
    this.nextButton = this.button('▶', () => this.turn(1))
    this.status = this.text(0, 0, '', MONO, 11.5, COLOR.muted)

    this.promptText = this.text(0, 0, '', FONT, PROMPT_PX, COLOR.ink)
    this.sendButton = this.button('Send ⏎ · buys a run', () => void this.submit(), COLOR.accent2)
    this.counter = this.text(0, 0, '', MONO, 10.5, COLOR.dim)
    this.historyButton = this.button('history', () => this.toggleHistory())
    this.newButton = this.button('new conversation', () => this.startConversation())

    this.historyPanel = this.add.container(0, 0).setVisible(false)
    this.historyBackdrop = this.add.graphics()
    this.historyTitle = this.text(0, 0, 'HISTORY', MONO, 11, COLOR.accent2).setLetterSpacing(2)
    this.historyList = this.add.container(0, 0)
    this.historyMaskShape = this.make.graphics({ x: 0, y: 0 }, false)
    this.historyList.setMask(this.historyMaskShape.createGeometryMask())
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
    this.input.on('pointerdown', () => this.keys.focus())
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
      if (this.historyOpen && this.inside(pointer, this.historyViewport)) {
        this.scrollHistory(dy)
      } else if (this.inside(pointer, this.dialogueRect)) {
        this.turn(dy > 0 ? 1 : -1)
      }
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
    const signature = JSON.stringify([
      found.health.state, conversation.known, conversation.resolved, conversation.status,
      conversation.posts.map((post) => post.message_id), conversation.latest_reply?.message_id ?? null,
      found.chat.configured,
    ])
    if (signature !== this.signature) {
      this.signature = signature
      const previous = this.reply?.message_id
      this.reply = conversation.latest_reply
      if (this.reply?.message_id !== previous) this.page = 0
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
    this.reply = null
    this.page = 0
    this.send = { kind: 'idle' }
    this.historyScroll = 0
    this.renderDialogue()
    this.renderHistory()
    this.renderCaption()
    this.renderStatus()
    void this.refresh()
  }

  // --- layout ----------------------------------------------------------------

  private layout(width: number, height: number) {
    // Background: cover the frame, centred, aspect preserved.
    const bgScale = Math.max(width / this.bg.width, height / this.bg.height)
    this.bg.setPosition(width / 2, height / 2).setScale(bgScale)

    const barY = height - BAR_HEIGHT - MARGIN
    // Portrait: lower left, aspect preserved, sized by the frame.
    const portraitHeight = Math.max(160, Math.min(height * 0.42, width * 0.3))
    const portraitScale = portraitHeight / this.portrait.height
    this.portrait.setPosition(MARGIN, barY - 8).setScale(portraitScale)
    const portraitWidth = this.portrait.width * portraitScale

    const historyWidth = this.historyOpen ? Math.min(440, Math.max(280, width * 0.36)) : 0
    const dialogueX = MARGIN + portraitWidth + 14
    const dialogueWidth = Math.max(200, width - dialogueX - MARGIN - (historyWidth ? historyWidth + MARGIN : 0))
    const dialogueHeight = Math.min(portraitHeight, Math.max(160, height * 0.4))
    const dialogueY = barY - 8 - dialogueHeight
    this.dialogueRect = { x: dialogueX, y: dialogueY, width: dialogueWidth, height: dialogueHeight }

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
    this.frame.fillRoundedRect(MARGIN - 8, 6, Math.min(640, width * 0.6), 44, 8)

    this.speaker.setPosition(dialogueX + 18, dialogueY + 12)
    this.body.setPosition(dialogueX + 18, dialogueY + 38)
    // The status sits in the box's own header so it reads over any background.
    this.status.setPosition(dialogueX + dialogueWidth - 18, dialogueY + 14).setOrigin(1, 0)
    this.nextButton.setPosition(dialogueX + dialogueWidth - 14, dialogueY + dialogueHeight - 12).setOrigin(1, 1)
    this.prevButton.setPosition(this.nextButton.x - this.nextButton.width - 8, this.nextButton.y).setOrigin(1, 1)
    this.pageLabel.setPosition(this.prevButton.x - this.prevButton.width - 10, this.nextButton.y - 6).setOrigin(1, 1)

    this.promptText.setPosition(MARGIN + 16, barY + BAR_HEIGHT / 2).setOrigin(0, 0.5)
    this.sendButton.setPosition(width - MARGIN - 12, barY + BAR_HEIGHT / 2).setOrigin(1, 0.5)
    this.counter.setPosition(this.sendButton.x - this.sendButton.width - 12, barY + BAR_HEIGHT / 2).setOrigin(1, 0.5)
    this.keys.place({
      x: MARGIN + 12, y: barY + 8,
      width: Math.max(40, this.counter.x - this.counter.width - 8 - (MARGIN + 12)), height: BAR_HEIGHT - 16,
    })

    this.historyButton.setPosition(width - MARGIN, 44).setOrigin(1, 0)
    this.newButton.setPosition(this.historyButton.x - this.historyButton.width - 8, 44).setOrigin(1, 0)

    // History panel: right side, above the bar.
    const panelX = width - MARGIN - historyWidth
    const panelY = 80
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
      this.historyMaskShape.clear()
      this.historyMaskShape.fillStyle(0xffffff, 1)
      this.historyMaskShape.fillRect(this.historyViewport.x, this.historyViewport.y, this.historyViewport.width, this.historyViewport.height)
      this.renderConversationChips()
    }
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
  }

  private renderDialogue() {
    const { x, y, width, height } = this.dialogueRect
    const innerWidth = width - 36
    const textTop = y + 38
    const textBottom = y + height - 40
    const linkRows = this.reply ? Math.min(2, Math.ceil(linksIn(this.reply.content).length / 3)) : 0
    const linesPerPage = Math.max(1, Math.floor((textBottom - textTop - linkRows * 26) / this.lineHeight))

    for (const chip of this.chips) chip.destroy()
    this.chips = []

    if (!this.reply) {
      this.speaker.setText(this.detail?.conversation.posts.length ? 'Front' : 'Front Desk')
      const placeholder = this.detail === undefined
        ? '…'
        : this.detail.conversation.posts.length === 0
          ? 'A new conversation. Say something in the bar below — Front answers here, and every post is kept in the history panel.'
          : 'No reply from Front in this conversation yet.'
      this.pages = paginate(wrapText(placeholder, innerWidth, this.measure), linesPerPage)
      this.body.setColor(COLOR.muted)
    } else {
      this.speaker.setText(this.reply.by)
      this.pages = paginate(wrapText(this.reply.content, innerWidth, this.measure), linesPerPage)
      this.body.setColor(COLOR.ink)
    }
    this.page = Math.min(this.page, this.pages.length - 1)
    this.body.setText(this.pages[this.page].join('\n'))
    const paged = this.pages.length > 1
    this.pageLabel.setText(paged ? `${this.page + 1}/${this.pages.length}` : '')
    this.prevButton.setVisible(paged).setAlpha(this.page > 0 ? 1 : 0.35)
    this.nextButton.setVisible(paged).setAlpha(this.page < this.pages.length - 1 ? 1 : 0.35)

    // Link chips: every URL the reply carries, plus the topic in Zulip.
    const links = this.reply ? linksIn(this.reply.content) : []
    const zulip = this.detail?.conversation.zulip_url
    if (zulip) links.push({ label: 'open in Zulip', url: zulip })
    let chipX = x + 18
    let chipY = y + height - 12
    const rows: Phaser.GameObjects.Text[][] = [[]]
    for (const link of links) {
      const chip = this.text(0, 0, `🔗 ${link.label}`, MONO, 11, COLOR.accent2)
        .setBackgroundColor('#1b2030').setPadding(8, 4, 8, 4)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => window.open(link.url, '_blank', 'noopener'))
      if (chipX + chip.width > x + width - 90 && rows[rows.length - 1].length > 0) {
        rows.push([])
        chipX = x + 18
      }
      rows[rows.length - 1].push(chip)
      chip.setPosition(chipX, 0)
      chipX += chip.width + 6
      this.chips.push(chip)
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
    }
    this.status.setText(text).setColor(color)
  }

  private renderPrompt() {
    const chat = this.detail?.chat
    const usable = !this.sending && !this.unreadable && Boolean(chat?.configured) && this.detail?.health.state === 'live'
    const maxWidth = Math.max(40, (this.counter.x - this.counter.width - 12) - (MARGIN + 16))
    if (this.draft === '') {
      this.promptText.setText(usable ? 'Say something to Front… (Enter sends, Shift+Enter is a newline)' : 'chat is not available right now').setColor(COLOR.dim)
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

  private renderHistory() {
    this.historyList.removeAll(true)
    if (!this.historyOpen) return
    const { x, y, width } = this.historyViewport
    const posts = this.detail?.conversation.posts ?? []
    let cursor = 0
    const add = (text: string, color: string, font = FONT, size = HISTORY_PX, wrap = true) => {
      const lines = wrap ? wrapText(text, width - 24, this.measureHistory) : [text]
      const node = this.text(x + 10, y + cursor, lines.join('\n'), font, size, color)
      this.historyList.add(node)
      cursor += node.height + 4
      return node
    }
    if (!this.detail) {
      add(this.unreadable ? `History unknown — ${this.unreadable}` : 'reading…', this.unreadable ? COLOR.warn : COLOR.dim)
    } else if (posts.length === 0) {
      add(this.detail.conversation.known === 'unknown' ? 'History unknown — the relay could not read this conversation.' : 'Nothing has been posted in this conversation yet.', COLOR.dim)
    }
    if (this.detail?.conversation.history.bounded) {
      add(`Only the newest ${this.detail.conversation.history.posts} posts are held; older ones are in Zulip.`, COLOR.warn, MONO, 11)
    }
    for (const post of posts) {
      if (post.kind === 'ack') {
        add(`· Front received it · ${clock(post.at)}`, COLOR.dim, MONO, 10.5)
        cursor += 4
        continue
      }
      add(`${post.by} · ${clock(post.at)}`, post.kind === 'developer' ? COLOR.accent2 : COLOR.accent, MONO, 10.5)
      add(post.content, post.kind === 'developer' ? COLOR.muted : COLOR.ink)
      cursor += 8
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

  private turn(delta: number) {
    const next = Math.max(0, Math.min(this.pages.length - 1, this.page + delta))
    if (next === this.page) return
    this.page = next
    this.renderDialogue()
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
  }

  private inside(pointer: Phaser.Input.Pointer, rect: { x: number; y: number; width: number; height: number }): boolean {
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
