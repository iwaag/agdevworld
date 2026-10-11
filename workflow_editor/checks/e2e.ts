// The p1 acceptance scenario, end to end, against real local repositories.
// It reseeds the fixture itself. Needs the service and the Vite dev server.
// Writers take turns: every external edit happens while the UI waits.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { seed } from '../scripts/seed.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import { BASE, check, done, FIXTURE, open, shot, wsDir } from './lib.ts'
import { addBinding, addNode, connectDrag, connectVia, dragNode, ideSave, pillStatus, save, selectNode, waitFor } from './ui.ts'

const A = wsDir('a'), B = wsDir('b')
const WF = 'e2e-release.yaml'
const wfPath = (ws: string) => join(ws, 'devdocs/workflows', WF)
const step = (n: number, title: string) => console.log(`\n${n}. ${title}`)
const commitConfig = { 'user.name': 'Fixture Author', 'user.email': 'fixture@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' }

// 1 ------------------------------------------------------------------------
step(1, 'Seed sources, a project with devdocs/study/wedo/other submodules, two workspaces')
await seed(FIXTURE, true)
const modules = await gitOk(A, ['config', '-f', '.gitmodules', '--get-regexp', 'path$'])
check(['devdocs', 'study/', 'wedo/', 'assets/shared'].every(p => modules.includes(p)), 'project records devdocs, study, wedo and other submodules')
check(await stat(join(B, 'project.yaml')).then(() => true), 'workspace B is a second clone of the same project')
check((await gitOk(A, ['config', '--get', 'remote.origin.url'])).trim().endsWith('sources/pj-demo.git'), 'origin is a local source repository (no Gitea)')

const { browser, page, errors } = await open(1440, 960)

// 2 ------------------------------------------------------------------------
step(2, 'Open workspace A: intent, goals, repositories, workflows')
await page.goto(`${BASE}/#/ws/a`)
await page.waitForSelector('.repo-row[data-path="assets/shared"]')
check((await page.locator('.project-meta textarea').inputValue()).startsWith('Deliver a small service'), 'project intent shown')
check(await page.locator('.goals li').count() === 3, 'three goals shown')
check(await page.locator('.repo-row').count() === 7, 'root and six submodules listed')
check(await page.locator('.wf-row').count() === 3, 'three workflows listed')
await page.getByRole('button', { name: '+ Add goal' }).click()
await page.getByLabel('Goal 4').fill('Approvals travel with the definitions through Git.')
await page.getByRole('button', { name: 'Save project.yaml' }).click()
await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.project-meta .save-state')?.textContent ?? ''))
check((await readFile(join(A, 'project.yaml'), 'utf8')).includes('- Approvals travel with the definitions through Git.'), 'project goal edited and saved')
await shot(page, 'e2e-2-project-a')

// 3 ------------------------------------------------------------------------
step(3, 'Create a workflow in the UI: all node types, branch, join, delegate, bindings; save and reopen')
await page.getByLabel('New workflow id').fill('e2e-release')
await page.getByLabel('New workflow name').fill('E2E Release')
await page.getByRole('button', { name: 'Create' }).click()
await page.waitForFunction(() => location.hash.endsWith('/wf/e2e-release.yaml'))
await page.waitForSelector('.wf-name:not([disabled])')
await page.getByLabel('Workflow intent').fill('Release a service safely: study conventions, build and agree in parallel,\nverify, then hand repository setup to its own workflow.')
await addBinding(page, 'tools', 'study/tools', 'readonly')
await addBinding(page, 'runtime', 'wedo/runtime', 'editable')
await addBinding(page, 'docs', 'devdocs', 'editable')
const study = await addNode(page, 'Study', 'Read conventions', 'Look up the release conventions.', ['tools'])
const build = await addNode(page, 'Do', 'Build', 'Build the release candidate.', ['runtime'])
const agree = await addNode(page, 'Talk', 'Agree scope', 'Agree the scope with the owner.', ['docs'])
const verify = await addNode(page, 'Do', 'Verify', 'Verify after build and agreement.', ['runtime', 'docs'])
const hand = await addNode(page, 'Delegate', 'Repository setup', 'Run repository setup and wait for it.')
await page.getByLabel('Delegate target').selectOption('repo-setup')
await connectVia(page, study, build)
await connectVia(page, study, agree)
await connectVia(page, build, verify)
await connectDrag(page, agree, verify)
await connectDrag(page, verify, hand)
await page.getByRole('button', { name: 'Auto-arrange' }).click()
await save(page)
const savedText = await readFile(wfPath(A), 'utf8')
const parsed = parseWorkflow(savedText)
check(parsed.ok && Object.keys(parsed.model.nodes).length === 5 && parsed.model.edges.length === 5, 'saved: five nodes, five edges')
check(parsed.ok && new Set(Object.values(parsed.model.nodes).map(n => n.type)).size === 4, 'saved: all four node types')
check(parsed.ok && parsed.model.edges.filter(e => e.from === study).length === 2 && parsed.model.edges.filter(e => e.to === verify).length === 2, 'saved: branch and join')
check(parsed.ok && parsed.model.nodes[hand].workflow === 'repo-setup', 'saved: delegate reference by id')
await page.reload()
await page.waitForSelector(`.node[data-id="${hand}"]`)
check(await page.locator('.node').count() === 5 && await page.locator('.edge').count() === 5 && await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'reopened: same graph, nothing unsaved')
check(await readFile(wfPath(A), 'utf8') === savedText, 'reopened: file text unchanged')
await shot(page, 'e2e-3-workflow-created', false)

