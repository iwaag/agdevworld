// Measures external-change reflection and watch load, and probes the update
// cases that can lose a refresh. Builds its own repositories and registry in a
// temporary directory, starts its own service (production build, port 8195 by
// default) with the counters in checks/bench/counters.ts, and drives the UI
// with playwright-core. It never touches another registry or workspace.
//
//   npm run build && node checks/measure.ts [--label <name>] [--repeat 20]
//     [--port 8195] [--out <file.json>] [--keep] [--skip-probes] [--skip-large]
//
// Results: a summary on stdout, the full record as JSON (--out).
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { chromium, type Page } from 'playwright-core'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const LABEL = option('--label', 'run')
const REPEAT = Number(option('--repeat', '20'))
const PORT = Number(option('--port', '8195'))
const OUT = args.includes('--out') ? resolve(option('--out', '')) : undefined
const BASE = `http://127.0.0.1:${PORT}`

const env = {
  GIT_AUTHOR_NAME: 'Bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid',
  GIT_COMMITTER_NAME: 'Bench', GIT_COMMITTER_EMAIL: 'bench@example.invalid',
}
const config = { ...LOCAL_TRANSPORT, 'commit.gpgsign': 'false', 'init.defaultBranch': 'main', 'core.hooksPath': '/dev/null' }
const run = (cwd: string, a: string[]) => gitOk(cwd, a, { env, config })

// ---- bench data ------------------------------------------------------------

function workflowText(id: string, intent: string, nodes = 4): string {
  const ids = Array.from({ length: nodes }, (_, i) => `step-${i + 1}`)
  return [
    'schema: ag.workflow.v1', `id: ${id}`, `name: Workflow ${id}`, 'intent: |', `  ${intent}`,
    'repositories:', '  docs: {path: devdocs, access: editable}', 'nodes:',
    ...ids.flatMap((n, i) => [`  ${n}:`, `    type: ${i % 2 ? 'do' : 'study'}`, `    name: Step ${i + 1}`, `    description: Bench step ${i + 1}.`, '    repositories: [docs]']),
    'edges:', ...ids.slice(1).map((n, i) => `  - {from: ${ids[i]}, to: ${n}}`), '',
  ].join('\n')
}

async function source(root: string, name: string, files: Record<string, string>) {
  const bare = join(root, 'sources', `${name}.git`)
  const work = join(root, 'tmp', name)
  await run(root, ['init', '--bare', '--initial-branch=main', bare])
  await run(root, ['init', '--initial-branch=main', work])
  for (const [f, t] of Object.entries(files)) { await mkdir(dirname(join(work, f)), { recursive: true }); await writeFile(join(work, f), t) }
  await run(work, ['add', '-A'])
  await run(work, ['commit', '-m', `Seed ${name}`])
  await run(work, ['push', bare, 'main'])
}

// A project root with devdocs (holding `workflows` workflow files) and
// `submodules` further submodules; the last one is left uninitialized.
async function project(root: string, name: string, submodules: number, workflows: number) {
  const files: Record<string, string> = { 'README.md': `# devdocs-${name}\n` }
  for (let i = 1; i <= workflows; i++) files[`workflows/wf-${String(i).padStart(3, '0')}.yaml`] = workflowText(`wf-${String(i).padStart(3, '0')}`, `Bench intent ${i}.`)
  await source(root, `${name}-devdocs`, files)
  for (let i = 1; i <= submodules; i++) await source(root, `${name}-repo${i}`, { 'README.md': `# repo${i}\n` })
  const work = join(root, 'workspaces', name)
  await run(root, ['init', '--bare', '--initial-branch=main', join(root, 'sources', `${name}.git`)])
  await run(root, ['init', '--initial-branch=main', work])
  await run(work, ['remote', 'add', 'origin', `../../sources/${name}.git`])
  await writeFile(join(work, '.gitignore'), '.local/\n')
  await writeFile(join(work, 'project.yaml'), `schema: ag.project.v1\nid: ${name}\nname: Bench ${name}\nintent: |\n  Project intent 0.\ngoals:\n  - One goal.\n`)
  await run(work, ['submodule', 'add', `../${name}-devdocs.git`, 'devdocs'])
  for (let i = 1; i <= submodules; i++) await run(work, ['submodule', 'add', `../${name}-repo${i}.git`, `${i % 2 ? 'study' : 'wedo'}/repo${i}`])
  await run(work, ['add', '-A'])
  await run(work, ['commit', '-m', `Seed ${name}`])
  if (submodules) await run(work, ['submodule', 'deinit', '-f', '--', `${submodules % 2 ? 'study' : 'wedo'}/repo${submodules}`])
  return work
}

