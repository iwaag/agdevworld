import assert from 'node:assert/strict'
import test from 'node:test'

import { proxyPlaneRequest, readPlaneConfig } from '../plane-passthrough.mjs'

const config = readPlaneConfig({
  PLANE_URL: 'http://plane.example/',
  PLANE_API_KEY: 'server-secret',
  PLANE_WORKSPACE_SLUG: 'agautolab',
  PLANE_PROJECT_ID: 'project-id',
})

test('Plane configuration reports missing server-side values without a key', () => {
  const missing = readPlaneConfig({ PLANE_URL: 'http://plane.example' })
  // PLANE_PROJECT_ID is optional now (multi-project): only the bare
  // default-project paths need it.
  assert.deepEqual(missing.missing, ['PLANE_API_KEY', 'PLANE_WORKSPACE_SLUG'])
  assert.equal(JSON.stringify(missing).includes('server-secret'), false)
})

test('project-scoped paths carry their own project id', async () => {
  const calls = []
  const result = await proxyPlaneRequest({
    method: 'GET',
    url: '/api/plane/projects/other-uuid/issues?per_page=5',
  }, config, async (url, options) => {
    calls.push({ url, options })
    return new Response('{"results":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  assert.equal(result.status, 200)
  assert.equal(calls[0].url, 'http://plane.example/api/v1/workspaces/agautolab/projects/other-uuid/issues/?per_page=5')
})

test('bare paths without a configured default project answer 404', async () => {
  const noDefault = readPlaneConfig({
    PLANE_URL: 'http://plane.example',
    PLANE_API_KEY: 'k',
    PLANE_WORKSPACE_SLUG: 'agautolab',
  })
  const result = await proxyPlaneRequest({ method: 'GET', url: '/api/plane/issues' }, noDefault)
  assert.equal(result.status, 404)
  assert.match(result.body.toString(), /plane_no_default_project/)
})

test('Plane passthrough fixes the project scope and injects the API key', async () => {
  const calls = []
  const result = await proxyPlaneRequest({
    method: 'GET',
    url: '/api/plane/issues?per_page=50',
  }, config, async (url, options) => {
    calls.push({ url, options })
    return new Response('{"results":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  assert.equal(result.status, 200)
  assert.equal(calls[0].url, 'http://plane.example/api/v1/workspaces/agautolab/projects/project-id/issues/?per_page=50')
  assert.equal(calls[0].options.headers['X-API-Key'], 'server-secret')
  assert.equal(result.body.toString(), '{"results":[]}')
})

test('Plane passthrough refuses paths outside issues and states', async () => {
  const result = await proxyPlaneRequest({ method: 'GET', url: '/api/plane/workspaces' }, config)
  assert.equal(result.status, 404)
  assert.match(result.body.toString(), /plane_path_not_proxied/)
})

test('Plane passthrough resolves state_name through the live project states', async () => {
  const calls = []
  const result = await proxyPlaneRequest({
    method: 'POST',
    url: '/api/plane/issues',
    contentType: 'application/json',
    body: JSON.stringify({ name: 'Readable UI', state_name: 'Ready' }),
  }, config, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/states/')) {
      return Response.json({ results: [{ id: 'ready-id', name: 'Ready' }] })
    }
    return Response.json({ id: 'issue-id' }, { status: 201 })
  })
  assert.equal(result.status, 201)
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Readable UI', state: 'ready-id' })
  assert.equal(calls[1].options.headers['X-API-Key'], 'server-secret')
})

test('Plane passthrough returns an explicit error for an unknown state name', async () => {
  const result = await proxyPlaneRequest({
    method: 'PATCH',
    url: '/api/plane/issues/issue-id',
    contentType: 'application/json',
    body: JSON.stringify({ state_name: 'Imaginary' }),
  }, config, async () => Response.json({ results: [{ id: 'ready-id', name: 'Ready' }] }))
  assert.equal(result.status, 400)
  assert.match(result.body.toString(), /unknown_plane_state/)
  assert.equal(result.body.toString().includes('server-secret'), false)
})
