// p4 stage 2: the agdev dashboard and the Project Editor's "Add existing
// repository" in a browser, against a disposable Gitea (test/giteaFixture.ts)
// and a private service on its own registry and area. Nothing touches the
// person's Gitea, registry or workspaces.
//
//   npm run build && node checks/agdev.ts [--port 8197] [--keep]
//
// Screenshots go to agdevworld/.local/wfe-checks/screenshots/ (ignored).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8197)

const root = await mkdtemp(join(tmpdir(), 'wfe-agdev-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { startGitea } = await import('../test/giteaFixture.ts')
const { gitOk } = await import('../server/git.ts')

const tg = await startGitea()
const area = join(root, 'area')
const registry = join(area, 'registry.json')
const service = new PrivateService({ registry, area, port: PORT, extraArgs: ['--gitea', tg.settingFile] })
await service.start()
const { browser, page, errors } = await open(1400, 1000)
const B = service.base
const waitText = (sel: string, re: RegExp, ms = 20_000) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source] as const, { timeout: ms })

try {
  console.log('empty dashboard')
  await page.goto(`${B}/#/`)
  await waitText('.dash-status', /Gitea http/)
  check(/No project is registered yet|registry does not exist/.test(await page.locator('.dash-projects').innerText()), 'an empty registry says so')
  check(/execution host: unknown — the executor has never reported/.test(await page.locator('.dash-status').innerText()), 'execution host availability is stated')

  console.log('create a project (directory mode) through the dashboard')
  await page.getByLabel('Project id').fill('rts')
  await page.getByLabel('Project name').fill('RTS vs Bot')
  await page.getByLabel('Project intent').fill('A small real-time strategy game against a bot.')
  await page.getByRole('button', { name: 'Create project' }).click()
  await waitText('.create-project', /Created rts/, 60_000)
  await waitText('.dash-projects', /RTS vs Bot/)
  const proj = await page.locator('.project-entry[data-project="rts"]').innerText()
  check(/devdocs: directory/.test(proj) && /workspace rts/.test(proj) && /read from workspace rts/.test(proj), 'the project lists its mode, workspace and the source of its definition')

  console.log('create a shared repository and obtain a second workspace')
  await page.getByLabel('Repository name').fill('study-rts')
  await page.getByLabel('Repository category').selectOption('study')
  await page.getByLabel('Repository description').fill('Notes on RTS design')
  await page.getByRole('button', { name: 'Create new' }).click()
  await waitText('.register-repo', /Created and registered/, 30_000)
  await waitText('.dash-repos', /study-rts/)
  check(/no project uses it yet/.test(await page.locator('.dash-repos').innerText()), 'an unused shared repository is listed as unused')
  await page.locator('.project-entry[data-project="rts"] button', { hasText: 'Obtain another workspace' }).click()
  check(await waitText('.project-entry[data-project="rts"]', /workspace rts-2/, 60_000).then(() => true, () => false), 'a second workspace obtained from Gitea appears under its project')
  await shot(page, 'p4-dashboard', true)

  console.log('Project Editor: add existing repository')
  await page.goto(`${B}/#/ws/rts`)
  await page.waitForSelector('.add-shared .shared-row')
  await page.getByLabel('Search registered repositories').fill('rts')
  await page.locator('.add-shared .shared-row', { hasText: 'study-rts' }).click()
  check(await page.getByLabel('Destination path').inputValue() === 'study/rts', 'a destination path is proposed from the category')
  await page.getByRole('button', { name: 'Add as submodule' }).click()
  await waitText('.add-shared', /Added study\/rts/, 60_000)
  await page.waitForSelector('.repo-row[data-path="study/rts"]')
  check(/^160000 /.test(await gitOk(join(area, 'pj-rts'), ['ls-files', '--stage', '--', 'study/rts'])), 'added as a staged gitlink in this workspace')
  await shot(page, 'p4-project-add-existing', true)
  await page.getByRole('button', { name: 'Add as submodule' }).click()
  check(await waitText('.add-shared', /already/, 30_000).then(() => true, () => false), 'adding at an occupied path is refused')
  const ws = join(area, 'pj-rts')
  await gitOk(ws, ['commit', '-q', '-m', 'add study/rts'])
  const pinned2 = await gitOk(join(area, 'pj-rts-2'), ['ls-files', '--stage', '--', 'study/rts'])
  check(pinned2.trim() === '', 'the other workspace (and anything else) is unchanged until it adopts the change')

  console.log('dashboard usage and Gitea outage')
  await page.goto(`${B}/#/`)
  await waitText('.repo-entry', /rts \(study\/rts\)/)
  check(/Used by: rts \(study\/rts\)/.test(await page.locator('.repo-entry', { hasText: 'study-rts' }).innerText()), 'the shared repository names the project that uses it, read from its workspace')
  await tg.stop()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await waitText('.dash-status', /Gitea unreachable/, 30_000)
  const repos = await page.locator('.dash-repos').innerText()
  check(/not read/.test(repos) && /study-rts|wfetest/.test(repos), 'with Gitea down, repositories are listed as not read, not as empty or missing')
  check(await page.locator('.project-entry[data-project="rts"]').count() === 1, 'projects stay listed from the registry')
  await shot(page, 'p4-dashboard-gitea-down', true)

  const pageErrors = errors.filter(e => !/^Failed to load resource/.test(e))
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  await tg.stop()
  if (args.includes('--keep')) console.log(`data kept: ${root}`)
  else await rm(root, { recursive: true, force: true })
  done()
}
