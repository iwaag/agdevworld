// Captures of Simple and Detail (workflow_editor p8/ex1) on the
// representative states of checks/states.ts, plus a second project with a
// long Japanese and English name. Viewport captures — what a person sees on
// opening the screen — in both modes at 1440 × 1000 and 1280 × 800.
//
//   npm run build && node checks/displayShots.ts --out <dir> [--port 8216]
//
// Synthetic parts, marked in the index: the working run's /exec reading (no
// executor process exists in a fixture) and, for "disconnected", the
// private service stopped for the capture.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const args = process.argv.slice(2)
const option = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const PORT = Number(option('--port', '8216'))
const out = resolve(option('--out', 'display-shots'))

const root = await mkdtemp(join(tmpdir(), 'wfe-display-shots-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const { PrivateService } = await import('./bench/service.ts')
const { buildStates } = await import('./states.ts')
const { createProject } = await import('../server/create.ts')

interface Shot { file: string; screen: string; mode: string; size: string; note?: string }
const shots: Shot[] = []
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
let states: Awaited<ReturnType<typeof buildStates>> | undefined
const browser = await chromium.launch()
try {
  states = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18840, 18849] })
  const S = states
  const jp = await createProject({ dir: join(root, 'pj-sync'), id: 'sync', name: '設定同期の調査 — why the nightly synchronisation of large settings files fails', intent: '夜間の設定同期がときどき失敗する原因を調べ、再現手順と修正案をまとめる。The intent continues in English: reproduce the failure, compare two fixes, and agree one with the person before changing the sync service.', goals: ['再現する', 'Agree a fix'], sourcesDir: join(root, 'sources'), registryFile: join(root, 'registry.json') })
  if (!jp.ok) throw new Error(jp.message)
  await service.start()
  const BASE = service.base
  await mkdir(out, { recursive: true })
  const run = (k: string, extra = '') => `/ws/sample/run/${S.runs[k].workflow}/${S.runs[k].run}${extra}`
  const working = S.runs.working

  const screens: { name: string; title: string; path: string; ready: string; then?: (p: Page) => Promise<void>; note?: string }[] = [
    { name: 'dashboard', title: 'Dashboard', path: '/', ready: '.dash-simple .project-tile, .dash-projects .ws-row, .project-entry' },
    { name: 'project', title: 'Project', path: '/ws/sample', ready: '.runs-card .run-row' },
    { name: 'project-jp', title: 'Project with a long Japanese and English name', path: '/ws/sync', ready: '.workflows' },
    { name: 'def', title: 'Workflow definition, nothing selected', path: '/ws/sample/wf/improve.yaml', ready: '.node' },
    { name: 'def-selected', title: 'Workflow definition, a node selected', path: '/ws/sample/wf/improve.yaml', ready: '.node', then: p => p.locator('.node[data-id="verify"]').click() },
    { name: 'def-longtext', title: 'Workflow definition, long Japanese and English names, a node selected', path: '/ws/sample/wf/longtext.yaml', ready: '.node', then: p => p.locator('.node[data-id="reproduce"]').click() },
    { name: 'def-large', title: 'Workflow definition, a large graph (16 nodes)', path: '/ws/sample/wf/pipeline.yaml', ready: '.node' },
    { name: 'nodes', title: 'User nodes', path: '/nodes', ready: '.template-item' },
    { name: 'nodes-selected', title: 'User nodes, a template selected', path: '/nodes', ready: '.template-item', then: p => p.locator('.template-item[data-template="present"]').click() },
    { name: 'run-working', title: 'Run: work in progress', path: run('working'), ready: '.run-summary[data-seq]', note: 'host facts synthetic (/exec answered with an alive attempt)' },
    { name: 'run-question', title: 'Run: an open question (the plan)', path: run('plan'), ready: '.run-summary[data-seq]' },
    { name: 'run-questions', title: 'Run: branch and join, two open questions', path: run('branch'), ready: '.run-summary[data-seq]' },
    { name: 'run-question-jp', title: 'Run: an open question in Japanese, long names', path: run('longtext'), ready: '.run-summary[data-seq]' },
    { name: 'run-review', title: 'Run: live review', path: run('review'), ready: '.run-summary[data-seq]' },
    { name: 'run-answered', title: 'Run: answer recorded, awaiting take-up', path: run('answered'), ready: '.run-summary[data-seq]' },
    { name: 'run-accepted', title: 'Run: accepted, cleanup still running', path: run('accepted'), ready: '.run-summary[data-seq]' },
    { name: 'run-completed', title: 'Run: completed and accepted', path: run('completed'), ready: '.run-summary[data-seq]' },
    { name: 'run-completed-selected', title: 'Run: completed, a step selected', path: run('completed'), ready: '.run-summary[data-seq]', then: p => p.locator('.node[data-id="present"]').click() },
    { name: 'run-nodecision', title: 'Run: completed without a decision', path: run('nodecision'), ready: '.run-summary[data-seq]' },
    { name: 'run-held', title: 'Run: held', path: run('held'), ready: '.run-summary[data-seq]' },
    { name: 'run-failed', title: 'Run: failed', path: run('failed'), ready: '.run-summary[data-seq]' },
    { name: 'run-cancelled', title: 'Run: cancelled', path: run('cancelled'), ready: '.run-summary[data-seq]' },
    { name: 'run-history', title: 'Run: historical view', path: run('working', `/at/${S.commit}`), ready: '.run-summary[data-seq]' },
    { name: 'run-disconnected', title: 'Run: the editor service unreachable', path: run('working'), ready: '.run-summary[data-seq]', note: 'the private service stopped for the capture; host facts synthetic before it',
      then: async p => { await service.stop(); for (let i = 0; i < 100 && !/not live/.test(await p.locator('.live-state').innerText()); i++) await sleep(100); await sleep(300) } },
  ]

  for (const [width, height] of [[1440, 1000], [1280, 800]] as const) {
    for (const mode of ['simple', 'detail'] as const) {
      const page = await browser.newPage({ viewport: { width, height } })
      page.on('dialog', d => void d.dismiss())
      await page.addInitScript(m => { try { localStorage.setItem('workflow-editor.display', m); localStorage.setItem('workflow-editor.actor', 'Sample Person') } catch { /* ignore */ } }, mode)
      await page.route(`**/api/workspaces/sample/runs/${working.workflow}/${working.run}/exec`, route => {
        const now = new Date().toISOString()
        return route.fulfill({ json: { attempts: [{ id: 'at-0002', state: 'running', began: now, ended: null, exit_code: null, signal: null, outcome: null, backend: 'check-harness', pid: 4242, alive: true, stop_requested: null, log: null }], jobs: [], checkpoints: [], executor: { state: 'available', detail: 'the executor polls every 5 s', at: now } } })
      })
      for (const sc of screens) {
        await page.goto(`${BASE}/#${sc.path}`)
        await page.locator(sc.ready).filter({ visible: true }).first().waitFor()
        await sleep(900)
        await sc.then?.(page)
        await sleep(400)
        const file = `${sc.name}-${mode}${width === 1280 ? '-1280' : ''}.png`
        await page.screenshot({ path: join(out, file) })
        shots.push({ file, screen: sc.title, mode, size: `${width} × ${height}`, ...(sc.note ? { note: sc.note } : {}) })
        if (sc.name === 'run-disconnected') await service.start()
      }
      await page.close()
    }
  }
  await writeFile(join(out, 'index.json'), JSON.stringify(shots, null, 2) + '\n')
  console.log(`${shots.length} captures in ${out}`)
} finally {
  await browser.close()
  await states?.stop()
  await service.stop()
  await rm(root, { recursive: true, force: true })
}
