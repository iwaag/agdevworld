// Step 3 browser check: build a workflow in the UI with all node types,
// branching, joining, a delegate and repository bindings; move, connect,
// delete, pan/zoom, both display modes; save, reopen and compare.
// Expects a fresh seed, the service and the Vite dev server.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseWorkflow } from '../server/yamlDoc.ts'
import { BASE, check, done, open, shot, wsDir } from './lib.ts'

const FILE = join(wsDir('a'), 'devdocs/workflows/release-check.yaml')
const { browser, page, errors } = await open(1440, 960)

// Create the workflow from the project screen.
await page.goto(`${BASE}/#/ws/a`)
await page.getByLabel('New workflow id').fill('release-check')
await page.getByLabel('New workflow name').fill('Release Check')
await page.getByRole('button', { name: 'Create' }).click()
await page.waitForFunction(() => location.hash.endsWith('/wf/release-check.yaml'))
await page.waitForSelector('.wf-name')
await page.waitForFunction(() => (document.querySelector('.wf-name') as HTMLInputElement).value === 'Release Check')

await page.getByLabel('Workflow intent').fill('Check that a release is ready: study the conventions, build and agree in parallel,\nthen hand repository setup to its workflow.')

// Repository bindings (nothing selected).
async function addBinding(key: string, path: string, access: string) {
  await page.getByLabel('New binding key').fill(key)
  await page.getByLabel('New binding path').selectOption(path)
  await page.getByLabel('New binding access').selectOption(access)
  await page.locator('.add-binding button', { hasText: 'Add' }).click()
  await page.waitForSelector(`.binding-row[data-binding="${key}"]`)
}
await addBinding('tools', 'study/tools', 'readonly')
await addBinding('runtime', 'wedo/runtime', 'editable')
await addBinding('docs', 'devdocs', 'editable')

// Nodes of every type, edited in the inspector.
async function addNode(type: string, name: string, description: string, repos: string[] = []) {
  await page.getByRole('button', { name: `Add ${type} node` }).click()
  await page.getByLabel('Node name').fill(name)
  await page.getByLabel('Node description').fill(description)
  for (const r of repos) await page.getByLabel(`Bind ${r}`).check()
  return page.locator('.node.selected').getAttribute('data-id')
}
const study = (await addNode('Study', 'Read conventions', 'Look up release conventions in the tool studies.', ['tools']))!
const build = (await addNode('Do', 'Build', 'Build the release candidate.', ['runtime']))!
const agree = (await addNode('Talk', 'Agree scope', 'Agree the release scope with the owner.', ['docs']))!
const verify = (await addNode('Do', 'Verify', 'Verify the candidate after build and agreement.', ['runtime', 'docs']))!
const hand = (await addNode('Delegate', 'Repository setup', 'Run repository setup and wait.'))!
await page.getByLabel('Delegate target').selectOption('repo-setup')
const extra = (await addNode('Talk', 'Temporary', 'Deleted later with its connections.'))!
check([study, build, agree, verify, hand, extra].every(Boolean), 'six nodes created')

// Connections: through the inspector …
async function connectVia(from: string, to: string) {
  await page.getByRole('button', { name: 'Fit' }).click()
  await page.locator(`.node[data-id="${from}"]`).click()
  await page.getByLabel('Connect to node').selectOption(to)
  await page.locator('.inspector button', { hasText: 'Connect' }).click()
}
await connectVia(study, build)
await connectVia(study, agree)
await connectVia(build, verify)
await connectVia(extra, verify)
await connectVia(verify, extra)
// … and by dragging a port onto a card (after fitting the graph into view).
await page.getByRole('button', { name: 'Fit' }).click()
async function connectDrag(from: string, to: string) {
  const card = page.locator(`.node[data-id="${from}"]`)
  await card.hover()
  const port = await card.locator('.port').boundingBox()
  const target = await page.locator(`.node[data-id="${to}"]`).boundingBox()
  await page.mouse.move(port!.x + port!.width / 2, port!.y + port!.height / 2)
  await page.mouse.down()
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 8 })
  await page.mouse.up()
}
await connectDrag(agree, verify)
await connectDrag(verify, hand)
const drawn = await page.$$eval('.edge', els => els.map(e => `${e.getAttribute('data-from')}>${e.getAttribute('data-to')}`))
check(drawn.length === 7, `seven connections drawn (${drawn.join(', ')})`)
check(await page.locator('.v-summary.error').isVisible(), 'cycle verify ↔ temporary is reported')

