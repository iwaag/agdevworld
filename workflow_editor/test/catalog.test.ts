// p7/ex1 step 2: the person's node catalog (docs/catalog.md). One file per
// operating area; the HTTP routes and `wfe nodes` share its operations:
// initialization once, validation, revisions, stale edits, retired ids, and
// an unreadable catalog that is reported and never overwritten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from '../server/api.ts'
import { addExample, createTemplate, deleteTemplate, readCatalog, updateTemplate } from '../server/catalog.ts'
import { main } from '../cli/wfe.ts'

async function area(): Promise<{ dir: string; registry: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'wfe-catalog-'))
  const registry = join(dir, 'registry.json')
  await writeFile(registry, JSON.stringify({ approver: '', workspaces: [] }))
  return { dir, registry }
}
const content = (over: Record<string, unknown> = {}) => ({ name: 'Preliminary research', type: 'study', description: 'Research first; record sources.', expectation: 'A study node before the work it informs.', ...over })
const rejects = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: { detail?: { code?: string } }) => { assert.equal(e.detail?.code, code); return true })

async function captured(argv: string[]): Promise<{ code: number; out: unknown }> {
  const lines: string[] = []
  const log = console.log, err = console.error
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  console.error = () => {}
  try { const code = await main([...argv, '--json']); return { code, out: lines.length ? JSON.parse(lines.join('\n')) : null } } finally { console.log = log; console.error = err }
}

test('a missing catalog is initialized once with the presets; deleting them sticks', async () => {
  const a = await area()
  const r = await readCatalog(a.dir)
  assert.equal(r.state, 'ok')
  if (r.state !== 'ok') return
  assert.equal(r.initializedNow, true)
  assert.deepEqual(r.catalog.templates.map(t => [t.id, t.type, t.revision, t.appearance?.icon]), [['present', 'do', 1, 'present'], ['cleanup', 'do', 1, 'cleanup']])
  assert.deepEqual(r.catalog.initialized?.seeded, ['present', 'cleanup'])
  assert.match(r.catalog.templates[0].description, /freeze it as a presentation/) // p7's preset text
  await deleteTemplate(a.dir, 'present', 1, 'Pat')
  await deleteTemplate(a.dir, 'cleanup', 1, 'Pat')
  // A later read (another process, a new release) finds the file: nothing is seeded again.
  const again = await readCatalog(a.dir)
  assert.ok(again.state === 'ok' && !again.initializedNow && again.catalog.templates.length === 0)
  assert.deepEqual(again.state === 'ok' && again.catalog.deleted.map(d => d.id), ['present', 'cleanup'])
})

test('revisions follow content; stale edits, retired ids and invalid content are refused', async () => {
  const a = await area()
  const { template } = await createTemplate(a.dir, 'research', content(), 'Pat')
  assert.equal(template.revision, 1)
  await rejects(createTemplate(a.dir, 'research', content(), 'Pat'), 'template-exists')
  const same = await updateTemplate(a.dir, 'research', content(), 1, 'Pat')
  assert.equal(same.changed, false)
  assert.equal(same.template.revision, 1)
  const edited = await updateTemplate(a.dir, 'research', content({ expectation: 'Its own node, always.' }), 1, 'Pat')
  assert.equal(edited.template.revision, 2)
  // Someone else's edit based on revision 1 is stale now.
  await rejects(updateTemplate(a.dir, 'research', content({ name: 'Research' }), 1, 'Sam'), 'template-stale')
  await rejects(deleteTemplate(a.dir, 'research', 1, 'Sam'), 'template-stale')
  await rejects(createTemplate(a.dir, 'delegate-it', content({ type: 'delegate' }), 'Pat'), 'template-invalid')
  await rejects(createTemplate(a.dir, 'no-expectation', content({ expectation: ' ' }), 'Pat'), 'template-invalid')
  await rejects(createTemplate(a.dir, 'odd', content({ appearance: { icon: 'rocket', color: '' } }), 'Pat'), 'template-invalid')
  await rejects(createTemplate(a.dir, 'Bad Id', content(), 'Pat'), 'template-id')
  await deleteTemplate(a.dir, 'research', 2, 'Pat')
  await rejects(createTemplate(a.dir, 'research', content(), 'Pat'), 'template-retired')
  const r = await readCatalog(a.dir)
  assert.ok(r.state === 'ok')
  if (r.state === 'ok') assert.equal(r.catalog.generation, 4) // initialization, creation, the edit, the deletion: refusals and no-op saves write nothing
})

