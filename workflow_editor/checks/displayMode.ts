// Simple and Detail (workflow_editor p8/ex1) in the browser, on the
// representative states of checks/states.ts: a private project, registry,
// area, presentation host and service. It asserts the preference and its
// toggle, what Simple leaves out and Detail keeps, the contextual entries,
// the graph across a switch (selection, place, alignment, Compact/Mini kept)
// and that a switch keeps the person's work and reading context. It never
// touches another registry or workspace.
//
//   npm run build && node checks/displayMode.ts [--port 8214]
//
// Synthetic composition (CDP) is not the native macOS IME.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8214')

const root = await mkdtemp(join(tmpdir(), 'wfe-display-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { buildStates } = await import('./states.ts')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => Promise<boolean>, ms = 6000): Promise<boolean> {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(40) }
  return false
}

// Every connection starts at its source card's right edge and ends at its
// target's left edge; every report icon sits inside its card.
async function aligned(page: Page): Promise<{ edges: number; ok: number; icons: boolean }> {
  return page.evaluate(() => {
    const surf = (el: HTMLElement) => { let x = 0, y = 0, e: HTMLElement | null = el; while (e && !e.classList.contains('surface')) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent as HTMLElement | null } return { x, y, w: el.offsetWidth, h: el.offsetHeight } }
    const res = [...document.querySelectorAll<SVGGElement>('.edge')].map(g => {
      const nums = g.querySelector('.line')!.getAttribute('d')!.match(/-?[\d.]+/g)!.map(Number)
      const [sx, sy] = nums, [ex, ey] = nums.slice(-2)
      const a = surf(document.querySelector<HTMLElement>(`.node[data-id="${g.dataset.from}"]`)!), b = surf(document.querySelector<HTMLElement>(`.node[data-id="${g.dataset.to}"]`)!)
      return Math.abs(sx - (a.x + a.w)) < 1.5 && Math.abs(sy - (a.y + a.h / 2)) < 1.5 && Math.abs(ex - (b.x - 2)) < 1.5 && Math.abs(ey - (b.y + b.h / 2)) < 1.5
    })
    const icons = [...document.querySelectorAll<HTMLElement>('.report-icon')].every(i => {
      const c = document.querySelector<HTMLElement>(`.node[data-id="${i.dataset.for}"]`)!.getBoundingClientRect(), r = i.getBoundingClientRect()
      return r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5
    })
    return { edges: res.length, ok: res.filter(Boolean).length, icons }
  })
}
const mode = (page: Page) => page.evaluate(() => document.documentElement.dataset.display)
const pressed = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.display-toggle button')].map(b => `${b.dataset.display}:${b.getAttribute('aria-pressed')}`).join(','))
const toggle = (page: Page, d: 'simple' | 'detail') => page.locator(`.display-toggle button[data-display="${d}"]`).click()
// Inside the canvas's visible rectangle.
const inCanvas = (page: Page, sel: string) => page.evaluate(s => { const c = document.querySelector('.canvas')!.getBoundingClientRect(), r = document.querySelector(s)!.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom }, sel)

