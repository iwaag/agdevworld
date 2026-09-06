// The chat panel: a thin wrapper around one Zulip topic.
//
// This file used to talk to an embedded assistant service that
// `modernize_agdevworld` p1 deleted in 2026-08-17, and it has been dead since
// (`POST /api/chat` has answered nothing for three weeks). README_DEV promised
// it would come back as "a thin wrapper over the Front agent's own Zulip
// conversation in a later phase"; this is that phase.
//
// What it shows is one routine's fire topic, `#front` › `front-routine-<name>`,
// exactly as the realm holds it: real posts only, nobody's summary, no local
// history of its own. What it sends is one post into that topic **as the
// Developer**, which serves Front and starts a paid run — that is not a side
// effect to be hidden, it is what a chat with an agent is, so the panel says so
// on the button.
//
// Selfnotes never arrive here: the relay drops them before the history exists,
// and refuses one typed by hand.

import {
  ago,
  at,
  loadRoutine,
  sendChat,
  type ChatStatus,
  type RoutineDetail,
  type RoutinePost,
} from './routineState'

const PANEL_CSS = `
#chat-panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: 340px;
  display: flex; flex-direction: column; box-sizing: border-box;
  background: rgba(13, 15, 20, 0.92); border-left: 1px solid #262b3d;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #f4f1ff; z-index: 10;
}
#chat-panel header {
  padding: 14px 16px 8px; border-bottom: 1px solid #1c2130;
}
#chat-panel header .cp-kind {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; letter-spacing: 3px; color: #70c7ff;
}
#chat-panel header .cp-topic {
  display: block; margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; color: #c3c7de; word-break: break-all;
}
#chat-panel header .cp-note {
  display: block; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px; color: #777a91; line-height: 1.45;
}
#chat-panel header .cp-note.live { color: #67e8a5; }
#chat-panel header .cp-note.warn { color: #ffc56d; }
#chat-messages {
  flex: 1; overflow-y: auto; padding: 12px 14px; display: flex;
  flex-direction: column; gap: 10px;
}
.chat-msg { max-width: 92%; padding: 8px 12px; border-radius: 12px; font-size: 12.5px;
  line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.chat-msg .chat-who {
  display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; letter-spacing: 1px; color: #9a9db5; margin-bottom: 3px;
}
.chat-msg.developer { align-self: flex-end; background: #1f3a5f; }
.chat-msg.agent { align-self: flex-start; background: #151927; border: 1px solid #262b3d; }
/* Front's transport ack is not conversation, and a panel that renders it like
   one turns a quiet topic into a busy-looking one. */
.chat-msg.ack { align-self: flex-start; background: none; border: 1px dashed #2c3550;
  color: #777a91; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px;
  padding: 3px 9px; }
.chat-msg.fire { align-self: stretch; background: #14202c; border: 1px solid #2b4257;
  color: #a8c8e6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.chat-msg.pending { color: #777a91; font-style: italic; }
.chat-msg.error { align-self: stretch; background: #2a1520; border: 1px solid #5f2740;
  color: #ffb3c8; }
.chat-empty { color: #777a91; font-size: 12px; line-height: 1.6; }
#chat-form { display: flex; flex-direction: column; gap: 6px; padding: 10px 14px;
  border-top: 1px solid #1c2130; }
#chat-input {
  resize: none; border-radius: 10px; border: 1px solid #262b3d;
  background: #10131c; color: #f4f1ff; padding: 8px 10px; font-size: 13px;
  font-family: inherit; outline: none;
}
#chat-input:focus { border-color: #70c7ff; }
#chat-input:disabled { color: #777a91; }
#chat-actions { display: flex; align-items: center; gap: 8px; }
#chat-count { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; color: #777a91; }
#chat-count.over { color: #ff8aa8; }
#chat-send {
  margin-left: auto; border: none; border-radius: 10px; background: #70c7ff; color: #0d0f14;
  font-weight: 700; font-size: 12px; padding: 6px 14px; cursor: pointer;
}
#chat-send:disabled { background: #33405a; color: #777a91; cursor: default; }
`

