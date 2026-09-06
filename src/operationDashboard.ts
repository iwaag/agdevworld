import { loadOpsBoard } from './opsState'
import { initChatPanel } from './chatPanel'
import { renderSessionGraph } from './sessionGraph'
import { loadRoutines, loadRoutine, loadInflight, routineHeadline, ago, at, type RoutineBoard, type RoutineDetail, type RoutineSession } from './routineState'
import './operationParts.css'

const sessionKey = (session: RoutineSession) => String(session.fire?.message_id ?? 'manual')
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') {
  const node = document.createElement(tag)
  node.textContent = text; node.className = className
  return node
}

// One controller owns the selection and supplies every pane, including chat.
export async function initOperationDashboard(): Promise<void> {
  const host = element('main', '', 'operation-parts parts-shell dashboard')
  host.innerHTML = `<header class="dashboard-header"><div><span class="eyebrow">AGDEVWORLD</span><h1>Operation room</h1></div><nav class="parts-toolbar"><a href="/?view=ops">Ops board</a><a href="/?view=nodes">World views</a><button class="refresh">Refresh</button></nav><p class="parts-health" role="status">Reading relay…</p></header>
    <div class="parts-grid"><aside class="routine-pane"><h2>Routines</h2><div class="routine-list"></div></aside>
    <section class="session-pane"><h2>Recent sessions <small>up to 3 · history, not capacity</small></h2><div class="session-list"></div></section>
    <section class="flow-pane"><h2>Conversation flow</h2><div class="standing-request"></div><div class="parts-graph"></div><div class="parts-inflight">Host observation not loaded.</div></section>
    <aside class="chat-pane"><h2>Fire conversation</h2><p class="chat-span-note"></p><div class="chat-mount"></div></aside></div>`
  document.body.append(host)
  const find = (selector: string) => host.querySelector<HTMLElement>(selector)!
  const health = find('.parts-health'), graph = find('.parts-graph')
  const selection = { routine: new URLSearchParams(location.search).get('routine') ?? '', session: '' }
  let board: RoutineBoard | undefined, detail: RoutineDetail | undefined
  let generation = 0
  let refreshing = false
  let graphSignature = ''
  let inflightGeneration = 0, inflightBusy = false
  let lastInflightAt = 0, lastInflightName = ''
  let stopped = false
  let timer: number | undefined
  const chat = initChatPanel({ mount: find('.chat-mount'), managed: true, onRefresh: () => { void refresh() } })

  function drawSession(scroll = false) {
    const list = find('.session-list'); list.replaceChildren()
    if (!detail) return
    if (!detail.sessions.some(session => sessionKey(session) === selection.session)) {
      selection.session = detail.sessions[0] ? sessionKey(detail.sessions[0]) : ''
    }
    for (const session of detail.sessions.slice(0, 3)) {
      const key = sessionKey(session)
      const button = element('button', '', 'session-card')
      button.dataset.session = key
      button.setAttribute('aria-pressed', String(selection.session === key))
      button.append(element('strong', session.fire ? `Fire #${session.fire.message_id}` : 'Manual activity'))
      button.append(element('small', session.fire ? `${ago(detail.generated_at - session.fire.at)} since fire · ${at(session.fire.at)}` : 'No identified scheduled run'))
      button.append(element('small', detail.health.state === 'live' ? `${session.nodes.length} linked conversations · current topic observations` : 'Unknown · last known links'))
      button.onclick = () => { selection.session = key; lastInflightAt = 0; drawSession(true); void refreshInflight() }
      list.append(button)
    }
    if (!detail.sessions.length) list.textContent = detail.health.state === 'live' ? 'No session observed.' : 'Unknown — session history is not available.'
    const index = detail.sessions.findIndex(session => sessionKey(session) === selection.session)
    const session = detail.sessions[index]
    if (session) {
      const signature = JSON.stringify([selection.routine, selection.session, detail.health.state, detail.health.reason, session])
      if (signature !== graphSignature) {
        const viewport = graph.querySelector('.graph-viewport')
        const previousScroll = scroll ? undefined : [viewport?.scrollLeft ?? 0, viewport?.scrollTop ?? 0]
        renderSessionGraph(graph, detail, session)
        const nextViewport = graph.querySelector('.graph-viewport')
        if (previousScroll && nextViewport) { nextViewport.scrollLeft = previousScroll[0]!; nextViewport.scrollTop = previousScroll[1]! }
        graphSignature = signature
      }
      const until = index > 0 ? detail.sessions[index - 1]?.fire?.message_id : undefined
      chat.highlight(session.fire?.message_id, until, scroll)
      find('.chat-span-note').textContent = session.fire
        ? `Fire #${session.fire.message_id} span highlighted. Chat always posts to this routine's fire topic.`
        : 'Manual activity · no dispatcher fire identifies a session span.'
    } else {
      graph.textContent = detail.health.state === 'live' ? 'No session observed.' : 'Unknown — no current session evidence.'
      find('.chat-span-note').textContent = 'No session span identified.'
    }
    host.dataset.routine = selection.routine; host.dataset.session = selection.session
    if (index > 0) find('.parts-inflight').textContent = 'Host observation is latest-only; it is not attached to this historical fire.'
  }

  function drawRoutines() {
    const list = find('.routine-list'); list.replaceChildren()
    if (!board) return
    for (const row of board.routines) {
      const live = board.health.state === 'live'
      const button = element('button', '', 'routine-card'); button.dataset.routine = row.name
      button.setAttribute('aria-pressed', String(row.name === selection.routine))
      button.append(element('strong', row.name + (row.retired ? ' · retired' : '')))
      button.append(element('span', live ? row.state : 'unknown', `state-chip ${live ? row.state : 'unknown'}`))
      button.append(element('small', row.last_fire ? `${ago(board.generated_at - row.last_fire.at)} since fire` : 'No dispatcher fire observed'))
      if (live && row.answer.state === 'acked' && (row.answer.age_seconds ?? 0) >= board.settings.stalled_seconds) {
        button.append(element('small', 'Ack overdue · no answer observed', 'annotation'))
      }
      button.append(element('small', !board.schedule.ok ? 'Schedule unknown' : `Next: ${row.schedule.next ? at(row.schedule.next.at) : 'none scheduled'} · ${row.schedule.overdue.length} overdue`))
      button.append(element('small', live ? 'Source: dispatcher fire / reply evidence' : 'Last known evidence · current state unknown', 'provenance'))
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
    }
    if (!name) { unavailable('No routine selected'); return }
    const found = await loadRoutine(name)
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
    chat.update(found); drawSession(changed)
    if (found.health.state !== 'live') {
      find('.parts-inflight').textContent = 'Host observation unknown — event queue cannot identify current activity.'
    } else void refreshInflight()
  }

  async function refreshInflight() {
    const name = selection.routine
    const latest = detail?.sessions[0]
    if (!detail || detail.health.state !== 'live' || !latest || sessionKey(latest) !== selection.session) return
    if (inflightBusy && lastInflightName === name) return
    if (lastInflightName === name && Date.now() - lastInflightAt < 15000) return
    lastInflightName = name; lastInflightAt = Date.now(); inflightBusy = true
    const current = ++inflightGeneration
    const found = await loadInflight(name)
    if (current !== inflightGeneration) return
    inflightBusy = false
    if (selection.routine !== name || detail?.health.state !== 'live' || sessionKey(detail.sessions[0]!) !== selection.session) return
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
