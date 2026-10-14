// The session policy in the browser (agent_session p1), on a private
// project, registry, area and service: Detail's Workflow settings offer it
// beside the execution settings, a choice survives save and reload, Simple
// does not show it, a run freezes the policy it was created with (a later
// edit reaches future runs only), the claim, the CLI and the API agree, and
// the run view states the run's effective policy and its session. It never
// touches another registry or workspace.
//
//   npm run build && node checks/sessions.ts [--port 8231]
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8231')
const pexec = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), 'wfe-sessions-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n[protocol "file"]\n\tallow = always\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { openSettings } = await import('./ui.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { gitOk } = await import('../server/git.ts')
const { ExecStore } = await import('../server/exec.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { readRun } = await import('../server/runs.ts')
const { runSpace } = await import('../server/runspace.ts')
const { Workspace } = await import('../server/workspace.ts')

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: keep
name: Keep
intent: |
  Agree on a scope, then build it.
execution:
  guides: [agent/g.md]
repositories:
  root: {path: ., access: editable}
nodes:
  scope:
    type: talk
    description: Agree on the scope with the person.
  build:
    type: do
    description: Build what was agreed.
edges:
  - {from: scope, to: build}
`
const registry = join(root, 'registry.json')
const dir = join(root, 'pj-sess')
const made = await createProject({ dir, id: 'sess', name: 'Sessions', intent: 'A synthetic project for the session policy.', goals: [], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
if (!made.ok) throw new Error(made.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'keep.yaml'), WF)
await mkdir(join(dir, 'agent'))
await writeFile(join(dir, 'agent', 'g.md'), '# guide\n')
await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
const remote = join(root, 'remote.git')
await gitOk(root, ['init', '-q', '--bare', '--initial-branch=main', remote])
await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])

const service = new PrivateService({ registry, area: root, port: PORT })
await service.start()
const { browser, page, errors } = await open(1400, 900, { display: 'detail' })
const file = join(dir, 'devdocs', 'workflows', 'keep.yaml')
const wfUrl = `${service.base}/#/ws/sess/wf/keep.yaml`
const policy = () => page.getByLabel('Session policy')
try {
  console.log('Detail: the session policy beside the execution settings')
  await page.goto(wfUrl)
  await page.waitForSelector('.node')
  await openSettings(page)
  check(await page.locator('.settings-head[data-section="execution"]').isVisible(), 'Workflow settings has an Execution section')
  check(await policy().inputValue() === '', 'an undeclared policy shows as fresh (not declared)')
  check((await page.locator('.session-explain').textContent())?.includes('Fresh'), 'the explanation says what fresh means')
  check((await page.locator('.settings-head[data-section="execution"] + dl').textContent())?.includes('agent/g.md'), 'the execution facts (agent, profile, guides) are shown beside it')
  await policy().selectOption('run')
  check((await page.locator('.session-explain').textContent())?.includes('resume the run'), 'choosing run explains retained sessions')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  for (let i = 0; i < 50 && !(await readFile(file, 'utf8')).includes('session: run'); i++) await new Promise(r => setTimeout(r, 100))
  check((await readFile(file, 'utf8')).includes('session: run'), 'Save writes execution.session: run into the file')
  await shot(page, 'sessions-detail-settings')
  await page.reload()
  await page.waitForSelector('.node')
  await openSettings(page)
  check(await policy().inputValue() === 'run', 'the choice survives a reload')
  console.log('Simple: uncluttered')
  await page.getByRole('button', { name: 'Simple', exact: true }).click().catch(() => null)
  await page.waitForTimeout(200)
  check(!(await page.locator('.session-policy').isVisible()), 'Simple does not show the session policy')
  await page.getByRole('button', { name: 'Detail', exact: true }).click().catch(() => null)

  console.log('A run freezes the policy; the claim, CLI and API agree')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'session: run']); await gitOk(dir, ['push', '-q'])
  const x = new ExecStore({ registryFile: registry, area: root })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const req = await x.request({ workspace: 'sess', workflow: 'keep', text: 'Build.', author: 'Sample Person', receipt: 'sessions-check-0001', via: 'browser' })
  // A later edit reaches future runs only.
  await page.goto(wfUrl); await page.waitForSelector('.node'); await openSettings(page)
  await policy().selectOption('fresh')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  for (let i = 0; i < 50 && !(await readFile(file, 'utf8')).includes('session: fresh'); i++) await new Promise(r => setTimeout(r, 100))
  check((await readFile(file, 'utf8')).includes('session: fresh'), 'the workflow now says fresh')
  const c = await x.claim('claude_code / anthropic/claude-sonnet-5', { profiles: {}, contract: { name: 'wfrun/guide.md', sha256: 'a'.repeat(64) }, sessions: { '': 'explicit' } })
  const claimed = 'attempt' in c ? c : null
  check(claimed?.execution.session?.policy === 'run' && claimed.execution.session.mode === 'new' && !!claimed.execution.session.id, 'the claim carries the run\'s frozen policy (run, new session with an id)')
  const space = await runSpace(ws, req.ref)
  const rec = (await readRun(space, req.ref)).record!
  check(rec.control.attempt?.settings?.session?.id === claimed?.execution.session?.id, 'attempt.begin records the same session')
  const wfeCli = join(here, '..', 'cli', 'wfe.ts')
  const cli = JSON.parse((await pexec('node', [wfeCli, 'run', 'session', `keep/${req.ref.run}`, '--workspace', 'sess', '--json'], { cwd: dir, env: { ...process.env, WFE_REGISTRY: registry } })).stdout)
  check(cli.policy === 'run' && cli.sessions[0]?.id === claimed?.execution.session?.id, 'wfe run session says run and names the same session')
  const apiRun = await (await fetch(`${service.base}/api/workspaces/sess/runs/keep/${req.ref.run}`)).json() as { bundle: Record<string, { workflow?: { execution?: { session?: string } } }>; record: { sessions?: { id: string }[] } }
  check(apiRun.bundle.keep?.workflow?.execution?.session === 'run' && apiRun.record.sessions?.[0]?.id === claimed?.execution.session?.id, 'the API\'s run (frozen bundle and sessions) agrees')
  console.log('Run view: the effective policy and its session')
  await page.goto(`${service.base}/#/ws/sess/run/keep/${req.ref.run}`)
  await page.waitForSelector('.run-session', { state: 'attached' })
  const sec = page.locator('.side-sec[data-section="execution"]')
  if (await sec.locator('.sec-content').isHidden()) await sec.locator('.sec-toggle').click()
  check(await page.locator('.run-session').isVisible(), 'the execution section shows it when opened')
  const line = await page.locator('.run-session').textContent()
  check(!!line?.includes('Session policy: run') && !!line.includes(`session ${claimed?.execution.session?.id?.slice(0, 8)}`), `the run view states the run's policy and session: "${line}"`)
  await shot(page, 'sessions-run-view')
  x.close()
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  await rm(root, { recursive: true, force: true })
}
done()
