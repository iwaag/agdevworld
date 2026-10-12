// Node appearance in the browser (p7 step 2): presets (catalog templates since p7/ex1) in the palette, the
// inspector's icon and color, saving, and — in the run view — that a node's
// own color never replaces its state's words, glyph or colors. Builds its own
// temporary project and private service.
//
//   npm run build && node checks/appearance.ts [--port 8198] [--keep]
//
// Screenshots go to agdevworld/.local/wfe-checks/screenshots/ (ignored).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpInput, RunRef } from '../shared/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8198')

const root = await mkdtemp(join(tmpdir(), 'wfe-appearance-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { createRun, runOp } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

const WF = `schema: ag.workflow.v2
id: show
name: Show
intent: |
  Implement, present, confirm, clean up.
documentation:
  policy: manual
nodes:
  implement:
    type: do
    name: Implement
    description: Change the game.
  present:
    type: do
    name: Present
    appearance: {icon: present, color: teal}
    description: Freeze and serve the result.
  check:
    type: talk
    name: Human check
    confirms: result
    description: Ask the person.
  cleanup:
    type: do
    name: Clean up
    appearance: {icon: cleanup, color: slate}
    description: Stop the server.
edges:
  - {from: implement, to: present}
  - {from: present, to: check}
  - {from: check, to: cleanup}
`
const registry = join(root, 'registry.json')
const dir = join(root, 'pj-look')
const created = await createProject({ dir, id: 'look', name: 'Appearance check', intent: 'Checks.', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
if (!created.ok) throw new Error(created.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'show.yaml'), WF)
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
for (const kind of ['intent', 'definition'] as const) await ws.approve('show.yaml', kind, 'Check Person')
const op = async (r: RunRef, i: OpInput) => (await runOp(ws, r, i, { via: 'cli' })).record
const R = (await createRun(ws, { workflow: 'show', input: { kind: 'braindump', text: 'x', author: 'Check Person' }, executor: { name: 'Omni Agent', backend: null }, by: 'Omni Agent', via: 'cli' })).ref
await op(R, { op: 'node.start', node: 'implement' })
await op(R, { op: 'node.complete', node: 'implement', outcome: 'Done.' })
await op(R, { op: 'node.start', node: 'present' }) // running, in a custom color

const service = new PrivateService({ registry, area: root, port: PORT })
await service.start()
const { browser, page, errors } = await open(1440, 900)
try {
  console.log('Editor')
  await page.goto(`${service.base}/#/ws/look/wf/show.yaml`)
  await page.locator('.node[data-id="present"]').waitFor()
  check(await page.locator('.node[data-id="present"]').evaluate(e => e.classList.contains('color-teal') && e.classList.contains('type-do')), 'the presentation node keeps its type and shows its own color')
  check(await page.locator('.node[data-id="present"] .type-label').textContent() === 'Do', 'its type label still says Do')
  check(await page.locator('.node[data-id="implement"]').evaluate(e => ![...e.classList].some(c => c.startsWith('color-'))), 'a node without appearance uses its type\'s look')
  // Since p7/ex1 the presets are the person's catalog templates (seeded once),
  // offered in the Add node menu (p8).
  await page.getByRole('button', { name: 'Add node', exact: true }).click()
  await page.locator('button.add-node.template').first().waitFor()
  const presetButtons = await page.locator('button.add-node.template').allTextContents()
  check(presetButtons.some(t => t.includes('Present')) && presetButtons.some(t => t.includes('Clean up')), `the palette offers the seeded templates (${presetButtons.join(', ')})`)
  const approvedBefore = await page.locator('.approval-pills').first().textContent().catch(() => '')
  await page.locator('button.add-node.template', { hasText: 'Clean up' }).click()
  const added = page.locator('.node[data-id="cleanup-2"]')
  await added.waitFor()
  check(await added.evaluate(e => e.classList.contains('color-slate') && e.classList.contains('type-do')), 'a preset adds an ordinary do node with the preset look')
  await page.locator('.node[data-id="implement"]').click()
  await page.locator('.insp-group[data-group="appearance"] summary').click() // a group of the node inspector (p8)
  await page.getByLabel('Node color').selectOption('orange')
  check(await page.locator('.node[data-id="implement"]').evaluate(e => e.classList.contains('color-orange')), 'the inspector changes the color on the card')
  await page.getByRole('button', { name: /^Save/ }).first().click()
  await page.waitForTimeout(600)
  const saved = await readFile(join(dir, 'devdocs', 'workflows', 'show.yaml'), 'utf8')
  check(/implement:[\s\S]*?appearance: \{color: orange\}/.test(saved), 'saving writes the appearance in flow style')
  check(/cleanup-2:\n    type: do\n    name: Clean up/.test(saved), 'the template node is saved as a do node with its name')
  const approvedAfter = await page.locator('.approval-pills').first().textContent().catch(() => '')
  check(!/stale/i.test(approvedAfter ?? '') || /stale/i.test(approvedBefore ?? ''), 'restyling did not make an approval stale (adding a node did change the definition)')
  await shot(page, 'p7-appearance-editor')

  console.log('Run view')
  await page.goto(`${service.base}/#/ws/look/run/show/run-001`)
  const running = page.locator('.node[data-id="present"]')
  await running.locator('.run-status').waitFor()
  const status = await running.locator('.run-status').evaluate(e => { const s = getComputedStyle(e); return { text: e.textContent ?? '', color: s.color, bg: s.backgroundColor } })
  const card = await running.evaluate(e => getComputedStyle(e).backgroundColor)
  check(status.text.includes('✎') && /Running/.test(status.text), `the running state is said in a glyph and words (${status.text.trim()})`)
  check(status.bg !== card, 'the state pill keeps its own background over the custom color')
  check(await running.evaluate(e => e.classList.contains('run-running') && e.classList.contains('color-teal')), 'state ring and custom color are both present')
  const ring = await running.evaluate(e => getComputedStyle(e).boxShadow)
  check(/111, 179, 214|6fb3d6/i.test(ring), `the running ring color is unchanged (${ring})`)
  check(await page.locator('.node[data-id="cleanup"]').evaluate(e => e.classList.contains('color-slate') && e.dataset.state === 'pending'), 'the cleanup node shows its look from the run\'s snapshot')
  await shot(page, 'p7-appearance-run')
  check(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
