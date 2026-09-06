import { loadRoutines, loadRoutine, routineHeadline, at } from './routineState'
import { renderSessionGraph } from './sessionGraph'
import './operationParts.css'

export async function initOperationParts(): Promise<void> {
  const host = document.createElement('main'); host.className = 'operation-parts'
  host.innerHTML = '<h1>Operation room · graph part</h1><div class="parts-toolbar"><a href="/">Operation room</a><label>Routine <select aria-label="Routine"></select></label><label>Session <select aria-label="Session"></select></label><button>Refresh snapshot</button></div><p class="parts-health" role="status">Reading relay…</p><section class="parts-graph"></section>'
  document.body.append(host)
  const [routines, sessions] = Array.from(host.querySelectorAll('select'))
  const health = host.querySelector<HTMLElement>('.parts-health')!
  const graph = host.querySelector<HTMLElement>('.parts-graph')!
  let generation = 0
  async function select() {
    const current = ++generation
    sessions.replaceChildren(); graph.textContent = 'Reading session…'
    const detail = await loadRoutine(routines.value)
    if (current !== generation) return
    if ('error' in detail) {
      graph.textContent = `Unknown — ${detail.error}`
      return
    }
    health.textContent = `${routineHeadline(detail)} · observed ${at(detail.generated_at)}`
    detail.sessions.slice(0, 3).forEach((session, index) => sessions.add(new Option(session.fire ? `Fire #${session.fire.message_id}` : 'Manual activity', String(index))))
    const draw = () => {
      const session = detail.sessions[Number(sessions.value)]
      if (session) renderSessionGraph(graph, detail, session)
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

    }
  }
  routines.onchange = select; host.querySelector('button')!.onclick = refresh
  await refresh()
}
