import { loadOpsBoard } from './opsState'
import { initChatPanel } from './chatPanel'
import { renderSessionGraph, type GraphMode } from './sessionGraph'
import { loadRoutines, loadRoutine, loadInflight, startSession, routineHeadline, ago, at, type RoutineBoard, type RoutineDetail, type RoutineSession } from './routineState'
import './operationParts.css'

// A session is a run topic (relay: `session.topic`), which is its identity.
const sessionKey = (session: RoutineSession) => session.topic
// How long a fire this screen posted is waited for before the list falls back
// to whatever the relay shows. The event queue carries a post back within a
// second or two; a minute is far past that, and past it the fire is either in
// the list or something else is wrong and the list should say what it sees.
const PENDING_FIRE_MS = 60000
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
const ANSWER_MARK: Record<string, string> = { answered: 'answered', acked: 'acked, no answer yet', unanswered: 'unanswered', 'no fire': 'no fire line' }
// A run's title on a card: its stamp, which is what the topic is named by.
const sessionTitle = (session: RoutineSession) => session.stamp ? `Run ${session.stamp}` : session.topic
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') {
  const node = document.createElement(tag)
  node.textContent = text; node.className = className
  return node
}

// One controller owns the selection and supplies every pane, including chat.
export async function initOperationDashboard(): Promise<void> {
  const host = element('main', '', 'operation-parts parts-shell dashboard')
  host.innerHTML = `<header class="dashboard-header"><div><span class="eyebrow">AGDEVWORLD</span><h1>Operation room</h1></div><nav class="parts-toolbar"><a href="/?parts=gauge" target="_blank" rel="opener">Cost gauge ↗</a><a href="/?view=ops">Ops board</a><a href="/?view=nodes">World views</a><button class="refresh">Refresh</button></nav><p class="parts-health" role="status">Reading relay…</p></header>
    <div class="parts-grid"><aside class="routine-pane"><h2>Routines</h2><div class="routine-list"></div></aside>
    <section class="session-pane"><div class="pane-head"><h2>Recent sessions <small>up to 3 visible · history, not capacity</small></h2><label class="show-resolved"><input type="checkbox"> Show resolved</label></div>
      <details class="new-session"><summary>New session</summary>
        <p class="ns-request"></p>
        <label class="ns-instruction">Optional instruction for this run<textarea rows="2" placeholder="Leave empty to run the standing request as it stands"></textarea></label>
        <div class="ns-row"><small class="ns-why"></small><button type="button" class="ns-start">Start new session · buys a run</button></div>
        <p class="ns-result" role="status"></p>
      </details>
      <div class="session-list"></div><p class="session-history"></p></section>
    <section class="flow-pane"><div class="pane-head"><h2>Conversation flow</h2><div class="graph-mode" role="radiogroup" aria-label="Flow rendering"><button type="button" data-mode="compact">Compact</button><button type="button" data-mode="detailed">Detailed</button></div></div><div class="standing-request"></div><div class="parts-graph"></div><div class="parts-inflight">Host observation not loaded.</div></section>
    <aside class="chat-pane"><h2>Run conversation</h2><p class="chat-span-note"></p><div class="chat-mount"></div></aside></div>`
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
  // A fire this screen posted and the relay has not yet listed. Selecting it
  // before it exists is what lets the list land on it when it arrives.
  let starting = false
  const showResolved = find('.show-resolved input') as HTMLInputElement
  // Compact by default: the same topology drawn small. Detailed keeps the
  // full cards. Persisted like Show resolved.
  let graphMode: GraphMode = readPref<string>('graphMode', 'compact') === 'detailed' ? 'detailed' : 'compact'
  function drawGraphMode() {
    for (const button of host.querySelectorAll<HTMLButtonElement>('.graph-mode button')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === graphMode))
    }
  }
  drawGraphMode()
  showResolved.checked = readPref('showResolved', false)
  let pendingFire: { routine: string; id: number; topic: string; at: number } | undefined
  const chat = initChatPanel({ mount: find('.chat-mount'), managed: true, onRefresh: () => { void refresh() } })

  function drawSession(scroll = false) { refocus(find('.session-list'), 'session', () => drawSessionCards(scroll)) }
  function drawSessionCards(scroll: boolean) {
    const list = find('.session-list'); list.replaceChildren()
    if (!detail) return
    const pending = pendingFire && pendingFire.routine === selection.routine ? pendingFire : undefined
    if (pending && detail.sessions.some(session => session.topic === pending.topic)) {
      // The event queue carried the fire back; the pending card is over.
      pendingFire = undefined; find('.ns-result').textContent = `${pending.topic} is listed below.`
    }
    const stillPending = pendingFire && pendingFire.routine === selection.routine && Date.now() - pendingFire.at < PENDING_FIRE_MS
    if (!detail.sessions.some(session => sessionKey(session) === selection.session) && !stillPending) {
      selection.session = detail.sessions[0] ? sessionKey(detail.sessions[0]) : ''
    }
    if (stillPending && pendingFire) {
      const card = element('button', '', 'session-card pending')
      card.dataset.session = pendingFire.topic
      card.setAttribute('aria-pressed', String(selection.session === pendingFire.topic))
      card.append(element('strong', `Run ${stampOf(pendingFire.topic)}`), element('small', `Fire #${pendingFire.id} posted from here · manual start`))
      card.append(element('small', 'Waiting for the event queue to reflect it', 'annotation'))
      list.append(card)
    }
    for (const session of detail.sessions.slice(0, 3)) {
      const key = sessionKey(session)
      const live = detail.health.state === 'live'
      const button = element('button', '', 'session-card')
      button.dataset.session = key
      button.setAttribute('aria-pressed', String(selection.session === key))
      button.title = `#front › ${session.topic}`
      button.append(element('strong', sessionTitle(session)))
      button.append(element('small', session.fire ? `Fire #${session.fire.message_id} · ${ago(detail.generated_at - session.fire.at)} ago · ${at(session.fire.at)}` : 'Opened by hand · no fire line'))
      const origin = session.origin === 'manual' ? 'Manual start' : session.origin === 'scheduled' ? 'Scheduled start' : 'Origin unknown'
      button.append(element('small', `${origin} · ${live ? `${ANSWER_MARK[session.answer.state] ?? session.answer.state} · ${session.nodes.length} linked conversations` : 'unknown · last known links'}`))
      const resolution = live ? session.resolution?.state ?? 'unknown' : 'unknown'
      const chip = element('small', RESOLUTION_MARK[resolution] ?? '? unknown (relay)', `resolution ${resolution}`)
      chip.title = session.resolution?.evidence ?? 'no resolution evidence reported'
      button.append(chip)
      if (session.history.bounded) button.append(element('small', `Window of ${session.history.post_limit} posts — older posts not held`, 'annotation'))
      if (session.previous) {
        // The fire names the run before it. A link when that run is in the
        // list; otherwise the name, so the reader can find it in Zulip.
        const target = detail.sessions.find(one => one.topic === session.previous)
        const prev = element('small', `↤ previous run ${stampOf(session.previous)}${target ? '' : ' · not listed (hidden, or older than the relay reads)'}`, 'session-prev')
        prev.title = `#front › ${session.previous}`
        if (target) {
          prev.setAttribute('role', 'link'); prev.tabIndex = 0
          const go = (event: Event) => { event.stopPropagation(); selection.session = target.topic; lastInflightAt = 0; drawSession(true); void refreshInflight() }
          prev.onclick = go; prev.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') go(event) }
        }
        button.append(prev)
      }
      button.onclick = () => { selection.session = key; lastInflightAt = 0; drawSession(true); void refreshInflight() }
      list.append(button)
    }
    if (!detail.sessions.length && !stillPending) {
      const hidden = detail.history?.hidden_resolved ?? 0
      list.textContent = detail.health.state !== 'live' ? 'Unknown — session history is not available.'
        : hidden > 0 ? `Every listed session is resolved and hidden (${hidden}). Turn on Show resolved to see them.` : 'No session observed.'
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
      // The chat is the selected run's topic, whole — no span to infer.
      chat.show(detail, session)
      find('.chat-span-note').textContent = session.resolution.state === 'resolved'
        ? `#front › ${session.topic} · ✔ resolved. Front does not sweep a resolved topic; un-resolve it in Zulip to continue, or start a new session.`
        : `#front › ${session.topic} · chat posts into this run's topic.`
    } else if (stillPending && pendingFire) {
      graphSignature = ''
      graph.textContent = `Waiting for the relay to list ${pendingFire.topic}. Its conversations appear here once the event queue reflects the post.`
      chat.show(detail, undefined, `Waiting for the event queue to carry ${pendingFire.topic} back…`)
      find('.chat-span-note').textContent = `#front › ${pendingFire.topic} · fire #${pendingFire.id} posted from here.`
    } else {
      const hidden = detail.history?.hidden_resolved ?? 0
      graph.textContent = detail.health.state !== 'live' ? 'Unknown — no current session evidence.'
        : hidden > 0 ? `No visible session — ${hidden} resolved and hidden. Turn on Show resolved to inspect them.` : 'No run observed — this routine has no run topic yet.'
      chat.show(detail, undefined, detail.health.state !== 'live' ? undefined
        : hidden > 0 ? `Every listed run is resolved and hidden (${hidden}). Turn on Show resolved to read one.` : 'No run to show — start a new session to open one.')
      find('.chat-span-note').textContent = 'No run selected.'
      find('.parts-inflight').textContent = 'Host observation attaches to the latest run; none is selected.'
    }
    host.dataset.routine = selection.routine; host.dataset.session = selection.session
    if (session && !isLatest(session)) find('.parts-inflight').textContent = 'Host observation is latest-only; it is not attached to this older run.'
  }

  // The stamp a run topic is named by, for a card title.
  function stampOf(topic: string): string {
    const found = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$/.exec(topic)
    return found ? found[1]! : topic
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

  // Why "New session" cannot be pressed right now, or nothing when it can.
  // Every sentence is the relay's own state, said before the click rather
  // than as a refusal after it.
  function startBlocker(): string {
    if (!detail || !board) return 'No routine selected'
    if (detail.health.state !== 'live') return `Unknown — ${detail.health.reason}; a start needs a live relay`
    if (!detail.chat.configured) return detail.chat.reason ?? 'chat is read-only'
    if (detail.routine.retired) return `Retired — its standing request carries ✔. Un-resolve #front › ${detail.routine.request_topic ?? `routine-${detail.routine.name}`} to start it again.`
    if (!detail.routine.request) return `No standing request — write one in #front › routine-${detail.routine.name} first.`
    if (starting) return 'Sending…'
    return ''
  }

  function drawNewSession() {
    const why = startBlocker()
    startButton.disabled = why !== ''
    find('.ns-why').textContent = why
    const request = detail?.routine.request
    find('.ns-request').textContent = !detail ? '' : request
      ? `Standing request (${detail.routine.request_topic}, #${request.message_id}): ${request.text.length > 280 ? `${request.text.slice(0, 279)}…` : request.text}`
      : 'Standing request unknown — no author post observed.'
    newSession.dataset.for = detail?.routine.name ?? ''
  }

  async function start() {
    if (!detail || startBlocker() !== '' || starting) return
    const name = detail.routine.name
    const text = instruction.value
    const previous = detail.routine.latest_topic
    starting = true; drawNewSession()
    const result = find('.ns-result')
    result.className = 'ns-result'
    result.textContent = `Opening a new run topic of ${name} in #front${previous ? ` (previous run: ${previous})` : ' — its first run'}…`
    const found = await startSession(name, text)
    starting = false
    if (!found.sent) {
      // The instruction stays in the box: a refusal is something to fix, an
      // uncertain send is something to check, and neither is a reason to
      // retype it.
      result.className = `ns-result ${found.uncertain ? 'uncertain' : 'error'}`
      result.textContent = found.uncertain
        ? `Uncertain — ${found.error}. The fire may have landed; look for the run topic in #front before starting again. ${found.note ?? ''}`.trim()
        : `Refused — ${found.error}`
      drawNewSession()
      return
    }
    instruction.value = ''
    const topic = found.topic ?? `front-routine-${name}-?`
    pendingFire = { routine: name, id: found.message_id!, topic, at: Date.now() }
    if (selection.routine === name) selection.session = topic
    result.textContent = `Fire #${found.message_id} posted into #front › ${topic}${found.previous ? ` (names ${found.previous} as the previous run)` : ' — the first run of this routine'}. Waiting for the event queue to reflect it.`
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
    // Routine, chat draft and pending fire stay; only the list is re-read.
    // A selection that becomes hidden falls back to the newest visible one
    // in drawSession, or to the empty state that says why.
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
      // Identity first: icon and title, with the internal name as secondary
      // text (or omitted when it is the title). Routing keys on the name.
      const display = row.display ?? { icon: '▫', icon_source: 'assigned', title: row.name, title_source: 'name' }
      const head = element('span', '', 'rc-head')
      const icon = element('span', display.icon, 'rc-icon'); icon.setAttribute('aria-hidden', 'true')
      icon.title = display.icon_source === 'assigned' ? 'Icon assigned from the name; add a `display:` line to the standing request to choose one' : `Icon from the standing request (${display.icon_source})`
      const title = element('strong', display.title, 'rc-title')
      head.append(icon, title)
      button.append(head)
      button.setAttribute('aria-label', `${display.title}${display.title !== row.name ? ` (${row.name})` : ''}${row.retired ? ', retired' : ''}, ${live ? row.state : 'unknown'}`)
      const secondary = [display.title !== row.name ? row.name : '', row.retired ? 'retired' : ''].filter(Boolean).join(' · ')
      if (secondary) button.append(element('small', secondary, 'rc-name'))
      const stateRow = element('span', '', 'rc-state')
      stateRow.append(element('span', live ? row.state : 'unknown', `state-chip ${live ? row.state : 'unknown'}`))
      stateRow.append(element('small', !board.schedule.ok ? 'schedule unknown' : row.schedule.next ? `next ${at(row.schedule.next.at)}` : 'none scheduled'))
      button.append(stateRow)
      if (live && row.answer.state === 'acked' && (row.answer.age_seconds ?? 0) >= board.settings.stalled_seconds) {
        button.append(element('small', 'Ack overdue · no answer observed', 'annotation'))
      }
      if (board.schedule.ok && row.schedule.overdue.length) button.append(element('small', `${row.schedule.overdue.length} overdue`, 'annotation'))
      if (selected) {
        // Timing and provenance belong to the selected view, not to every card.
        const more = element('span', '', 'rc-more')
        more.append(element('small', row.last_fire ? `${ago(board.generated_at - row.last_fire.at)} since fire · ${at(row.last_fire.at)}` : 'No dispatcher fire observed'))
        more.append(element('small', `Title from ${display.title_source} · icon ${display.icon_source}`))
        more.append(element('small', live ? 'Source: dispatcher fire / reply evidence' : 'Last known evidence · current state unknown', 'provenance'))
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
      graph.textContent = 'Reading session…'; find('.session-list').textContent = 'Reading sessions…'
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
    const requestOpen = find('.standing-request').querySelector('details')?.open ?? false
    const request = element('details', '', 'request-evidence')
    request.open = requestOpen
    request.append(element('summary', `Standing request · ${found.routine.request_topic ?? 'unknown'}`))
    request.append(element('p', found.routine.request?.text ?? 'Standing request unknown — no author post observed.'))
    find('.standing-request').replaceChildren(request)
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
}