// 4 ------------------------------------------------------------------------
step(4, 'External YAML edit shows in the UI; then a UI edit shows in the YAML')
await page.waitForTimeout(1200)
await ideSave(wfPath(A), savedText.replace('Look up the release conventions.', 'Look up the release conventions and the changelog format.'))
check(await waitFor(async () => (await page.locator(`.node[data-id="${study}"] .node-desc`).innerText()).includes('changelog format'), 'external'), 'external edit appears in the UI')
await selectNode(page, build)
await page.getByLabel('Node name').fill('Build candidate')
await save(page)
const afterUi = await readFile(wfPath(A), 'utf8')
check(afterUi.includes('name: Build candidate') && afterUi.includes('changelog format'), 'UI edit saved next to the external one')

// 5 ------------------------------------------------------------------------
step(5, 'Validation and recovery: a missing reference, then malformed YAML')
await ideSave(wfPath(A), afterUi.replace('workflow: repo-setup', 'workflow: repo-setupp'))
check(await waitFor(() => page.locator(`.node[data-id="${hand}"] .delegate-target.missing`).isVisible(), 'missing ref'), 'the reloaded delegate card marks its target missing')
check(await page.locator('.v-summary.error').innerText() === '1 error, 0 warnings', 'missing delegate target is the one error')
check(await page.getByRole('button', { name: 'Approve definition' }).isDisabled(), 'definition cannot be approved with errors')
await shot(page, 'e2e-5-missing-reference', false)
await selectNode(page, hand)
await page.getByLabel('Delegate target').selectOption('repo-setup')
await save(page)
check(await page.locator('.v-summary.ok').isVisible(), 'fixed in the UI: valid again')
const valid = await readFile(wfPath(A), 'utf8')
await ideSave(wfPath(A), valid.replace('edges:\n', 'edges:\n  - {from: [broken\n'))
check(await waitFor(() => page.locator('.banner.error:has-text("malformed")').isVisible(), 'malformed'), 'malformed YAML is reported, last valid graph kept')
check(await page.locator('.node').count() === 5 && await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'stale rendering cannot be saved')
await shot(page, 'e2e-5-malformed', false)
await ideSave(wfPath(A), valid)
check(await waitFor(async () => !(await page.locator('.banner.error').isVisible()), 'recovered'), 'recovered after correction')

