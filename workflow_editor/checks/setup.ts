// pre1 step 2 browser check: the home view's setup actions on an empty
// authoring area — no registry, Create project, a refused duplicate, Register
// workspace with diagnostics, and a malformed registry. Uses its own
// temporary area, registry and service (port 8196); needs `npm run build`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitOk } from '../server/git.ts'
import { PrivateService } from './bench/service.ts'
import { check, done, open, shot } from './lib.ts'

const area = await mkdtemp(join(tmpdir(), 'wfe-setup-check-'))
const registry = join(area, 'registry.json')
const svc = new PrivateService({ registry, area, port: Number(process.env.WFE_CHECK_PORT ?? 8196) })
await svc.start()
const { browser, page, errors } = await open(1400, 1000)
try {
  await page.goto(`${svc.base}/`)
  await page.waitForSelector('.create-project')
  check(await page.getByText('No project is registered yet').isVisible(), 'no registry: empty setup state, not an error')
  check(await page.getByRole('button', { name: 'Create project' }).isVisible() && await page.getByRole('button', { name: 'Register' }).isVisible(), 'Create project and Register are visible')
  await shot(page, 'pre1-setup-empty')

  await page.getByLabel('Project id').fill('web')
  await page.getByLabel('Project name').fill('Web Project')
  await page.getByLabel('Project intent').fill('Created from the browser.')
  await page.getByLabel('Project goals').fill('First goal\nSecond goal')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.waitForURL(/#\/ws\/web$/, { timeout: 30_000 })
  await page.waitForSelector('.repo-row[data-path="devdocs"]')
  check(await page.locator('.crumbs strong').innerText() === 'Web Project', 'created project opens in the project view')
  check(await page.locator('.project-meta .banner.warn:has-text("incomplete")').count() === 0, 'no structure diagnostics for a created project')
  check((await page.locator('.goals input').evaluateAll(els => els.map(e => (e as HTMLInputElement).value))).join('|') === 'First goal|Second goal', 'goals as entered')
  check((await gitOk(join(area, 'pj-web'), ['log', '--format=%s'])).trim() === 'Create project web', 'root has its initial commit')
  await shot(page, 'pre1-setup-created')

  await page.locator('.crumbs a', { hasText: 'Projects' }).click()
  await page.waitForSelector('.ws-row[data-id="web"]')
  check(true, 'home lists the new workspace')
  await page.getByLabel('Project id').fill('web')
  await page.getByLabel('Project name').fill('Again')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.waitForSelector('.create-project .banner.error')
  check(/not empty/.test(await page.locator('.create-project .banner.error').innerText()), 'a second creation into the same folder is refused')

  // An existing repository with only project.yaml.
  const plain = join(area, 'pj-plain')
  await mkdir(plain)
  await gitOk(plain, ['init', '-q'])
  await writeFile(join(plain, 'project.yaml'), 'schema: ag.project.v1\nid: plain\nname: Plain\nintent: x\ngoals: [a]\n')
  await page.getByLabel('Workspace path').fill('pj-plain')
  await page.getByRole('button', { name: 'Register' }).click()
  await page.waitForSelector('.register-workspace .banner')
  const text = await page.locator('.register-workspace').innerText()
  check(/Registered .*pj-plain as workspace "plain"/.test(text), 'register records the workspace')
  check(/devdocs is not a submodule/.test(text) && /wfe add-repo devdocs/.test(text), 'incomplete structure is diagnosed with a fix')
  await shot(page, 'pre1-setup-registered')
  await page.getByLabel('Workspace path').fill('pj-plain')
  await page.getByRole('button', { name: 'Register' }).click()
  await page.waitForFunction(() => /already registered/.test(document.querySelector('.register-workspace .banner')?.textContent ?? ''))
  check(true, 'registering again reports the existing registration')
  check(await page.locator('.ws-row').count() === 2, 'no duplicate rows')

  await writeFile(registry, '{"workspaces": [')
  await page.reload()
  await page.waitForSelector('.workspaces .banner.error')
  check((await page.locator('.workspaces .banner.error').innerText()).includes('registry.json is not valid JSON'), 'malformed registry: readable error naming the file')
  check(await page.getByRole('button', { name: 'Create project' }).isVisible(), 'actions stay visible with a malformed registry')
  await shot(page, 'pre1-setup-malformed')
  check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, `no page errors (${errors.join('; ')})`)
} finally {
  await browser.close()
  await svc.stop()
  await rm(area, { recursive: true, force: true })
}
done()
