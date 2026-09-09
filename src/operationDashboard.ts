import { loadOpsBoard } from './opsState'
import { initChatPanel } from './chatPanel'
import { renderSessionGraph, type GraphMode } from './sessionGraph'
import { loadRoutines, loadRoutine, loadInflight, requestRun, routineHeadline, runLine, ago, at, type RoutineBoard, type RoutineDetail, type RoutineSession } from './routineState'
import { closeCompletionPanel, completionPanelRoot, openCompletionPanel } from './completionPanel'
import { COMPLETED_EVENT } from './completionState'
import './operationParts.css'

// A session is a run topic (relay: `session.topic`), which is its identity.
const sessionKey = (session: RoutineSession) => session.topic
// How long a run request this screen posted is waited for before the list
// falls back to whatever the relay shows. The request is a paid Front run
// that reads the guide and opens the run topic — a minute or two, not a
// second; past five minutes the run is either listed or something else is
// wrong and the list should say what it sees.
const PENDING_REQUEST_MS = 300000
// Browser-side preferences. Wrapped because storage can be absent or throw
// (private windows, blocked site data) and the page must render without it.
const PREFS = 'agdevworld.operationRoom'
function readPref<T>(key: string, fallback: T): T {
  try { const found = JSON.parse(localStorage.getItem(PREFS) ?? '{}')[key]; return found === undefined ? fallback : found as T }
  catch { return fallback }
}
function writePref(key: string, value: unknown) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...JSON.parse(localStorage.getItem(PREFS) ?? '{}'), [key]: value })) } catch { /* no storage: the choice lives for this page only */ }
}
const RESOLUTION_MARK: Record<string, string> = { resolved: '✔ resolved', open: '○ open', unknown: '? unknown (relay)' }
// A run's title on a card: its id, which is what Front named the topic by.
const idOf = (topic: string) => topic.replace(/^routinerun-/, '')
const sessionTitle = (session: RoutineSession) => `Run ${idOf(session.topic)}`
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') {
  const node = document.createElement(tag)
  node.textContent = text; node.className = className
  return node
}

