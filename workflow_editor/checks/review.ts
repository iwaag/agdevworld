// The review in the browser (p7 step 3): the run view offers one prominent
// link to the live presentation; it opens the result (a playable page whose
// own script runs) and the request-specific explanation on one screen, says
// where to answer, and serves nothing else. After the stop the run view
// offers no dead link. Builds its own temporary project, private service and
// presentation instance on this host — the route the person uses.
//
//   npm run build && node checks/review.ts [--port 8199] [--keep]
//
// Screenshots go to agdevworld/.local/wfe-checks/screenshots/ (ignored).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpInput, RunRef } from '../shared/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8199')

const root = await mkdtemp(join(tmpdir(), 'wfe-review-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { createRun, registerPresentation, runOp } = await import('../server/runs.ts')
const { Presenter } = await import('../server/present.ts')
const { Workspace } = await import('../server/workspace.ts')

const WF = `schema: ag.workflow.v2
id: improve
name: Improve
intent: |
  Implement, present, confirm, clean up.
documentation:
  policy: manual
repositories:
  game: {path: ., access: editable}
nodes:
  implement: {type: do, name: Implement, description: Change the game.}
  present: {type: do, name: Present, description: Present it., appearance: {icon: present, color: teal}}
  check: {type: talk, name: Human check, confirms: result, description: Ask.}
  cleanup: {type: do, name: Clean up, description: Stop it., appearance: {icon: cleanup, color: slate}}
edges:
  - {from: implement, to: present}
  - {from: present, to: check}
  - {from: check, to: cleanup}
`
const registry = join(root, 'registry.json')
const dir = join(root, 'pj-rts')
const created = await createProject({ dir, id: 'rts', name: 'RTS check', intent: 'Checks.', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
if (!created.ok) throw new Error(created.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), WF)
await mkdir(join(dir, 'game'), { recursive: true })
await writeFile(join(dir, 'game', 'index.html'), '<!doctype html><html><head><title>Game</title><script type="module" src="main.js"></script></head><body><canvas id="c" width="320" height="200"></canvas><p id="status">loading</p></body></html>\n')
await writeFile(join(dir, 'game', 'main.js'), 'document.getElementById("status").textContent = "game running"\nconst g = document.getElementById("c").getContext("2d"); g.fillStyle = "#3fa59a"; g.fillRect(20, 20, 120, 80)\n')
await writeFile(join(dir, 'review.md'), '# Barracks upgrades\n\n## What changed\n\n- **Attack upgrade** (E) and **Armor upgrade** (R) at the barracks.\n\n## How to play\n\n1. Select the barracks.\n2. Press `E` or `R`.\n\n## Please check\n\n- Upgraded units hit harder.\n')
await writeFile(join(root, 'present.json'), JSON.stringify({ ports: [18390, 18399], answerBase: `http://127.0.0.1:${PORT}/` }))
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const op = async (r: RunRef, i: OpInput, by = 'Omni Agent') => (await runOp(ws, r, i, { via: 'cli', by })).record
const R = (await createRun(ws, { workflow: 'improve', input: { kind: 'braindump', text: 'Barracks upgrades', author: 'Check Person' }, executor: { name: 'Omni Agent', backend: null }, by: 'Omni Agent', via: 'cli' })).ref
await op(R, { op: 'node.start', node: 'implement' })
await op(R, { op: 'node.complete', node: 'implement', outcome: 'Done.' })
await op(R, { op: 'node.start', node: 'present' })
await registerPresentation(ws, R, { node: 'present', source: 'game', entry: 'index.html', review: 'review.md', title: 'Barracks upgrades' }, { via: 'cli', by: 'Omni Agent' })
const pr = new Presenter({ registryFile: registry, area: root })
const served = await pr.start(ws, R, 'p1')
await op(R, { op: 'node.complete', node: 'present', outcome: 'Presented p1.' })
await op(R, { op: 'node.start', node: 'check' })
await op(R, { op: 'question.ask', question: '', node: 'check', text: 'Please try the upgrades. Accept, or say what to change.', to: 'Check Person', presentation: 'p1' })

const service = new PrivateService({ registry, area: root, port: PORT })
await service.start()
const { browser, page, errors } = await open(1440, 900)
try {
  console.log('Run view')
  await page.goto(`${service.base}/#/ws/rts/run/improve/run-001`)
  const link = page.locator('.review-link a.button.primary')
  await link.waitFor()
  check((await link.textContent())?.includes('Open the review: Barracks upgrades'), 'the run view shows one prominent review link')
  check(await link.getAttribute('href') === served.url, `it points at the live instance (${served.url})`)
  check((await page.locator('.review-link').textContent())?.includes('opens on this host'), 'it says the address opens on this host')
  check((await page.locator('.question[data-question="q1"]').textContent())?.includes('About presentation p1'), 'the open question names the presentation it asks about')
  await shot(page, 'p7-review-runview')

  console.log('Review screen (one click)')
  const [review] = await Promise.all([page.context().waitForEvent('page'), link.click()])
  await review.waitForLoadState('load')
  check(review.url() === served.url, 'the click opened the review screen')
  const frame = review.frameLocator('iframe')
  await frame.locator('#status').filter({ hasText: 'game running' }).waitFor({ timeout: 5000 })
  check(true, 'the game loads and runs its own script in the same screen')
  const aside = await review.locator('aside').textContent() ?? ''
  check(aside.includes('Barracks upgrades') && aside.includes('Attack upgrade') && aside.includes('Please check'), 'the request-specific explanation is beside it')
  check(await review.locator('aside a.answer').getAttribute('href') === `http://127.0.0.1:${PORT}/#/ws/rts/run/improve/run-001`, 'it links back to where the person answers (the run view)')
  const box = await review.locator('iframe').boundingBox(), side = await review.locator('aside').boundingBox()
  check(!!box && !!side && box.width > 700 && side.width > 300 && Math.abs(box.y - 0) < 60, `game and explanation share one screen (${Math.round(box?.width ?? 0)} + ${Math.round(side?.width ?? 0)} px)`)
  await review.screenshot({ path: join(process.env.WFE_FIXTURE!, 'screenshots', 'p7-review-screen.png') })
  for (const path of ['manifest.json', 'review.md', 'content/../manifest.json', 'registry.json']) {
    const r = await review.request.get(`${served.url}${path}`)
    check(r.status() === 404, `${path} is not served (${r.status()})`)
  }
  await review.close()

  console.log('After the stop')
  await pr.stop(ws, R, 'p1')
  await page.reload()
  await page.locator('.run-summary .review-link').waitFor()
  check(await page.locator('.review-link a.button.primary').count() === 0, 'no live link is offered for a stopped presentation')
  check((await page.locator('.review-link').textContent())?.includes('no longer served'), 'the run view says it is no longer served')
  check((await page.locator('.presentation[data-presentation="p1"]').textContent())?.includes('Stopped'), 'the presentation keeps its record, marked stopped')
  await shot(page, 'p7-review-stopped')
  check(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  await pr.stop(ws, R, 'all').catch(() => {})
  pr.close()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
