import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchClusterState, latestScan } from './fetch-cluster-state.mjs'

const run = { workflow: 'scan', ref: 'scan/run-002', created: '2026-10-16T00:00:00Z', execution: 'completed' }
const snapshot = {
  schema: 'cagent.snapshot.v1', run: run.ref, generated_at: run.created, complete: false,
  observation: { hosts: [{ host: 'unavailable-example', outcome: 'unavailable' }] },
  sources: {},
  ...Object.fromEntries([['drift', 'nctl.drift.v1'], ['workspaces', 'nctl.workspaces.v1'], ['actual', 'nctl.actual.v2']]
    .map(([key, schema]) => [key, { schema, ok: true, generated_at: run.created, data: {} }])),
}

test('newer failed or waiting scan never falls back to older complete scan', () => {
  for (const execution of ['failed', 'in-progress']) {
    assert.throws(() => latestScan([run, { ...run, created: '2026-10-17T00:00:00Z', execution }]), /snapshots were not refreshed/)
  }
})

test('partial artifact preserves provenance; invalid source leaves previous files intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cluster-import-'))
  let current = structuredClone(snapshot)
  const urls = []
  const server = createServer((req, res) => {
    urls.push(req.url)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.endsWith('/runs') ? { runs: [run] } : { path: 'snapshot.json', text: JSON.stringify(current) }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = { WFE_URL: `http://127.0.0.1:${server.address().port}/wfe/`,
    CLUSTER_STATE_OUTPUT: join(dir, 'state'), CLUSTER_ACTUAL_OUTPUT: join(dir, 'actual'),
    CLUSTER_WORKSPACES_OUTPUT: join(dir, 'workspaces'), CLUSTER_METADATA_OUTPUT: join(dir, 'meta') }
  try {
    const metadata = await fetchClusterState(env)
    assert.equal(metadata.complete, false)
    assert.deepEqual(metadata.observation, snapshot.observation)
    assert.deepEqual(JSON.parse(await readFile(env.CLUSTER_STATE_OUTPUT, 'utf8')), snapshot.drift)
    assert.equal(JSON.parse(await readFile(env.CLUSTER_METADATA_OUTPUT, 'utf8')).run, run.ref)
    assert.equal(urls.length, 2)
    assert.match(urls[1], /\/runs\/scan\/run-002\/file\?path=snapshot.json/)
    await writeFile(env.CLUSTER_STATE_OUTPUT, 'previous-state')
    current.actual.ok = false
    await assert.rejects(fetchClusterState(env), /unreadable actual/)
    assert.equal(await readFile(env.CLUSTER_STATE_OUTPUT, 'utf8'), 'previous-state')
    current = { ...snapshot, run: 'scan/wrong-run' }
    await assert.rejects(fetchClusterState(env), /Invalid snapshot identity/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