const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
let states: Awaited<ReturnType<typeof buildStates>> | undefined
let browser: Browser | undefined
try {
  states = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18820, 18829] })
  const S = states
  await service.start()
  const BASE = service.base
  const opened = await open(1440, 1000, { display: null })
  browser = opened.browser
  const { page, errors } = opened
  const runUrl = (k: string, extra = '') => `${BASE}/#/ws/sample/run/${S.runs[k].workflow}/${S.runs[k].run}${extra}`
  const gotoRun = async (k: string, extra = '') => { await page.goto(runUrl(k, extra)); await page.waitForSelector('.run-summary[data-seq], .banner.error'); await sleep(400) }
  const gotoWf = async (f: string) => { await page.goto(`${BASE}/#/ws/sample/wf/${f}`); await page.waitForSelector('.node'); await sleep(400) }

  // ==== the graph across a switch (step 3) =================================================
  console.log('graph: selection, place and Compact/Mini across a switch')
  await page.goto(`${BASE}/#/`)
  await page.evaluate(() => { localStorage.setItem('workflow-editor.display', 'detail'); localStorage.setItem('workflow-editor.mode', 'mini') })
  await gotoWf('improve.yaml')
  check(await page.locator('.mode-switch button.active').innerText() === 'Mini', 'Detail opens in the stored Mini mode')
  await page.locator('.node[data-id="verify"]').click()
  await page.getByLabel('Node description').fill('A draft made in Detail')
  const zoomBefore = await page.locator('.zoom-level').innerText()
  await toggle(page, 'simple')
  await sleep(250)
  check(await mode(page) === 'simple' && await page.locator('.node[data-id="verify"].selected').count() === 1, 'Simple keeps the selected card')
  check(await page.getByLabel('Node description').inputValue() === 'A draft made in Detail' && await page.getByLabel('Node description').isVisible(), 'the selection shows its name and description, with the draft')
  check(await page.getByLabel('Node type').isHidden() && await page.locator('.insp-group[data-group="appearance"]').isHidden() && await page.getByRole('button', { name: 'Delete node' }).isHidden(), 'type, appearance and Delete are Detail\'s')
  check(await page.locator('.inspector .insp-more button').isVisible(), 'the selection offers "More details"')
  check(await page.locator('.zoom-level').innerText() === zoomBefore, `no Fit or reframing on the switch (${zoomBefore})`)
  check(await inCanvas(page, '.node[data-id="verify"]'), 'the selected card is in view after the switch')
  check(await page.locator('.mode-switch').isHidden() && await page.locator('.node[data-id="verify"] .type-label').count() === 0 && await page.locator('.node .node-desc').count() === 0, 'Simple cards: no type label or description; Compact/Mini is not offered')
  check(await page.locator('.node[data-id="verify"]').getAttribute('aria-label') === 'Do node Verify', 'the type stays in the card\'s accessible name')
  let a = await aligned(page)
  check(a.ok === a.edges && a.edges === 4 && a.icons, `Simple: connections attached (${a.ok}/${a.edges}) and report icons in their cards`)
  await page.locator('.inspector .insp-more button').click()
  await sleep(150)
  check(await mode(page) === 'detail' && await page.getByLabel('Node type').isVisible(), '"More details" is the same inspector in Detail')
  check(await page.evaluate(() => document.activeElement?.closest('.insp-head') !== null), 'the keyboard is on the inspector\'s heading')
  check(await page.locator('.mode-switch button.active').innerText() === 'Mini' && await page.evaluate(() => localStorage.getItem('workflow-editor.mode')) === 'mini', 'back in Detail, Mini is still the graph setting (its key untouched)')
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, `Detail (Mini): connections attached (${a.ok}/${a.edges})`)

  console.log('graph: editing in Simple')
  await toggle(page, 'simple')
  await sleep(200)
  await page.keyboard.press('Escape')
  const box = (await page.locator('.node[data-id="present"]').boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 110, { steps: 6 }); await page.mouse.up()
  await sleep(200)
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, 'dragging a Simple card carries its connections and report icon')
  check(await page.locator('.save-state').innerText() === 'Unsaved changes', 'the move is a draft change, saved only by Save')
  const imp = (await page.locator('.node[data-id="implement"] .port').boundingBox())!, chk = (await page.locator('.node[data-id="check"]').boundingBox())!
  await page.locator('.node[data-id="implement"]').hover()
  await page.mouse.move(imp.x + 8, imp.y + 8); await page.mouse.down(); await page.mouse.move(chk.x + 30, chk.y + 30, { steps: 8 }); await page.mouse.up()
  await sleep(200)
  check(await page.locator('.edge.selected').count() === 1 && /Connection/.test(await page.locator('.inspector .insp-head h3').innerText()), 'connecting in Simple selects the new connection')
  check(await page.locator('.inspector .insp-more button').isVisible() && await page.getByRole('button', { name: 'Delete connection' }).isHidden(), 'a connection: its ends, and "More details" for its controls')
  await page.locator('[data-step="_report.verify"]').click()
  await sleep(150)
  check(/Report on Verify/.test(await page.locator('.inspector .insp-head h3').innerText()) && await page.locator('.inspector .insp-more button').isVisible() && await page.locator('.inspector dl.kv').isHidden(), 'a report step stays selectable and inspectable, its waits and instructions in Detail')
  a = await aligned(page)
  check(a.ok === a.edges && a.edges === 5 && a.icons, `after the edits: ${a.ok}/${a.edges} connections attached`)
  await page.goto(`${BASE}/#/`) // leaves the draft (the guard is accepted)

  console.log('graph: branch and join, a run')
  await gotoWf('explore.yaml')
  a = await aligned(page)
  check(a.ok === a.edges && a.edges === 4 && a.icons, `branch and join in Simple: ${a.ok}/${a.edges} attached`)
  await gotoRun('completed')
  check(await page.locator('.run-side').isHidden(), 'a completed, decided run in Simple: the graph has the width (no side pane)')
  await page.locator('.node[data-id="present"]').click()
  await sleep(250)
  check(await page.locator('.run-side').isVisible() && /Presented p1/.test(await page.locator('.side-card .outcome').innerText()), 'selecting a step shows its recorded outcome')
  check(await inCanvas(page, '.node[data-id="present"]'), 'the selected card is in view beside the pane')
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, `run graph in Simple: ${a.ok}/${a.edges} attached`)
  await page.locator('.side-card .insp-more button').click()
  await sleep(200)
  check(await mode(page) === 'detail' && await page.locator('.side-card dl.kv').isVisible() && await page.locator('.node[data-id="present"].selected').count() === 1, '"More details" shows the same node\'s full record in Detail')
  a = await aligned(page)
  check(a.ok === a.edges && a.icons, `run graph in Detail: ${a.ok}/${a.edges} attached`)
  await shot(page, 'p8ex1-run-detail-selected', false)

  check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, `no page errors (${errors.join('; ')})`)
  void pressed; void waitFor
} finally {
  await browser?.close()
  await states?.stop()
  await service.stop()
  await rm(root, { recursive: true, force: true })
}
done()
