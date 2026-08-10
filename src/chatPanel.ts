// DOM overlay chat panel on the right side of the screen. Phaser keeps the
// full-screen #app canvas underneath; this is an absolutely-positioned sibling.
//
// The panel also runs the assistant's tools. `POST /api/chat` answers with
// prose, with tool calls, or with both; a call is executed here and its raw
// result is posted back in the next message list. Tools run in the browser
// because that is where the screen and the same-origin paths are.

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

// Resource guard, the same class as a wall-clock kill: without it a model that
// keeps calling tools polls this browser forever. The assistant is told the
// number; it is not a statement about whether its calls are worthwhile.
const MAX_TOOL_ROUNDS = 16
// One bound for one call, the same 60 s a single `wait` gets. It used to be
// 10 s, which is shorter than a node's own window takes to answer (3–28 s) —
// a path the assistant is told it can reach has to stay reachable long enough
// to answer.
const FETCH_TIMEOUT_MS = 60_000

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
.chat-msg.tool { align-self: flex-start; background: #101520; border: 1px dashed #2c3550;
  color: #777a91; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.chat-msg.error { align-self: stretch; background: #2a1520; border: 1px solid #5f2740;
  color: #ffb3c8; }
.chat-msg.image { padding: 4px; }
.chat-msg.image img { max-width: 100%; border-radius: 9px; display: block; cursor: zoom-in; }
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
// a reply. Nothing asks the assistant to write these any more — tool calls are
// the ordinary way — but a model that emits one anyway is understood rather
// than ignored. Anything that fails to parse stays visible.
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

export interface ChatPanelHandle {
  // Programmatically send a question as if the user typed it: it appears in
  // the history and goes through the same /api/chat seam. Ignored while a
  // request is already in flight.
  ask: (question: string) => void
}

export function initChatPanel(
  getContext: () => string,
  // Tools this panel does not own — the screen. Whatever the handler returns
  // is what the assistant reads; an unknown name is a fact, not a silence.
  runExternalTool: (call: ToolCall) => string,
): ChatPanelHandle {
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

  // Any same-origin path. The response is handed back whole — status, content
  // type and body — so the assistant reads what the server actually said,
  // including a refusal and its reason.
  async function runFetch(args: Record<string, unknown>): Promise<string> {
    const path = String(args.path ?? '')
    const method = String(args.method ?? 'GET').toUpperCase()
    const body = typeof args.body === 'string' ? args.body : undefined
    try {
      const response = await fetch(path, {
        method,
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const text = await response.text()
      return `HTTP ${response.status} ${response.headers.get('content-type') ?? ''}\n\n${text}`
    } catch (error) {
      return `fetch ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // The assistant paces its own polling; without this it can only spend rounds
  // as fast as the network answers. 60 s is a resource bound on one call, not
  // an opinion about how long a thing should take — and it is told the number.
  async function runWait(args: Record<string, unknown>): Promise<string> {
    const asked = Number(args.seconds)
    const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 60) : 0
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    return seconds === asked
      ? `waited ${seconds} seconds`
      : `waited ${seconds} seconds (${args.seconds} was asked for; one wait lasts at most 60)`
  }

  function showImage(args: Record<string, unknown>): string {
    const url = String(args.url ?? '')
    const bubble = addBubble('assistant image', '')
    const img = document.createElement('img')
    img.src = url
    img.alt = 'generated image'
    img.addEventListener('load', () => {
      messagesEl.scrollTop = messagesEl.scrollHeight
    })
    img.addEventListener('error', () => {
      bubble.className = 'chat-msg error'
      bubble.textContent = `this browser could not load ${url}`
    })
    img.addEventListener('click', () => window.open(url, '_blank'))
    bubble.append(img)
    return `the image at ${url} was placed in the conversation`
  }

  async function runTool(call: ToolCall): Promise<string> {
    addBubble('tool', `${call.name} ${JSON.stringify(call.arguments)}`)
    if (call.name === 'fetch') return runFetch(call.arguments)
    if (call.name === 'wait') return runWait(call.arguments)
    if (call.name === 'show_image') return showImage(call.arguments)
    return runExternalTool(call)
  }

  async function send(question: string) {
    history.push({ role: 'user', content: question })
    addBubble('user', question)
    sendButton.disabled = true
    let pending = addBubble('assistant pending', 'thinking…')
    try {
      for (let round = 0; ; round += 1) {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: history, context: getContext() }),
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || typeof data?.reply !== 'string') {
          pending.remove()
          const offline = data?.error === 'assistant_offline'
          addBubble('error', offline ? `assistant offline — ${data.detail}` : 'The assistant request failed.')
          return
        }

        const calls: ToolCall[] = Array.isArray(data.tool_calls) ? data.tool_calls : []
        history.push({ role: 'assistant', content: data.reply, tool_calls: calls })
        const { text, actions } = extractAssistantActions(data.reply)
        if (text !== '') {
          pending.className = 'chat-msg assistant'
          pending.textContent = text
          messagesEl.scrollTop = messagesEl.scrollHeight
        }

        // Inline action objects are the lenient alternative to a tool call.
        // They carry no call id, so the result goes back as an ordinary
        // message from this side rather than as a tool result.
        for (const action of actions) {
          const { action: name, ...rest } = action
          const result = await runTool({ id: `inline-${round}`, name, arguments: rest })
          history.push({ role: 'user', content: `[${name}] ${result}` })
        }

        if (calls.length === 0 && actions.length === 0) {
          if (text === '') {
            pending.className = 'chat-msg assistant'
            pending.textContent = 'OK.'
          }
          return
        }
        if (round >= MAX_TOOL_ROUNDS) {
          if (text === '') pending.remove()
          addBubble('error', `the tool budget for this reply is spent (${MAX_TOOL_ROUNDS} rounds).`)
          return
        }

        for (const call of calls) {
          const result = await runTool(call)
          history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result })
        }
        pending = addBubble('assistant pending', 'thinking…')
      }
    } catch {
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

  return {
    ask(question: string) {
      const trimmed = question.trim()
      if (trimmed === '' || sendButton.disabled) return
      void send(trimmed)
    },
  }
}