// 6 ------------------------------------------------------------------------
step(6, 'Approve intent and definition; stale on description and intent changes; layout keeps approval')
await page.getByLabel('Approver').fill('e2e-author')
await page.getByRole('button', { name: 'Approve intent' }).click()
check(await waitFor(async () => (await pillStatus(page, 'intent')) === 'approved', 'intent approved'), 'intent approved')
await page.getByRole('button', { name: 'Approve definition' }).click()
check(await waitFor(async () => (await pillStatus(page, 'definition')) === 'approved', 'definition approved'), 'definition approved')
check(await page.locator('.approval-pill.author').isVisible(), '"Author Approved" shown')
const approvedText = await readFile(wfPath(A), 'utf8')
check(/approver: e2e-author/.test(approvedText) && (approvedText.match(/digest: "?sha256:/g) ?? []).length === 2, 'both approval records written to the file')
await shot(page, 'e2e-6-approved', false)

await selectNode(page, agree)
await page.getByLabel('Node description').fill('Agree the scope and the release date with the owner.')
check(await pillStatus(page, 'definition') === 'stale' && await pillStatus(page, 'intent') === 'approved', 'draft description change: definition changed since approval, intent still approved')
check(await page.getByRole('button', { name: 'Approve definition' }).isDisabled(), 'approval actions wait for a save')
await save(page)
check(await pillStatus(page, 'definition') === 'stale', 'saved description change: definition stale')
check((await readFile(wfPath(A), 'utf8')).includes('approver: e2e-author'), 'stale approval record is kept, not erased')
await shot(page, 'e2e-6-definition-stale', false)

await page.getByLabel('Workflow intent').fill('Release a service safely and on schedule: study conventions, build and agree in parallel,\nverify, then hand repository setup to its own workflow.')
await save(page)
check(await pillStatus(page, 'intent') === 'stale' && await pillStatus(page, 'definition') === 'stale', 'intent change: both stale')
await shot(page, 'e2e-6-both-stale', false)

await page.getByRole('button', { name: 'Approve intent' }).click()
await waitFor(async () => (await pillStatus(page, 'intent')) === 'approved', 'reapprove intent')
await page.getByRole('button', { name: 'Approve definition' }).click()
check(await waitFor(async () => (await pillStatus(page, 'definition')) === 'approved' && (await pillStatus(page, 'intent')) === 'approved', 'reapproved'), 'reapproved both')
const beforeMove = parseWorkflow(await readFile(wfPath(A), 'utf8'))
await page.getByRole('button', { name: 'Fit' }).click()
await dragNode(page, hand, 60, 90)
await save(page)
const afterMove = parseWorkflow(await readFile(wfPath(A), 'utf8'))
check(beforeMove.ok && afterMove.ok && JSON.stringify(beforeMove.model.layout.nodes[hand]) !== JSON.stringify(afterMove.model.layout.nodes[hand]), 'node moved and the new position saved')
check(await pillStatus(page, 'intent') === 'approved' && await pillStatus(page, 'definition') === 'approved', 'layout change keeps both approvals')
check(beforeMove.ok && afterMove.ok && JSON.stringify(beforeMove.model.approvals) === JSON.stringify(afterMove.model.approvals), 'approval records unchanged by the move')
await shot(page, 'e2e-6-moved-still-approved', false)

// 7 ------------------------------------------------------------------------
step(7, 'Commit devdocs and the root reference, publish to the local origins, update workspace B')
const devdocsA = join(A, 'devdocs')
await gitOk(devdocsA, ['switch', '-q', 'main'])
await gitOk(devdocsA, ['add', 'workflows/e2e-release.yaml'])
await gitOk(devdocsA, ['commit', '-q', '-m', 'Add the e2e-release workflow with approvals'], { config: commitConfig })
await gitOk(devdocsA, ['push', '-q', 'origin', 'main'])
await gitOk(A, ['add', 'project.yaml', 'devdocs'])
await gitOk(A, ['commit', '-q', '-m', 'Record devdocs with e2e-release and a new project goal'], { config: commitConfig })
await gitOk(A, ['push', '-q', 'origin', 'main'])
check((await gitOk(A, ['status', '--porcelain'])).trim() === '', 'workspace A is clean after commit')
// Workspace B is updated explicitly, as a person would.
await gitOk(B, ['pull', '-q', '--ff-only'])
await gitOk(B, ['submodule', 'update', '--init', '-q'], { config: LOCAL_TRANSPORT })
check(await readFile(join(B, 'project.yaml'), 'utf8') === await readFile(join(A, 'project.yaml'), 'utf8'), 'B: project.yaml identical')
check(await readFile(wfPath(B), 'utf8') === await readFile(wfPath(A), 'utf8'), 'B: workflow file identical (content, approvals, layout)')
const recorded = (await gitOk(B, ['ls-tree', 'HEAD', 'devdocs'])).split(/\s+/)[2]
check(recorded === (await gitOk(join(B, 'devdocs'), ['rev-parse', 'HEAD'])).trim(), 'B: devdocs checked out at the recorded commit')

await page.goto(`${BASE}/#/ws/b`)
await page.waitForSelector('.pill:has-text("workspace b")')
await page.waitForSelector('.wf-row[data-file="e2e-release.yaml"]')
check(await page.getByLabel('Goal 4').inputValue() === 'Approvals travel with the definitions through Git.', 'B project view: the new goal')
check(await page.locator('.wf-row[data-file="e2e-release.yaml"] .chip.ok:has-text("Author approved")').isVisible(), 'B project view: e2e-release is author approved')
await shot(page, 'e2e-7-project-b')
await page.goto(`${BASE}/#/ws/b/wf/e2e-release.yaml`)
await page.waitForSelector(`.node[data-id="${hand}"]`)
check(await pillStatus(page, 'intent') === 'approved' && await pillStatus(page, 'definition') === 'approved', 'B editor: both approvals valid')
const posA = afterMove.ok ? afterMove.model.layout.nodes : {}
const left = await page.locator(`.node[data-id="${hand}"]`).evaluate(e => [parseFloat((e as HTMLElement).style.left), parseFloat((e as HTMLElement).style.top)])
check(left[0] === posA[hand].x && left[1] === posA[hand].y, 'B editor: the moved node is where A left it')
await shot(page, 'e2e-7-workflow-b', false)

check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await browser.close()
done()
