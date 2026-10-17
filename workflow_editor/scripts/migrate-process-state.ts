// Explicit p11 projection migration. Historical operations, actors, decisions,
// frozen definitions and user stops remain facts. Only derived state/change
// projections are recomputed. Original bytes remain in ignored local evidence.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkRecord, replay, type RunGraph, type RunRecord } from '../shared/run.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'

export async function migrateProcessRecord(file: string, backupDir: string): Promise<{ changed: boolean; before: string; after: string }> {
  const bytes = await readFile(file, 'utf8')
  const raw = JSON.parse(bytes) as RunRecord
  const first = raw.history[0]
  if (first?.op !== 'run.create') throw new Error(`${file}: no creation event`)
  let graph: RunGraph
  if (first.definition.effective) graph = first.definition.effective
  else {
    const parsed = parseWorkflow(await readFile(join(dirname(file), 'definition', `${raw.workflow}.yaml`), 'utf8'))
    if (!parsed.ok) throw new Error(`${file}: frozen definition unreadable`)
    graph = { nodes: parsed.model.nodes, edges: parsed.model.edges }
  }
  const checked = checkRecord(raw, graph)
  if (checked.ok) return { changed: false, before: raw.execution.state, after: raw.execution.state }
  // A malformed history or gap is still an error; this is never a repair of
  // missing operations. replay validates the sequence, payloads and citations.
  const { state, changes } = replay(raw.history, graph)
  const next = { ...state, history: raw.history.map((entry, i) => ({ ...entry, change: changes[i] })) }
  const validation = checkRecord(next, graph)
  if (!validation.ok) throw new Error(`${file}: ${validation.message}`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  await mkdir(backupDir, { recursive: true })
  await writeFile(join(backupDir, `${digest}.json`), bytes, { flag: 'wx' }).catch(async e => {
    if (e.code !== 'EEXIST' || await readFile(join(backupDir, `${digest}.json`), 'utf8') !== bytes) throw e
  })
  await writeFile(`${file}.p11-tmp`, `${JSON.stringify(next, null, 2)}\n`)
  await rename(`${file}.p11-tmp`, file)
  await writeFile(join(backupDir, `${digest}.migration.json`), `${JSON.stringify({ migration: 'p11-process-projection', sha256: digest, before: raw.execution.state, after: next.execution.state, at: new Date().toISOString() }, null, 2)}\n`)
  return { changed: true, before: raw.execution.state, after: next.execution.state }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [backup, ...files] = process.argv.slice(2)
  if (!backup || !files.length) throw new Error('Usage: node scripts/migrate-process-state.ts <ignored-backup-directory> <run.json>...')
  for (const file of files) {
    if (!(await stat(file)).isFile()) throw new Error(`${file}: not a file`)
    console.log(JSON.stringify({ file, ...await migrateProcessRecord(file, backup) }))
  }
}
