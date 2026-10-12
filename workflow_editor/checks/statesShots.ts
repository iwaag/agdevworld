// Captures every representative state of checks/states.ts (workflow_editor
// p8): the definition editor without and with a selection, and each run
// state, at 1440 × 1000 and — for the main ones — 1280 × 800. Viewport
// captures, not full pages: what a person sees on opening the screen.
//
// The working run's host facts are the one synthetic part: no executor
// process exists in the fixture, so its /exec read is answered with one
// alive attempt and an available executor (marked in the index).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import type { States } from './states.ts'

export interface Shot { file: string; title: string; size: string; note?: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function captureStates(base: string, s: States, titles: Record<string, string>, out: string, opts: { prefix?: string; sizes?: [number, number][] } = {}): Promise<Shot[]> {
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch()
  const shots: Shot[] = []
  const prefix = opts.prefix ?? ''
  try {
    for (const [width, height] of opts.sizes ?? [[1440, 1000], [1280, 800]]) {
      const small = width < 1440
      const page = await browser.newPage({ viewport: { width, height } })
      page.on('dialog', d => void d.dismiss())
      await page.addInitScript(() => { try { localStorage.setItem('workflow-editor.actor', 'Sample Person') } catch { /* ignore */ } })
      const working = s.runs.working
      await page.route(`**/api/workspaces/sample/runs/${working.workflow}/${working.run}/exec`, async route => {
        const now = new Date().toISOString()
        await route.fulfill({ json: { attempts: [{ id: 'at-0002', state: 'running', began: now, ended: null, exit_code: null, signal: null, outcome: null, backend: 'check-harness', pid: 4242, alive: true, stop_requested: null, log: null }], jobs: [], checkpoints: [], executor: { state: 'available', detail: 'the executor polls every 5 s', at: now } } })
      })
      const take = async (name: string, title: string, note?: string) => {
        const file = `${prefix}${name}${small ? '-1280' : ''}.png`
        await sleep(400)
        await page.screenshot({ path: join(out, file) })
        shots.push({ file, title, size: `${width} × ${height}`, ...(note ? { note } : {}) })
      }
      const wf = async (file: string) => { await page.goto(`${base}/#/ws/sample/wf/${file}`); await page.waitForSelector('.node, .banner'); await sleep(600) }
      const run = async (k: string, extra = '') => { const r = s.runs[k]; await page.goto(`${base}/#/ws/sample/run/${r.workflow}/${r.run}${extra}`); await page.waitForSelector('.run-summary[data-seq], .banner.error'); await sleep(800) }

      await wf('improve.yaml')
      await take('def-improve', 'Definition, nothing selected (default documentation policy)')
      if (!small) {
        await page.locator('.node[data-id="present"]').click()
        await take('def-node', 'Definition, the Present node selected (appearance, template provenance)')
        await page.locator('.edge[data-index="0"] .hit').dispatchEvent('pointerdown')
        await take('def-edge', 'Definition, a connection selected')
        await page.locator('[data-step="_report.verify"]').click()
        await take('def-step', 'Definition, a generated report step selected')
        await wf('explore.yaml')
        await take('def-branch', 'Definition, branch and join')
        await wf('tidy.yaml')
        await take('def-manual', 'Definition, manual policy with custom appearances')
        await wf('broken.yaml')
        await take('def-broken', 'Definition file that cannot be read (YAML error)')
      }
      await wf('pipeline.yaml')
      await take('def-large', 'Definition, a large graph (16 nodes, 16 reports)')
      if (!small) {
        await wf('improve.yaml')
        await page.getByRole('button', { name: 'Intent & approvals' }).click()
        await take('def-intent', 'Definition, "Intent & approvals" opened')
        await page.getByRole('button', { name: 'Intent & approvals' }).click()
        await page.getByRole('button', { name: 'Workflow settings' }).click()
        await take('def-settings', 'Definition, "Workflow settings" opened')
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Add node', exact: true }).click()
        await take('def-add-node', 'Definition, the Add node menu (base types and templates)')
        await page.keyboard.press('Escape')
        await wf('longtext.yaml')
        await page.locator('.node[data-id="reproduce"]').click()
        await take('def-longtext', 'Definition, long Japanese and English names and text, a node selected')
      }

      for (const k of Object.keys(titles)) {
        if (small && !['plan', 'review', 'accepted', 'completed', 'failed', 'held', 'branch', 'longtext'].includes(k)) continue
        await run(k)
        await take(`run-${k}`, `Run: ${titles[k]}`, k === 'working' ? 'host facts synthetic (/exec answered with an alive attempt)' : undefined)
      }
      if (!small) {
        await run('working', `/at/${s.commit}`)
        await take('run-history', 'Run: historical view (as committed before Verify)')
        await run('completed')
        await page.getByRole('button', { name: 'Run details' }).click()
        for (const t = page.locator('.run-side .sec-toggle[aria-expanded="false"]:visible'); await t.count();) await t.first().click()
        await page.locator('.node[data-id="present"]').click()
        await page.evaluate(() => { window.scrollTo(0, 0); (document.querySelector('.run-side') as HTMLElement).scrollTop = 0 })
        await take('run-completed-details', 'Run: completed, with Run details, every side section and a selected node opened', 'side pane scrolled to its top; it scrolls on its own')
        await page.evaluate(() => { const s = document.querySelector('.run-side') as HTMLElement; s.scrollTop = s.scrollHeight })
        await take('run-completed-details-end', 'Run: completed, side pane scrolled to its end (execution, coordination, result, history)')
        await page.evaluate(() => { try { localStorage.removeItem('workflow-editor.run-sections') } catch { /* ignore */ } })
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
  await writeFile(join(out, `${prefix}index.json`), JSON.stringify(shots, null, 2) + '\n')
  return shots
}

export type { Page }