// Delete the temporary node: its three incident edges go with it.
await page.locator(`.node[data-id="${extra}"]`).click()
await page.getByRole('button', { name: 'Delete node' }).click()
check(await page.locator('.node').count() === 5, 'node deleted')
check(await page.locator('.edge').count() === 5, 'its two incident edges removed with the node')
// Delete one connection and re-add it by keyboard selection + Delete.
await page.locator(`.edge[data-from="${study}"][data-to="${build}"] .hit`).dispatchEvent('pointerdown')
check(await page.locator('.inspector h3', { hasText: 'Connection' }).isVisible(), 'edge selection opens the connection inspector')
await page.keyboard.press('Delete')
check(await page.locator('.edge').count() === 4, 'Delete key removes the selected edge')
await connectVia(study, build)
check(await page.locator('.v-summary.ok').isVisible(), 'graph is valid again')

// Auto-arrange lays out by rank: the parallel branches share a column.
await page.getByRole('button', { name: 'Auto-arrange' }).click()
const bBox = await page.locator(`.node[data-id="${build}"]`).boundingBox()
const aBox = await page.locator(`.node[data-id="${agree}"]`).boundingBox()
check(Math.abs(bBox!.x - aBox!.x) < 1 && Math.abs(bBox!.y - aBox!.y) > bBox!.height, 'auto-arrange puts the two branches in one column, different rows')

// Move a node by dragging it.
const before = await page.locator(`.node[data-id="${hand}"]`).boundingBox()
await page.mouse.move(before!.x + 40, before!.y + 20)
await page.mouse.down()
await page.mouse.move(before!.x + 40 + 120, before!.y + 20 + 60, { steps: 10 })
await page.mouse.up()
const after = await page.locator(`.node[data-id="${hand}"]`).boundingBox()
check(Math.abs(after!.x - before!.x - 120) < 3 && Math.abs(after!.y - before!.y - 60) < 3, 'node moved by drag')

// Pan and zoom change the view, not the draft positions.
const zoomBefore = await page.locator(`.node[data-id="${study}"]`).boundingBox()
await page.getByRole('button', { name: '+' }).click()
const zoomed = await page.locator(`.node[data-id="${study}"]`).boundingBox()
check(zoomed!.width > zoomBefore!.width * 1.15, 'zoom in enlarges cards')
const canvas = await page.locator('.canvas').boundingBox()
await page.mouse.move(canvas!.x + 30, canvas!.y + canvas!.height - 30)
await page.mouse.down(); await page.mouse.move(canvas!.x + 130, canvas!.y + canvas!.height - 80, { steps: 5 }); await page.mouse.up()
const panned = await page.locator(`.node[data-id="${study}"]`).boundingBox()
check(Math.abs(panned!.x - zoomed!.x - 100) < 3, 'background drag pans')
await page.getByRole('button', { name: 'Fit' }).click()
await shot(page, 'step3-release-compact', false)

// Mini mode: same nodes and edges, less detail; full description via selection.
await page.getByRole('button', { name: 'Mini' }).click()
check(await page.locator('.canvas[data-mode="mini"] .node').count() === 5 && await page.locator('.edge').count() === 5, 'mini mode shows the same graph')
check(await page.locator('.node .node-desc').count() === 0, 'mini cards omit descriptions')
await page.locator(`.node[data-id="${verify}"]`).click()
check(await page.getByLabel('Node description').inputValue() === 'Verify the candidate after build and agreement.', 'full description available through selection')
await shot(page, 'step3-release-mini', false)
await page.getByRole('button', { name: 'Compact' }).click()

