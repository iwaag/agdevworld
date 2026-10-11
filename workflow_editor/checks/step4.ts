// Step 4 browser check: sequential external (IDE/agent) edits and UI edits in
// both directions, malformed and corrected content, failed saves, and the
// unsaved-draft guard. Writers take turns; nothing here edits concurrently.
// Expects a fresh seed, the service and the Vite dev server.
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { BASE, check, done, open, shot, wsDir } from './lib.ts'

const dir = join(wsDir('a'), 'devdocs/workflows')
const FILE = join(dir, 'onboarding.yaml')
const { browser, page, errors } = await open(1440, 960)

// An IDE-style save: write a sibling file and rename it over the target.
async function ideSave(path: string, text: string) {
  await writeFile(`${path}.ide-swap`, text)
  await rename(`${path}.ide-swap`, path)
}
const desc = (p: Page, id: string) => p.locator(`.node[data-id="${id}"] .node-desc`).innerText()
const waitFor = (fn: () => Promise<boolean>, label: string, ms = 6000) => new Promise<boolean>(resolve => {
  const start = Date.now()
  const tick = async () => {
    if (await fn().catch(() => false)) return resolve(true)
    if (Date.now() - start > ms) { console.log(`    (timed out waiting: ${label})`); return resolve(false) }
    setTimeout(tick, 150)
  }
  void tick()
})

await page.goto(`${BASE}/#/ws/a/wf/onboarding.yaml`)
await page.waitForSelector('.node[data-id="survey"]')
await page.waitForTimeout(1200) // let the watcher take its first snapshot

// 1. External edit while the UI has no draft: the UI follows.
let text = await readFile(FILE, 'utf8')
text = text.replace('Read the agentic pattern notes and existing tool studies; summarise what applies.', 'Edited in the IDE, read the pattern notes.')
await writeFile(FILE, text) // plain in-place write
check(await waitFor(async () => (await desc(page, 'survey')) === 'Edited in the IDE, read the pattern notes.', 'in-place write'), 'in-place external write appears in the UI')
text = text.replace('edges:\n', 'edges:\n  - {from: provision, to: announce}\n')
text = text.replace('  announce:\n', '  qa:\n    type: talk\n    name: QA sign-off\n    description: Added by an agent in its IDE.\n  announce:\n')
await ideSave(FILE, text) // atomic rename, as many editors and agents do
check(await waitFor(async () => (await page.locator('.node[data-id="qa"]').count()) === 1, 'rename save'), 'atomic-rename external save adds the node in the UI')
check(await page.locator('.edge[data-from="provision"][data-to="announce"]').count() === 1, 'external edge appears')
check(await page.locator('.save-state').innerText() === 'Saved', 'no draft after external reload')
await shot(page, 'step4-external-applied', false)

// 2. UI edit, saved, then inspect the YAML.
await page.locator('.node[data-id="qa"]').click()
await page.getByLabel('Node description').fill('Edited in the UI after the agent added it.')
await page.getByRole('button', { name: 'Save', exact: true }).click()
await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.save-state')?.textContent ?? ''))
const afterUi = await readFile(FILE, 'utf8')
check(afterUi.includes('    description: Edited in the UI after the agent added it.\n'), 'UI edit is in the YAML')
check(afterUi.includes('  - {from: provision, to: announce}\n') && afterUi.startsWith('# Onboarding:'), 'external additions and comments survive the UI save')
await page.waitForTimeout(1500)
check(!(await page.locator('.banner.warn:has-text("changed on disk")').isVisible()), 'the UI does not flag its own save as an external change')

// 3. Then the IDE again: still followed.
await ideSave(FILE, afterUi.replace('name: QA sign-off', 'name: QA approval'))
check(await waitFor(async () => (await page.locator('.node[data-id="qa"] .node-title').innerText()) === 'QA approval', 'second external'), 'next external edit appears after a UI save')

// 4. Unsaved-draft guard: the draft is kept, the change is announced.
await page.locator('.node[data-id="qa"]').click()
await page.getByLabel('Node name').fill('Draft name in the UI')
const external = (await readFile(FILE, 'utf8')).replace('Edited in the UI after the agent added it.', 'Changed in the IDE while the UI had a draft.')
await ideSave(FILE, external)
check(await waitFor(() => page.locator('.banner.warn:has-text("changed on disk")').isVisible(), 'guard banner'), 'external change during a draft is announced')
check(await page.locator('.node[data-id="qa"] .node-title').innerText() === 'Draft name in the UI', 'the draft is retained')
check(await page.locator('.save-state').innerText() === 'Unsaved changes', 'the draft is still unsaved')
await shot(page, 'step4-draft-guard', false)
await page.getByRole('button', { name: 'Reload from disk (discard my edits)' }).click()
check(await waitFor(async () => (await desc(page, 'qa')) === 'Changed in the IDE while the UI had a draft.', 'reload'), 'explicit reload adopts the external content')
check(await page.locator('.node[data-id="qa"] .node-title').innerText() === 'QA approval' && await page.locator('.save-state').innerText() === 'Reloaded from disk', 'the draft was discarded only on request')

