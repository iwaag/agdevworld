// DOM overlay chat panel on the right side of the screen. Phaser keeps the
// full-screen #app canvas underneath; this is an absolutely-positioned sibling.

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const PANEL_CSS = `
#chat-panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: 340px;
  display: flex; flex-direction: column; box-sizing: border-box;
  background: rgba(13, 15, 20, 0.92); border-left: 1px solid #262b3d;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #f4f1ff; z-index: 10;
}
#chat-panel header {
  padding: 14px 16px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; letter-spacing: 3px; color: #70c7ff; border-bottom: 1px solid #1c2130;
}
#chat-messages {
  flex: 1; overflow-y: auto; padding: 12px 14px; display: flex;
  flex-direction: column; gap: 10px;
}
.chat-msg { max-width: 90%; padding: 8px 12px; border-radius: 12px; font-size: 13px;
  line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.chat-msg.user { align-self: flex-end; background: #1f3a5f; }
.chat-msg.assistant { align-self: flex-start; background: #151927; border: 1px solid #262b3d; }
.chat-msg.pending { color: #777a91; font-style: italic; }
.chat-msg.error { align-self: stretch; background: #2a1520; border: 1px solid #5f2740;
  color: #ffb3c8; }
#chat-form { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid #1c2130; }
#chat-input {
  flex: 1; resize: none; border-radius: 10px; border: 1px solid #262b3d;
  background: #10131c; color: #f4f1ff; padding: 8px 10px; font-size: 13px;
  font-family: inherit; outline: none;
}
#chat-input:focus { border-color: #70c7ff; }
#chat-send {
  border: none; border-radius: 10px; background: #70c7ff; color: #0d0f14;
  font-weight: 700; font-size: 13px; padding: 0 16px; cursor: pointer;
}
#chat-send:disabled { background: #33405a; color: #777a91; cursor: default; }
`

export interface AssistantAction {
  action: string
  [key: string]: unknown
}

// Pull action JSON objects like {"action":"switch_view","view":"nodes"} out of
// a reply. Deliberately forgiving: small local models mangle formats, so the
// object is accepted anywhere in the text (fenced or inline); anything that
// fails to parse stays visible. Empty code fences left behind are removed.
export function extractAssistantActions(reply: string): { text: string; actions: AssistantAction[] } {
  const actions: AssistantAction[] = []
  let text = reply.replace(/\{[^{}]*"action"\s*:\s*"[^"]*"[^{}]*\}/g, (match) => {
    try {
      const parsed: unknown = JSON.parse(match)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as AssistantAction).action === 'string') {
        actions.push(parsed as AssistantAction)
        return ''
      }
    } catch {
      // fall through: keep unparsable text visible
    }
    return match
  })
  text = text
    .replace(/```[a-zA-Z]*\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, actions }
}

export function initChatPanel(getContext: () => string, onAction?: (action: AssistantAction) => void): void {
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  document.head.append(style)

  const panel = document.createElement('div')
  panel.id = 'chat-panel'
  panel.innerHTML = `
    <header>assistant</header>
    <div id="chat-messages"></div>
    <form id="chat-form">
      <textarea id="chat-input" rows="2" placeholder="Ask about the cluster…"></textarea>
      <button id="chat-send" type="submit">Send</button>
    </form>
  `
  document.body.append(panel)

  const messagesEl = panel.querySelector<HTMLDivElement>('#chat-messages')!
  const form = panel.querySelector<HTMLFormElement>('#chat-form')!
  const input = panel.querySelector<HTMLTextAreaElement>('#chat-input')!
  const sendButton = panel.querySelector<HTMLButtonElement>('#chat-send')!

  const history: ChatMessage[] = []

  function addBubble(className: string, text: string): HTMLDivElement {
    const bubble = document.createElement('div')
    bubble.className = `chat-msg ${className}`
    bubble.textContent = text
    messagesEl.append(bubble)
    messagesEl.scrollTop = messagesEl.scrollHeight
    return bubble
  }

  async function send(question: string) {
    history.push({ role: 'user', content: question })
    addBubble('user', question)
    const pending = addBubble('assistant pending', 'thinking…')
    sendButton.disabled = true
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, context: getContext() }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || typeof data?.reply !== 'string') {
        history.pop()
        pending.remove()
        const offline = data?.error === 'assistant_offline'
        addBubble('error', offline ? `assistant offline — ${data.detail}` : 'The assistant request failed.')
        return
      }
      history.push({ role: 'assistant', content: data.reply })
      const { text, actions } = extractAssistantActions(data.reply)
      for (const action of actions) onAction?.(action)
      pending.className = 'chat-msg assistant'
      pending.textContent = text !== '' ? text : 'OK.'
      messagesEl.scrollTop = messagesEl.scrollHeight
    } catch {
      history.pop()
      pending.remove()
      addBubble('error', 'assistant offline — the assistant service is unreachable.')
    } finally {
      sendButton.disabled = false
      input.focus()
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const question = input.value.trim()
    if (question === '' || sendButton.disabled) return
    input.value = ''
    void send(question)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
}
