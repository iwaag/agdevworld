import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = [
  ['drift', 'nctl.drift.v1', 'CLUSTER_STATE_OUTPUT', 'state.json'],
  ['workspaces', 'nctl.workspaces.v1', 'CLUSTER_WORKSPACES_OUTPUT', 'workspaces.json'],
  ['actual', 'nctl.actual.v2', 'CLUSTER_ACTUAL_OUTPUT', 'actual.json'],
]

export function latestScan(runs) {
  const scans = runs.filter((r) => r.workflow === 'scan').sort((a, b) => b.created.localeCompare(a.created))
  const latest = scans[0]
  if (!latest) throw new Error('No cagent scan run exists; request a scan first')
  if (latest.execution !== 'completed') {
    throw new Error(`Latest scan ${latest.ref} is ${latest.execution}; snapshots were not refreshed`)
  }
  return latest
}

export function validateSnapshot(snapshot, ref) {
  if (snapshot?.schema !== 'cagent.snapshot.v1' || snapshot.run !== ref || !Number.isFinite(Date.parse(snapshot.generated_at))) {
    throw new Error(`Invalid snapshot identity or timestamp for ${ref}`)
  }
  for (const [key, schema] of ARTIFACTS) {
    const source = snapshot[key]
    if (source?.schema !== schema || source.ok !== true || !source.data || !Number.isFinite(Date.parse(source.generated_at))) {
      throw new Error(`Snapshot ${ref} has an unreadable ${key} source; existing files were not replaced`)
    }
  }
  return snapshot
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`GET ${url.pathname} returned HTTP ${response.status}`)
  return response.json()
}

// Reads a completed run's artifact; it never opens a request or buys an LLM run.
export async function fetchClusterState(env = process.env) {
  if (!env.WFE_URL) throw new Error('WFE_URL is required: the workflow editor URL (including /wfe/ when proxied)')
  const base = new URL(env.WFE_URL.endsWith('/') ? env.WFE_URL : `${env.WFE_URL}/`)
  const prefix = `api/workspaces/${encodeURIComponent(env.CAGENT_WORKSPACE || 'cagent')}/runs`
  const list = await getJson(new URL(prefix, base))
  const latest = latestScan(list.runs || [])
  const ref = latest.ref
  const artifactUrl = new URL(`${prefix}/${ref.split('/').map(encodeURIComponent).join('/')}/file`, base)
  artifactUrl.searchParams.set('path', 'snapshot.json')
  const artifact = await getJson(artifactUrl)
  const snapshot = validateSnapshot(JSON.parse(artifact.text), ref)
  // Validate every source before changing any output. Partial observation is
  // usable data, but remains explicitly partial in metadata and the UI.
  const metadata = {
    schema: snapshot.schema, run: ref, generated_at: snapshot.generated_at,
    fetched_at: new Date().toISOString(), complete: snapshot.complete === true,
    observation: snapshot.observation, sources: snapshot.sources,
  }
  const outputs = ARTIFACTS.map(([key, , outputEnv, file]) => [
    resolve(env[outputEnv] || resolve(SCRIPT_DIR, '../public/cluster', file)), snapshot[key],
  ])
  outputs.push([resolve(env.CLUSTER_METADATA_OUTPUT || resolve(SCRIPT_DIR, '../public/cluster/snapshot.json')), metadata])
  const staged = []
  try {
    for (const [path, value] of outputs) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      staged.push([temporary, path])
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    }
    for (const [temporary, path] of staged) await rename(temporary, path)
  } finally {
    await Promise.all(staged.map(([temporary]) => unlink(temporary).catch(() => {})))
  }
  return metadata
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  fetchClusterState().then((metadata) => {
    console.log(`Saved ${metadata.run} snapshot from ${metadata.generated_at} (${metadata.complete ? 'complete' : 'partial observation'})`)
  }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