test('an unreadable catalog is reported, refuses writes and is never replaced', async () => {
  for (const text of ['{ not json', JSON.stringify({ schema: 'ag.node-catalog.v0', generation: 1, templates: [] }), JSON.stringify({ schema: 'ag.node-catalog.v1', generation: 1, templates: [{ id: 'x', revision: 1, name: 'X', type: 'delegate', description: 'd', expectation: 'e', updated: '', by: '' }] })]) {
    const a = await area()
    const file = join(a.dir, 'node-catalog.json')
    await writeFile(file, text)
    const r = await readCatalog(a.dir)
    assert.equal(r.state, 'unavailable')
    await rejects(createTemplate(a.dir, 'research', content(), 'Pat'), 'catalog-unavailable')
    assert.equal(await readFile(file, 'utf8'), text)
  }
})

test('the browser route and wfe nodes read and change the same catalog', async () => {
  const a = await area()
  const handler = createHandler({ registryFile: a.registry, area: a.dir, allowedOrigins: [], allowedHosts: ['127.0.0.1'] })
  const srv = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/nodes`
  const http = async (method: string, path = '', body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() as Record<string, unknown> }
  }
  try {
    const cli = (...args: string[]) => captured(['nodes', ...args, '--registry', a.registry, '--area', a.dir])
    // Created from the command line, seen by the browser route.
    assert.equal((await cli('create', 'research', '--name', 'Research', '--type', 'study', '--description', 'Look first.', '--expectation', 'A study node first.', '--icon', 'study', '--color', 'violet', '--by', 'Pat')).code, 0)
    const seen = await http('GET')
    assert.equal(seen.status, 200)
    const ids = ((seen.body.catalog as { templates: { id: string }[] }).templates).map(t => t.id)
    assert.deepEqual(ids, ['present', 'cleanup', 'research'])
    assert.deepEqual((seen.body.examples as { id: string }[]).map(x => x.id), ['preliminary-research'])
    // Edited by the browser route, seen by the CLI.
    assert.equal((await http('PUT', '/research', { ...content({ name: 'Research first' }), expectRevision: 1, by: 'Pat' })).status, 200)
    const shown = await cli('show', 'research')
    assert.equal((shown.out as { name: string; revision: number }).name, 'Research first')
    assert.equal((shown.out as { revision: number }).revision, 2)
    // A stale edit through either surface is refused the same way.
    assert.equal((await http('PUT', '/research', { ...content(), expectRevision: 1, by: 'Sam' })).status, 409)
    assert.equal((await cli('update', 'research', '--expect-revision', '1', '--name', 'X', '--by', 'Sam')).code, 1)
    // The example is offered, never added by itself; added on request, it is the person's.
    assert.equal((await cli('example', 'preliminary-research', '--by', 'Pat')).code, 0)
    assert.equal((await http('DELETE', '/preliminary-research?revision=1&by=Pat')).status, 200)
    assert.deepEqual(((await cli('list')).out as { templates: { id: string }[] }).templates.map(t => t.id), ['present', 'cleanup', 'research'])
    // A missing name for who changes it is a refusal, not an anonymous write.
    assert.equal((await http('POST', '', { id: 'anon', ...content() })).status, 422)
  } finally { srv.close() }
})

test('the example becomes an ordinary template of the person', async () => {
  const a = await area()
  const { template } = await addExample(a.dir, 'preliminary-research', 'Pat')
  assert.equal(template.type, 'study')
  assert.match(template.description, /sources consulted/)
  assert.equal(template.by, 'Pat')
})