// One controller owns the selection and supplies every pane, including chat.
export async function initOperationDashboard(): Promise<void> {
  const host = element('main', '', 'operation-parts parts-shell dashboard')
  host.innerHTML = `<header class="dashboard-header"><div><span class="eyebrow">AGDEVWORLD</span><h1>Operation room</h1></div><nav class="parts-toolbar"><a href="/?parts=gauge" target="_blank" rel="opener">Cost gauge ↗</a><a href="/?view=frontdesk">Front Desk</a><a href="/?view=ops">Ops board</a><a href="/?view=nodes">World views</a><button class="refresh">Refresh</button></nav><p class="parts-health" role="status">Reading relay…</p></header>
    <div class="parts-grid"><aside class="routine-pane"><h2>Routines</h2><div class="routine-list"></div></aside>
    <section class="session-pane"><div class="pane-head"><h2>Recent runs <small>up to 3 visible · history, not capacity</small></h2><label class="show-resolved"><input type="checkbox"> Show resolved</label></div>
      <details class="new-session"><summary>Ask Front to run it</summary>
        <p class="ns-request"></p>
        <label class="ns-instruction">Conditions for this run (optional)<textarea rows="2" placeholder="e.g. until the 5-hour window is 50 % used; one repository only"></textarea></label>
        <div class="ns-row"><small class="ns-why"></small><button type="button" class="ns-start">Ask Front · buys a run</button></div>
        <p class="ns-result" role="status"></p>
      </details>
      <div class="session-list"></div><p class="session-history"></p></section>
    <section class="flow-pane"><div class="pane-head"><h2>Conversation flow</h2><div class="graph-mode" role="radiogroup" aria-label="Flow rendering"><button type="button" data-mode="compact">Compact</button><button type="button" data-mode="detailed">Detailed</button></div></div><div class="standing-request"></div><div class="parts-graph"></div><div class="parts-inflight">Host observation not loaded.</div></section>
    <aside class="chat-pane"><h2>Run record</h2><p class="chat-span-note"></p><p class="session-finish"><button type="button" class="finish-run">finish ✔ this run</button><small class="finish-why"></small></p><div class="chat-mount"></div></aside></div>`
  document.body.append(host)
  const find = (selector: string) => host.querySelector<HTMLElement>(selector)!
  const health = find('.parts-health'), graph = find('.parts-graph')
  const newSession = find('.new-session') as HTMLDetailsElement
  const instruction = find('.ns-instruction textarea') as HTMLTextAreaElement
  const startButton = find('.ns-start') as HTMLButtonElement
  const selection = { routine: new URLSearchParams(location.search).get('routine') ?? '', session: '' }
  let board: RoutineBoard | undefined, detail: RoutineDetail | undefined
  let generation = 0
  let refreshing = false
  let graphSignature = ''
  let inflightGeneration = 0, inflightBusy = false
  let lastInflightAt = 0, lastInflightName = ''
  let stopped = false
  let timer: number | undefined
  let starting = false
  const showResolved = find('.show-resolved input') as HTMLInputElement
  let graphMode: GraphMode = readPref<string>('graphMode', 'compact') === 'detailed' ? 'detailed' : 'compact'
  function drawGraphMode() {
    for (const button of host.querySelectorAll<HTMLButtonElement>('.graph-mode button')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === graphMode))
    }
  }
  drawGraphMode()
  showResolved.checked = readPref('showResolved', false)
  // A run request this screen posted and no run yet answers to. Front opens
  // the run topic from its own conversation; until it appears the card says
  // where the request went.
  let pendingRequest: { routine: string; id: number; desk: string; at: number } | undefined
  const chat = initChatPanel({ mount: find('.chat-mount'), managed: true, onRefresh: () => { void refresh() } })
  // Completion (`front_desk` p4): the selected run and the work it opened,
  // previewed and applied by the relay's shared operation. A run Front
  // finished is resolved already; the preview then says what of its work
  // is still open.
  const finishButton = find('.finish-run') as HTMLButtonElement
  finishButton.onclick = () => {
    const session = detail?.sessions.find(one => sessionKey(one) === selection.session)
    if (!session) return
    openCompletionPanel({ channel: session.channel, topic: session.topic }, { onChanged: () => { void refresh() } })
  }
  window.addEventListener(COMPLETED_EVENT, () => { void refresh() })
  function drawFinish(session: RoutineSession | undefined) {
    const why = find('.finish-why')
    if (!session) { finishButton.disabled = true; why.textContent = 'no run selected'; return }
    if (detail?.health.state !== 'live') { finishButton.disabled = true; why.textContent = 'unknown — a completion needs a live relay'; return }
    finishButton.disabled = false
    why.textContent = session.resolution.state === 'resolved'
      ? 'this run carries ✔ already (Front resolves a run it finished); the preview says what of its work is still open'
      : 'previews first; closes this run, its topics, channels and Plane Works — never the guide, the channel or another run'
  }

  function drawSession(scroll = false) { refocus(find('.session-list'), 'session', () => drawSessionCards(scroll)) }
  function drawSessionCards(scroll: boolean) {
    const list = find('.session-list'); list.replaceChildren()
    if (!detail) return
    const pending = pendingRequest && pendingRequest.routine === selection.routine ? pendingRequest : undefined
    if (pending && detail.sessions.some(session => (session.opened?.at ?? 0) * 1000 >= pending.at - 60000)) {
      // A run opened after the request: Front answered it. The pending card is over.
      pendingRequest = undefined; find('.ns-result').textContent = 'Front opened a run; it is listed below.'
    }
    const stillPending = pendingRequest && pendingRequest.routine === selection.routine && Date.now() - pendingRequest.at < PENDING_REQUEST_MS
    if (!detail.sessions.some(session => sessionKey(session) === selection.session)) {
      selection.session = detail.sessions[0] ? sessionKey(detail.sessions[0]) : ''
    }
    if (stillPending && pendingRequest) {
      const card = element('div', '', 'session-card pending')
      card.append(element('strong', 'Requested'), element('small', `Request #${pendingRequest.id} posted at Front's entrance (#front › front-desk-${pendingRequest.desk})`))
      card.append(element('small', 'Front reads the guide and opens the run; it appears here when it does', 'annotation'))
      const link = document.createElement('a'); link.href = `/?view=frontdesk&conv=${encodeURIComponent(pendingRequest.desk)}`; link.textContent = 'Open the Front Desk conversation'
      card.append(link)
      list.append(card)
    }
    for (const session of detail.sessions.slice(0, 3)) {
      const key = sessionKey(session)
      const live = detail.health.state === 'live'
      const button = element('button', '', 'session-card')
      button.dataset.session = key
      button.setAttribute('aria-pressed', String(selection.session === key))
      button.title = `#${session.channel} › ${session.topic}`
      button.append(element('strong', sessionTitle(session)))
      button.append(element('small', session.opened ? `Opened #${session.opened.message_id} by ${session.opened.by} · ${ago(detail.generated_at - session.opened.at)} ago · ${at(session.opened.at)}` : 'Opening post not held'))
      const origin = session.origin ? `From #${session.origin.channel} › ${session.origin.topic}` : 'Opened by hand'
      button.append(element('small', `${origin} · ${live ? `${session.run.state} · ${session.entries} ${session.entries === 1 ? 'entry' : 'entries'} · ${session.nodes.length} linked conversations` : 'unknown · last known links'}`))
      if (live && session.finish) {
        button.append(element('small', `${session.finish.achieved ? '✅ goal reached' : '⏹ goal not reached'} — ${session.finish.reason}`, 'annotation'))
      }
      const resolution = live ? session.resolution?.state ?? 'unknown' : 'unknown'
      const chip = element('small', RESOLUTION_MARK[resolution] ?? '? unknown (relay)', `resolution ${resolution}`)
      chip.title = session.resolution?.evidence ?? 'no resolution evidence reported'
      button.append(chip)
      if (session.history.bounded) button.append(element('small', `Window of ${session.history.post_limit} posts — older posts not held`, 'annotation'))
      button.onclick = () => { selection.session = key; lastInflightAt = 0; drawSession(true); void refreshInflight() }
      list.append(button)
    }
    if (!detail.sessions.length && !stillPending) {
      const hidden = detail.history?.hidden_resolved ?? 0
      list.textContent = detail.health.state !== 'live' ? 'Unknown — run history is not available.'
        : hidden > 0 ? `Every listed run is resolved and hidden (${hidden}). Turn on Show resolved to see them.` : 'No run observed.'
    }
    const history = detail.history
    find('.session-history').textContent = !history ? 'History limit unknown — this relay did not report its window.'
      : `${history.runs} run topic${history.runs === 1 ? '' : 's'} held (${history.open_runs} open) · ${history.hidden_resolved} resolved hidden · the newest ${history.deep_runs} are read whole, older ones only while open; a resolved run older than that is in Zulip, not here`
    const index = detail.sessions.findIndex(session => sessionKey(session) === selection.session)
    const session = detail.sessions[index]
    if (session) {
      const signature = JSON.stringify([selection.routine, selection.session, graphMode, detail.health.state, detail.health.reason, session])
      if (signature !== graphSignature) {
        const viewport = graph.querySelector('.graph-viewport')
        const previousScroll = scroll ? undefined : [viewport?.scrollLeft ?? 0, viewport?.scrollTop ?? 0]
        renderSessionGraph(graph, detail, session, graphMode)
        const nextViewport = graph.querySelector('.graph-viewport')
        if (previousScroll && nextViewport) { nextViewport.scrollLeft = previousScroll[0]!; nextViewport.scrollTop = previousScroll[1]! }
        graphSignature = signature
      }
      chat.show(detail, session)
      find('.chat-span-note').textContent = session.resolution.state === 'resolved'
        ? `#${session.channel} › ${session.topic} · ✔ resolved — this run is finished. Ask Front for another run to continue.`
        : `#${session.channel} › ${session.topic} · a post here is a word into Front's run and serves Front there.`
      drawFinish(session)
      const shown = completionPanelRoot()
      if (shown && (shown.channel !== session.channel || shown.topic !== session.topic)) closeCompletionPanel()
    } else if (stillPending && pendingRequest) {
      graphSignature = ''
      graph.textContent = `Waiting for Front to open a run of ${pendingRequest.routine}. Its conversations appear here once the run topic exists.`
      chat.show(detail, undefined, 'Waiting for Front to open the run…')
      find('.chat-span-note').textContent = `Request #${pendingRequest.id} at #front › front-desk-${pendingRequest.desk}.`
      drawFinish(undefined)
    } else {
      const hidden = detail.history?.hidden_resolved ?? 0
      graph.textContent = detail.health.state !== 'live' ? 'Unknown — no current run evidence.'
        : hidden > 0 ? `No visible run — ${hidden} resolved and hidden. Turn on Show resolved to inspect them.` : 'No run observed — this routine has no run topic yet.'
      chat.show(detail, undefined, detail.health.state !== 'live' ? undefined
        : hidden > 0 ? `Every listed run is resolved and hidden (${hidden}). Turn on Show resolved to read one.` : 'No run to show — ask Front to run the routine.')
      find('.chat-span-note').textContent = 'No run selected.'
      find('.parts-inflight').textContent = 'Host observation attaches to the latest run; none is selected.'
      drawFinish(undefined)
    }
    host.dataset.routine = selection.routine; host.dataset.session = selection.session
    if (session && !isLatest(session)) find('.parts-inflight').textContent = 'Host observation is latest-only; it is not attached to this older run.'
  }

  // Whether a session is the routine's actual newest run, judged against
  // the relay's `latest_topic` and not against the first visible card.
  function isLatest(session: RoutineSession): boolean {
    if (!detail) return false
    const latest = detail.latest_topic === undefined ? detail.sessions[0]?.topic ?? null : detail.latest_topic
    return session.topic === latest
  }
  function selectedIsLatest(): boolean {
    const session = detail?.sessions.find(one => sessionKey(one) === selection.session)
    return Boolean(session && isLatest(session))
  }

  // Why "Ask Front" cannot be pressed right now, or nothing when it can.
  function startBlocker(): string {
    if (!detail || !board) return 'No routine selected'
    if (detail.health.state !== 'live') return `Unknown — ${detail.health.reason}; a request needs a live relay`
    if (!detail.chat.configured) return detail.chat.reason ?? 'chat is read-only'
    if (detail.routine.retired) return `Retired — its guide carries ✔. Un-resolve #${detail.routine.channel} › guide to run it again.`
    if (!detail.routine.guide) return `No guide — write one in #${detail.routine.channel} › guide first.`
    if (starting) return 'Sending…'
    return ''
  }

  function drawNewSession() {
    const why = startBlocker()
    startButton.disabled = why !== ''
    find('.ns-why').textContent = why
    const guide = detail?.routine.guide
    find('.ns-request').textContent = !detail ? '' : guide
      ? `Guide (#${detail.routine.channel} › guide, #${guide.message_id}): ${guide.text.length > 280 ? `${guide.text.slice(0, 279)}…` : guide.text}`
      : 'Guide unknown — no post in the guide topic.'
    newSession.dataset.for = detail?.routine.name ?? ''
  }

  async function start() {
    if (!detail || startBlocker() !== '' || starting) return
    const name = detail.routine.name
    const text = instruction.value
    starting = true; drawNewSession()
    const result = find('.ns-result')
    result.className = 'ns-result'
    result.textContent = `Asking Front to run ${name}…`
    const found = await requestRun(name, text)
    starting = false
    if (!found.sent) {
      result.className = `ns-result ${found.uncertain ? 'uncertain' : 'error'}`
      result.textContent = found.uncertain
        ? `Uncertain — ${found.error}. The request may have landed; look at the Front Desk before asking again. ${found.note ?? ''}`.trim()
        : `Refused — ${found.error}`
      drawNewSession()
      return
    }
    instruction.value = ''
    pendingRequest = { routine: name, id: found.message_id!, desk: found.desk ?? '', at: Date.now() }
    result.textContent = `Request #${found.message_id} posted at Front's entrance (#${found.channel} › ${found.topic}). Front reads the guide and opens the run; it appears here when it does, and the report comes back to that conversation.`
    drawNewSession()
    if (selection.routine === name && detail) drawSession(true)
    void refresh()
  }
  startButton.onclick = () => { void start() }
  for (const button of host.querySelectorAll<HTMLButtonElement>('.graph-mode button')) {
    button.onclick = () => {
      const mode = button.dataset.mode === 'detailed' ? 'detailed' : 'compact'
      if (mode === graphMode) return
      graphMode = mode; writePref('graphMode', mode); drawGraphMode()
      if (detail) drawSession()
    }
  }
  showResolved.onchange = () => {
    writePref('showResolved', showResolved.checked)
    void selectRoutine()
  }

  // A redraw replaces the cards, and a keyboard user's focus would go with
  // them every five seconds. Remember which card had it and give it back.
  function refocus(list: HTMLElement, attribute: 'routine' | 'session', draw: () => void) {
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
      ? document.activeElement.dataset[attribute] : undefined
    draw()
    if (focused !== undefined) list.querySelector<HTMLElement>(`[data-${attribute}="${CSS.escape(focused)}"]`)?.focus()
  }

  function drawRoutines() { refocus(find('.routine-list'), 'routine', drawRoutineCards) }
  function drawRoutineCards() {
    const list = find('.routine-list'); list.replaceChildren()
    if (!board) return
    for (const row of board.routines) {
      const live = board.health.state === 'live'
      const selected = row.name === selection.routine
      const button = element('button', '', `routine-card${row.retired ? ' retired' : ''}`); button.dataset.routine = row.name
      button.setAttribute('aria-pressed', String(selected))
      const display = row.display ?? { icon: '▫', icon_source: 'assigned', title: row.name, title_source: 'name' }
      const head = element('span', '', 'rc-head')
      const icon = element('span', display.icon, 'rc-icon'); icon.setAttribute('aria-hidden', 'true')
      icon.title = display.icon_source === 'assigned' ? 'Icon assigned from the name; add a `display:` line to the guide to choose one' : `Icon from the guide (${display.icon_source})`
      const title = element('strong', display.title, 'rc-title')
      head.append(icon, title)
      button.append(head)
      button.setAttribute('aria-label', `${display.title}${display.title !== row.name ? ` (${row.name})` : ''}${row.retired ? ', retired' : ''}, ${live ? row.state : 'unknown'}`)
      const secondary = [display.title !== row.name ? row.name : '', row.retired ? 'retired' : ''].filter(Boolean).join(' · ')
      if (secondary) button.append(element('small', secondary, 'rc-name'))
      const stateRow = element('span', '', 'rc-state')
      stateRow.append(element('span', live ? row.state : 'unknown', `state-chip ${live ? row.state : 'unknown'}`))
      stateRow.append(element('small', row.latest ? `${row.runs} run${row.runs === 1 ? '' : 's'} · ${row.open_runs} open` : row.guide ? 'no run yet' : 'no guide'))
      button.append(stateRow)
      if (live && (row.state === 'stalled' || row.state === 'awaiting')) {
        button.append(element('small', 'Somebody posted into the run and Front has not answered', 'annotation'))
      }
      if (selected) {
        const more = element('span', '', 'rc-more')
        more.append(element('small', row.latest?.opened ? `latest run opened ${ago(board.generated_at - row.latest.opened.at)} ago · ${at(row.latest.opened.at)}` : 'No run observed'))
        more.append(element('small', `Title from ${display.title_source} · icon ${display.icon_source}`))
        more.append(element('small', live ? `Source: the run topic's own posts — ${row.latest?.run.evidence ?? 'no run'}` : 'Last known evidence · current state unknown', 'provenance'))
        button.append(more)
      }
      button.onclick = () => {
        if (selection.routine === row.name) return
        selection.routine = row.name; selection.session = ''; detail = undefined
        drawRoutines(); void selectRoutine()
      }
      list.append(button)
    }
    if (!board.routines.length) list.textContent = board.health.state === 'live' ? 'No routines observed.' : 'Unknown — routines could not be read.'
  }

  function unavailable(reason: string) {
    health.textContent = `Unknown — ${reason}`
    if (board) { board = { ...board, health: { ...board.health, state: 'unknown', reason } }; drawRoutines() }
    if (detail) { detail = { ...detail, health: { ...detail.health, state: 'unknown', reason } }; drawSession() }
    else { graph.textContent = `Unknown — ${reason}`; find('.session-list').textContent = `Unknown — ${reason}` }
    chat.unavailable(reason)
    drawNewSession()
    find('.parts-inflight').textContent = 'Host observation unknown — routine evidence unavailable.'
  }

  async function selectRoutine() {
    const current = ++generation, name = selection.routine
    const changed = chat.selected() !== name
    chat.select(name || undefined)
    if (!detail) {
      graph.textContent = 'Reading run…'; find('.session-list').textContent = 'Reading runs…'
      graphSignature = ''
      find('.standing-request').textContent = ''; find('.chat-span-note').textContent = ''
      find('.parts-inflight').textContent = 'Reading latest host observation…'
      if (changed) { find('.ns-result').textContent = ''; newSession.open = false }
    }
    if (!name) { unavailable('No routine selected'); return }
    const found = await loadRoutine(name, { includeResolved: showResolved.checked })
    if (generation !== current) return
    if ('error' in found) { unavailable(found.error); return }
    if (board?.health.state !== 'live') found.health = { ...found.health, state: 'unknown', reason: board?.health.reason ?? 'Board unavailable' }
    if (found.health.state !== 'live' && board) { board = { ...board, health: found.health }; drawRoutines() }
    detail = found
    health.textContent = `${routineHeadline(found)} · observed ${at(found.generated_at)} · refresh 5 s`
    const guideOpen = find('.standing-request').querySelector('details')?.open ?? false
    const guide = element('details', '', 'request-evidence')
    guide.open = guideOpen
    const guidePost = found.routine.guide
    guide.append(element('summary', `Guide · #${found.routine.channel} › guide${guidePost ? ` · #${guidePost.message_id} by ${guidePost.by}, ${at(guidePost.at)}` : ''}`))
    guide.append(element('p', guidePost?.text ?? 'Guide unknown — no post in the guide topic.'))
    find('.standing-request').replaceChildren(guide)
    chat.update(found); drawNewSession(); drawSession(changed)
    if (found.health.state !== 'live') {
      find('.parts-inflight').textContent = 'Host observation unknown — event queue cannot identify current activity.'
    } else void refreshInflight()
  }

  async function refreshInflight() {
    const name = selection.routine
    if (!detail || detail.health.state !== 'live' || !selectedIsLatest()) return
    if (inflightBusy && lastInflightName === name) return
    if (lastInflightName === name && Date.now() - lastInflightAt < 15000) return
    lastInflightName = name; lastInflightAt = Date.now(); inflightBusy = true
    const current = ++inflightGeneration
    const found = await loadInflight(name)
    if (current !== inflightGeneration) return
    inflightBusy = false
    if (selection.routine !== name || detail?.health.state !== 'live' || !selectedIsLatest()) return
    const line = find('.parts-inflight')
    if ('error' in found) { line.textContent = `Host observation unknown — ${found.error}`; return }
    const observation = element('details', '', 'host-evidence')
    const running = found.topics.filter(topic => topic.known && topic.in_flight).length
    const unknown = found.topics.filter(topic => !topic.known).length
    const summary = !found.configured ? 'Unknown — observation not configured' : !found.topics.length
      ? 'Unknown — no topic observations returned' : `${running} in flight · ${unknown} unknown · ${found.topics.length - running - unknown} without an observed run`
    observation.append(element('summary', `Latest activity only · host directories · ${summary} · observed ${at(found.generated_at)}`))
    const evidence = element('div', '')
    for (const topic of found.topics) evidence.append(element('p', `${topic.instance} · ${topic.channel}/${topic.topic}: ${topic.known ? topic.in_flight ? 'in flight' : 'no run in flight observed' : 'unknown'} — ${topic.reason}`))
    observation.append(evidence); line.replaceChildren(observation)
  }

  async function refresh() {
    if (refreshing || stopped) return
    refreshing = true
    try {
      const current = ++generation
      const [found, ops] = await Promise.all([loadRoutines(), loadOpsBoard()])
      if (generation !== current || stopped) return
      if (ops.health.state !== 'live') found.health = { ...found.health, state: 'unknown', reason: ops.health.reason }
      if (found.health.state !== 'live' && !found.routines.length) { unavailable(found.health.reason); return }
      board = found
      if ((!selection.routine || found.health.state === 'live') && !found.routines.some(row => row.name === selection.routine)) {
        selection.routine = found.routines[0]?.name ?? ''; selection.session = ''; detail = undefined
      }
      drawRoutines()
      await selectRoutine()
    } finally { refreshing = false }
  }
  find('.refresh').onclick = () => { void refresh() }
  async function tick() {
    await refresh()
    if (!stopped) timer = window.setTimeout(() => { void tick() }, 5000)
  }
  window.addEventListener('pagehide', () => { stopped = true; generation++; inflightGeneration++; window.clearTimeout(timer) })
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void tick() } })
  await tick()
  void runLine
}
