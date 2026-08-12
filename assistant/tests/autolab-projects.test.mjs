import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROJECT_NAME,
  ProjectStartError,
  createGiteaRepoPair,
  createPlaneProject,
  createProjectChannel,
  planeIdentifier,
  readGiteaConfig,
  readPlaneWorkspaceConfig,
  startProject,
} from '../autolab-projects.mjs'

function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

test('project names are lowercase-hyphen only', () => {
  assert.ok(PROJECT_NAME.test('whack-a-mole-2'))
  assert.ok(!PROJECT_NAME.test('Whack'))
  assert.ok(!PROJECT_NAME.test('a'))
  assert.ok(!PROJECT_NAME.test('-x'))
})

test('plane identifiers are initials plus numeric parts', () => {
  assert.equal(planeIdentifier('whack-a-mole'), 'WAM')
  assert.equal(planeIdentifier('whack-a-mole-2'), 'WAM2')
  assert.equal(planeIdentifier('quiz'), 'Q')
})

test('config readers report what is missing', () => {
  assert.deepEqual(readGiteaConfig({}).missing, ['GITEA_URL'])
  assert.deepEqual(readGiteaConfig({ GITEA_URL: 'http://g' }).missing, [])
  assert.equal(readGiteaConfig({}).org, 'autodev')
  assert.deepEqual(readPlaneWorkspaceConfig({ PLANE_URL: 'http://p', PLANE_API_KEY: 'k' }).missing, ['PLANE_WORKSPACE_SLUG'])
})

async function giteaConfigWithToken() {
  const dir = await mkdtemp(join(tmpdir(), 'gitea-'))
  const tokenPath = join(dir, 'token')
  await writeFile(tokenPath, 'sekrit\n')
  return { url: 'http://gitea.test', tokenPath, org: 'autodev', missing: [] }
}

test('createGiteaRepoPair creates both repos and seeds the direction repo', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push([url, options.method, options.body])
    return jsonResponse(201, { ok: true })
  }
  const config = await giteaConfigWithToken()
  const result = await createGiteaRepoPair(config, 'demo', 'a demo game', fetchImpl)
  assert.deepEqual(result.repos, ['autodev/demo', 'autodev/demo-direction'])
  assert.deepEqual(result.seeded, ['GUIDE.md', 'concept.md', '.gitignore'])
  assert.equal(calls.length, 5)
  assert.ok(calls[0][0].endsWith('/api/v1/orgs/autodev/repos'))
  assert.equal(calls[0][1], 'POST')
  assert.ok(calls[2][0].includes('/repos/autodev/demo-direction/contents/GUIDE.md'))
  const seeded = JSON.parse(calls[3][2])
  assert.ok(Buffer.from(seeded.content, 'base64').toString().includes('a demo game'))
})

test('createGiteaRepoPair surfaces the failing step', async () => {
  const config = await giteaConfigWithToken()
  const fetchImpl = async () => jsonResponse(409, { message: 'repo exists' })
  await assert.rejects(
    createGiteaRepoPair(config, 'demo', 'c', fetchImpl),
    (error) => error instanceof ProjectStartError && error.step === 'gitea' && /409/.test(error.message),
  )
})

test('createPlaneProject returns the uuid and state ids', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') return jsonResponse(201, { id: 'uuid-1', identifier: 'D' })
    return jsonResponse(200, [{ name: 'Todo', id: 's-todo' }, { name: 'Done', id: 's-done' }])
  }
  const config = { url: 'http://plane.test', apiKey: 'k', workspace: 'ws', missing: [] }
  const result = await createPlaneProject(config, 'demo', 'concept', fetchImpl)
  assert.deepEqual(result, { id: 'uuid-1', identifier: 'D', states: { Todo: 's-todo', Done: 's-done' } })
})

test('createProjectChannel subscribes every active user', async () => {
  const calls = []
  const sender = {
    activeUserIds: async () => [8, 9, 10],
    createChannel: async (name, description, principals) => {
      calls.push([name, principals])
    },
  }
  const result = await createProjectChannel(sender, 'demo')
  assert.deepEqual(calls, [['pj-demo', [8, 9, 10]]])
  assert.deepEqual(result, { channel: 'pj-demo', principals: [8, 9, 10] })
})

test('startProject provisions gitea, plane, and zulip in order', async () => {
  const order = []
  const gitea = await giteaConfigWithToken()
  const fetchImpl = async (url, options = {}) => {
    if (url.startsWith('http://gitea.test')) {
      order.push('gitea')
      return jsonResponse(201, {})
    }
    order.push('plane')
    if (options.method === 'POST') return jsonResponse(201, { id: 'u', identifier: 'D' })
    return jsonResponse(200, [])
  }
  const sender = {
    activeUserIds: async () => [1],
    createChannel: async () => order.push('zulip'),
  }
  const created = await startProject(
    { project: 'demo', concept: 'c' },
    { gitea, plane: { url: 'http://plane.test', apiKey: 'k', workspace: 'w', missing: [] }, sender, fetchImpl },
  )
  assert.equal(order.filter((step) => step === 'gitea').length, 5)
  assert.deepEqual(order.slice(-3), ['plane', 'plane', 'zulip'])
  assert.equal(created.zulip.channel, 'pj-demo')
})
