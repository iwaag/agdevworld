// User nodes in the browser (p7/ex1 steps 2–3): the dashboard's entry, the
// catalog list and editor with card previews, the example, a stale edit, an
// unreadable catalog; then "Add node" with a template in the workflow
// editor, the node's provenance in the inspector, and the CLI seeing what
// the browser wrote. Builds its own temporary project and private service.
//
//   npm run build && node checks/nodes.ts [--port 8197] [--keep]
//
// Screenshots go to agdevworld/.local/wfe-checks/screenshots/ (ignored).
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8197')

const root = await mkdtemp(join(tmpdir(), 'wfe-nodes-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { readCatalog, updateTemplate } = await import('../server/catalog.ts')

const WF = `schema: ag.workflow.v2
id: improve
name: Improve
intent: |
  Implement and verify.
documentation:
  policy: default
repositories:
  game: {path: ., access: editable}
nodes:
  implement:
    type: do
    name: Implement
    description: Change the game.
    repositories: [game]
edges: []
`
const registry = join(root, 'registry.json')
const dir = join(root, 'pj-rts')
const created = await createProject({ dir, id: 'rts', name: 'RTS check', intent: 'Checks.', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
if (!created.ok) throw new Error(created.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), WF)

const service = new PrivateService({ registry, area: root, port: PORT })
await service.start()
const { browser, page, errors } = await open(1440, 1000)
try {
  console.log('Dashboard and User nodes')
  await page.goto(`${service.base}/#/`)
  await page.getByRole('link', { name: 'User nodes' }).click()
  await page.locator('.template-item[data-template="present"]').waitFor()
  check(await page.locator('.template-item[data-template]').count() === 2, 'the catalog starts with the two p7 presets as templates')
  check(await page.locator('.template-item[data-template="present"] .node.preview.color-teal').count() === 1, 'each template is shown as a card preview')
  check(await page.locator('.template-item.example[data-example="preliminary-research"]').count() === 1, 'the preliminary-research example is offered, not added')
  await page.getByLabel('Your name').fill('Check Person')
  await page.getByRole('button', { name: 'Add "Preliminary research"' }).click()
  await page.locator('.template-item[data-template="preliminary-research"]').waitFor()
  check(await page.locator('.node-editor h2').textContent().then(t => /preliminary-research/.test(t ?? '')), 'the added example opens in the editor as the person\'s template')
  await page.getByLabel('Template expectation').fill('When I ask for research before implementing, I want a study node before it.')
  await page.getByLabel('Template expectation').blur()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.locator('.banner.ok', { hasText: 'Saved preliminary-research' }).waitFor()
  const cat = await readCatalog(root)
  const research = cat.state === 'ok' ? cat.catalog.templates.find(t => t.id === 'preliminary-research') : undefined
  check(research?.revision === 2 && /I want a study node/.test(research.expectation), `the edit is saved as revision 2 in node-catalog.json (${research?.revision})`)
  // Someone else changes it meanwhile; this view's edit is stale.
  await updateTemplate(root, 'preliminary-research', { ...research!, name: 'Research (CLI)' }, 2, 'Someone Else')
  await page.getByLabel('Template name').fill('Research (browser)')
  await page.getByLabel('Template name').blur()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.locator('.banner.error').waitFor()
  check(/revision 3, not 2/.test(await page.locator('.banner.error').textContent() ?? ''), 'a stale edit is refused and says why')
  await page.getByRole('button', { name: /Reload it/ }).click()
  await page.locator('.node-editor h2 .chip', { hasText: 'revision 3' }).waitFor()
  check(await page.getByLabel('Template name').inputValue() === 'Research (CLI)', 'reloading shows the other edit')
  errors.splice(0, errors.length, ...errors.filter(e => !/status of 409/.test(e))) // the stale save's refusal, expected
  // A new template from scratch, with a live preview.
  await page.getByRole('button', { name: '+ New template' }).click()
  await page.getByLabel('Template id').fill('review-doc')
  await page.getByLabel('Template name').fill('Review notes')
  await page.getByLabel('Template name').blur()
  await page.getByLabel('Template type').selectOption('talk')
  await page.getByLabel('Template description').fill('Ask the person to read the notes.')
  await page.getByLabel('Template description').blur()
  await page.getByLabel('Template expectation').fill('A talk node after documentation changes.')
  await page.getByLabel('Template expectation').blur()
  await page.getByLabel('Template color').selectOption('rose')
  check(await page.locator('.preview-slot .node.preview.type-talk.color-rose .node-title').textContent() === 'Review notes', 'the editor previews the card as it will look')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.locator('.template-item[data-template="review-doc"]').waitFor()
  await shot(page, 'p7ex1-user-nodes')

  console.log('Add node in the workflow editor')
  await page.goto(`${service.base}/#/ws/rts/wf/improve.yaml`)
  await page.locator('.node[data-id="implement"]').waitFor()
  await page.locator('button.add-node.template[data-template="preliminary-research"]').waitFor()
  const offered = await page.locator('button.add-node.template').allTextContents()
  check(offered.length === 4 && offered.some(t => t.includes('Research (CLI)')), `"Add node" offers the person's templates beside the basic types (${offered.join(', ')})`)
  check(await page.locator('button.add-node.type-study').count() === 1, 'the basic types are still offered')
  await page.locator('button.add-node.template[data-template="preliminary-research"]').click()
  const added = page.locator('.node[data-id="preliminary-research"]')
  await added.waitFor()
  check(await added.evaluate(e => e.classList.contains('type-study') && e.classList.contains('color-violet')), 'the template adds an ordinary study node with its look')
  check(await page.locator('.template-field').textContent().then(t => /preliminary-research/.test(t ?? '') && /revision 3/.test(t ?? '') && /I want a study node/.test(t ?? '')), 'the inspector shows the template, its revision and the expectation')
  await page.getByLabel('Bind game').check()
  await page.getByLabel('Node description').fill('Research RTS formation movement first.')
  await page.getByRole('button', { name: /^Save/ }).first().click()
  await page.waitForTimeout(700)
  const saved = await readFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), 'utf8')
  check(/  preliminary-research:\n    type: study\n    name: Research \(CLI\)\n    appearance: \{icon: study, color: violet\}\n    description: Research RTS formation movement first.\n    repositories: \[game\]\n    template:\n      id: preliminary-research\n      revision: 3\n/.test(saved), 'saved as an ordinary node with the edited description, the chosen binding and its provenance')
  // The catalog moves on: the inspector says so, the workflow does not change.
  await updateTemplate(root, 'preliminary-research', { ...research!, name: 'Research v4' }, 3, 'Someone Else')
  await page.reload()
  await added.click()
  check(await page.locator('.template-field').textContent().then(t => /catalog has revision 4 now/.test(t ?? '')), 'after a catalog edit the inspector says the node keeps what it was made from')
  check(await readFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), 'utf8') === saved, 'the workflow file is unchanged by the catalog edit')
  await shot(page, 'p7ex1-add-from-template')

  console.log('An unreadable catalog')
  const file = join(root, 'node-catalog.json')
  await rename(file, `${file}.good`)
  await writeFile(file, '{ "schema": "ag.node-catalog.v1", ')
  await page.goto(`${service.base}/#/nodes`)
  await page.locator('.node-list .banner.error').waitFor()
  check(/unavailable/.test(await page.locator('.node-list .banner.error').textContent() ?? ''), 'the page says the catalog is unavailable instead of showing an empty list')
  check(await page.locator('.template-item[data-template]').count() === 0 && await page.getByRole('button', { name: '+ New template' }).count() === 0, 'nothing is offered for editing')
  check(await readFile(file, 'utf8') === '{ "schema": "ag.node-catalog.v1", ', 'the unreadable file is left as it was')
  await page.goto(`${service.base}/#/ws/rts/wf/improve.yaml`)
  await page.locator('.palette-templates .chip.error').waitFor()
  check(true, 'the workflow editor says the templates are unavailable')
  await rename(`${file}.good`, file)
  check(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
