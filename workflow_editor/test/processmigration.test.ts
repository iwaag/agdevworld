import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateProcessRecord } from '../scripts/migrate-process-state.ts'
import { compile } from '../shared/compile.ts'
import { emptyWorkflow } from '../shared/model.ts'
import { operate, type OpInput } from '../shared/run.ts'

test('p11 migration reprojects optional documentation, keeps actors and user stop, and retains original bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfe-p11-migration-'))
  try {
    const w = emptyWorkflow('w', 'W')
    w.nodes.work = { type: 'do', name: 'Work', description: 'Work', repositories: [] }
    const c = compile(w)
    assert.ok(c.ok)
    const graph = c.graph
    const meta = { at: '2026-10-17T00:00:00.000Z', by: 'Agent', via: 'test', graph }
    let r = operate(null, { op: 'run.create', project: 'p', workflow: 'w', run: 'run-001', nodes: Object.keys(graph.nodes), input: { kind: 'braindump', file: 'braindump.md', author: 'Developer' }, executor: { name: 'Agent', backend: null }, predecessor: null, definition: { root: 'w', workflows: {}, warnings: [], effective: graph }, context: { repositories: [] } }, meta)
    for (const op of [{ op: 'node.start', node: 'work' }, { op: 'node.complete', node: 'work', outcome: 'built' }, { op: 'run.stop', reason: 'Developer stopped this run' }] as OpInput[]) r = operate(r, op, meta)
    // The former projection waited for generated reports. Its event history
    // and explicit stop remain the authoritative facts during migration.
    const originalHistory = structuredClone(r.history)
    r.execution.state = 'in-progress'
    r.ended = null
    const file = join(root, 'run.json')
    const original = JSON.stringify(r)
    await writeFile(file, original)
    const migrated = await migrateProcessRecord(file, join(root, '.local'))
    assert.deepEqual(migrated, { changed: true, before: 'in-progress', after: 'completed' })
    const next = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(next.control.hold.kind, 'stopped')
    assert.deepEqual(next.decisions, [])
    assert.deepEqual(next.history.map(({ change: _, ...e }: Record<string, unknown>) => e), originalHistory.map(({ change: _, ...e }) => e))
    const backup = (await readdir(join(root, '.local'))).find(p => !p.endsWith('.migration.json'))!
    assert.equal(await readFile(join(root, '.local', backup), 'utf8'), original)
    assert.equal((await migrateProcessRecord(file, join(root, '.local'))).changed, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
