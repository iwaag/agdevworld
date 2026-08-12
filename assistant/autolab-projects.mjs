// Project start for autolab projects (zulip_channel_topic2, Step 4).
//
// One call provisions the three standing pieces a project needs before any
// mission can run — and nothing else. No Plane issue, no task planning, no
// mission: prep and dev start stay separable in the evidence (the S5 lesson).
//
// - Gitea: the `<name>` + `<name>-direction` repo pair under the autodev org,
//   the direction repo seeded with GUIDE.md / concept.md / .gitignore
//   (agautolab/AGENT_GUIDE.md "Projects").
// - Plane: a fresh project in the configured workspace; its UUID and state
//   ids are returned so mission briefings can carry them (multi-project:
//   the project UUID travels in the mission text, never in node config).
// - Zulip: the standing `#pj-<name>` channel, subscribing every active realm
//   user (all agents + the Developer).

import { readFile } from 'node:fs/promises'

export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,38}$/

export function readGiteaConfig(env = process.env) {
  const url = String(env.GITEA_URL ?? '').trim().replace(/\/$/, '')
  const tokenPath = String(env.GITEA_TOKEN_PATH ?? '/run/secrets/gitea.token').trim()
  const org = String(env.GITEA_ORG ?? 'autodev').trim()
  const missing = []
  if (!url) missing.push('GITEA_URL')
  if (url && !/^https?:\/\//.test(url)) missing.push('valid GITEA_URL')
  return { url, tokenPath, org, missing }
}

export function readPlaneWorkspaceConfig(env = process.env) {
  const url = String(env.PLANE_URL ?? '').trim().replace(/\/$/, '')
  const apiKey = String(env.PLANE_API_KEY ?? '').trim()
  const workspace = String(env.PLANE_WORKSPACE_SLUG ?? '').trim()
  const missing = []
  if (!url) missing.push('PLANE_URL')
  if (!apiKey) missing.push('PLANE_API_KEY')
  if (!workspace) missing.push('PLANE_WORKSPACE_SLUG')
  return { url, apiKey, workspace, missing }
}

// "whack-a-mole-2" -> "WAM2": initials of the word parts plus any numeric
// parts, which keeps identifiers short, readable, and distinct across the
// `<name>-N` families Phase B provisions.
export function planeIdentifier(project) {
  const parts = project.split(/[^a-z0-9]+/).filter(Boolean)
  const id = parts.map((part) => (/^\d+$/.test(part) ? part : part[0])).join('')
  return id.toUpperCase().slice(0, 12)
}

export class ProjectStartError extends Error {
  constructor(step, message) {
    super(`${step}: ${message}`)
    this.step = step
  }
}

async function giteaCall(config, token, method, path, body, fetchImpl) {
  const response = await fetchImpl(`${config.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const detail = parsed?.message ?? text.slice(0, 200)
    throw new ProjectStartError('gitea', `${method} ${path} -> HTTP ${response.status}: ${detail}`)
  }
  return parsed
}

function directionSeedFiles(project, concept) {
  return {
    'GUIDE.md': `# ${project}-direction\n\nProject: ${project}\nRole: director\n`,
    'concept.md': `# ${project} — concept\n\n${concept.trim()}\n`,
    '.gitignore': '.local/\n',
  }
}

export async function createGiteaRepoPair(config, project, concept, fetchImpl = fetch) {
  const token = (await readFile(config.tokenPath, 'utf8')).trim()
  const repos = [project, `${project}-direction`]
  for (const name of repos) {
    await giteaCall(config, token, 'POST', `/orgs/${config.org}/repos`, {
      name,
      private: false,
      default_branch: 'main',
    }, fetchImpl)
  }
  const seeds = directionSeedFiles(project, concept)
  for (const [path, body] of Object.entries(seeds)) {
    await giteaCall(
      config, token, 'POST',
      `/repos/${config.org}/${project}-direction/contents/${encodeURIComponent(path)}`,
      { content: Buffer.from(body).toString('base64'), message: `Seed ${path}` },
      fetchImpl,
    )
  }
  return { repos: repos.map((name) => `${config.org}/${name}`), seeded: Object.keys(seeds) }
}

export async function createPlaneProject(config, project, concept, fetchImpl = fetch) {
  const base = `${config.url}/api/v1/workspaces/${encodeURIComponent(config.workspace)}/projects`
  const headers = { 'X-API-Key': config.apiKey, 'content-type': 'application/json' }
  const response = await fetchImpl(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: project,
      identifier: planeIdentifier(project),
      description: concept.trim(),
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new ProjectStartError('plane', `project create -> HTTP ${response.status}: ${JSON.stringify(payload)?.slice(0, 200)}`)
  }
  const statesResponse = await fetchImpl(`${base}/${payload.id}/states/`, {
    headers, signal: AbortSignal.timeout(60_000),
  })
  const statesPayload = await statesResponse.json().catch(() => undefined)
  const rows = Array.isArray(statesPayload) ? statesPayload : statesPayload?.results
  if (!statesResponse.ok || !Array.isArray(rows)) {
    throw new ProjectStartError('plane', `state list -> HTTP ${statesResponse.status}`)
  }
  const states = Object.fromEntries(rows.map((state) => [state.name, state.id]))
  return { id: payload.id, identifier: payload.identifier, states }
}

export async function createProjectChannel(sender, project) {
  const channel = `pj-${project}`
  const principals = await sender.activeUserIds()
  await sender.createChannel(
    channel,
    `Project channel for autolab project ${project} (standing channel, disposable mission-* topics)`,
    principals,
  )
  return { channel, principals }
}

// The whole project start, in provisioning order. Any step's failure aborts
// the rest; what was already created is reported in the error so a human
// (or a retry) can pick up from the evidence.
export async function startProject({ project, concept }, { gitea, plane, sender, fetchImpl = fetch }) {
  const created = {}
  created.gitea = await createGiteaRepoPair(gitea, project, concept, fetchImpl)
  created.plane = await createPlaneProject(plane, project, concept, fetchImpl)
  created.zulip = await createProjectChannel(sender, project)
  return created
}