// Save, then compare the file with what was built.
await page.getByRole('button', { name: 'Save', exact: true }).click()
await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.save-state')?.textContent ?? ''))
const text = await readFile(FILE, 'utf8')
const parsed = parseWorkflow(text)
check(parsed.ok, 'saved file parses')
if (parsed.ok) {
  const w = parsed.model
  check(Object.keys(w.nodes).length === 5 && w.edges.length === 5, 'file has five nodes and five edges')
  check(new Set(Object.values(w.nodes).map(n => n.type)).size === 4, 'file has all four node types')
  check(w.edges.filter(e => e.from === study).length === 2, 'branch: study has two successors')
  check(w.edges.filter(e => e.to === verify).length === 2, 'join: verify waits for two predecessors')
  check(w.nodes[hand].workflow === 'repo-setup', 'delegate target saved by id')
  check(w.edges.some(e => e.from === verify && e.to === hand), 'delegate waits for verify (drag-connected)')
  check(w.repositories.tools.access === 'readonly' && w.repositories.runtime.access === 'editable', 'binding access saved')
  check(JSON.stringify(w.nodes[verify].repositories) === '["runtime","docs"]', 'node bindings saved')
  check(Object.keys(w.layout.nodes).length === 5, 'positions stored for every node')
  check(w.intent.includes('\n'), 'multiline intent saved')
  check(text.startsWith('# Workflow definition'), 'creation comment kept')
}

// Reopen: same graph and same text.
const positionsBefore = await page.$$eval('.node', els => els.map(e => [e.getAttribute('data-id'), (e as HTMLElement).style.left, (e as HTMLElement).style.top]).sort())
await page.reload()
await page.waitForSelector('.node')
await page.waitForTimeout(300)
const positionsAfter = await page.$$eval('.node', els => els.map(e => [e.getAttribute('data-id'), (e as HTMLElement).style.left, (e as HTMLElement).style.top]).sort())
check(JSON.stringify(positionsBefore) === JSON.stringify(positionsAfter), 'reopened graph has the same nodes and positions')
check(await page.locator('.edge').count() === 5, 'reopened graph has the same edges')
check(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'reopened draft is clean (nothing to save)')
check(await readFile(FILE, 'utf8') === text, 'file text unchanged by reopening')
await shot(page, 'step3-release-reopened', false)

// The existing onboarding workflow opens unchanged and stays byte-identical.
const onboardingPath = join(wsDir('a'), 'devdocs/workflows/onboarding.yaml')
const onboardingText = await readFile(onboardingPath, 'utf8')
await page.goto(`${BASE}/#/ws/a/wf/onboarding.yaml`)
await page.waitForSelector('.node[data-id="integrate"]')
check(await page.locator('.node').count() === 6 && await page.locator('.edge').count() === 6, 'onboarding renders 6 nodes and 6 edges (auto layout)')
check(await page.locator('.node[data-id="setup"] .delegate-target').innerText() === '→ Repository Setup', 'delegate shows the target workflow name')
check(await page.locator('.node[data-id="survey"] .badge.readonly').count() === 2, 'readonly badges on survey')
check(await page.locator('.node[data-id="integrate"] .badge.editable').count() === 2, 'editable badges on integrate')
check(await readFile(onboardingPath, 'utf8') === onboardingText, 'opening does not write')
await shot(page, 'step3-onboarding-compact', false)

// The gaps draft shows unresolved references.
await page.goto(`${BASE}/#/ws/a/wf/draft-gaps.yaml`)
await page.waitForSelector('.node[data-id="explore"]')
check(await page.locator('.node[data-id="explore"] .badge.unresolved').count() === 2, 'missing repository and undeclared binding are unresolved badges')
check(await page.locator('.node[data-id="hand-off"] .delegate-target.missing').isVisible(), 'unknown delegate target is marked missing')
check(await page.locator('.v-summary.error').innerText().then(t => t.startsWith('4 errors')), 'four errors reported')
await shot(page, 'step3-draft-gaps', false)

check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await browser.close()
done()
