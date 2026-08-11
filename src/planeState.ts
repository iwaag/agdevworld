import { loadAutolabNodes, loadAutolabStatus, type AutolabNode } from './autolabState'

export interface PlaneState {
  id: string
  name: string
  group: string
}

export interface PlaneIssue {
  id: string
  name: string
  description_html?: string | null
  state?: string | { id?: string; name?: string; group?: string }
}

export interface DispatchNode extends AutolabNode {
  busy?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

class HttpRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, detail: string, code?: string) {
    super(`HTTP ${status}${detail ? ` — ${detail}` : ''}`)
    this.status = status
    this.code = code
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const detail = isObject(parsed) ? String(parsed.detail ?? parsed.error ?? '') : text.slice(0, 160)
    const code = isObject(parsed) && typeof parsed.error === 'string' ? parsed.error : undefined
    throw new HttpRequestError(response.status, detail, code)
  }
  if (parsed === undefined) throw new Error('response was not JSON')
  return parsed
}

function results(value: unknown, label: string): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : isObject(value) ? value.results : undefined
  if (!Array.isArray(rows)) throw new Error(`${label} response was malformed`)
  return rows.filter(isObject)
}

export async function loadPlaneStates(): Promise<PlaneState[]> {
  return results(await requestJson('/api/plane/states'), 'state list').map((state) => ({
    id: String(state.id),
    name: String(state.name),
    group: String(state.group),
  }))
}

export async function loadPlaneIssues(): Promise<PlaneIssue[]> {
  return results(await requestJson('/api/plane/issues?per_page=100'), 'issue list').map((issue) => ({
    ...issue,
    id: String(issue.id),
    name: String(issue.name),
  })) as PlaneIssue[]
}

export async function loadDispatchNodes(): Promise<DispatchNode[]> {
  const nodes = await loadAutolabNodes()
  return Promise.all(nodes.map(async (node) => {
    if (!node.reachable) return node
    try {
      const status = await loadAutolabStatus(node.name)
      return { ...node, busy: status.driver?.running === true }
    } catch {
      return node
    }
  }))
}

export async function changePlaneIssueState(issueId: string, stateName: string): Promise<void> {
  await requestJson(`/api/plane/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state_name: stateName }),
  })
}

function missionText(issue: PlaneIssue): string {
  const description = issue.description_html?.trim() || '(No description was provided.)'
  return [
    'Execute this Plane task as an autolab mission.',
    '',
    `Plane issue ID: ${issue.id}`,
    `Title: ${issue.name}`,
    'Description (HTML):',
    description,
    '',
    'Keep the Plane issue ID with the mission so progress and the final outcome can be reported to the same issue.',
  ].join('\n')
}

export async function dispatchPlaneIssue(issue: PlaneIssue, node: string): Promise<void> {
  await changePlaneIssueState(issue.id, 'In Progress')
  let definitiveFailure = false
  try {
    const answer = await requestJson(`/api/autolab/${encodeURIComponent(node)}/window`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: missionText(issue) }),
    })
    const mission = isObject(answer) && isObject(answer.mission) ? answer.mission : undefined
    if (!mission || mission.status !== 202) {
      definitiveFailure = true
      const detail = mission ? String(mission.error ?? `mission status ${mission.status}`) : 'the node window did not start a mission'
      throw new Error(detail)
    }
  } catch (error) {
    // A proxy timeout/offline answer is ambiguous: the remote window may
    // still finish and launch the mission after our connection is gone. Keep
    // In Progress in that case rather than creating a Ready + running split.
    const canProveNoMission = definitiveFailure || (error instanceof HttpRequestError && error.code !== 'node_offline')
    if (!canProveNoMission) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${detail}; dispatch outcome is unknown, so the issue remains In Progress`)
    }
    try {
      await changePlaneIssueState(issue.id, 'Ready')
    } catch (rollbackError) {
      const first = error instanceof Error ? error.message : String(error)
      const second = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`${first}; returning the issue to Ready also failed: ${second}`)
    }
    throw error
  }
}

export function planeIssueState(issue: PlaneIssue, states: PlaneState[]): PlaneState | undefined {
  if (typeof issue.state === 'string') return states.find((state) => state.id === issue.state)
  if (isObject(issue.state)) {
    const id = typeof issue.state.id === 'string' ? issue.state.id : undefined
    return states.find((state) => state.id === id) ?? {
      id: id ?? '',
      name: String(issue.state.name ?? ''),
      group: String(issue.state.group ?? ''),
    }
  }
  return undefined
}
