// workflow_editor p8/ex2 in the browser: creating a workflow from Simple,
// the run view's activity line, the documentation settings and the
// freework template. A private project (checks/states.ts), a second empty
// project, registry, area and service; nothing else is touched.
//
//   npm run build && node checks/freework.ts [--port 8216] [--keep] [--shots <dir>]
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Browser, Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8216')
const SHOTS = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null

const root = await mkdtemp(join(tmpdir(), 'wfe-freework-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { buildStates } = await import('./states.ts')
const { createProject } = await import('../server/create.ts')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<number | null> {
  const t = performance.now()
  while (performance.now() - t < ms) { if (await fn().catch(() => false)) return performance.now() - t; await sleep(40) }
  return null
}
async function capture(page: Page, name: string) {
  if (!SHOTS) return
  const { mkdir } = await import('node:fs/promises')
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
let browser: Browser | undefined
try {
  const S = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18820, 18829] })
  const blank = await createProject({ dir: join(root, 'pj-blank'), id: 'blank', name: 'Blank project', intent: 'A project without workflows.', goals: [], sourcesDir: join(root, 'sources'), registryFile: join(root, 'registry.json') })
  if (!blank.ok) throw new Error(blank.message)
  await service.start()
  const BASE = service.base
  const opened = await open(1440, 1000, { display: 'simple' })
  browser = opened.browser
  const { page, errors } = opened
  const text = (sel: string) => page.locator(sel).first().innerText().catch(() => '')
  const visible = (sel: string) => page.locator(sel).first().isVisible().catch(() => false)

  // ==== 1. Creating a workflow from Simple ====================================================
  console.log('create: an empty project in Simple')
  await page.goto(`${BASE}/#/ws/blank`)
  await page.waitForSelector('.workflows .create-wf-open')
  check(await page.evaluate(() => document.documentElement.dataset.display) === 'simple', 'the page is in Simple')
  check(await visible('.workflows .create-wf-open') && /Create workflow/.test(await text('.workflows .create-wf-open')), 'the workflow list has "Create workflow" in Simple')
  check(/No workflow yet/.test(await text('.workflows')) && await visible('.empty-workflows .link-btn'), 'an empty list says so and offers the same entry')
  await page.locator('.empty-workflows .link-btn').click()
  check(await visible('form.create-wf') && await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Name of the new workflow', 'the form opens with the keyboard in Name')
  check(!(await visible('form.create-wf .create-more label')), 'id and documents are behind "More settings"')
  await capture(page, 'create-open-simple')

  console.log('create: errors stay beside their field, input is kept')
  await page.locator('form.create-wf button[type=submit]').click()
  check(/Give the workflow a name/.test(await text('#create-wf-name-error')) && await page.getByLabel('Name of the new workflow').getAttribute('aria-invalid') === 'true', 'an empty name is refused beside Name')
  await page.getByLabel('Name of the new workflow').fill('Release Check')
  check(!(await visible('#create-wf-name-error')), 'typing clears the error')
  check(await page.getByLabel('Id of the new workflow').inputValue() === 'release-check', 'the id follows the name')
  // A switch to Detail and back keeps everything.
  await page.locator('.display-toggle button[data-display="detail"]').click()
  check(await visible('form.create-wf') && await page.getByLabel('Name of the new workflow').inputValue() === 'Release Check', 'Detail shows the same open form with the typed name')
  await page.locator('.display-toggle button[data-display="simple"]').click()
  // A background reload (a file appears) keeps the form, the text and the keyboard.
  await page.getByLabel('Name of the new workflow').click()
  await page.keyboard.press('End')
  await writeFile(join(root, 'pj-blank', 'devdocs', 'workflows', 'release-check.yaml'), 'schema: ag.workflow.v2\nid: release-check\nname: Taken\nintent: x\ndocumentation: {policy: manual}\nnodes: {a: {type: do, description: x}}\n')
  const reloaded = await waitFor(async () => /Taken/.test(await text('.workflows')))
  check(reloaded !== null, 'the list reloads while the form is open')
  check(await page.getByLabel('Name of the new workflow').inputValue() === 'Release Check' && await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Name of the new workflow', 'the reload keeps the text and the keyboard in Name')
  check(await page.getByLabel('Id of the new workflow').inputValue() === 'release-check-2', 'the derived id moves past the id that appeared')
  await page.locator('form.create-wf .create-more > summary').click()
  await page.getByLabel('Id of the new workflow').fill('release-check')
  await page.locator('form.create-wf button[type=submit]').click()
  check(/already used/.test(await text('#create-wf-id-error')) && await page.locator('form.create-wf .create-more').getAttribute('open') !== null, 'a taken id is refused beside Id, with More settings opened')
  await page.getByLabel('Id of the new workflow').fill('Bad Id')
  await page.locator('form.create-wf button[type=submit]').click()
  check(/lowercase/.test(await text('#create-wf-id-error')), 'a malformed id is refused beside Id')
  await capture(page, 'create-error-simple')
  await page.getByLabel('Id of the new workflow').fill('release-check-2')
  await page.locator('form.create-wf button[type=submit]').click()
  await page.waitForURL(/\/wf\/release-check-2\.yaml$/)
  check(true, 'Create opens the new workflow in the editor')
  await waitFor(async () => await page.locator('.wf-name').inputValue() !== '')
  check(await page.evaluate(() => document.documentElement.dataset.display) === 'simple' && await page.locator('.wf-name').inputValue() === 'Release Check', `the editor opens in Simple with the name given (${await page.locator('.wf-name').inputValue()})`)

  console.log('create: a project with workflows')
  await page.goto(`${BASE}/#/ws/sample`)
  await page.waitForSelector('.workflows .wf-row')
  check(await visible('.workflows .create-wf-open') && !(await visible('form.create-wf')), 'a list with workflows keeps the entry in its head, the form closed')
  check(S.ws !== undefined, 'fixture ready')

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser?.close()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