// ---- service ---------------------------------------------------------------

interface Stats { counts: Record<string, number>; gitByCommand: Record<string, number>; cpu: { user: number; system: number }; rss: number }
let service: ChildProcess | undefined
let registryFile = ''

async function startService() {
  service = fork(join(pkg, 'server/main.ts'), ['--serve-dist', '--port', String(PORT), '--registry', registryFile], {
    cwd: pkg, execArgv: ['--import', join(here, 'bench/counters.ts')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  service.stderr?.on('data', d => process.stderr.write(`[service] ${d}`))
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/workspaces`).then(r => r.ok, () => false)) return
    await sleep(100)
  }
  throw new Error('service did not start')
}
async function stopService() {
  if (!service) return
  const s = service
  service = undefined
  await new Promise<void>(r => { s.once('exit', () => r()); s.kill() })
}
function stats(): Promise<Stats> {
  return new Promise(r => { service!.once('message', m => r(m as Stats)); service!.send('stats') })
}
function delta(a: Stats, b: Stats) {
  const counts: Record<string, number> = {}
  for (const k of Object.keys(b.counts)) counts[k] = b.counts[k] - (a.counts[k] ?? 0)
  const git: Record<string, number> = {}
  for (const k of Object.keys(b.gitByCommand)) { const d = b.gitByCommand[k] - (a.gitByCommand[k] ?? 0); if (d) git[k] = d }
  return { counts, gitByCommand: git, cpuMs: Math.round((b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1000), rssMb: Math.round(b.rss / 1e6) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) }
const summary = (xs: number[]) => xs.length ? { n: xs.length, min: Math.round(Math.min(...xs)), p50: pct(xs, 0.5), p90: pct(xs, 0.9), max: Math.round(Math.max(...xs)), over2s: xs.filter(x => x > 2000).length } : { n: 0 }

async function ideSave(path: string, text: string) {
  await writeFile(`${path}.swap`, text)
  await rename(`${path}.swap`, path)
}

// ---- page ------------------------------------------------------------------

const requests: string[] = []
function routeKey(url: string, method: string) {
  const p = new URL(url).pathname.replace(/\/workflows\/[^/]+/, '/workflows/<file>').replace(/\/workspaces\/[^/]+/, '/workspaces/<ws>')
  return `${method} ${p}`
}
const tally = (list: string[]) => list.reduce<Record<string, number>>((o, k) => { o[k] = (o[k] ?? 0) + 1; return o }, {})

// `fn` runs in the page; it must be a function, not a string expression.
async function waitUntil<A extends string | number | null>(page: Page, fn: (arg: A) => unknown, arg: A, ms = 8000): Promise<number | null> {
  const t = performance.now()
  try { await page.waitForFunction(fn as (arg: unknown) => unknown, arg as unknown, { timeout: ms, polling: 20 }); return performance.now() - t } catch { return null }
}
const intentHas = (m: string) => (document.querySelector<HTMLTextAreaElement>('#intent')?.value ?? '').includes(m)
const projectIntentHas = (m: string) => [...document.querySelectorAll<HTMLTextAreaElement>('.project-meta textarea')].some(t => t.value.includes(m))

async function measureWorkflow(page: Page, ws: string, dir: string, file: string, repeat: number) {
  const path = join(dir, 'devdocs/workflows', file)
  await page.goto(`${BASE}/#/ws/${ws}/wf/${file}`)
  await page.waitForSelector('.node')
  await sleep(2500)
  // Idle with a viewer.
  let s0 = await stats(); let r0 = requests.length
  await sleep(15_000)
  const idle = { seconds: 15, ...delta(s0, await stats()), requests: tally(requests.slice(r0)) }
  // Sequential edits, alternating in-place and atomic-rename saves.
  const latencies: number[] = [], timeouts: number[] = []
  const base = await readFile(path, 'utf8')
  s0 = await stats(); r0 = requests.length
  const t0 = performance.now()
  for (let i = 0; i < repeat; i++) {
    const marker = `${ws}-edit-${i}-${Date.now()}`
    const text = base.replace(/^ {2}Bench intent .*$/m, `  ${marker}`)
    if (i % 2) await ideSave(path, text); else await writeFile(path, text)
    const t = await waitUntil(page, intentHas, marker)
    if (t === null) timeouts.push(i); else latencies.push(t)
    await sleep(300 + Math.random() * 1200) // sample the polling phase
  }
  const editing = { seconds: Math.round((performance.now() - t0) / 1000), ...delta(s0, await stats()), requests: tally(requests.slice(r0)) }
  await writeFile(path, base)
  await sleep(1500)
  return { ws, file, idle, editing, latency: summary(latencies), timeouts, latencies: latencies.map(Math.round) }
}

async function measureProject(page: Page, ws: string, dir: string, repeat: number) {
  const path = join(dir, 'project.yaml')
  await page.goto(`${BASE}/#/ws/${ws}`)
  await page.waitForSelector('.project-meta textarea')
  await sleep(2500)
  let s0 = await stats(); let r0 = requests.length
  await sleep(15_000)
  const idle = { seconds: 15, ...delta(s0, await stats()), requests: tally(requests.slice(r0)) }
  const base = await readFile(path, 'utf8')
  const latencies: number[] = [], timeouts: number[] = []
  s0 = await stats(); r0 = requests.length
  for (let i = 0; i < repeat; i++) {
    const marker = `project-edit-${i}-${Date.now()}`
    const text = base.replace(/^ {2}Project intent .*$/m, `  ${marker}`)
    if (i % 2) await ideSave(path, text); else await writeFile(path, text)
    const t = await waitUntil(page, projectIntentHas, marker)
    if (t === null) timeouts.push(i); else latencies.push(t)
    await sleep(300 + Math.random() * 1200)
  }
  const editing = { ...delta(s0, await stats()), requests: tally(requests.slice(r0)) }
  await writeFile(path, base)
  await sleep(1500)
  return { ws, idle, editing, latency: summary(latencies), timeouts }
}

// ---- probes ----------------------------------------------------------------

interface Probe { name: string; ok: boolean; observed: string }

async function probes(page: Page, ws: string, dir: string, other: string): Promise<Probe[]> {
  const out: Probe[] = []
  const wfDir = join(dir, 'devdocs/workflows')
  const W1 = join(wfDir, 'wf-001.yaml'), W2 = join(wfDir, 'wf-002.yaml')
  const note = (name: string, ok: boolean, observed: string) => { out.push({ name, ok, observed }); console.log(`  ${ok ? '✔' : '✖'} ${name}: ${observed}`) }
  const openWf = async (file: string) => { await page.goto(`${BASE}/#/ws/${ws}/wf/${file}`); await page.waitForSelector('.node'); await sleep(2000) }
  const openProject = async () => { await page.goto(`${BASE}/#/ws/${ws}`); await page.waitForSelector('.project-meta textarea'); await sleep(2000) }
  const banners = () => page.locator('.banners, .banner').allInnerTexts().then(t => t.join(' | ').slice(0, 200))
  const w1Base = await readFile(W1, 'utf8')

  // A UI edit saved to the file, then an external edit of the same file.
  await openWf('wf-001.yaml')
  await page.locator('.node[data-id="step-2"]').click()
  await page.getByLabel('Node description').fill('Edited in the browser.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.save-state')?.textContent ?? ''))
  const uiSaved = await readFile(W1, 'utf8')
  note('UI save writes the definition file', uiSaved.includes('description: Edited in the browser.'), uiSaved.includes('Edited in the browser.') ? 'description in the YAML' : 'not in the YAML')
  let m = `after-ui-${Date.now()}`
  await writeFile(W1, uiSaved.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  let t = await waitUntil(page, intentHas, m, 6000)
  note('external edit after a UI save appears', t !== null, t === null ? 'not shown' : `shown in ${Math.round(t)} ms`)
  await writeFile(W1, w1Base); await sleep(1500)

  // Burst: the open workflow changes and a new workflow appears in the same tick.
  m = `burst-new-${Date.now()}`
  await writeFile(W1, w1Base.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  await writeFile(join(wfDir, 'wf-new.yaml'), workflowText('wf-new', 'New in a burst.'))
  t = await waitUntil(page, intentHas, m, 6000)
  note('burst: open workflow edit + workflow created', t !== null, t === null ? 'open workflow content was not refreshed within 6 s' : `refreshed in ${Math.round(t)} ms`)
  await unlink(join(wfDir, 'wf-new.yaml')); await sleep(1500)

  // Burst: the open workflow and project.yaml change together.
  m = `burst-project-${Date.now()}`
  const projBase = await readFile(join(dir, 'project.yaml'), 'utf8')
  await writeFile(W1, w1Base.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  await writeFile(join(dir, 'project.yaml'), projBase.replace('One goal.', `Goal ${m}.`))
  t = await waitUntil(page, intentHas, m, 6000)
  note('burst: open workflow edit + project.yaml edit', t !== null, t === null ? 'open workflow content was not refreshed within 6 s' : `refreshed in ${Math.round(t)} ms`)
  await writeFile(join(dir, 'project.yaml'), projBase)
  await sleep(1500)

  // Burst: two workflows saved together, viewer on the second one's sibling.
  m = `burst-two-${Date.now()}`
  const w2Base = await readFile(W2, 'utf8')
  await writeFile(W2, w2Base.replace(/^ {2}Bench intent .*$/m, `  other-${m}`))
  await writeFile(W1, w1Base.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  t = await waitUntil(page, intentHas, m, 6000)
  note('burst: two workflow files saved together', t !== null, t === null ? 'open workflow content was not refreshed within 6 s' : `refreshed in ${Math.round(t)} ms`)
  await writeFile(W2, w2Base); await writeFile(W1, w1Base); await sleep(1500)

  // Deletion of the open workflow, then restoring it.
  await unlink(W1)
  await sleep(3000)
  const gone = await banners()
  const recreated = await readFile(W1, 'utf8').then(() => true, () => false)
  note('delete open workflow: visible, not recreated', /missing|does not exist|deleted/i.test(gone) && !recreated, `banners: "${gone}"; recreated: ${recreated}`)
  m = `restored-${Date.now()}`
  await writeFile(W1, w1Base.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  t = await waitUntil(page, intentHas, m, 6000)
  note('restore deleted open workflow', t !== null, t === null ? 'not reloaded' : `reloaded in ${Math.round(t)} ms`)
  await writeFile(W1, w1Base); await sleep(1500)

  // Rename of the open workflow file.
  await rename(W1, join(wfDir, 'wf-001-renamed.yaml'))
  await sleep(3000)
  const renamed = await banners()
  note('rename open workflow: visible in the open view', /renamed|missing|does not exist|moved/i.test(renamed), `banners: "${renamed}"; url: ${new URL(page.url()).hash}`)
  await rename(join(wfDir, 'wf-001-renamed.yaml'), W1); await sleep(1500)

  // Creation, rename and deletion seen from the project view.
  await openProject()
  await writeFile(join(wfDir, 'wf-created.yaml'), workflowText('wf-created', 'Created from outside.'))
  t = await waitUntil(page, () => !!document.querySelector('.wf-row[data-file="wf-created.yaml"]'), null, 6000)
  note('project view: workflow file created', t !== null, t === null ? 'row did not appear' : `row appeared in ${Math.round(t)} ms`)
  await rename(join(wfDir, 'wf-created.yaml'), join(wfDir, 'wf-created2.yaml'))
  t = await waitUntil(page, () => !!document.querySelector('.wf-row[data-file="wf-created2.yaml"]') && !document.querySelector('.wf-row[data-file="wf-created.yaml"]'), null, 6000)
  note('project view: workflow file renamed', t !== null, t === null ? 'list not updated' : `list updated in ${Math.round(t)} ms`)
  await unlink(join(wfDir, 'wf-created2.yaml'))
  t = await waitUntil(page, () => !document.querySelector('.wf-row[data-file="wf-created2.yaml"]'), null, 6000)
  note('project view: workflow file deleted', t !== null, t === null ? 'row stayed' : `row removed in ${Math.round(t)} ms`)

  // Malformed intermediate content, then a valid save.
  await openWf('wf-001.yaml')
  await writeFile(W1, `${w1Base}\n  : : [unclosed\n`)
  t = await waitUntil(page, () => /cannot be used/.test(document.querySelector('.banners')?.textContent ?? ''), null, 6000)
  note('malformed save shows the error', t !== null, t === null ? 'no error banner' : `error shown in ${Math.round(t)} ms`)
  m = `recovered-${Date.now()}`
  await writeFile(W1, w1Base.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  t = await waitUntil(page, (mk: string) => (document.querySelector<HTMLTextAreaElement>('#intent')?.value ?? '').includes(mk) && !/cannot be used/.test(document.querySelector('.banners')?.textContent ?? ''), m, 6000)
  note('valid save after malformed recovers editing', t !== null, t === null ? 'did not recover' : `recovered in ${Math.round(t)} ms`)
  await writeFile(W1, w1Base); await sleep(1500)

  // Service restart with an edit made while it is down.
  await stopService()
  await sleep(1500)
  const outage = await page.evaluate(() => document.body.innerText.match(/(disconnected|not reachable|offline|reconnect)[^\n]*/i)?.[0] ?? '')
  note('service down: outage is visible', !!outage, outage ? `"${outage}"` : 'nothing indicates the outage')
  m = `while-down-${Date.now()}`
  await writeFile(W1, w1Base.replace(/^ {2}Bench intent .*$/m, `  ${m}`))
  await startService()
  t = await waitUntil(page, intentHas, m, 10_000)
  note('edit made while the service was down appears after restart', t !== null, t === null ? 'not shown 10 s after restart' : `shown ${Math.round(t)} ms after restart`)
  await writeFile(W1, w1Base); await sleep(1500)

  // Git state that does not touch definition files, seen from the project view.
  await openProject()
  // Each probe waits for the repository row to differ from its text just before the action.
  const rowText = (path: string) => page.evaluate(q => document.querySelector(`.repo-row[data-path="${q}"]`)?.textContent ?? '', path)
  const rowChanged = (arg: string) => { const [q, b] = JSON.parse(arg) as [string, string]; return (document.querySelector(`.repo-row[data-path="${q}"]`)?.textContent ?? b) !== b }
  const gitProbe = async (name: string, path: string, act: () => Promise<unknown>) => {
    const before = await rowText(path)
    await act()
    const t = await waitUntil(page, rowChanged, JSON.stringify([path, before]), 5000)
    note(name, t !== null, t === null ? 'repository row unchanged within 5 s' : `shown in ${Math.round(t)} ms`)
  }
  await gitProbe('git: submodule working tree becomes dirty', 'devdocs', () => writeFile(join(dir, 'devdocs', 'scratch.md'), 'dirty\n'))
  await gitProbe('git: root index changes (git add)', '.', async () => { await writeFile(join(dir, 'NOTES.md'), `${Date.now()}\n`); await run(dir, ['add', 'NOTES.md']) })
  await gitProbe('git: root HEAD moves (git commit)', '.', () => run(dir, ['commit', '-m', 'bench note']))
  const sub = (await run(dir, ['config', '-f', '.gitmodules', '--get-regexp', 'path'])).trim().split('\n').map(l => l.split(' ')[1]).pop()!
  await gitProbe('git: submodule initialized', sub, () => run(dir, ['submodule', 'update', '--init', '--', sub]))
  await unlink(join(dir, 'devdocs', 'scratch.md'))

  // Switching workspaces quickly: the last one requested must win.
  await page.goto(`${BASE}/#/ws/${ws}`)
  await page.evaluate(([a, b]) => { location.hash = `#/ws/${b}`; setTimeout(() => { location.hash = `#/ws/${a}` }, 30) }, [ws, other])
  await sleep(4000)
  const crumb = await page.locator('.crumbs strong').innerText().catch(() => '')
  const selected = await page.locator('.ws-row.current strong').innerText().catch(() => '')
  note('fast workspace switch ends on the last requested workspace', crumb.includes(ws) && selected.length > 0, `header "${crumb}", selected row "${selected}"`)

  // Registry change while the project view is open.
  const reg = JSON.parse(await readFile(registryFile, 'utf8'))
  reg.workspaces.push({ id: 'late', label: 'Late registration', host: 'this machine', path: dir })
  await writeFile(registryFile, JSON.stringify(reg, null, 2))
  t = await waitUntil(page, () => /Late registration/.test(document.querySelector('.workspaces')?.textContent ?? ''), null, 5000)
  note('registry change appears in the open view', t !== null, t === null ? 'not shown within 5 s' : `shown in ${Math.round(t)} ms`)
  reg.workspaces.pop()
  await writeFile(registryFile, JSON.stringify(reg, null, 2))
  return out
}

// ---- main ------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'wfe-measure-'))
const result: Record<string, unknown> = { label: LABEL, at: new Date().toISOString(), repeat: REPEAT }
try {
  console.log(`bench root ${root}`)
  const rep = await project(root, 'rep', 2, 1)
  const large = args.includes('--skip-large') ? '' : await project(root, 'large', 19, 150)
  await rm(join(root, 'tmp'), { recursive: true, force: true })
  registryFile = join(root, 'registry.json')
  await writeFile(registryFile, JSON.stringify({ approver: 'bench', workspaces: [
    { id: 'rep', label: 'Representative', host: 'this machine', path: rep },
    ...(large ? [{ id: 'large', label: 'Large', host: 'this machine', path: large }] : []),
  ] }, null, 2))
  result.data = { rep: { submodules: 3, workflows: 1 }, large: large ? { submodules: 20, workflows: 150 } : null }

  await startService()
  let s0 = await stats()
  await sleep(10_000)
  result.idleNoViewer = { seconds: 10, ...delta(s0, await stats()) }
  console.log('idle, no viewer', JSON.stringify(result.idleNoViewer))

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('request', r => { if (r.url().includes('/api/')) requests.push(routeKey(r.url(), r.method())) })
  page.on('dialog', d => void d.accept())

  result.workflowRep = await measureWorkflow(page, 'rep', rep, 'wf-001.yaml', REPEAT)
  console.log('workflow view, rep', JSON.stringify(result.workflowRep))
  result.projectRep = await measureProject(page, 'rep', rep, Math.ceil(REPEAT / 2))
  console.log('project view, rep', JSON.stringify(result.projectRep))
  if (large) {
    result.workflowLarge = await measureWorkflow(page, 'large', large, 'wf-001.yaml', REPEAT)
    console.log('workflow view, large', JSON.stringify(result.workflowLarge))
    result.projectLarge = await measureProject(page, 'large', large, Math.ceil(REPEAT / 2))
    console.log('project view, large', JSON.stringify(result.projectLarge))
  }
  await page.goto('about:blank')
  await sleep(2000)
  s0 = await stats()
  await sleep(10_000)
  result.idleAfterViewerLeft = { seconds: 10, ...delta(s0, await stats()) }
  console.log('idle after the viewer left', JSON.stringify(result.idleAfterViewerLeft))

  if (!args.includes('--skip-probes')) {
    console.log('probes (rep):')
    // The representative project has one workflow; the probes need a second one.
    await writeFile(join(rep, 'devdocs/workflows/wf-002.yaml'), workflowText('wf-002', 'Bench intent 2.'))
    result.probes = await probes(page, 'rep', rep, large ? 'large' : 'rep')
  }
  await browser.close()
} finally {
  await stopService()
  if (OUT) { await mkdir(dirname(OUT), { recursive: true }); await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`) }
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
}
