import { loadRoutines, loadRoutine, loadInflight, routineHeadline, at } from './routineState'
import { renderSessionGraph } from './sessionGraph'
import './operationParts.css'
import { initOperationDashboard } from './operationDashboard'

export async function initOperationParts(): Promise<void> {
  if (new URLSearchParams(location.search).get('parts') === 'shell') return initOperationDashboard()
  const shell = new URLSearchParams(location.search).get('parts') === 'shell'
  const host = document.createElement('main'); host.className = 'operation-parts'
  host.innerHTML = '<h1>Operation room · graph part</h1><div class="parts-toolbar"><a href="/">Existing views</a><label>Routine <select aria-label="Routine"></select></label><label>Session <select aria-label="Session"></select></label><button>Refresh snapshot</button></div><p class="parts-health" role="status">Reading relay…</p><section class="parts-graph"></section>'
  if (shell) {
    host.classList.add('parts-shell')
    host.innerHTML = '<header><h1>Operation room · layout shell</h1><div class="parts-toolbar"><a href="/">Existing views</a><button>Refresh snapshot</button></div><p class="parts-health" role="status">Reading relay…</p></header><div class="parts-grid"><aside class="routine-pane"><h2>Routines</h2><select aria-label="Routine"></select><p>List part connects here.</p></aside><section class="session-pane"><h2>Recent sessions · up to 3</h2><select aria-label="Session"></select><p>Session cards connect here.</p></section><section class="flow-pane"><h2>Conversation flow</h2><div class="parts-graph"></div><p class="parts-inflight"></p></section><aside class="chat-pane"><h2>Chat history</h2><p class="chat-slot">Select a routine.</p><p>Existing chatPanel connects here during assembly.</p></aside></div>'
  }
  document.body.append(host)
  const [routines, sessions] = Array.from(host.querySelectorAll('select'))
  const health = host.querySelector<HTMLElement>('.parts-health')!
  const graph = host.querySelector<HTMLElement>('.parts-graph')!
  let generation = 0
  async function select() {
    const current = ++generation
    sessions.replaceChildren(); graph.textContent = 'Reading session…'
    if (shell) {
      host.querySelector('.chat-slot')!.textContent = 'Reading routine history…'
      host.querySelector('.parts-inflight')!.textContent = 'Reading host observation…'
    }
    const detail = await loadRoutine(routines.value)
    if (current !== generation) return
    if ('error' in detail) {
      graph.textContent = `Unknown — ${detail.error}`
      if (shell) {
        host.querySelector('.chat-slot')!.textContent = `Unknown — ${detail.error}`
        host.querySelector('.parts-inflight')!.textContent = 'Unknown — routine could not be read'
      }
      return
    }
    if (shell) {
      host.querySelector('.chat-slot')!.textContent = `${detail.chat_log.length} posts loaded from the routine fire topic. History part is ready for assembly.`
      void loadInflight(routines.value).then(inflight => {
        if (current !== generation) return
        host.querySelector('.parts-inflight')!.textContent = 'error' in inflight ? `In-flight unknown — ${inflight.error}` :
          `Latest activity only · host observation ${at(inflight.generated_at)} · ${inflight.topics.filter(topic => topic.known && topic.in_flight).length} topics in flight · ${inflight.topics.filter(topic => !topic.known).length} unknown. ${inflight.configured ? '' : 'Observation not configured.'}`
      })
    }
    health.textContent = `${routineHeadline(detail)} · observed ${at(detail.generated_at)}`
    detail.sessions.slice(0, 3).forEach((session, index) => sessions.add(new Option(session.fire ? `Fire #${session.fire.message_id}` : 'Manual activity', String(index))))
    const draw = () => {
      const session = detail.sessions[Number(sessions.value)]
      if (session && shell) {
        graph.replaceChildren()
        const message = document.createElement('p')
        message.textContent = `${session.nodes.length} linked conversations loaded. Graph part connects here. ${session.note ?? ''}`
        const link = document.createElement('a')
        link.href = `/?parts=graph&routine=${encodeURIComponent(detail.routine.name)}`
        link.textContent = 'Open graph prototype'
        graph.append(message, link)
      } else if (session) renderSessionGraph(graph, detail, session)
      else graph.textContent = 'No session observed.'
    }
    sessions.onchange = draw; draw()
  }
  async function refresh() {
    const current = ++generation
    const board = await loadRoutines()
    if (current !== generation) return
    health.textContent = routineHeadline(board)
    const previous = routines.value || new URLSearchParams(location.search).get('routine')
    routines.replaceChildren()
    board.routines.forEach(row => routines.add(new Option(`${row.name} · ${row.state}`, row.name)))
    if (previous && board.routines.some(row => row.name === previous)) routines.value = previous
    if (routines.value) await select()
    else {
      sessions.replaceChildren(); graph.textContent = board.health.state === 'live' ? 'No routines observed.' : `Unknown — ${board.health.reason}`
      if (shell) {
        host.querySelector('.chat-slot')!.textContent = 'No routine selected.'
        host.querySelector('.parts-inflight')!.textContent = 'Host observation unknown — no routine selected.'
      }
    }
  }
  routines.onchange = select; host.querySelector('button')!.onclick = refresh
  await refresh()
}