// 5. Malformed external YAML: last valid rendering, read-only, no save.
const good = await readFile(FILE, 'utf8')
await writeFile(FILE, good.replace('  qa:\n    type: talk\n', '  qa:\n    type: [talk\n'))
check(await waitFor(() => page.locator('.banner.error:has-text("cannot be used")').isVisible(), 'malformed banner'), 'parse error is shown')
const banner = await page.locator('.banner.error:has-text("cannot be used")').innerText()
check(/malformed/.test(banner) && /line \d+/.test(banner), `error names the problem and line (${banner.slice(0, 90)}…)`)
check(await page.locator('.node[data-id="qa"]').count() === 1, 'last valid rendering is kept')
check(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled() && await page.getByRole('button', { name: 'Add Study node' }).isDisabled(), 'editing and saving are disabled')
const refused = await page.evaluate(async () => {
  const r = await fetch('/api/workspaces/a/workflows/onboarding.yaml')
  const body = await r.json()
  return body.problem?.kind
})
check(refused === 'malformed', 'the service reports the file as malformed')
await shot(page, 'step4-malformed', false)
// Corrected externally: the editor recovers.
await ideSave(FILE, good.replace('name: QA approval', 'name: QA approval (fixed)'))
check(await waitFor(async () => !(await page.locator('.banner.error:has-text("cannot be used")').isVisible()), 'recovery'), 'banner clears once the file is corrected')
check(await page.locator('.node[data-id="qa"] .node-title').innerText() === 'QA approval (fixed)' && !(await page.getByRole('button', { name: 'Add Study node' }).isDisabled()), 'corrected content is shown and editable')

// 6. Malformed file while the UI holds a draft: a save is refused, draft kept.
await page.locator('.node[data-id="qa"]').click()
await page.getByLabel('Node description').fill('Draft written before the file broke.')
const fixed = await readFile(FILE, 'utf8')
await writeFile(FILE, 'schema: ag.workflow.v1\nid: onboarding\nnodes: {broken\n')
await waitFor(() => page.locator('.banner.warn:has-text("changed on disk")').isVisible(), 'guard 2')
await page.getByRole('button', { name: 'Save', exact: true }).click()
check(await waitFor(() => page.locator('.banner.error:has-text("Save failed")').isVisible(), 'refused save'), 'saving over a malformed file is refused visibly')
check(await readFile(FILE, 'utf8') === 'schema: ag.workflow.v1\nid: onboarding\nnodes: {broken\n', 'the malformed file was not overwritten')
check(await page.getByLabel('Node description').inputValue() === 'Draft written before the file broke.', 'the draft is kept for retry')
await shot(page, 'step4-refused-save', false)
await ideSave(FILE, fixed)
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Save', exact: true }).click()
check(await waitFor(async () => (await readFile(FILE, 'utf8')).includes('Draft written before the file broke.'), 'retry'), 'retry after the file is fixed saves the draft')

// 7. Failed save (unwritable directory): visible, draft kept, retry works.
await page.locator('.node[data-id="qa"]').click()
await page.getByLabel('Node description').fill('Saved after a failure.')
await chmod(dir, 0o555)
try {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  check(await waitFor(() => page.locator('.banner.error:has-text("EACCES")').isVisible(), 'eacces'), 'file system failure is shown')
  check(await page.locator('.save-state').innerText() === 'Save failed' && await page.getByLabel('Node description').inputValue() === 'Saved after a failure.', 'draft kept after the failure')
  await shot(page, 'step4-failed-save', false)
} finally {
  await chmod(dir, 0o755)
}
await page.getByRole('button', { name: 'Save', exact: true }).click()
check(await waitFor(async () => (await readFile(FILE, 'utf8')).includes('Saved after a failure.'), 'retry 2'), 'retry succeeds once writable')
check(await waitFor(async () => !(await page.locator('.banner.error').isVisible()), 'clear'), 'error clears after a successful save')

// 8. Project metadata follows external edits the same way.
await page.goto(`${BASE}/#/ws/a`)
await page.waitForSelector('.project-meta input')
await page.waitForTimeout(1200)
const projectFile = join(wsDir('a'), 'project.yaml')
await ideSave(projectFile, (await readFile(projectFile, 'utf8')).replace('name: Demo Delivery Project', 'name: Demo Delivery Project (IDE)'))
check(await waitFor(async () => (await page.locator('.project-meta input').nth(1).inputValue()) === 'Demo Delivery Project (IDE)', 'project'), 'external project.yaml edit appears in the project view')
await page.locator('.project-meta input').nth(1).fill('Draft project name')
await ideSave(projectFile, (await readFile(projectFile, 'utf8')).replace('(IDE)', '(IDE again)'))
check(await waitFor(() => page.locator('.project-meta .banner.warn').isVisible(), 'project guard'), 'project draft is guarded too')
check(await page.locator('.project-meta input').nth(1).inputValue() === 'Draft project name', 'project draft retained')
// A new workflow file written externally appears in the list.
await writeFile(join(dir, 'agent-made.yaml'), 'schema: ag.workflow.v1\nid: agent-made\nname: Agent Made\nintent: Written by an agent.\nnodes:\n  only: {type: do, description: one step}\n')
check(await waitFor(async () => (await page.locator('.wf-row[data-file="agent-made.yaml"]').count()) === 1, 'new file'), 'externally created workflow appears in the list')
await shot(page, 'step4-project-guard', false)
page.removeAllListeners('dialog')
page.on('dialog', d => void d.dismiss())

check(errors.filter(e => !/status of (409|500)/.test(e)).length === 0, `no unexpected console errors${errors.length ? ` (${errors.length} expected HTTP errors from refused saves)` : ''}`)
await browser.close()
done()
