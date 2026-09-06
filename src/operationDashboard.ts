import { initChatPanel } from './chatPanel'
import { renderSessionGraph } from './sessionGraph'
import { loadRoutines, loadRoutine, routineHeadline, ago, at, type RoutineBoard, type RoutineDetail, type RoutineSession } from './routineState'
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
    <section class="flow-pane"><h2>Conversation flow</h2><div class="standing-request"></div><div class="parts-graph"></div><p class="parts-inflight">Host observation not loaded.</p></section>
    <aside class="chat-pane"><h2>Fire conversation</h2><p class="chat-span-note"></p><div class="chat-mount"></div></aside></div>`
  document.body.append(host)
  const find = (selector: string) => host.querySelector<HTMLElement>(selector)!
  const health = find('.parts-health'), graph = find('.parts-graph')
  const selection = { routine: new URLSearchParams(location.search).get('routine') ?? '', session: '' }
  let board: RoutineBoard | undefined, detail: RoutineDetail | undefined
  let generation = 0
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
      button.onclick = () => { selection.session = key; drawSession(true) }
      list.append(button)
    }
    const index = detail.sessions.findIndex(session => sessionKey(session) === selection.session)
    const session = detail.sessions[index]
    if (session) {
      renderSessionGraph(graph, detail, session)
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
    chat.select(name || undefined)
    if (!detail) {
      graph.textContent = 'Reading session…'; find('.session-list').textContent = 'Reading sessions…'
      find('.standing-request').textContent = ''; find('.chat-span-note').textContent = ''
    }
    if (!name) { unavailable('No routine selected'); return }
    const found = await loadRoutine(name)
    if (generation !== current) return
    if ('error' in found) { unavailable(found.error); return }
    detail = found
    health.textContent = `${routineHeadline(found)} · observed ${at(found.generated_at)}`
    const request = element('details', '', 'request-evidence')
    request.append(element('summary', `Standing request · ${found.routine.request_topic ?? 'unknown'}`))
    request.append(element('p', found.routine.request?.text ?? 'Standing request unknown — no author post observed.'))
    find('.standing-request').replaceChildren(request)
    chat.update(found); drawSession()
  }

  async function refresh() {
    const current = ++generation
    const found = await loadRoutines()
    if (generation !== current) return
    if (found.health.state !== 'live' && !found.routines.length) { unavailable(found.health.reason); return }
    board = found
    if (!found.routines.some(row => row.name === selection.routine)) {
      selection.routine = found.routines[0]?.name ?? ''; selection.session = ''; detail = undefined
    }
    drawRoutines()
    await selectRoutine()
  }
  find('.refresh').onclick = () => { void refresh() }
  await refresh()
}
