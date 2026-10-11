// Step 2 browser check: project metadata, repositories, add submodule,
// workflow creation, access labels and workspace switching.
// Expects a fresh seed, the service and the Vite dev server.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitOk } from '../server/git.ts'
import { BASE, check, done, open, shot, wsDir } from './lib.ts'

const { browser, page, errors } = await open()
await page.goto(`${BASE}/#/ws/a`)
await page.waitForSelector('.repo-row[data-path="assets/shared"]')

const row = (path: string) => page.locator(`.repo-row[data-path="${path}"]`)
check(await row('assets/shared').getByText('not initialized').isVisible(), 'uninitialized submodule is labelled')
check(await row('study/tools').getByText('detached HEAD').isVisible(), 'detached HEAD is labelled')
check(await row('study/agentic-patterns').getByText('main').isVisible(), 'branch checkout is labelled')

// Edit name and a goal, save, and read the file.
await page.getByLabel('Goal 2').fill('Study results land in study repositories; lessons in wedo repositories.')
await page.locator('.project-meta input').nth(1).fill('Demo Delivery Project')
await page.getByRole('button', { name: '+ Add goal' }).click()
await page.getByLabel('Goal 4').fill('Edited through the project editor.')
check(await page.getByText('Unsaved changes').isVisible(), 'draft is marked unsaved')
await page.getByRole('button', { name: 'Save project.yaml' }).click()
await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.project-meta .save-state')?.textContent ?? ''))
const text = await readFile(join(wsDir('a'), 'project.yaml'), 'utf8')
check(text.includes('- Edited through the project editor.'), 'saved goal is in project.yaml')
check(text.startsWith('# Project definition (ag.project.v1).'), 'leading comment preserved')
check(text.includes('lessons in wedo repositories.'), 'edited goal is in project.yaml')

// Dirty checkout appears after an external change to a submodule.
await import('node:fs/promises').then(fs => fs.writeFile(join(wsDir('a'), 'wedo/runtime/scratch.txt'), 'x\n'))
await page.reload(); await page.waitForSelector('.repo-row[data-path="wedo/runtime"]')
check(await row('wedo/runtime').getByText('1 uncommitted').isVisible(), 'dirty submodule is labelled')

// Access in the context of a workflow.
await page.getByLabel('Show access for workflow').selectOption('onboarding.yaml')
await page.waitForSelector('.access-badge')
check(await row('study/tools').locator('.access-badge').innerText() === 'Read-only', 'study/tools is read-only in onboarding')
check(await row('wedo/runtime').locator('.access-badge').innerText() === 'Editable', 'wedo/runtime is editable in onboarding')
check(await row('assets/shared').getByText('not bound').isVisible(), 'unbound repository says so')
await page.getByLabel('Show access for workflow').selectOption('draft-gaps.yaml')
await page.waitForSelector('.banner.error:has-text("Unresolved")')
check(await page.locator('.banner.error:has-text("Unresolved")').innerText().then(t => t.includes('study/evals')), 'unresolved binding is shown for draft-gaps')

// Failed and successful submodule additions.
await page.getByLabel('Submodule path').fill('other/nothing')
await page.getByLabel('Repository location').fill('../no-such.git')
await page.getByRole('button', { name: 'Add submodule' }).click()
await page.waitForSelector('.add-repo .banner.error')
check(await page.locator('.add-repo .banner.error').innerText().then(t => /failed/.test(t) && /Left behind/.test(t)), 'failed add shows Git error and partial state')
await shot(page, 'step2-add-failed')
await page.getByLabel('Submodule path').fill('study/evals')
await page.getByLabel('Repository location').fill('../study-evals.git')
await page.getByRole('button', { name: 'Add submodule' }).click()
await page.waitForSelector('.add-repo .banner.ok')
await page.waitForSelector('.repo-row[data-path="study/evals"]')
check(await row('study/evals').getByText(/staged/).isVisible(), 'added submodule appears as staged')
const status = await gitOk(wsDir('a'), ['status', '--porcelain'])
check(/^A {2}study\/evals$/m.test(status) && /^ M project\.yaml$/m.test(status), 'git status shows the staged submodule and the unstaged project edit')
await shot(page, 'step2-project-after')

// Create a workflow; it opens in the editor route.
await page.getByLabel('New workflow id').fill('release-check')
await page.getByLabel('New workflow name').fill('Release Check')
await page.getByRole('button', { name: 'Create' }).click()
await page.waitForFunction(() => location.hash.endsWith('/wf/release-check.yaml'))
check(true, 'new workflow opens its editor')
const created = await readFile(join(wsDir('a'), 'devdocs/workflows/release-check.yaml'), 'utf8')
check(created.includes('id: release-check') && created.includes('name: Release Check'), 'workflow file created in devdocs/workflows')

// Switch workspace: B is the same project at its own state.
await page.goto(`${BASE}/#/ws/a`)
await page.waitForSelector('.ws-row')
await page.locator('.ws-row:has-text("Workspace B") button').click()
await page.waitForFunction(() => location.hash === '#/ws/b')
await page.waitForSelector('.pill:has-text("workspace b")')
await page.waitForSelector('.repo-row[data-path="assets/shared"]')
check(!(await row('assets/shared').getByText('not initialized').isVisible()), 'workspace B has assets/shared initialized')
check(await page.locator('.wf-row').count() === 3, 'workspace B lists its own three workflows')
check(await page.locator('.ws-row:has-text("Removed workspace")').innerText().then(t => t.includes('registered, not available')), 'missing workspace is registered but unavailable')
await shot(page, 'step2-project-b')
// The deliberately failed submodule add answers 422, which the browser logs.
const unexpected = errors.filter(e => !e.includes('status of 422'))
check(unexpected.length === 0, `no unexpected console errors${unexpected.length ? `: ${unexpected.join(' | ')}` : ''}`)
await browser.close()
done()
