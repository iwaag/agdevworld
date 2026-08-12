// Multi-project (zulip_channel_topic2): the project travels in the path —
// /api/plane/projects/<uuid>/issues|states/… — instead of being pinned in
// config. The bare /issues|/states form remains as the default-project view
// for the task UI and requires PLANE_PROJECT_ID to be configured.
const PROJECT_SCOPED_PATH = /^\/projects\/([A-Za-z0-9-]+)(\/(?:issues|states)(?:\/[A-Za-z0-9_-]+)*\/?)$/
const DEFAULT_PROJECT_PATH = /^\/(issues|states)(\/[A-Za-z0-9_-]+)*\/?$/

function jsonResult(status, body) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(body)),
  }
}

export function readPlaneConfig(env = process.env) {
  const url = String(env.PLANE_URL ?? '').trim().replace(/\/$/, '')
  const apiKey = String(env.PLANE_API_KEY ?? '').trim()
  const workspace = String(env.PLANE_WORKSPACE_SLUG ?? '').trim()
  // Optional: only the bare /issues|/states default-project view needs it.
  const project = String(env.PLANE_PROJECT_ID ?? '').trim()
  const missing = []
  if (!url) missing.push('PLANE_URL')
  if (!apiKey) missing.push('PLANE_API_KEY')
  if (!workspace) missing.push('PLANE_WORKSPACE_SLUG')
  if (url && !/^https?:\/\//.test(url)) missing.push('valid PLANE_URL')
  return { url, apiKey, workspace, project, missing }
}

function projectBase(config, project) {
  return `${config.url}/api/v1/workspaces/${encodeURIComponent(config.workspace)}/projects/${encodeURIComponent(project)}`
}

async function stateIdForName(config, project, name, fetchImpl) {
  const response = await fetchImpl(`${projectBase(config, project)}/states/`, {
    headers: { 'X-API-Key': config.apiKey },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) return { response }
  const payload = await response.json()
  const states = Array.isArray(payload) ? payload : payload.results
  const state = Array.isArray(states)
    ? states.find((item) => String(item.name).toLowerCase() === String(name).toLowerCase())
    : undefined
  return state ? { id: state.id } : { missing: true }
}

export async function proxyPlaneRequest(request, config, fetchImpl = fetch) {
  if (config.missing.length > 0) {
    return jsonResult(503, {
      error: 'plane_unconfigured',
      detail: `Missing Plane configuration: ${config.missing.join(', ')}.`,
    })
  }

  const parsed = new URL(request.url, 'http://agdevworld.local')
  const fullPath = parsed.pathname.slice('/api/plane'.length) || '/'
  const scoped = PROJECT_SCOPED_PATH.exec(fullPath)
  let project
  let path
  if (scoped) {
    ;[, project, path] = scoped
  } else if (DEFAULT_PROJECT_PATH.test(fullPath)) {
    if (!config.project) {
      return jsonResult(404, {
        error: 'plane_no_default_project',
        detail: 'No default Plane project is configured; use /api/plane/projects/<uuid>/… instead.',
      })
    }
    project = config.project
    path = fullPath
  } else {
    return jsonResult(404, {
      error: 'plane_path_not_proxied',
      detail: 'Only per-project issues and states (/api/plane/projects/<uuid>/…) are reachable through the Plane passthrough.',
    })
  }
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) {
    return jsonResult(405, { error: 'method_not_allowed' })
  }

  let body = request.body
  if (body && ['POST', 'PATCH'].includes(request.method)) {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      payload = undefined
    }
    if (payload && Object.hasOwn(payload, 'state_name')) {
      const name = payload.state_name
      const resolved = await stateIdForName(config, project, name, fetchImpl)
      if (resolved.response) {
        const upstreamBody = Buffer.from(await resolved.response.arrayBuffer())
        return {
          status: resolved.response.status,
          contentType: resolved.response.headers.get('content-type') ?? 'application/json; charset=utf-8',
          body: upstreamBody,
        }
      }
      if (resolved.missing) {
        return jsonResult(400, {
          error: 'unknown_plane_state',
          detail: `No state named "${name}" exists in the configured Plane project.`,
        })
      }
      payload.state = resolved.id
      delete payload.state_name
      body = JSON.stringify(payload)
    }
  }

  const upstreamPath = path.endsWith('/') ? path : `${path}/`
  const target = `${projectBase(config, project)}${upstreamPath}${parsed.search}`
  const response = await fetchImpl(target, {
    method: request.method,
    headers: {
      'X-API-Key': config.apiKey,
      'content-type': request.contentType || 'application/json',
    },
    body: request.method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(60_000),
  })
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
    body: Buffer.from(await response.arrayBuffer()),
  }
}