// Front's own ack, spelled here because the panel styles it differently. It is
// `agag.agent.SWEEP_ACK`; the relay says the same thing about it in its states.
const ACK = 'Message received. Please wait for the reply.'
const FIRE = /^\s*Routine\s+`?[^`\s,]+`?,\s*run of\b/
// The realm side needs no timer — the relay holds an event queue — but the
// browser still has to ask. Five seconds against a loopback relay that answers
// from memory, and no Zulip call is made by any of it.
const REFRESH_MS = 5000

export interface ChatPanelHandle {
  // Show a routine's fire topic. `undefined` puts the panel back to its
  // "nothing selected" state.
  select: (name: string | undefined) => void
  update: (detail: RoutineDetail) => void
  unavailable: (reason: string) => void
  highlight: (since: number | undefined, until?: number, scroll?: boolean) => void
  selected: () => string | undefined
  // Put text in the box **without sending it**. The popup's "Ask Front" uses
  // this: a run is bought by a human pressing Send, never by a click that
  // happened to be near a card.
  compose: (text: string) => void
  onUpdate: (listener: (detail: RoutineDetail) => void) => void
}

export function initChatPanel(options: { mount?: HTMLElement; managed?: boolean; onRefresh?: () => void } = {}): ChatPanelHandle {
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  document.head.append(style)

  const panel = document.createElement('div')
  panel.id = 'chat-panel'
  panel.innerHTML = `
    <header>
      <span class="cp-kind">routine chat</span>
      <span class="cp-topic"></span>
      <span class="cp-note"></span>
    </header>
    <div id="chat-messages"></div>
    <form id="chat-form">
      <textarea id="chat-input" rows="3" placeholder="Say something to Front in this topic…"></textarea>
      <div id="chat-actions">
        <span id="chat-count"></span>
        <button id="chat-send" type="submit">Send · buys a run</button>
      </div>
    </form>
  `
  ;(options.mount ?? document.body).append(panel)

  const topicEl = panel.querySelector<HTMLSpanElement>('.cp-topic')!
  const noteEl = panel.querySelector<HTMLSpanElement>('.cp-note')!
  const messagesEl = panel.querySelector<HTMLDivElement>('#chat-messages')!
  const form = panel.querySelector<HTMLFormElement>('#chat-form')!
  const input = panel.querySelector<HTMLTextAreaElement>('#chat-input')!
  const sendButton = panel.querySelector<HTMLButtonElement>('#chat-send')!
  const countEl = panel.querySelector<HTMLSpanElement>('#chat-count')!

  let selected: string | undefined
  let status: ChatStatus | undefined
  let timer: number | undefined
  let sending = false
  let lastIds = ''
  const listeners: Array<(detail: RoutineDetail) => void> = []

  function bubble(className: string, who: string | undefined, text: string): HTMLDivElement {
    const node = document.createElement('div')
    node.className = `chat-msg ${className}`
    if (who) {
      const label = document.createElement('span')
      label.className = 'chat-who'
      label.textContent = who
      node.append(label)
    }
    node.append(document.createTextNode(text))
    messagesEl.append(node)
    return node
  }

  function renderEmpty(text: string) {
    messagesEl.replaceChildren()
    const node = document.createElement('div')
    node.className = 'chat-empty'
    node.textContent = text
    messagesEl.append(node)
  }

  function classOf(post: RoutinePost & { content: string }): string {
    if (FIRE.test(post.content)) return 'fire'
    if (post.content.trim() === ACK) return 'ack'
    return post.by === 'Developer' ? 'developer' : 'agent'
  }

  function renderChat(detail: RoutineDetail) {
    const posts = detail.chat_log ?? []
    // The relay is the source of the history, so a repaint only happens when
    // the history actually changed — otherwise the panel would scroll itself
    // away from what the reader is looking at every five seconds.
    const ids = JSON.stringify([detail.health.state, posts])
    if (ids === lastIds) return
    const atBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60 ||
      lastIds === ''
    lastIds = ids
    messagesEl.replaceChildren()
    if (posts.length === 0) {
      renderEmpty(detail.health.state === 'live' ? 'This routine has no posts in its fire topic yet.' : 'History unknown — no posts available in the last known evidence.')
      return
    }
    for (const post of posts) {
      const kind = classOf(post)
      const who = kind === 'ack' ? undefined : `${post.by} · ${ago(detail.generated_at - post.at)} ago`
      bubble(kind, who, kind === 'ack' ? 'ack — Front received it' : post.content).dataset.messageId = String(post.message_id)
    }
    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function renderStatus(detail: RoutineDetail) {
    status = detail.chat
    const live = detail.health.state === 'live'
    const answer = detail.routine.answer
    const parts = [
      live ? `realm live · observed ${at(detail.generated_at)}` : `Unknown — ${detail.health.reason}; last known history`,
      !live ? 'Current answer unknown' : answer.state === 'answered'
        ? `last fire answered in ${ago(answer.answered_after ?? null)}`
        : answer.state === 'no fire'
          ? 'never fired by the dispatcher'
          : `last fire ${ago(answer.age_seconds)} ago, ${answer.state}`,
    ]
    if (!status?.configured) parts.push(status?.reason ?? 'chat is read-only')
    noteEl.className = `cp-note${live ? (status?.configured ? ' live' : ' warn') : ' warn'}`
    noteEl.textContent = parts.join(' · ')
    const usable = live && Boolean(status?.configured) && !sending
    input.disabled = !usable
    sendButton.disabled = !usable
    countEl.textContent = status?.max_chars ? `${input.value.length}/${status.max_chars}` : ''
    countEl.className = status?.max_chars && input.value.length > status.max_chars ? 'over' : ''
  }

  async function refresh() {
    if (!selected) return
    if (options.managed) { options.onRefresh?.(); return }
    const name = selected
    const found = await loadRoutine(name)
    if (selected !== name) return
    if ('error' in found) {
      unavailable(found.error)
      return
    }
    renderChat(found)
    renderStatus(found)
    for (const listener of listeners) listener(found)
  }

  // `started` exists because the panel's first render is `select(undefined)`
  // and `undefined === undefined` would have made it a no-op — the panel came
  // up blank, with no header and no explanation, which is exactly the "empty
  // for a reason nobody stated" this application is built against. Found in
  // the first screenshot of this view and in no other way.
  let started = false
  function select(name: string | undefined) {
    if (name === selected && started) return
    started = true
    selected = name
    lastIds = ''
    status = undefined
    input.value = ''
    input.disabled = true
    sendButton.disabled = true
    window.clearInterval(timer)
    if (!name) {
      topicEl.textContent = ''
      noteEl.textContent = ''
      input.disabled = true
      sendButton.disabled = true
      renderEmpty('Pick a routine in the routines view to see its conversation with Front.')
      return
    }
    topicEl.textContent = `#front › front-routine-${name}`
    renderEmpty('reading the fire topic…')
    if (options.managed) return
    void refresh()
    // Only the selected routine is refreshed, and only from the relay's own
    // memory: this makes no Zulip call, which is the whole reason it is
    // allowed to be a timer at all.
    timer = window.setInterval(() => void refresh(), REFRESH_MS)
  }

  async function send(text: string) {
    if (!selected || sending) return
    const destination = selected
    sending = true
    sendButton.disabled = true
    input.disabled = true
    const pending = bubble('pending', undefined, 'posting to #front…')
    messagesEl.scrollTop = messagesEl.scrollHeight
    const found = await sendChat(`front-routine-${destination}`, text)
    pending.remove()
    sending = false
    if (selected !== destination) { await refresh(); return }
    if (!found.sent) {
      bubble('error', undefined, found.error ?? 'the post was refused')
      messagesEl.scrollTop = messagesEl.scrollHeight
      input.disabled = false
      sendButton.disabled = false
      return
    }
    // The post is in the realm; the relay's event queue carries it back within
    // a second or two and the next refresh renders it from there. Showing an
    // optimistic copy would mean de-duplicating against that, and the timer is
    // shorter than the round trip is worth.
    input.value = ''
    input.disabled = false
    sendButton.disabled = false
    lastIds = ''
    await refresh()
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (text === '' || sending || !status?.configured) return
    void send(text)
  })
  input.addEventListener('input', () => {
    if (!status?.max_chars) return
    countEl.textContent = `${input.value.length}/${status.max_chars}`
    countEl.className = input.value.length > status.max_chars ? 'over' : ''
  })
  // Enter sends in a chat box; this one buys a paid run, so it takes the
  // deliberate chord instead and plain Enter is a newline.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  function unavailable(reason: string) {
    status = undefined
    noteEl.className = 'cp-note warn'
    noteEl.textContent = `Unknown — ${reason}`
    input.disabled = true
    sendButton.disabled = true
    renderEmpty(`History unknown — ${reason}`)
    lastIds = ''
  }

  select(undefined)

  return {
    update(detail) {
      if (detail.routine.name !== selected) return
      renderChat(detail)
      renderStatus(detail)
    },
    unavailable,
    highlight(since, until, scroll = false) {
      let first: HTMLElement | undefined
      for (const node of messagesEl.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const id = Number(node.dataset.messageId)
        const active = since !== undefined && id >= since && (until === undefined || id < until)
        node.classList.toggle('session-span', active)
        if (active && !first) first = node
      }
      if (scroll && first) messagesEl.scrollTop = first.offsetTop - messagesEl.offsetTop
    },
    select,
    selected: () => selected,
    compose(text: string) {
      if (!selected) return
      input.value = input.value.trim() === '' ? text : `${input.value.trim()}\n\n${text}`
      input.focus()
      input.dispatchEvent(new Event('input'))
    },
    onUpdate(listener) {
      listeners.push(listener)
    },
  }
}

export { at }
